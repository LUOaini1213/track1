#!/usr/bin/env node
// Keeps the measured numbers in the docs tied to the committed evidence.
//
// Fails when:
//   - a number quoted in README.md or docs/OTLP_DELIVERY.md differs from
//     docs/evidence/otlp-benchmark.json or otlp-recovery.json;
//   - a source file hashed in the benchmark record has changed since it was
//     measured (re-run `npm run build && npm run benchmark:otlp`, or move the
//     record to a historical file and say so in the docs);
//   - the fault modes the README claims are not the ones the CI recovery smoke
//     test (`scripts/verify-otlp-recovery.mjs`) actually exercises;
//   - a relative link in a tracked Markdown file points at a missing file.
//
// Usage: node scripts/check-evidence.mjs [repo-root]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url)));
const problems = [];
const fail = (message) => problems.push(message);
const read = (relative) => readFileSync(path.join(repo, relative), "utf8").replace(/\r\n/g, "\n");
const flat = (text) => text.replace(/\s+/g, " ");

const bench = JSON.parse(read("docs/evidence/otlp-benchmark.json"));
const recovery = JSON.parse(read("docs/evidence/otlp-recovery.json"));
const readme = read("README.md");
const delivery = read("docs/OTLP_DELIVERY.md");

// 1. The benchmark describes the current sources.
for (const [file, expected] of Object.entries(bench.sourceHashes)) {
  if (!existsSync(path.join(repo, file))) {
    fail(`benchmark source ${file} no longer exists`);
    continue;
  }
  const actual = createHash("sha256").update(read(file)).digest("hex");
  if (actual !== expected) {
    fail(`${file} changed since the benchmark was measured at ${bench.sourceCommit.slice(0, 7)}; ` +
      "re-run `npm run build && npm run benchmark:otlp` or retire the record");
  }
}
const { disabled, durable503 } = bench.http;
const { spanOnly, spanAndOutbox } = bench.localPersistence100Spans;
const samples = disabled.samples;
for (const arm of [durable503, spanOnly, spanAndOutbox]) {
  if (arm.samples !== samples) fail("benchmark arms have different sample counts");
}
if (bench.allRunsCompleted !== true) fail("benchmark record does not say all Runs completed");

// 2. docs/OTLP_DELIVERY.md quotes the record exactly.
const row = (label) => delivery.split("\n").find((line) => line.startsWith("| " + label));
const expectRow = (label, values) => {
  const line = row(label);
  if (!line) return fail(`docs/OTLP_DELIVERY.md: table row "${label}" not found`);
  const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean).slice(1);
  if (JSON.stringify(cells) !== JSON.stringify(values)) {
    fail(`docs/OTLP_DELIVERY.md: row "${label}" is ${JSON.stringify(cells)}, evidence says ${JSON.stringify(values)}`);
  }
};
expectRow("Replay HTTP Run completion", [`${disabled.p95Ms} ms`, `${durable503.p95Ms} ms`, String(samples)]);
expectRow("Local persistence of 100 spans", [`${spanOnly.p95Ms} ms`, `${spanAndOutbox.p95Ms} ms`, String(samples)]);
const deliveryText = flat(delivery);
const measuredLine = deliveryText.match(/Measured on (\S+) with Node (\S+?),.*? at source `([0-9a-f]{40})`/);
if (!measuredLine) {
  fail("docs/OTLP_DELIVERY.md: 'Measured on <date> with Node <version>, ... at source `<sha>`' not found");
} else {
  const [, date, node, commit] = measuredLine;
  if (date !== bench.measuredAt.slice(0, 10)) fail(`docs/OTLP_DELIVERY.md: date ${date} != ${bench.measuredAt.slice(0, 10)}`);
  if ("v" + node !== bench.runtime) fail(`docs/OTLP_DELIVERY.md: Node ${node} != ${bench.runtime}`);
  if (commit !== bench.sourceCommit) fail(`docs/OTLP_DELIVERY.md: source ${commit} != ${bench.sourceCommit}`);
}
if (!deliveryText.includes(`All ${samples} measured durable-arm Runs completed`)) {
  fail("docs/OTLP_DELIVERY.md: completed-Run count does not match the evidence");
}
if (!deliveryText.includes(`Including excluded warmups, ${bench.queuedDuringCollector503} pending Runs`)) {
  fail("docs/OTLP_DELIVERY.md: pending-Run count does not match the evidence");
}

// 3. The README's results lines.
const readmeText = flat(readme);
const cost = readmeText.match(/persisting 100 spans takes ([\d.]+) ms at p95 without the outbox and ([\d.]+) ms with it, (\d+) samples per arm/);
if (!cost) {
  fail("README.md: the 100-span persistence result line was not found");
} else {
  const want = [spanOnly.p95Ms.toFixed(1), spanAndOutbox.p95Ms.toFixed(1), String(samples)];
  if (JSON.stringify(cost.slice(1)) !== JSON.stringify(want)) {
    fail(`README.md: persistence result ${JSON.stringify(cost.slice(1))}, evidence says ${JSON.stringify(want)}`);
  }
  if (/Windows/.test(cost.input.slice(cost.index, cost.index + 300)) !== bench.platform.startsWith("win32")) {
    fail(`README.md: the platform named next to the result does not match ${bench.platform}`);
  }
}
if (recovery.result !== "PASS") fail("otlp-recovery.json does not record PASS");
const verifier = read("scripts/verify-otlp-recovery.mjs");
for (const mode of recovery.faultModes) {
  if (!readmeText.includes(mode)) fail(`README.md does not name recovery fault mode "${mode}"`);
  if (!verifier.includes(JSON.stringify(mode))) fail(`verify-otlp-recovery.mjs does not exercise "${mode}"`);
}
for (const flag of ["acknowledgedRunNotResent", "restoredPayloadsByteIdentical"]) {
  if (recovery[flag] !== true) fail(`otlp-recovery.json: ${flag} is not true`);
}

// 4. Relative links in the tracked Markdown resolve.
const markdown = ["README.md", "SECURITY.md", "CONTRIBUTING.md",
  ...readdirSync(path.join(repo, "docs")).filter((name) => name.endsWith(".md")).map((name) => "docs/" + name)];
for (const file of markdown) {
  if (!existsSync(path.join(repo, file))) continue;
  for (const [, target] of read(file).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    if (/^(?:[a-z]+:|#)/i.test(target)) continue;
    const resolved = path.join(repo, path.dirname(file), decodeURIComponent(target.split("#")[0]));
    if (!existsSync(resolved)) fail(`${file}: link target ${target} does not exist`);
  }
}

if (problems.length) {
  console.error("check-evidence: " + problems.length + " problem(s)\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log(`check-evidence: OK (benchmark at ${bench.sourceCommit.slice(0, 7)} matches ${Object.keys(bench.sourceHashes).length} sources; ` +
  `docs and README numbers match; ${markdown.length} Markdown files' links resolve)`);
