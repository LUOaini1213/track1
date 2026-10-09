import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import { OtlpOutbox } from "./otlp-outbox.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunOtlpDelivery } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const roots: string[] = [], apps: FastifyInstance[] = [], services: AgentService[] = [], collectors: Server[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(collectors.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })));
});
const runner: AgentRunner = { run: async () => ({ output: "Task complete", threadId: "demo", usage: {} }),
  cancel: async () => false, isAvailable: async () => true };
async function target(handler: (response: ServerResponse) => void) {
  let requests = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Read the actual OTLP request. */ }
    requests++; handler(response);
  }); collectors.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: "http://127.0.0.1:" + (server.address() as { port: number }).port, requests: () => requests };
}
async function configuration(endpoint = "") {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-delivery-http-")); roots.push(root);
  return loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test", ARK_MODEL: "demo", OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=delivery-private-header", OTEL_EXPORTER_OTLP_TIMEOUT: "100",
    OTEL_EXPORTER_OTLP_RETRY_INITIAL_MS: "100", OTEL_EXPORTER_OTLP_RETRY_MAX_MS: "200" });
}
async function open(config: AppConfig, executor = runner) {
  const service = new AgentService(config, new JsonStore(path.join(config.dataDirectory, "launchpad.json")),
    new WorkspaceManager(config.workspaceRoot), executor); services.push(service); await service.initialize();
  const app = await createApp(config, service); apps.push(app);
  return { app, service, delivery: async (id: string) => {
    const response = await app.inject({ method: "GET", url: `/api/runs/${id}/delivery` });
    expect(response.statusCode).toBe(200);
    const result = response.json<{ delivery: RunOtlpDelivery }>();
    expect(Object.keys(result)).toEqual(["delivery"]);
    expect(response.body.length).toBeLessThan(1000);
    return result.delivery;
  }, trace: async (id: string) => {
    const response = await app.inject({ method: "GET", url: `/api/runs/${id}/trace` });
    expect(response.statusCode).toBe(200);
    return response.json<{ run: { status: string; output: string }; spans: unknown[]; delivery: RunOtlpDelivery }>();
  } };
}
async function execute(service: AgentService) {
  const agent = await service.createAgent({ name: "Delivery demo" });
  const { run } = await service.sendMessage(agent.id, "write hello");
  await expect.poll(() => service.getRun(run.id).status).toBe("completed"); return run.id;
}
const accepted = (response: ServerResponse) => { response.writeHead(200); response.end("{}"); };

