#!/usr/bin/env node
/**
 * Starts the built server the way Docker and the ECS paths do — `node
 * apps/server/dist/index.js` — and asks it one question.
 *
 * `npm run check` did not catch that the shared contract package exported
 * TypeScript source: tsc typechecks it, vitest resolves it and Vite bundles it,
 * so every existing gate was green while the production entrypoint could not
 * start at all. Nothing short of running the artefact would have found it.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = fileURLToPath(new URL("../apps/server", import.meta.url));
const port = 3987;
const root = await mkdtemp(path.join(tmpdir(), "launchpad-smoke-"));

const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: serverRoot,
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    LOG_LEVEL: "silent",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "smoke-key",
    ARK_MODEL: "ep-smoke",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (c) => (output += c));
child.stderr.on("data", (c) => (output += c));

const cleanup = async () => {
  child.kill();
  await rm(root, { recursive: true, force: true });
};

const fail = async (message) => {
  await cleanup();
  console.error("smoke: " + message);
  if (output.trim()) console.error(output.trim().split("\n").slice(0, 12).join("\n"));
  process.exit(1);
};

const deadline = Date.now() + 25_000;
let health = null;
while (Date.now() < deadline) {
  if (child.exitCode !== null) {
    await fail("server exited with code " + child.exitCode + " before answering");
  }
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/api/health");
    if (response.ok) {
      health = await response.json();
      break;
    }
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

if (!health?.ok) await fail("no healthy response within 25s");

const system = await fetch("http://127.0.0.1:" + port + "/api/system").then((r) => r.json());
if (typeof system.arkConfigured !== "boolean") {
  await fail("/api/system did not answer with a readiness shape");
}

await cleanup();
console.log("smoke: built server started and answered /api/health and /api/system");
