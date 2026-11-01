// Controlled cleanup failure against real temporary files and the HTTP/UI app.
// This instance alone injects EACCES during workspace archive. The next manual
// DELETE lifts the injection; automatic retries cannot finish it beforehand.
// It changes no OS permissions, production data, credentials or model state.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { AgentService } from "../apps/server/dist/agent-service.js";
import { createApp } from "../apps/server/dist/app.js";
import { loadConfig } from "../apps/server/dist/config.js";
import { JsonStore } from "../apps/server/dist/store.js";
import { WorkspaceManager } from "../apps/server/dist/workspace.js";

const base = path.resolve(tmpdir());
const root = await mkdtemp(path.join(base, "launchpad-cleanup-demo-"));
const config = loadConfig({ HOST: "127.0.0.1", NODE_ENV: "production", LOG_LEVEL: "silent",
  RUNTIME_PROVIDER: "replay", APP_DATA_DIR: path.join(root, "data"),
  AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"),
  APP_AUTH_TOKEN: "", ARK_API_KEY: "", OTEL_EXPORTER_OTLP_ENDPOINT: "" });
const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = { isAvailable: async () => true, cancel: async () => false,
  run: async () => { throw new Error("This cleanup demo never runs a model"); } };
const service = new AgentService(config, store, workspaces, runner);
let app, fixtureId, blocked = true, deleteRequests = 0;
const archive = workspaces.archive.bind(workspaces);
workspaces.archive = async (agent, ...args) => {
  if (blocked && agent.id === fixtureId) {
    throw Object.assign(new Error("Controlled cleanup-demo failure"), { code: "EACCES" });
  }
  return archive(agent, ...args);
};
const deletion = service.deleteAgent.bind(service);
service.deleteAgent = async (id) => {
  if (id === fixtureId && ++deleteRequests > 1) blocked = false;
  const result = await deletion(id);
  console.log(JSON.stringify({ event: "demo-delete", request: deleteRequests,
    cleanupPending: result.cleanupPending, archiveExists: result.archivedWorkspace !== null }));
  return result;
};
const input = createInterface({ input: process.stdin });
let finish;
const finished = new Promise((resolve) => { finish = resolve; });
const stop = () => finish();
process.once("SIGINT", stop); process.once("SIGTERM", stop); input.once("close", stop);
try {
  await service.initialize();
  const fixture = await service.createAgent({ name: "Cleanup recovery demo",
    description: "Disposable local fixture: controlled EACCES, then manual retry." });
  fixtureId = fixture.id;
  app = await createApp(config, service);
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  console.log(JSON.stringify({ event: "demo-ready", url, agentId: fixtureId }));
  console.log("Open the URL. Delete the demo Agent to see pending cleanup. Reload to recover its status, then click Retry cleanup.");
  console.log("The first deletion and background archive attempts inject EACCES; the next manual retry removes that injection and archives real files. No OS permissions change. Enter delete to prepare pending state through HTTP, or quit to stop.");
  let commandInFlight = false;
  input.on("line", async (line) => {
    if (line.trim() === "quit") { finish(); return; }
    if (line.trim() !== "delete" || commandInFlight || deleteRequests > 0) return;
    commandInFlight = true;
    try {
      const response = await fetch(url + "/api/agents/" + fixtureId, { method: "DELETE" });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).cleanupPending, true);
      console.log("Pending state prepared through the real DELETE endpoint. Reload the browser and click Retry cleanup.");
    } catch (error) {
      console.error("Demo deletion failed:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1; finish();
    } finally { commandInFlight = false; }
  });
  await finished;
} finally {
  input.close(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  await service.shutdown(); if (app) await app.close();
  const absolute = path.resolve(root), relative = path.relative(base, absolute);
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    && path.basename(absolute).startsWith("launchpad-cleanup-demo-"), "unsafe demo cleanup target");
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
