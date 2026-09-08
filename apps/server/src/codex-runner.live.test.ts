import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRunner } from "./codex-runner.js";
import { loadConfig } from "./config.js";
import { PolicyDeniedError, RunCancelledError } from "./errors.js";

// Drives the real CodexRunner against a stand-in binary: real spawn, real
// stdout framing, real exit codes. Everything below this line was previously
// uncovered — deleting the live-deny termination left the suite green.
const FAKE_CODEX = fileURLToPath(
  new URL("./fixtures/fake-codex.js", import.meta.url),
);

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function runnerFor(overrides: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "codex-live-"));
  directories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: root,
    CODEX_HOME: path.join(root, "codex"),
    CODEX_BIN: FAKE_CODEX,
    CODEX_TIMEOUT_MS: "2000",
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...overrides,
  });
  return { runner: new CodexRunner(config), workspacePath: root };
}

describe("CodexRunner against a real child process", () => {
  it("completes a normal turn and reports usage and thread id", async () => {
    const { runner, workspacePath } = await runnerFor();
    const result = await runner.run({
      agentId: "a1",
      workspacePath,
      prompt: "happy",
      threadId: null,
    });
    expect(result.output).toBe("all good");
    expect(result.threadId).toBe("thread-fake");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  }, 20_000);

  it("terminates the child when the live gate denies a command", async () => {
    // The timeout must stay far above the fixture's 4s sleep. With the default
    // 2s it fires first and kills the child anyway, so the test passes even when
    // the deny path forgets to terminate — which is the exact bug it exists to
    // catch. Verified by mutation: removing this.terminate(active) now fails.
    const { runner, workspacePath } = await runnerFor({
      CODEX_TIMEOUT_MS: "30000",
    });
    const seen: string[] = [];
    const started = Date.now();
    await expect(
      runner.run({
        agentId: "a1",
        workspacePath,
        prompt: "deny",
        threadId: null,
        onCodexEvent: (event) => {
          seen.push(String(event.type));
          if (event.type === "item.started") {
            throw new PolicyDeniedError("protected-env-file");
          }
        },
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    // The fixture sleeps 4s before its agent_message. Returning fast is the
    // proof that the child was actually killed rather than left to finish.
    expect(Date.now() - started).toBeLessThan(2500);
    expect(seen).not.toContain("turn.completed");
    expect(seen).not.toContain("item.completed");
  }, 20_000);

  it("fails only the Run when an event handler throws a non-policy error", async () => {
    const { runner, workspacePath } = await runnerFor();
    // A rethrow here used to escape the stdout data handler as an uncaught
    // exception and take the whole server down with it.
    await expect(
      runner.run({
        agentId: "a1",
        workspacePath,
        prompt: "throwing-event",
        threadId: null,
        onCodexEvent: (event) => {
          if (event.type === "boom") throw new TypeError("handler is broken");
        },
      }),
    ).rejects.toThrow("handler is broken");
  }, 20_000);

  it("reports a non-zero exit with no stderr without a dangling colon", async () => {
    const { runner, workspacePath } = await runnerFor();
    await expect(
      runner.run({
        agentId: "a1",
        workspacePath,
        prompt: "fail-silently",
        threadId: null,
      }),
    ).rejects.toThrow("Codex exited with code 1: No error detail");
  }, 20_000);

  it("keeps the Codex error when the process reports one and exits zero", async () => {
    const { runner, workspacePath } = await runnerFor();
    await expect(
      runner.run({
        agentId: "a1",
        workspacePath,
        prompt: "error-then-exit-zero",
        threadId: null,
      }),
    ).rejects.toThrow(/401 Unauthorized/);
  }, 20_000);

  it("times out a hung child", async () => {
    const { runner, workspacePath } = await runnerFor();
    await expect(
      runner.run({
        agentId: "a1",
        workspacePath,
        prompt: "hang",
        threadId: null,
      }),
    ).rejects.toThrow("Codex timed out after 2000 ms");
  }, 20_000);

  it("cancels a running child on request", async () => {
    const { runner, workspacePath } = await runnerFor({
      CODEX_TIMEOUT_MS: "20000",
    });
    const pending = runner.run({
      agentId: "a1",
      workspacePath,
      prompt: "hang",
      threadId: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(runner.cancel("a1")).resolves.toBe(true);
    await expect(pending).rejects.toBeInstanceOf(RunCancelledError);
  }, 20_000);
});
