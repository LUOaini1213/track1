import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { OtlpOutbox } from "./otlp-outbox.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, TraceSpan } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const roots: string[] = [], boxes: OtlpOutbox[] = [], servers: Server[] = [], services: AgentService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await Promise.all(boxes.splice(0).map((box) => box.shutdown()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })));
});
async function collector(handler: (response: ServerResponse, n: number) => void) {
  const requests: { body: string; headers: IncomingMessage["headers"] }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ body, headers: request.headers });
    handler(response, requests.length);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { requests, endpoint: `http://127.0.0.1:${address.port}` };
}
async function setup(endpoint: string, extra: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-outbox-")); roots.push(root);
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"),
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_TIMEOUT: "100",
    OTEL_EXPORTER_OTLP_RETRY_INITIAL_MS: "100", OTEL_EXPORTER_OTLP_RETRY_MAX_MS: "200", ...extra });
  const box = new OtlpOutbox(config); boxes.push(box); await box.initialize();
  return { root, config, box, file: (id: string) => path.join(config.dataDirectory, "otlp-outbox", id + ".json") };
}
function spans(runId: string, n = 1): TraceSpan[] {
  return Array.from({ length: n }, (_, i) => ({ traceId: runId, spanId: randomUUID(), parentSpanId: null,
    runId, agentId: randomUUID(), name: "execute_tool shell", kind: "tool", status: "ok",
    startedAt: "2026-10-01T00:00:00.000Z", endedAt: "2026-10-01T00:00:01.000Z", durationMs: 1000,
    attributes: { index: i } }));
}
async function record(file: string) { return JSON.parse(await readFile(file, "utf8")); }
const accepted = (response: ServerResponse) => { response.writeHead(200); response.end("{}"); };

