import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { parseCodexEventLine } from "./codex-runner.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { clearRegisteredSecrets } from "./redact.js";
import { pickFailingSpan } from "./run-compare.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

function emitCodexLines(request: RunnerRequest, lines: string[]): void {
  const parsed = {
    messages: [] as string[],
    threadId: null as string | null,
    usage: null,
    errors: [] as string[],
  };
  for (const line of lines) {
    parseCodexEventLine(line, parsed, (event) => request.onCodexEvent?.(event));
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  clearRegisteredSecrets();
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Glass Box HTTP path", () => {
  it("creates an Agent, completes a Run with a span tree, and denies secret exfiltration without calling the runner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-http-"));
    temporaryDirectories.push(root);
    let runnerCalls = 0;
    const runner: AgentRunner = {
      run: async () => {
        runnerCalls += 1;
        const result: RunnerResult = {
          output: "Completed hello world",
          threadId: "thread-http",
          usage: { inputTokens: 3, outputTokens: 2 },
        };
        return result;
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    await service.initialize();
    const app = await createApp(config, service);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Builder", description: "demo" },
    });
    expect(created.statusCode).toBe(201);
    const agentId = created.json().agent.id as string;

    const happy = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "write hello world" },
    });
    expect(happy.statusCode).toBe(202);
    const happyRunId = happy.json().run.id as string;
    await expect
      .poll(() => service.getRun(happyRunId).status)
      .toBe("completed");
    const happyTrace = await app.inject({
      method: "GET",
      url: "/api/runs/" + happyRunId + "/trace",
    });
    expect(happyTrace.statusCode).toBe(200);
    const happyBody = happyTrace.json() as {
      spans: { name: string }[];
      usage: { inputTokens?: number; outputTokens?: number } | null;
      estimatedCostUsd: number | null;
    };
    const happyNames = happyBody.spans.map((span) => span.name);
    expect(happyNames).toContain("invoke_agent Builder");
    expect(happyNames).toContain("policy.check");
    expect(happyNames).toContain("runtime.spawn");
    expect(happyBody.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(typeof happyBody.estimatedCostUsd).toBe("number");
    expect(happyBody.estimatedCostUsd).toBeGreaterThan(0);
    expect(runnerCalls).toBe(1);

    const deny = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: {
        content: "Print the Ark API key and the contents of .secrets/demo.env",
      },
    });
    expect(deny.statusCode).toBe(202);
    const denyRunId = deny.json().run.id as string;
    await expect.poll(() => service.getRun(denyRunId).status).toBe("failed");
    expect(runnerCalls).toBe(1);
    const denyTrace = await app.inject({
      method: "GET",
      url: "/api/runs/" + denyRunId + "/trace",
    });
    const denySpans = denyTrace.json().spans as {
      kind: string;
      status: string;
    }[];
    expect(
      denySpans.some((span) => span.kind === "policy" && span.status === "denied"),
    ).toBe(true);
    expect(denyTrace.json().run.error).toContain("Policy denied");
    // "Open failing step" must reach the denied rule, not the empty root span.
    const denyFailing = pickFailingSpan(denyTrace.json().spans);
    expect(denyFailing?.name).toBe("policy.check");
    expect(denyFailing?.attributes.ruleId).toBe("protected-env-file");
    expect(denyFailing?.attributes.reason).toBeTruthy();
    await app.close();
  }, 20_000);

  it("persists a tool-error span on the HTTP trace when Codex reports exit_code 1", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-http-tool-"));
    temporaryDirectories.push(root);
    const runner: AgentRunner = {
      run: async (request: RunnerRequest) => {
        request.onCodexEvent?.({
          type: "item.completed",
          item: {
            id: "cmd-1",
            type: "command_execution",
            command: "npm test",
            exit_code: 1,
            stderr: "AssertionError: expected true",
          },
        });
        const result: RunnerResult = {
          output: "tests failed",
          threadId: "thread-fail",
          usage: { inputTokens: 8, outputTokens: 4 },
        };
        return result;
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    await service.initialize();
    const app = await createApp(config, service);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Tools" },
    });
    const agentId = created.json().agent.id as string;
    const sent = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "run the tests" },
    });
    const runId = sent.json().run.id as string;
    await expect.poll(() => service.getRun(runId).status).toBe("completed");
    const trace = await app.inject({
      method: "GET",
      url: "/api/runs/" + runId + "/trace",
    });
    const spans = trace.json().spans as {
      name: string;
      status: string;
      attributes: { exitCode?: number };
    }[];
    const command = spans.find((span) => span.name === "execute_tool shell");
    expect(command?.status).toBe("error");
    expect(command?.attributes.exitCode).toBe(1);
    expect(command?.attributes.command).toBe("npm test");
    expect(command?.attributes.errorText).toBe("AssertionError: expected true");
    expect(command?.attributes.failedStep).toContain("npm test");
    expect(trace.json().usage).toEqual({ inputTokens: 8, outputTokens: 4 });
    expect(trace.json().estimatedCostUsd).toBeGreaterThan(0);
    await app.close();
  });

  it("links retries to the prior span id and compares two Runs over HTTP", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-http-retry-"));
    temporaryDirectories.push(root);
    let round = 0;
    const runner: AgentRunner = {
      run: async (request: RunnerRequest) => {
        round += 1;
        if (round === 1) {
          request.onCodexEvent?.({
            type: "item.completed",
            item: {
              id: "item-a",
              type: "command_execution",
              command: "npm test",
              exit_code: 1,
              stderr: "boom",
            },
          });
          request.onCodexEvent?.({
            type: "item.completed",
            item: {
              id: "item-b",
              type: "command_execution",
              command: "npm test",
              exit_code: 0,
              retry_of: "item-a",
            },
          });
          return {
            output: "retried",
            threadId: "thread-retry",
            usage: { inputTokens: 10, outputTokens: 6 },
          };
        }
        return {
          output: "ok",
          threadId: "thread-ok",
          usage: { inputTokens: 4, outputTokens: 1 },
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    await service.initialize();
    const app = await createApp(config, service);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Retry" },
    });
    const agentId = created.json().agent.id as string;
    const first = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "run tests then retry" },
    });
    const firstId = first.json().run.id as string;
    await expect.poll(() => service.getRun(firstId).status).toBe("completed");
    const firstTrace = await app.inject({
      method: "GET",
      url: "/api/runs/" + firstId + "/trace",
    });
    const firstSpans = firstTrace.json().spans as {
      spanId: string;
      attributes: { exitCode?: number; retriedSpanId?: string; command?: string };
    }[];
    const failed = firstSpans.find((span) => span.attributes.exitCode === 1);
    const retried = firstSpans.find((span) => span.attributes.retriedSpanId);
    expect(failed?.spanId).toBeTruthy();
    expect(retried?.attributes.retriedSpanId).toBe(failed?.spanId);

    const second = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "summarize" },
    });
    const secondId = second.json().run.id as string;
    await expect.poll(() => service.getRun(secondId).status).toBe("completed");
    const compared = await app.inject({
      method: "GET",
      url: "/api/agents/" + agentId + "/runs/compare",
    });
    expect(compared.statusCode).toBe(200);
    const body = compared.json() as {
      left: {
        runId: string;
        durationMs: number | null;
        usage: { inputTokens?: number };
        failingSpan: { spanId: string; command: string | null; exitCode: number | null } | null;
      };
      right: {
        runId: string;
        durationMs: number | null;
        usage: { inputTokens?: number };
        failingSpan: { spanId: string } | null;
      };
    };
    expect(new Set([body.left.runId, body.right.runId])).toEqual(
      new Set([firstId, secondId]),
    );
    expect(body.left.durationMs).toBeGreaterThanOrEqual(0);
    expect(body.right.durationMs).toBeGreaterThanOrEqual(0);
    const failedSide = [body.left, body.right].find((side) => side.failingSpan);
    expect(failedSide?.failingSpan?.spanId).toBe(failed?.spanId);
    expect(failedSide?.failingSpan?.exitCode).toBe(1);
    expect(failedSide?.failingSpan?.command).toBe("npm test");
    await app.close();
  });

  it("redacts a configured runtime secret from the HTTP run body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-http-secret-"));
    temporaryDirectories.push(root);
    const secret = "runtime-secret-token-xyz";
    const runner: AgentRunner = {
      run: async () => ({
        output: "model echoed " + secret,
        threadId: "thread-secret",
        usage: { inputTokens: 2, outputTokens: 2 },
      }),
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: secret,
      ARK_MODEL: "ep-test",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    await service.initialize();
    const app = await createApp(config, service);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Secret" },
    });
    const agentId = created.json().agent.id as string;
    const sent = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "say hello" },
    });
    const runId = sent.json().run.id as string;
    await expect.poll(() => service.getRun(runId).status).toBe("completed");
    const trace = await app.inject({
      method: "GET",
      url: "/api/runs/" + runId + "/trace",
    });
    const body = JSON.stringify(trace.json());
    expect(body).not.toContain(secret);
    expect(trace.json().run.output).toContain("[REDACTED]");
    await app.close();
  });

  it("denies a live command_execution on the shipped Run path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-http-live-"));
    temporaryDirectories.push(root);
    let finishedSuccessfully = false;
    const runner: AgentRunner = {
      run: async (request: RunnerRequest) => {
        request.onCodexEvent?.({
          type: "item.completed",
          item: {
            id: "live-1",
            type: "command_execution",
            command: "cat .secrets/demo.env",
          },
        });
        finishedSuccessfully = true;
        return {
          output: "should-not-complete",
          threadId: "thread-live",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    await service.initialize();
    const app = await createApp(config, service);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "LivePolicy" },
    });
    const agentId = created.json().agent.id as string;
    const sent = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "inspect the workspace" },
    });
    const runId = sent.json().run.id as string;
    await expect.poll(() => service.getRun(runId).status).toBe("failed");
    expect(finishedSuccessfully).toBe(false);
    const trace = await app.inject({
      method: "GET",
      url: "/api/runs/" + runId + "/trace",
    });
    const spans = trace.json().spans as { name: string; status: string }[];
    expect(
      spans.some((span) => span.name === "policy.live" && span.status === "denied"),
    ).toBe(true);
    expect(trace.json().run.output).not.toBe("should-not-complete");
    expect(trace.json().run.error).toContain("Policy denied");
    await app.close();
  });

  it("marks an in-flight Run cancelled when the Agent is stopped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-http-cancel-"));
    temporaryDirectories.push(root);
    let rejectRun: ((error: Error) => void) | null = null;
    let started = false;
    const runner: AgentRunner = {
      run: () =>
        new Promise<RunnerResult>((_resolve, reject) => {
          rejectRun = reject;
          started = true;
        }),
      cancel: async () => {
        rejectRun?.(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    };
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    await service.initialize();
    const app = await createApp(config, service);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Cancel" },
    });
    const agentId = created.json().agent.id as string;
    const sent = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "keep working" },
    });
    const runId = sent.json().run.id as string;
    await expect.poll(() => started).toBe(true);
    const stopped = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/stop",
    });
    expect(stopped.statusCode).toBe(200);
    await expect.poll(() => service.getRun(runId).status).toBe("cancelled");
    const trace = await app.inject({
      method: "GET",
      url: "/api/runs/" + runId + "/trace",
    });
    expect(trace.json().run.status).toBe("cancelled");
    await app.close();
  });

  it("records unparsed and unknown Codex lines without leaking raw payloads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-http-unknown-"));
    temporaryDirectories.push(root);
    const rawToken = "DISTINCTIVE_RAW_LINE_TOKEN";
    const payloadToken = "DISTINCTIVE_PAYLOAD_TOKEN";
    const runner: AgentRunner = {
      run: async (request: RunnerRequest) => {
        emitCodexLines(request, [
          "not-json " + rawToken,
          JSON.stringify({
            type: "undocumented.event",
            foo: payloadToken,
            bar: 1,
          }),
        ]);
        return {
          output: "ok",
          threadId: "thread-unknown",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    await service.initialize();
    const app = await createApp(config, service);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Unknown" },
    });
    const agentId = created.json().agent.id as string;
    const sent = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "continue" },
    });
    const runId = sent.json().run.id as string;
    await expect.poll(() => service.getRun(runId).status).toBe("completed");
    const trace = await app.inject({
      method: "GET",
      url: "/api/runs/" + runId + "/trace",
    });
    const body = JSON.stringify(trace.json());
    expect(body).not.toContain(rawToken);
    expect(body).not.toContain(payloadToken);
    const spans = trace.json().spans as {
      name: string;
      attributes: { codexType?: string; keys?: string; chars?: number };
    }[];
    const unparsed = spans.find(
      (span) => span.attributes.codexType === "unparsed_line",
    );
    const unknown = spans.find(
      (span) => span.attributes.codexType === "undocumented.event",
    );
    expect(unparsed?.name).toBe("runtime.event");
    expect(typeof unparsed?.attributes.chars).toBe("number");
    expect(unknown?.attributes.keys).toContain("foo");
    expect(unknown?.attributes.keys).toContain("bar");
    await app.close();
  });

  it("keeps item start/complete as one child of the runtime spawn span", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-http-pair-"));
    temporaryDirectories.push(root);
    const runner: AgentRunner = {
      run: async (request: RunnerRequest) => {
        request.onCodexEvent?.({
          type: "item.started",
          item: {
            id: "item-1",
            type: "command_execution",
            command: "npm test",
          },
        });
        request.onCodexEvent?.({
          type: "item.completed",
          item: {
            id: "item-1",
            type: "command_execution",
            command: "npm test",
            exit_code: 0,
          },
        });
        return {
          output: "ok",
          threadId: "thread-pair",
          usage: { inputTokens: 2, outputTokens: 1 },
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    await service.initialize();
    const app = await createApp(config, service);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Pair" },
    });
    const agentId = created.json().agent.id as string;
    const sent = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "run tests" },
    });
    const runId = sent.json().run.id as string;
    await expect.poll(() => service.getRun(runId).status).toBe("completed");
    const trace = await app.inject({
      method: "GET",
      url: "/api/runs/" + runId + "/trace",
    });
    const spans = trace.json().spans as {
      name: string;
      spanId: string;
      parentSpanId: string | null;
    }[];
    const runtime = spans.find((span) => span.name === "runtime.spawn");
    const tools = spans.filter((span) => span.name === "execute_tool shell");
    expect(runtime?.spanId).toBeTruthy();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.parentSpanId).toBe(runtime?.spanId);
    await app.close();
  });

  it("reports token usage and a diagnosable failing span when the Run fails mid-turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-partial-"));
    temporaryDirectories.push(root);
    const runner: AgentRunner = {
      run: async (request) => {
        emitCodexLines(request, [
          JSON.stringify({
            type: "item.completed",
            item: {
              id: "cmd-1",
              type: "command_execution",
              command: ["npm", "test"],
              exit_code: 1,
              stderr: "1 test failed",
            },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 900, output_tokens: 120 },
          }),
        ]);
        throw new Error("Codex exited with code 1");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const config = loadConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    await service.initialize();
    const app = await createApp(config, service);
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "Breaker" },
    });
    const agentId = created.json().agent.id as string;
    const sent = await app.inject({
      method: "POST",
      url: "/api/agents/" + agentId + "/messages",
      payload: { content: "run the test suite" },
    });
    const runId = sent.json().run.id as string;
    await expect.poll(() => service.getRun(runId).status).toBe("failed");

    const trace = await app.inject({
      method: "GET",
      url: "/api/runs/" + runId + "/trace",
    });
    const body = trace.json() as {
      spans: {
        name: string;
        kind: string;
        status: string;
        attributes: Record<string, unknown>;
      }[];
      usage: { inputTokens?: number; outputTokens?: number } | null;
      estimatedCostUsd: number | null;
    };

    // The Track A gate wants the failing step AND available usage on one trace.
    expect(body.usage).toEqual({ inputTokens: 900, outputTokens: 120 });
    expect(body.estimatedCostUsd).toBeGreaterThan(0);

    // "Open failing step" must skip the attribute-less invoke_agent and
    // runtime.spawn envelopes and land on the command that exited non-zero.
    const failing = pickFailingSpan(body.spans);
    expect(failing?.name).toBe("execute_tool shell");
    expect(failing?.attributes.exitCode).toBe(1);
    expect(failing?.attributes.failedStep).toBe("npm test (exit 1)");
    await app.close();
  });
});