describe("per-Run OTLP delivery through the real trace API", () => {
  it("distinguishes an executing Run, collector retry and eventual acknowledgment without changing execution", async () => {
    let healthy = false, finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const collector = await target((response) => healthy ? accepted(response) : (response.writeHead(503), response.end()));
    const { service, trace } = await open(await configuration(collector.endpoint), {
      ...runner, run: async () => { await gate; return { output: "Task complete", threadId: "demo", usage: {} }; } });
    const agent = await service.createAgent({ name: "Pending delivery" });
    const { run } = await service.sendMessage(agent.id, "write hello");
    try { expect((await trace(run.id)).delivery.state).toBe("awaiting_completion"); }
    finally { finish(); }
    await expect.poll(async () => (await trace(run.id)).delivery.attempts).toBeGreaterThan(0);
    const pending = await trace(run.id);
    expect(pending.run).toMatchObject({ status: "completed", output: "Task complete" });
    expect(pending.delivery).toMatchObject({ state: "pending", acceptedSpans: 0, checkpointPending: false });
    expect(pending.delivery.pendingBatches).toBeGreaterThan(0); expect(pending.delivery.nextRetryAt).not.toBeNull();
    healthy = true;
    await expect.poll(async () => (await trace(run.id)).delivery.state).toBe("delivered");
    const delivered = await trace(run.id);
    expect(delivered.delivery.acceptedSpans).toBe(delivered.spans.length);
    expect(delivered.delivery).toMatchObject({ attempts: 0, pendingBatches: 0, nextRetryAt: null });
    expect(delivered.delivery.settledAt).not.toBeNull();
  });

  it.each([
    ["partial", 200, '{"partialSuccess":{"rejectedSpans":"1","errorMessage":"collector-private-error"}}'],
    ["rejected", 400, "collector-private-error"],
    ["uncertain", 200, "collector-private-error"],
    ["delivered", 200, '{"partialSuccess":{"rejectedSpans":"0","errorMessage":"collector-private-error"}}'],
  ] as const)("exposes %s counts without collector URLs, credentials or response text", async (state, status, body) => {
    const collector = await target((response) => { response.writeHead(status); response.end(body); });
    const config = await configuration(collector.endpoint), { service, trace, delivery } = await open(config);
    const id = await execute(service);
    await expect.poll(async () => (await trace(id)).delivery.state).toBe(state);
    const result = await trace(id), serialized = JSON.stringify(result.delivery);
    expect(await delivery(id)).toEqual(result.delivery);
    expect(result.run).toMatchObject({ status: "completed", output: "Task complete" });
    expect(serialized).not.toContain(collector.endpoint); expect(serialized).not.toContain("delivery-private-header");
    expect(serialized).not.toContain("collector-private-error");
    expect(Object.keys(result.delivery).sort()).toEqual(["state", "acceptedSpans", "rejectedSpans", "uncertainSpans", "warningBatches",
      "attempts", "pendingBatches", "queuedAt", "settledAt", "nextRetryAt", "checkpointPending", "recoveryPossible", "corruptionEvidence"].sort());
    const total = result.spans.length;
    expect(result.delivery.acceptedSpans + result.delivery.rejectedSpans + result.delivery.uncertainSpans).toBe(total);
    if (state === "partial") expect(result.delivery.rejectedSpans).toBe(1);
    if (state === "rejected") expect(result.delivery.rejectedSpans).toBe(total);
    if (state === "uncertain") expect(result.delivery.uncertainSpans).toBe(total);
    if (state === "delivered") expect(result.delivery.warningBatches).toBe(1);
    await service.shutdown(); expect(collector.requests()).toBe(1);
    const reopened = await open(config);
    expect((await reopened.trace(id)).delivery).toEqual(result.delivery);
    expect(await reopened.delivery(id)).toEqual(result.delivery);
    expect(collector.requests()).toBe(1);
  });

  it("shows paused historical content after a destination change and export off when unconfigured", async () => {
    const first = await target((response) => { response.writeHead(503); response.end(); });
    const second = await target(accepted), config = await configuration(first.endpoint);
    const initial = await open(config), id = await execute(initial.service);
    await expect.poll(async () => (await initial.trace(id)).delivery.attempts).toBeGreaterThan(0);
    await initial.service.shutdown();
    const changed = await open({ ...config, otlpEndpoint: second.endpoint });
    const delivery = (await changed.trace(id)).delivery;
    expect(delivery).toMatchObject({ state: "paused", nextRetryAt: null, checkpointPending: false });
    expect(delivery.pendingBatches).toBeGreaterThan(0); expect(second.requests()).toBe(0);
    await changed.service.shutdown();
    const disabled = await open({ ...config, otlpEndpoint: "" });
    expect((await disabled.trace(id)).delivery).toMatchObject({ state: "disabled", acceptedSpans: 0, pendingBatches: 0 });
    expect(await disabled.delivery(id)).toEqual((await disabled.trace(id)).delivery);
    expect(second.requests()).toBe(0);
  });

  it("reports a recoverable missing record and distinguishes missing local spans", async () => {
    const collector = await target((response) => { response.writeHead(503); response.end(); });
    const config = await configuration(collector.endpoint), { service, trace, delivery } = await open(config);
    const id = await execute(service);
    await expect.poll(async () => (await trace(id)).delivery.state).toBe("pending");
    const outbox = (service as unknown as { outbox: OtlpOutbox }).outbox;
    await outbox.forget([id]);
    expect((await trace(id)).delivery).toMatchObject({ state: "recovery_needed", recoveryPossible: true });
    expect(await delivery(id)).toEqual((await trace(id)).delivery);
    await service.shutdown();
    await rm(path.join(config.dataDirectory, "spans", id + ".json"));
    expect((await trace(id)).delivery).toMatchObject({ state: "unavailable", recoveryPossible: false });
    expect(await delivery(id)).toEqual((await trace(id)).delivery);
  });

  it("keeps compact refresh independent of span file I/O and rejects unknown or unauthenticated Runs", async () => {
    const collector = await target(accepted), config = await configuration(collector.endpoint);
    const { app, service, delivery } = await open(config), id = await execute(service);
    await expect.poll(async () => (await delivery(id)).state).toBe("delivered");
    const spans = (service as unknown as { spanStore: { read: (id: string) => Promise<unknown[]> } }).spanStore;
    spans.read = async () => { throw new Error("compact endpoint must not read acknowledged spans"); };
    expect((await delivery(id)).acceptedSpans).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: "/api/runs/not-a-uuid/delivery" })).statusCode).toBe(400);
    const missing = await app.inject({ method: "GET", url: "/api/runs/00000000-0000-4000-8000-000000000099/delivery" });
    expect(missing.statusCode).toBe(404);
    const authenticated = await createApp({ ...config, authToken: "delivery-api-shared-token" }, service); apps.push(authenticated);
    expect((await authenticated.inject({ method: "GET", url: `/api/runs/${id}/delivery` })).statusCode).toBe(401);
    expect((await authenticated.inject({ method: "GET", url: `/api/runs/${id}/delivery`,
      headers: { authorization: "Bearer delivery-api-shared-token" } })).statusCode).toBe(200);
  });
});
