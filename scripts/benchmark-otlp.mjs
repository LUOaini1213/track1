#!/usr/bin/env node
// End-to-end replay HTTP latency and local persistence overhead on this host.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { SpanStore } from "../apps/server/dist/span-store.js";
import { OtlpOutbox } from "../apps/server/dist/otlp-outbox.js";
import { loadConfig } from "../apps/server/dist/config.js";
import { createHash, randomUUID } from "node:crypto";
import { agent, collector, removeRoot, repo, run, start, temporaryRoot } from "./otlp-test-support.mjs";

const samples = Number(process.env.OTLP_BENCHMARK_SAMPLES ?? 40);
assert(Number.isInteger(samples) && samples % 2 === 0 && samples >= 20 && samples <= 200);
const target = await collector((response) => { response.writeHead(503); response.end(); });
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b), percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1];
  return { samples: sorted.length, medianMs: +percentile(0.5).toFixed(3), p95Ms: +percentile(0.95).toFixed(3),
    meanMs: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3) };
};
const http = { disabled: [], durable503: [] }, local = { spanOnly: [], spanAndOutbox: [] };
let pending = 0;
try {
  // Alternate order across four independent blocks to reduce warmup/order bias.
  for (const mode of ["disabled", "durable503", "durable503", "disabled"]) {
    const root = await temporaryRoot(); let service;
    try {
      service = await start(root, mode === "disabled" ? {} : { OTEL_EXPORTER_OTLP_ENDPOINT: target.endpoint, OTEL_EXPORTER_OTLP_RETRY_INITIAL_MS: "1000" });
      const id = await agent(service);
      await run(service, id); await run(service, id); // Warmup excluded in both arms.
      for (let i = 0; i < samples / 2; i++) http[mode].push((await run(service, id)).durationMs);
      if (mode === "durable503") {
        const status = (await service.request("/api/system")).otlpDelivery;
        assert.equal(status.pending, samples / 2 + 2); pending += status.pending;
      }
    } finally { if (service) await service.stop(); await removeRoot(root); }
  }
  const root = await temporaryRoot();
  try {
    const config = loadConfig({ APP_DATA_DIR: path.join(root, "data"), OTEL_EXPORTER_OTLP_ENDPOINT: target.endpoint,
      OTEL_EXPORTER_OTLP_RETRY_INITIAL_MS: "60000", LOG_LEVEL: "silent" });
    const store = new SpanStore(path.join(config.dataDirectory, "spans")); await store.initialize();
    const outbox = new OtlpOutbox(config); await outbox.initialize(); await outbox.shutdown(); // Only durable enqueue cost, no network.
    for (let i = 0; i < samples + 4; i++) {
      const values = Array.from({ length: 100 }, (_, index) => ({ traceId: randomUUID(), spanId: randomUUID(), parentSpanId: null,
        runId: randomUUID(), agentId: randomUUID(), name: "execute_tool shell", kind: "tool", status: "ok",
        startedAt: "2026-10-09T00:00:00.000Z", endedAt: "2026-10-09T00:00:01.000Z", durationMs: 1000,
        attributes: { command: "synthetic benchmark command " + index, exitCode: 0 } }));
      for (const mode of i % 2 ? ["spanAndOutbox", "spanOnly"] : ["spanOnly", "spanAndOutbox"]) {
        const id = randomUUID(), started = performance.now(); await store.write(id, values);
        if (mode === "spanAndOutbox") await outbox.enqueue(id, values);
        if (i >= 4) local[mode].push(performance.now() - started);
      }
    }
    await outbox.shutdown();
  } finally { await removeRoot(root); }
  const sourceFiles = ["apps/server/src/otlp-outbox.ts", "apps/server/src/otlp.ts", "apps/server/src/config.ts", "apps/server/src/agent-service.ts",
    "apps/server/src/span-store.ts", "scripts/benchmark-otlp.mjs", "scripts/otlp-test-support.mjs", "package-lock.json"];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, createHash("sha256").update((await readFile(path.join(repo, file), "utf8")).replace(/\r\n/g, "\n")).digest("hex")])));
  const result = { measuredAt: new Date().toISOString(), sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    sourceHashes, sourceHashNormalization: "UTF-8 text with CRLF normalized to LF", runtime: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model, http: Object.fromEntries(Object.entries(http).map(([name, values]) => [name, stats(values)])),
    localPersistence100Spans: Object.fromEntries(Object.entries(local).map(([name, values]) => [name, stats(values)])),
    queuedDuringCollector503: pending, allRunsCompleted: true,
    methodology: "Built replay server, actual loopback HTTP, 4 order-balanced blocks, 2 excluded warmups/block; local 100-span writes alternate order, 4 excluded warmups. Local durability arm fsyncs the outbox. Shared Windows host; no model or cloud benchmark." };
  const out = path.resolve(process.argv[2] ?? path.join(repo, "docs/evidence/otlp-benchmark.json"));
  await mkdir(path.dirname(out), { recursive: true }); await writeFile(out, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally { await target.close(); }
