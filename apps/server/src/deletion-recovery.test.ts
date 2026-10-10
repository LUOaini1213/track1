import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import type { OtlpOutbox } from "./otlp-outbox.js";
import { SpanStore } from "./span-store.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, TraceSpan } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const faults = vi.hoisted(() => ({ unlink: new Set<string>(), archive: new Set<string>() }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const denied = () => Object.assign(new Error("EACCES: injected cleanup permission failure"), { code: "EACCES" });
  return { ...actual,
    rm: async (file: string, options: Parameters<typeof actual.rm>[1]) => {
      if (faults.unlink.has(String(file))) throw denied();
      return actual.rm(file, options);
    },
    rename: async (from: string, to: string) => {
      if (faults.archive.has(String(from))) throw denied();
      return actual.rename(from, to);
    },
  };
});

const roots: string[] = [], services: AgentService[] = [], apps: FastifyInstance[] = [], collectors: Server[] = [];
const runner: AgentRunner = { run: async () => { throw new Error("No model may run in cleanup tests"); },
  cancel: async () => false, isAvailable: async () => true };
afterEach(async () => {
  vi.useRealTimers(); faults.unlink.clear(); faults.archive.clear(); vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(collectors.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })));
});
function outbox(service: AgentService) { return (service as unknown as { outbox: OtlpOutbox }).outbox; }
async function config(endpoint = "") {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-deletion-")); roots.push(root);
  return loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", RUNTIME_PROVIDER: "replay",
    APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"), OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
}
async function open(configuration: AppConfig) {
  const store = new JsonStore(path.join(configuration.dataDirectory, "launchpad.json"));
  const workspaces = new WorkspaceManager(configuration.workspaceRoot);
  const spanStore = new SpanStore(path.join(configuration.dataDirectory, "spans"));
  const service = new AgentService(configuration, store, workspaces, runner, spanStore); services.push(service);
  await service.initialize(); const app = await createApp(configuration, service); apps.push(app);
  return { service, store, workspaces, spanStore, app };
}
function files(configuration: AppConfig, id: string) {
  return { queue: path.join(configuration.dataDirectory, "otlp-outbox", id + ".json"),
    spans: path.join(configuration.dataDirectory, "spans", id + ".json") };
}
async function seed(context: Awaited<ReturnType<typeof open>>, agentId: string, persistedRun = true) {
  const id = randomUUID(), timestamp = new Date().toISOString();
  const spans: TraceSpan[] = [{ traceId: id, spanId: randomUUID(), parentSpanId: null, runId: id, agentId,
    name: "cleanup fixture", kind: "tool", status: "ok", startedAt: timestamp, endedAt: timestamp,
    durationMs: 0, attributes: {} }];
  if (persistedRun) await context.store.mutate((database) => {
    database.runs.push({ id, agentId, traceId: id, status: "completed", prompt: "fixture", output: "fixture",
      error: null, usage: null, startedAt: timestamp, completedAt: timestamp, createdAt: timestamp, spans: [] });
    database.messages.push({ id: randomUUID(), agentId, runId: id, role: "user", content: "fixture", createdAt: timestamp });
  });
  await context.spanStore.write(id, spans); await outbox(context.service).enqueue(id, spans); return id;
}
async function collector() {
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    received.push(payload.resourceSpans[0].resource.attributes.find((a: { key: string }) => a.key === "launchpad.run.id").value.stringValue);
    response.writeHead(200); response.end("{}");
  }); collectors.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: "http://127.0.0.1:" + (server.address() as { port: number }).port, received };
}

