import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repo = fileURLToPath(new URL("../", import.meta.url));
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check, description, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch {}
    await wait(10);
  }
  throw new Error("Timed out: " + description);
}
export async function temporaryRoot() { return mkdtemp(path.join(tmpdir(), "launchpad-otlp-")); }
export async function removeRoot(root) {
  const absolute = path.resolve(root), relative = path.relative(path.resolve(tmpdir()), absolute);
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(absolute).startsWith("launchpad-otlp-"), "unsafe cleanup target");
  await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
async function freePort() {
  const server = createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
export async function collector(handler) {
  const requests = [], server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const item = { body, receivedAt: Date.now(), url: request.url };
    requests.push(item); handler(response, item, requests.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, endpoint: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
export async function start(root, extra = {}) {
  const port = await freePort(), child = spawn(process.execPath, ["dist/replay-dev.js"], {
    cwd: path.join(repo, "apps/server"), env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "production", LOG_LEVEL: "silent",
      APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"),
      APP_AUTH_TOKEN: "", ARK_API_KEY: "", ARK_MODEL: "", OTEL_EXPORTER_OTLP_ENDPOINT: "", OTEL_EXPORTER_OTLP_HEADERS: "",
      REPLAY_SPEED: "1000", OTEL_EXPORTER_OTLP_TIMEOUT: "500", OTEL_EXPORTER_OTLP_RETRY_INITIAL_MS: "100",
      OTEL_EXPORTER_OTLP_RETRY_MAX_MS: "200", ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (chunk) => log += chunk); child.stderr.on("data", (chunk) => log += chunk);
  const request = async (endpoint, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
  };
  const stop = async (hard = false) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill(hard ? "SIGKILL" : "SIGTERM"); await exited;
  };
  try {
    await until(async () => { assert(child.exitCode === null, log); return (await request("/api/health")).ok; }, "server ready");
  } catch (error) { await stop(true); throw new Error(String(error) + "\n" + log); }
  return { child, request, stop, url: `http://127.0.0.1:${port}` };
}
export async function agent(server) {
  const { agent } = await server.request("/api/agents", { name: "OTLP verification" });
  await server.request(`/api/agents/${agent.id}/start`, {}); return agent.id;
}
export async function run(server, agentId) {
  const started = performance.now();
  const { run } = await server.request(`/api/agents/${agentId}/messages`, { content: "Build a hello CLI" });
  await until(async () => !["queued", "running"].includes((await server.request(`/api/runs/${run.id}`)).run.status), "run terminal");
  const terminal = (await server.request(`/api/runs/${run.id}`)).run;
  assert.equal(terminal.status, "completed"); return { runId: run.id, durationMs: performance.now() - started };
}
