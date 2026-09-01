import { describe, expect, it } from "vitest";
import { compareRuns, failingSpanIdentity } from "./run-compare.js";
import type { AgentRun, TraceSpan } from "./types.js";

const span = (overrides: Partial<TraceSpan>): TraceSpan => ({
  traceId: "t",
  spanId: "s-fail",
  parentSpanId: null,
  runId: "r1",
  agentId: "a",
  name: "execute_tool shell",
  kind: "tool",
  status: "error",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1000,
  attributes: { command: "npm test", exitCode: 1, errorText: "boom" },
  ...overrides,
});

const run = (overrides: Partial<AgentRun>): AgentRun => ({
  id: "r1",
  agentId: "a",
  status: "completed",
  prompt: "go",
  output: "done",
  error: null,
  usage: { inputTokens: 10, outputTokens: 2 },
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:02.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  traceId: "t",
  spans: [],
  ...overrides,
});

describe("run compare", () => {
  it("extracts failing-span identity from diagnostic attributes", () => {
    const identity = failingSpanIdentity([span({})]);
    expect(identity).toMatchObject({
      spanId: "s-fail",
      command: "npm test",
      exitCode: 1,
      errorText: "boom",
    });
  });

  it("skips the attribute-less root span so the failing step is diagnosable", () => {
    const root = span({
      spanId: "s-root",
      name: "invoke_agent Builder",
      kind: "agent",
      status: "denied",
      attributes: { promptChars: 62 },
    });
    const policy = span({
      spanId: "s-policy",
      name: "policy.check",
      kind: "policy",
      status: "denied",
      attributes: {
        ruleId: "print-ark-secret",
        reason: "Attempt to print or dump Ark / API credentials",
      },
    });
    const identity = failingSpanIdentity([root, policy]);
    expect(identity?.spanId).toBe("s-policy");
    expect(identity?.name).toBe("policy.check");
  });

  it("falls back to the root span when it is the only problem span", () => {
    const root = span({
      spanId: "s-root",
      name: "invoke_agent Builder",
      kind: "agent",
      status: "error",
      attributes: { error: "spawn codex ENOENT" },
    });
    expect(failingSpanIdentity([root])?.spanId).toBe("s-root");
  });

  it("compares usage and duration of two Runs", () => {
    const left = run({
      id: "left",
      spans: [span({})],
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    const right = run({
      id: "right",
      usage: { inputTokens: 4, outputTokens: 1 },
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:05.000Z",
      spans: [],
    });
    const compared = compareRuns(left, right);
    expect(compared.left.runId).toBe("left");
    expect(compared.right.runId).toBe("right");
    expect(compared.left.durationMs).toBe(2000);
    expect(compared.right.durationMs).toBe(5000);
    expect(compared.left.failingSpan?.spanId).toBe("s-fail");
    expect(compared.right.failingSpan).toBeNull();
  });
});
