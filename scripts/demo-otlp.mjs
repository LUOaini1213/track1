// A local, zero-key demonstration of delivery independently from Run execution.
// Build first. Commands change only this loopback collector's response behavior.
import { createInterface } from "node:readline";
import { agent, collector, removeRoot, run, start, temporaryRoot } from "./otlp-test-support.mjs";

const modes = ["503", "success", "partial", "rejected", "uncertain", "disabled"];
let mode = process.argv[2] ?? "503";
if (!modes.includes(mode)) throw new Error("Mode must be " + modes.join(", "));
const exportDisabled = mode === "disabled";
const root = await temporaryRoot();
const target = await collector((response) => {
  response.writeHead(mode === "503" ? 503 : mode === "rejected" ? 400 : 200);
  response.end(mode === "partial" ? '{"partialSuccess":{"rejectedSpans":"1"}}' : mode === "uncertain" ? "invalid JSON" : "{}");
});
let server;
const input = createInterface({ input: process.stdin });
const done = new Promise((resolve) => {
  input.on("line", (line) => {
    const next = line.trim();
    if (next === "quit") { resolve(); return; }
    if (exportDisabled) { console.log("Export is disabled for this demo. Restart with 503 or success to enable it."); return; }
    if (!modes.includes(next) || next === "disabled") {
      console.log("Enter 503, success, partial, rejected, uncertain or quit. Disabled is selected only at startup."); return;
    }
    mode = next; console.log("Collector mode: " + mode + ". Send another Run in the browser to see a new outcome.");
  });
  input.on("close", resolve);
  process.once("SIGINT", resolve); process.once("SIGTERM", resolve);
});
try {
  server = await start(root, { OTEL_EXPORTER_OTLP_ENDPOINT: mode === "disabled" ? "" : target.endpoint,
    OTEL_EXPORTER_OTLP_RETRY_INITIAL_MS: "1000", OTEL_EXPORTER_OTLP_RETRY_MAX_MS: "2000" });
  const id = await agent(server); await run(server, id);
  console.log("Open " + server.url + ". Collector mode: " + mode + ".");
  console.log(exportDisabled ? "The first Run is complete; OTLP is off. Enter quit to stop."
    : "The first Run is complete. Enter success to deliver pending traces, or partial/rejected/uncertain and send another Run.");
  await done;
} finally {
  input.close(); if (server) await server.stop(); await target.close(); await removeRoot(root);
}