describe("durable OTLP outbox over actual HTTP", () => {
  it("keeps a 503 pending on disk, retries, and compacts the confirmed payload", async () => {
    let healthy = false;
    const target = await collector((response) => healthy ? accepted(response) : (response.writeHead(503), response.end()));
    const { box, file } = await setup(target.endpoint); const id = randomUUID();
    await box.enqueue(id, spans(id));
    await expect.poll(async () => (await record(file(id))).attempts).toBeGreaterThanOrEqual(1);
    const pending = await record(file(id)); expect(pending.state).toBe("pending"); expect(pending.batches.length).toBe(1);
    healthy = true;
    await expect.poll(async () => (await record(file(id))).state).toBe("delivered");
    expect((await record(file(id))).batches).toEqual([]);
    expect(target.requests[0]!.body).toBe(target.requests.at(-1)!.body);
    const count = target.requests.length; await box.enqueue(id, spans(id));
    await box.shutdown();
    expect(target.requests.length).toBe(count);
  });

  it("times out without discarding the payload, then retries the identical batch", async () => {
    const target = await collector((response, n) => { if (n > 1) accepted(response); });
    const { box, file } = await setup(target.endpoint); const id = randomUUID();
    await box.enqueue(id, spans(id));
    await expect.poll(async () => (await record(file(id))).state).toBe("delivered");
    expect(target.requests.length).toBeGreaterThanOrEqual(2);
    expect(target.requests[0]!.body).toBe(target.requests[1]!.body);
  });

  it("resumes only unconfirmed batches after reopening the same directory", async () => {
    let healthy = false;
    const target = await collector((response, n) => n === 1 || healthy ? accepted(response) : (response.writeHead(503), response.end()));
    const { box, file, config } = await setup(target.endpoint, { OTEL_EXPORTER_OTLP_MAX_BATCH_BYTES: "64000" });
    const id = randomUUID(); await box.enqueue(id, spans(id, 500));
    await expect.poll(async () => (await record(file(id))).attempts).toBeGreaterThanOrEqual(1);
    const pending = await record(file(id)); expect(pending.nextBatch).toBe(1); expect(pending.batches.length).toBeGreaterThan(1);
    await box.shutdown(); healthy = true;
    const count = target.requests.length;
    const resumed = new OtlpOutbox(config); boxes.push(resumed); await resumed.initialize(); resumed.start();
    await expect.poll(async () => (await record(file(id))).state).toBe("delivered");
    const acknowledgedBody = target.requests[0]!.body;
    expect(target.requests.slice(count).some((request) => request.body === acknowledgedBody)).toBe(false);
    await resumed.shutdown();
    const done = new OtlpOutbox(config); boxes.push(done); await done.initialize(); done.start();
    expect(done.has(id)).toBe(true); await done.enqueue(id, spans(id)); await done.shutdown();
    expect(target.requests.filter((request) => request.body === acknowledgedBody)).toHaveLength(1);
  });

  it("does not retry populated partial success and records rejected spans separately", async () => {
    const target = await collector((response, n) => {
      response.writeHead(200); response.end('{"partialSuccess":{"rejectedSpans":"1"}}');
    });
    const { box, file, config } = await setup(target.endpoint); const id = randomUUID(); await box.enqueue(id, spans(id, 2));
    await expect.poll(async () => (await record(file(id))).state).toBe("partial");
    expect((await record(file(id))).acceptedSpans).toBe(1); expect((await record(file(id))).rejectedSpans).toBe(1);
    expect(box.status().delivered).toBe(0); expect(box.status().partial).toBe(1);
    await box.shutdown(); const resumed = new OtlpOutbox(config); boxes.push(resumed);
    await resumed.initialize(); resumed.start(); await wait(350); expect(target.requests.length).toBe(1);
  });

  it("treats a zero-rejection partial-success warning as accepted without retry", async () => {
    const target = await collector((response) => {
      response.writeHead(200); response.end('{"partialSuccess":{"rejectedSpans":"0","errorMessage":"warning"}}');
    });
    const { box, file } = await setup(target.endpoint); const id = randomUUID(); await box.enqueue(id, spans(id));
    await expect.poll(async () => (await record(file(id))).state).toBe("delivered"); await wait(350);
    expect(target.requests.length).toBe(1); expect(box.status().warningBatches).toBe(1); expect(box.status().rejectedSpans).toBe(0);
  });

  it("continues later batches once and preserves partial loss in the final outcome", async () => {
    const target = await collector((response, n) => {
      response.writeHead(200); response.end(n === 1 ? '{"partialSuccess":{"rejectedSpans":"1"}}' : "{}");
    });
    const { box, file } = await setup(target.endpoint, { OTEL_EXPORTER_OTLP_MAX_BATCH_BYTES: "64000" });
    const id = randomUUID(); await box.enqueue(id, spans(id, 500));
    await expect.poll(async () => (await record(file(id))).state).toBe("partial");
    const final = await record(file(id)); expect(final.acceptedSpans).toBe(499); expect(final.rejectedSpans).toBe(1);
    expect(target.requests.length).toBeGreaterThan(1);
    expect(new Set(target.requests.map((request) => request.body)).size).toBe(target.requests.length);
  });

  it.each([400, 401, 403, 408, 413, 500])("never retries HTTP %s or loses the terminal rejection after restart", async (code) => {
    const target = await collector((response) => { response.writeHead(code); response.end(); });
    const { box, file, config } = await setup(target.endpoint); const id = randomUUID(); await box.enqueue(id, spans(id));
    await expect.poll(async () => (await record(file(id))).state).toBe("rejected");
    expect(box.status().rejectedSpans).toBe(1); expect(box.status().delivered).toBe(0);
    await box.shutdown(); const resumed = new OtlpOutbox(config); boxes.push(resumed);
    await resumed.initialize(); resumed.start(); await wait(350); expect(target.requests.length).toBe(1);
  });

  it.each([429, 502, 503, 504])("retries HTTP %s until accepted", async (code) => {
    const target = await collector((response, n) => n === 1 ? (response.writeHead(code), response.end()) : accepted(response));
    const { box, file } = await setup(target.endpoint); const id = randomUUID(); await box.enqueue(id, spans(id));
    await expect.poll(async () => (await record(file(id))).state).toBe("delivered"); expect(target.requests.length).toBe(2);
  });

  it("bounds response bytes and records unknown acceptance without resending", async () => {
    const target = await collector((response) => { response.writeHead(200); response.end("x".repeat(2048)); });
    const { box, file } = await setup(target.endpoint, { OTEL_EXPORTER_OTLP_MAX_RESPONSE_BYTES: "1024" });
    const id = randomUUID(); await box.enqueue(id, spans(id));
    await expect.poll(async () => (await record(file(id))).state).toBe("uncertain"); await wait(350);
    expect(target.requests.length).toBe(1); expect(box.status().uncertainSpans).toBe(1);
  });

  it.each([201, 204])("records unexpected HTTP %s acceptance as uncertain without retry", async (code) => {
    const target = await collector((response) => { response.writeHead(code); response.end(); });
    const { box, file } = await setup(target.endpoint); const id = randomUUID(); await box.enqueue(id, spans(id));
    await expect.poll(async () => (await record(file(id))).state).toBe("uncertain"); await wait(350);
    expect(target.requests.length).toBe(1); expect(box.status().delivered).toBe(0);
  });

  it("honors Retry-After and shutdown aborts a hanging request promptly", async () => {
    const target = await collector((response) => { response.writeHead(503, { "retry-after": "2" }); response.end(); });
    const { box, file } = await setup(target.endpoint); const id = randomUUID(); await box.enqueue(id, spans(id));
    await expect.poll(async () => (await record(file(id))).attempts).toBe(1);
    expect((await record(file(id))).nextAttemptAt - Date.now()).toBeGreaterThan(1500);
    await box.shutdown();
    const hanging = await collector(() => {});
    const second = await setup(hanging.endpoint, { OTEL_EXPORTER_OTLP_TIMEOUT: "5000" });
    const id2 = randomUUID(); await second.box.enqueue(id2, spans(id2));
    await expect.poll(() => hanging.requests.length).toBe(1);
    const started = performance.now(); await second.box.shutdown();
    expect(performance.now() - started).toBeLessThan(1000);
    expect((await record(second.file(id2))).state).toBe("pending");
  });

  it("never persists collector credentials and redacts payload content before queuing", async () => {
    const secret = "outbox-header-secret-20261009";
    const target = await collector((response) => { response.writeHead(503); response.end(); });
    const { box, file } = await setup(target.endpoint, { OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer " + secret });
    const id = randomUUID(), trace = spans(id); trace[0]!.attributes.command = "echo Bearer " + secret;
    await box.enqueue(id, trace);
    await expect.poll(() => target.requests.length).toBeGreaterThanOrEqual(1);
    expect(await readFile(file(id), "utf8")).not.toContain(secret);
    expect(target.requests[0]!.headers.authorization).toBe("Bearer " + secret);
    expect(target.requests[0]!.body).not.toContain(secret);
  });

  it("pins a queued payload to its original destination after configuration changes", async () => {
    const first = await collector((response) => { response.writeHead(503); response.end(); });
    const { box, config, file } = await setup(first.endpoint); const id = randomUUID(); await box.enqueue(id, spans(id));
    await expect.poll(() => first.requests.length).toBe(1); await box.shutdown();
    const other = await collector(accepted);
    const changed = new OtlpOutbox({ ...config, otlpEndpoint: other.endpoint }); boxes.push(changed);
    await changed.initialize(); changed.start(); await changed.enqueue(id, spans(id)); await changed.shutdown();
    expect(other.requests).toHaveLength(0); expect((await record(file(id))).state).toBe("pending");
  });

  it("measures UTF-8 batches within the configured limit", async () => {
    const target = await collector(accepted);
    const { box, file } = await setup(target.endpoint, { OTEL_EXPORTER_OTLP_MAX_BATCH_BYTES: "64000" });
    const id = randomUUID(), trace = spans(id, 80);
    for (const span of trace) span.attributes.command = "中文命令".repeat(80);
    await box.enqueue(id, trace);
    await expect.poll(async () => (await record(file(id))).state).toBe("delivered");
    expect(target.requests.length).toBeGreaterThan(1);
    expect(target.requests.every((request) => Buffer.byteLength(request.body) <= 64000)).toBe(true);
    const ids = target.requests.flatMap((request) => JSON.parse(request.body).resourceSpans[0].scopeSpans[0].spans.map((span: { spanId: string }) => span.spanId));
    expect(new Set(ids).size).toBe(80);
  });

  it("purges deleted runs including a request already in flight", async () => {
    const target = await collector(() => {});
    const { box, file } = await setup(target.endpoint, { OTEL_EXPORTER_OTLP_TIMEOUT: "5000" });
    const id = randomUUID(); await box.enqueue(id, spans(id)); await expect.poll(() => target.requests.length).toBe(1);
    await box.forget([id]); await box.shutdown();
    await expect(readFile(file(id))).rejects.toMatchObject({ code: "ENOENT" }); expect(box.has(id)).toBe(false);
  });

  it("serializes concurrent duplicate enqueue calls into one durable payload", async () => {
    const target = await collector(accepted); const { box, file } = await setup(target.endpoint);
    const id = randomUUID(), trace = spans(id);
    await Promise.all(Array.from({ length: 20 }, () => box.enqueue(id, trace)));
    await expect.poll(async () => (await record(file(id))).state).toBe("delivered");
    expect(target.requests.length).toBe(1);
  });

  it.each(["initialization", "live worker"])("isolates malformed inner payloads during %s and continues the next Run", async (phase) => {
    const target = await collector(accepted), { box, config, file } = await setup(target.endpoint);
    await box.shutdown(); // Prepare disk without a sender.
    const badId = randomUUID(), goodId = randomUUID(); await box.enqueue(badId, spans(badId)); await box.enqueue(goodId, spans(goodId));
    const original = await record(file(badId)); original.nextAttemptAt = 0;
    await writeFile(file(badId), JSON.stringify(original));
    const poison = { ...original, batches: ["{bad json}"] };
    if (phase === "initialization") await writeFile(file(badId), JSON.stringify(poison));
    const resumed = new OtlpOutbox(config); boxes.push(resumed); await resumed.initialize();
    if (phase === "live worker") await writeFile(file(badId), JSON.stringify(poison));
    resumed.start();
    await expect.poll(async () => (await record(file(goodId))).state).toBe("delivered");
    await expect.poll(() => resumed.status().quarantinedRecords).toBe(1);
    expect(target.requests.length).toBe(1); expect(resumed.has(badId)).toBe(false);
    expect(resumed.status().quarantinedRecords).toBe(1);
    expect((await readdir(path.dirname(file(badId)))).some((name) => name.startsWith(badId + ".json.corrupt."))).toBe(true);
  });

  it("removes every deleted Run from scheduling even if deleting the first file fails", async () => {
    const target = await collector((response, n) => { if (n > 1) accepted(response); }), { box, file } = await setup(target.endpoint, { OTEL_EXPORTER_OTLP_TIMEOUT: "5000" });
    const first = randomUUID(), second = randomUUID(), third = randomUUID();
    await box.enqueue(first, spans(first)); await box.enqueue(second, spans(second)); await box.enqueue(third, spans(third));
    await expect.poll(() => target.requests.length).toBe(1);
    await rm(file(first)); await mkdir(file(first)); // Force unlink failure on Windows and POSIX.
    await expect(box.forget([first, second])).rejects.toThrow(first);
    expect(box.has(first)).toBe(false); expect(box.has(second)).toBe(false);
    await expect(readFile(file(second))).rejects.toMatchObject({ code: "ENOENT" });
    // The surviving third Run proves the deleted hanging request was aborted,
    // rather than occupying the sender until its five-second timeout.
    await expect.poll(async () => (await record(file(third))).state).toBe("delivered");
    expect(target.requests.length).toBe(2);
    expect(target.requests[1]!.body).toContain(third);
  });

  it.each(["forget", "shutdown"])("does not send after %s occurs during a pending disk read", async (action) => {
    const target = await collector(accepted), { box } = await setup(target.endpoint), id = randomUUID();
    const internals = box as unknown as { read: (runId: string) => Promise<unknown>; worker: Promise<void> | null };
    const original = internals.read.bind(box);
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => entered = resolve), blocked = new Promise<void>((resolve) => release = resolve);
    internals.read = async (runId) => { const value = await original(runId); entered(); await blocked; return value; };
    await box.enqueue(id, spans(id)); await reading;
    if (action === "forget") { await box.forget([id]); release(); await internals.worker; }
    else { const stopping = box.shutdown(); release(); await stopping; }
    expect(target.requests.length).toBe(0);
  });

  it("retains the original payload if acknowledgment persistence fails after acceptance", async () => {
    const target = await collector(accepted); const { box, file } = await setup(target.endpoint);
    const internals = box as unknown as { write: (record: { state: string }) => Promise<void> };
    const original = internals.write.bind(box); let fail = true;
    internals.write = async (value) => {
      if (value.state === "delivered" && fail) throw new Error("simulated ack disk failure");
      await original(value);
    };
    const id = randomUUID(); await box.enqueue(id, spans(id));
    await expect.poll(() => box.runStatus(id, false, true).checkpointPending).toBe(true);
    expect(box.runStatus(id, false, true)).toMatchObject({ state: "delivered", acceptedSpans: 1,
      pendingBatches: 0, checkpointPending: true });
    expect((await record(file(id))).state).toBe("pending");
    fail = false;
    await expect.poll(async () => (await record(file(id))).state).toBe("delivered");
    expect(box.runStatus(id, false, true).checkpointPending).toBe(false);
    expect(target.requests.length).toBe(1);
  });

  it("keeps a successfully executed Run completed while the collector hangs", async () => {
    const target = await collector(() => {});
    const { config } = await setup(target.endpoint, { OTEL_EXPORTER_OTLP_TIMEOUT: "5000" });
    const runner: AgentRunner = { run: async () => ({ output: "ok", threadId: "test", usage: {} }),
      cancel: async () => false, isAvailable: async () => true };
    const service = new AgentService({ ...config, arkApiKey: "test", arkModel: "test" },
      new JsonStore(path.join(config.dataDirectory, "launchpad.json")), new WorkspaceManager(config.workspaceRoot), runner);
    services.push(service); await service.initialize(); const agent = await service.createAgent({ name: "Outbox" });
    const started = performance.now(), { run } = await service.sendMessage(agent.id, "write hello");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(service.getMessages(agent.id).at(-1)!.content).toBe("ok");
  });

  it("recovers a final local trace whose queue publication was interrupted", async () => {
    const target = await collector(accepted); const { config } = await setup(target.endpoint);
    const runner: AgentRunner = { run: async () => ({ output: "ok", threadId: "test", usage: {} }),
      cancel: async () => false, isAvailable: async () => true };
    const disabled = { ...config, otlpEndpoint: "", arkApiKey: "test", arkModel: "test" };
    const make = (cfg: typeof config) => new AgentService(cfg, new JsonStore(path.join(config.dataDirectory, "launchpad.json")), new WorkspaceManager(config.workspaceRoot), runner);
    const first = make(disabled); services.push(first); await first.initialize();
    const agent = await first.createAgent({ name: "Recovery" }), { run } = await first.sendMessage(agent.id, "write hello");
    await expect.poll(() => first.getRun(run.id).status).toBe("completed"); await first.shutdown();
    const resumed = make(config); services.push(resumed); await resumed.initialize();
    await expect.poll(() => target.requests.length).toBe(1);
    expect(JSON.parse(target.requests[0]!.body).resourceSpans[0].resource.attributes.find((item: { key: string }) => item.key === "launchpad.run.id").value.stringValue).toBe(run.id);
  });
});
