#!/usr/bin/env node
// Real built server processes, actual loopback HTTP, no model or collector service.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { agent, collector, removeRoot, run, start, temporaryRoot, until, wait } from "./otlp-test-support.mjs";

const root = await temporaryRoot(); let service; let mode = "503";
const target = await collector((response) => {
  if (mode === "hang") return;
  response.writeHead(mode === "503" ? 503 : 200); response.end(mode === "503" ? "" : "{}");
});
const config = { OTEL_EXPORTER_OTLP_ENDPOINT: target.endpoint };
const queued = async (id) => JSON.parse(await readFile(path.join(root, "data/otlp-outbox", id + ".json"), "utf8"));
try {
  service = await start(root, config); const id = await agent(service);
  const first = await run(service, id);
  await until(async () => (await queued(first.runId)).attempts >= 1, "503 saved retry");
  assert.equal((await queued(first.runId)).state, "pending");
  const original = target.requests[0].body; await service.stop(true); // No shutdown handlers.
  mode = "ok"; const count = target.requests.length; service = await start(root, config);
  await until(async () => (await queued(first.runId)).state === "delivered", "restart replay after 503");
  assert(target.requests.slice(count).some((item) => item.body === original));
  const confirmed = target.requests.length; await service.stop(true); service = await start(root, config);
  await wait(350); assert.equal(target.requests.length, confirmed, "acknowledged run was resent after restart");
  mode = "hang"; const second = await run(service, id);
  await until(async () => (await queued(second.runId)).attempts >= 1, "timeout saved retry");
  assert.equal((await queued(second.runId)).state, "pending");
  const secondBody = target.requests.find((item) => JSON.parse(item.body).resourceSpans[0].resource.attributes.some((a) => a.key === "launchpad.run.id" && a.value.stringValue === second.runId)).body;
  await service.stop(true); mode = "ok"; const timeoutCount = target.requests.length; service = await start(root, config);
  await until(async () => (await queued(second.runId)).state === "delivered", "restart replay after timeout");
  assert(target.requests.slice(timeoutCount).some((item) => item.body === secondBody));
  // rename makes the checkpoint visible before directory fsync and the live
  // summary publication complete. Observe both boundaries, rather than assuming
  // a visible file means the status API has already published its acknowledgment.
  await until(async () => {
    const delivery = (await service.request("/api/system")).otlpDelivery;
    return delivery.pending === 0 && delivery.delivered === 2;
  }, "durable acknowledgments published to status API");
  for (const runId of [first.runId, second.runId]) {
    const delivery = (await service.request(`/api/runs/${runId}/delivery`)).delivery;
    assert.equal(delivery.state, "delivered"); assert.equal(delivery.checkpointPending, false);
    assert(delivery.acceptedSpans > 0);
  }
  const status = (await service.request("/api/system")).otlpDelivery;
  assert.equal(status.pending, 0); assert.equal(status.delivered, 2);
  console.log(JSON.stringify({ result: "PASS", faultModes: ["HTTP 503", "HTTP timeout", "SIGKILL restart"],
    acknowledgedRunNotResent: true, restoredPayloadsByteIdentical: true, perRunAcknowledgmentsPublished: true,
    terminalRuns: 2, collectorRequests: target.requests.length,
    delivery: status, runtime: process.version, platform: process.platform }));
} finally { if (service) await service.stop(true); await target.close(); await removeRoot(root); }
