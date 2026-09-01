import { describe, expect, it } from "vitest";
import {
  compareRuns,
  failingSpanIdentity,
  problemSpans,
  spanDepths,
} from "./run-compare.js";
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

  it("ranks several failures by explanation, then depth, then first-seen", () => {
    const root = span({ spanId: "root", parentSpanId: null, kind: "agent",
      name: "invoke_agent Builder", status: "error", attributes: { promptChars: 12 } });
    const spawn = span({ spanId: "spawn", parentSpanId: "root", kind: "runtime",
      name: "runtime.spawn", status: "error", attributes: {} });
    const first = span({ spanId: "first", parentSpanId: "spawn", kind: "tool",
      status: "error", attributes: { command: "npm test", exitCode: 1 } });
    const second = span({ spanId: "second", parentSpanId: "spawn", kind: "tool",
      status: "error", attributes: { command: "npm run lint", exitCode: 2 } });

    const ranked = problemSpans([root, spawn, first, second]);
    // Both wrappers rank last: they are on the failure path but explain nothing.
    expect(ranked.map((s) => s.spanId)).toEqual(["first", "second", "spawn", "root"]);
    // When a Run fails twice the first failure is usually the cause; the later
    // one is a cascade. That ordering is now explicit, not sort-stability luck.
    expect(ranked[0]?.attributes.command).toBe("npm test");
  });

  it("gives an orphaned span a depth without looping forever", () => {
    const orphan = span({ spanId: "orphan", parentSpanId: "missing" });
    const a = span({ spanId: "a", parentSpanId: "b" });
    const b = span({ spanId: "b", parentSpanId: "a" });
    const depths = spanDepths([orphan, a, b]);
    expect(depths.get("orphan")).toBe(1);
    expect(depths.get("a")).toBeGreaterThanOrEqual(1);
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