describe("recoverable Agent deletion through real storage and HTTP", () => {
  it("rejects admissions queued before DELETE when their store mutation begins afterward", async () => {
    const configuration = await config(), context = await open(configuration), agent = await context.service.createAgent({ name: "Queued admission" });
    let entered!: () => void, release!: () => void;
    const occupied = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    const blocker = context.store.mutate(async () => { entered(); await gate; }); await occupied;
    const model = vi.spyOn(runner, "run");
    const admissions = Promise.allSettled([context.service.startAgent(agent.id), context.service.sendMessage(agent.id, "queued before delete")]);
    const deleting = context.service.deleteAgent(agent.id); release(); await blocker;
    for (const outcome of await admissions) { expect(outcome.status).toBe("rejected"); if (outcome.status === "rejected") expect(outcome.reason.statusCode).toBe(409); }
    await deleting; expect(model).not.toHaveBeenCalled();
    expect(context.store.snapshot().agents).toEqual([]); expect(context.store.snapshot().runs).toEqual([]);
  });

  it("rejects Start, edit and message admission while DELETE is cancelling", async () => {
    const configuration = await config(), context = await open(configuration), agent = await context.service.createAgent({ name: "Admission blocked" });
    let entered!: () => void, release!: () => void;
    const cancelled = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(context.service as unknown as { cancelExecution: (id: string) => Promise<void> }, "cancelExecution")
      .mockImplementation(async () => { entered(); await gate; });
    const deleting = context.service.deleteAgent(agent.id); await cancelled;
    let outcomes;
    try { outcomes = await Promise.allSettled([context.service.startAgent(agent.id),
      context.service.updateAgent(agent.id, { instructions: "late edit" }), context.service.sendMessage(agent.id, "late admission")]); }
    finally { release(); await deleting; }
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes!) { expect(outcome.status).toBe("rejected"); if (outcome.status === "rejected") expect(outcome.reason.statusCode).toBe(409); }
    expect(context.store.snapshot().agents).toEqual([]); expect(context.store.snapshot().runs).toEqual([]);
    await expect(access(agent.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("withholds a committed admission before it can publish activeExecutions or start a runner", async () => {
    const configuration = await config(), context = await open(configuration), agent = await context.service.createAgent({ name: "Publication held" });
    let admit!: () => void, publish!: () => void, stopped!: () => void, continueDelete!: () => void;
    const committed = new Promise<void>((resolve) => { admit = resolve; }), publicationGate = new Promise<void>((resolve) => { publish = resolve; });
    const marked = new Promise<void>((resolve) => { stopped = resolve; }), deleteGate = new Promise<void>((resolve) => { continueDelete = resolve; });
    const originalMutation = context.store.mutate.bind(context.store); let holdAdmission = true;
    vi.spyOn(context.store, "mutate").mockImplementation((async (mutation: never) => {
      const result = await originalMutation(mutation);
      if (holdAdmission) { holdAdmission = false; admit(); await publicationGate; }
      return result;
    }) as typeof context.store.mutate);
    const mutable = context.service as unknown as { setStatus: (id: string, status: "stopped") => Promise<unknown>; activeExecutions: Map<string, unknown> };
    const originalStatus = mutable.setStatus.bind(context.service);
    vi.spyOn(mutable, "setStatus").mockImplementation(async (id, status) => { const result = await originalStatus(id, status); stopped(); await deleteGate; return result; });
    const model = vi.spyOn(runner, "run");
    const admission = context.service.sendMessage(agent.id, "committed but unpublished").then(() => ({ admitted: true, status: 0 }),
      (error) => ({ admitted: false, status: error.statusCode }));
    await committed; expect(context.store.snapshot().runs).toHaveLength(1);
    const deleting = context.service.deleteAgent(agent.id); await marked; publish();
    const outcome = await admission; continueDelete(); await deleting;
    expect(outcome).toEqual({ admitted: false, status: 409 }); expect(model).not.toHaveBeenCalled();
    expect(mutable.activeExecutions.size).toBe(0); expect(context.store.snapshot().runs).toEqual([]);
    expect(context.store.snapshot().agents).toEqual([]);
  });

  it("settles an already writing edit before archiving, so it cannot recreate the workspace", async () => {
    const configuration = await config(), context = await open(configuration), agent = await context.service.createAgent({ name: "Edit held" });
    let entered!: () => void, release!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    const originalWrite = context.workspaces.writeInstructions.bind(context.workspaces);
    vi.spyOn(context.workspaces, "writeInstructions").mockImplementation(async (changed) => { entered(); await gate; await originalWrite(changed); });
    const edit = context.service.updateAgent(agent.id, { instructions: "already admitted edit" }).catch((error) => error.statusCode);
    await writing; const deleting = context.service.deleteAgent(agent.id);
    const finishedBeforeEdit = await Promise.race([deleting.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))]);
    release(); expect(await edit).toBe(409); const result = await deleting;
    expect(finishedBeforeEdit).toBe(false); expect(result.cleanupPending).toBe(false);
    await expect(access(result.archivedWorkspace!)).resolves.toBeUndefined();
    await expect(access(agent.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(context.store.snapshot().deletions).toEqual([]);
  });

  it("commits one fixed cleanup intent when two DELETEs pass admission together", async () => {
    const configuration = await config(), context = await open(configuration), agent = await context.service.createAgent({ name: "Concurrent deletion" });
    faults.archive.add(agent.workspacePath);
    let release!: () => void, entered!: () => void, arrivals = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const admitted = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(context.service as unknown as { cancelExecution: (id: string) => Promise<void> }, "cancelExecution")
      .mockImplementation(async () => { if (++arrivals === 2) entered(); await gate; });
    const planned = vi.spyOn(context.workspaces, "archivePath");
    const left = context.service.deleteAgent(agent.id), right = context.service.deleteAgent(agent.id);
    await admitted; release(); const results = await Promise.all([left, right]);
    expect(results).toEqual([{ archivedWorkspace: null, cleanupPending: true }, { archivedWorkspace: null, cleanupPending: true }]);
    expect(context.store.snapshot().agents).toEqual([]);
    expect(context.store.snapshot().deletions).toHaveLength(1); expect(planned).toHaveBeenCalledTimes(1);
    const originalPath = context.store.snapshot().deletions[0]!.workspace!.archivePath;
    faults.archive.clear(); const retry = await context.service.deleteAgent(agent.id);
    expect(retry).toEqual({ archivedWorkspace: originalPath, cleanupPending: false });
    expect(context.store.snapshot().deletions).toEqual([]);
    expect(await readdir(path.join(configuration.workspaceRoot, ".deleted"))).toEqual([path.basename(originalPath)]);
  });

  it("archives despite EACCES, restarts healthy delivery, and retries the deleted id without 404", async () => {
    const target = await collector(), configuration = await config(target.endpoint), first = await open(configuration);
    await outbox(first.service).shutdown();
    const removed = await first.service.createAgent({ name: "Removed" }), healthy = await first.service.createAgent({ name: "Healthy" });
    const removedRun = await seed(first, removed.id), healthyRun = await seed(first, healthy.id);
    const blocked = files(configuration, removedRun); faults.unlink.add(blocked.queue); faults.unlink.add(blocked.spans);
    const archive = vi.spyOn(first.workspaces, "archive");
    const response = await first.app.inject({ method: "DELETE", url: "/api/agents/" + removed.id });
    expect(response.statusCode).toBe(200);
    const deletion = response.json<{ archivedWorkspace: string; cleanupPending: boolean }>();
    expect(deletion.cleanupPending).toBe(true); expect(deletion.archivedWorkspace).toBeTruthy(); expect(archive).toHaveBeenCalledTimes(1);
    await expect(access(deletion.archivedWorkspace)).resolves.toBeUndefined();
    const persisted = JSON.parse(await readFile(path.join(configuration.dataDirectory, "launchpad.json"), "utf8"));
    expect(persisted.agents.map((a: { id: string }) => a.id)).toEqual([healthy.id]); expect(persisted.runs.map((r: { id: string }) => r.id)).toEqual([healthyRun]);
    expect(persisted.messages.some((m: { agentId: string }) => m.agentId === removed.id)).toBe(false);
    expect(persisted.deletions).toHaveLength(1); expect(outbox(first.service).has(removedRun)).toBe(false);
    expect((await first.app.inject({ method: "DELETE", url: "/api/agents/" + removed.id })).json().cleanupPending).toBe(true);
    await first.service.shutdown(); const resumed = await open(configuration);
    expect((await resumed.app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    await expect.poll(() => target.received).toEqual([healthyRun]);
    expect(() => resumed.service.getRun(removedRun)).toThrow("Run not found");
    const system = (await resumed.app.inject({ method: "GET", url: "/api/system" })).json();
    expect(system.deletionCleanup).toEqual({ pendingRecords: 1, pendingRuns: 1 });
    faults.unlink.clear();
    const retry = await resumed.app.inject({ method: "DELETE", url: "/api/agents/" + removed.id });
    expect(retry.statusCode).toBe(200); expect(retry.json()).toEqual({ archivedWorkspace: deletion.archivedWorkspace, cleanupPending: false });
    expect(resumed.store.snapshot().deletions).toEqual([]);
    await expect(access(blocked.queue)).rejects.toMatchObject({ code: "ENOENT" }); await expect(access(blocked.spans)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.join(configuration.workspaceRoot, ".deleted"))).toHaveLength(1);
    await outbox(resumed.service).enqueue(removedRun, []); expect(outbox(resumed.service).has(removedRun)).toBe(false);
    expect(target.received).toEqual([healthyRun]);
    expect((await resumed.app.inject({ method: "DELETE", url: "/api/agents/" + removed.id })).statusCode).toBe(404);
  });

  it("automatically retries a busy archive without restoring the deleted Agent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const configuration = await config(), context = await open(configuration), agent = await context.service.createAgent({ name: "Busy" });
    faults.archive.add(agent.workspacePath);
    expect(await context.service.deleteAgent(agent.id)).toEqual({ archivedWorkspace: null, cleanupPending: true });
    expect(context.store.snapshot().agents).toEqual([]); expect(context.store.snapshot().deletions).toHaveLength(1);
    await expect(access(agent.workspacePath)).resolves.toBeUndefined();
    faults.archive.clear(); await vi.advanceTimersByTimeAsync(5_000); vi.useRealTimers();
    await expect.poll(() => context.store.snapshot().deletions.length).toBe(0);
    await expect(access(agent.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.join(configuration.workspaceRoot, ".deleted"))).toHaveLength(1);
    expect(context.store.snapshot().agents).toEqual([]);
  });

  it("recovers rename-before-ack with exactly the original archive destination", async () => {
    const configuration = await config(), first = await open(configuration), agent = await first.service.createAgent({ name: "Ack interrupted" });
    const originalArchive = first.workspaces.archive.bind(first.workspaces);
    vi.spyOn(first.workspaces, "archive").mockImplementation(async (...args) => {
      const destination = await originalArchive(...args);
      vi.spyOn(first.store as unknown as { persist: () => Promise<void> }, "persist").mockRejectedValueOnce(new Error("injected DB ack failure"));
      return destination;
    });
    const result = await first.service.deleteAgent(agent.id); expect(result.cleanupPending).toBe(true);
    expect(first.store.snapshot().deletions).toHaveLength(1); await first.service.shutdown();
    const restarted = await open(configuration);
    expect(restarted.store.snapshot().deletions).toEqual([]); expect(restarted.service.listAgents()).toEqual([]);
    await expect(access(result.archivedWorkspace!)).resolves.toBeUndefined();
    expect(await readdir(path.join(configuration.workspaceRoot, ".deleted"))).toEqual([path.basename(result.archivedWorkspace!)]);
  });

  it("journals legacy orphan traces and tolerates their unlink failure on upgrade", async () => {
    const target = await collector(), configuration = await config(target.endpoint), first = await open(configuration);
    await outbox(first.service).shutdown();
    const healthy = await first.service.createAgent({ name: "Healthy legacy Agent" });
    const orphan = await seed(first, randomUUID(), false), blocked = files(configuration, orphan);
    faults.unlink.add(blocked.queue); faults.unlink.add(blocked.spans); await first.service.shutdown();
    const file = path.join(configuration.dataDirectory, "launchpad.json"), legacy = JSON.parse(await readFile(file, "utf8"));
    delete legacy.deletions; await writeFile(file, JSON.stringify(legacy));
    const upgraded = await open(configuration);
    expect(upgraded.service.listAgents().map((a) => a.id)).toEqual([healthy.id]);
    expect(upgraded.store.snapshot().deletions[0]).toMatchObject({ runIds: [orphan], workspace: null });
    expect(outbox(upgraded.service).has(orphan)).toBe(false); expect(target.received).toEqual([]);
    await upgraded.service.shutdown(); faults.unlink.clear();
    const recovered = await open(configuration); expect(recovered.store.snapshot().deletions).toEqual([]);
    await expect(access(blocked.queue)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(blocked.spans)).rejects.toMatchObject({ code: "ENOENT" }); expect(target.received).toEqual([]);
  });

  it("retains a workspace when its archive parent disappears, then repairs on restart", async () => {
    const configuration = await config(), first = await open(configuration), agent = await first.service.createAgent({ name: "Archive parent gone" });
    await rm(path.join(configuration.workspaceRoot, ".deleted"), { recursive: true });
    expect(await first.service.deleteAgent(agent.id)).toEqual({ archivedWorkspace: null, cleanupPending: true });
    const archivePath = first.store.snapshot().deletions[0]!.workspace!.archivePath;
    await expect(access(agent.workspacePath)).resolves.toBeUndefined(); await first.service.shutdown();
    const restarted = await open(configuration); expect(restarted.store.snapshot().deletions).toEqual([]);
    await expect(access(archivePath)).resolves.toBeUndefined(); await expect(access(agent.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
