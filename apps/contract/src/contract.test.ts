import { describe, expect, it } from "vitest";
import {
  problemSpans,
  pickFailingSpan,
  estimateCostUsd,
  compareRuns,
} from "./index.js";
import type { AgentRun, TraceSpan } from "./index.js";

// This package exists because problemSpans, DIAGNOSTIC_KEYS and every wire type
// were hand-mirrored between the control plane and the Playground, and had
// already drifted: the server always sends traceId and spans, while the web
// declared both optional. These tests pin the shared behaviour both sides now
// import, so a change to the ranker cannot mean one thing on the server and
// another in the browser.
const span = (over: Partial<TraceSpan>): TraceSpan => ({
  traceId: "t",
  spanId: "s",
  parentSpanId: null,
  runId: "r",
  agentId: "a",
  name: "execute_tool shell",
  kind: "tool",
  status: "ok",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1000,
  attributes: {},
  ...over,
});

describe("shared contract", () => {
  it("ranks problem spans identically for both consumers", () => {
    const root = span({ spanId: "root", kind: "agent", status: "error",
      name: "invoke_agent B", attributes: { promptChars: 5 } });
    const wrapper = span({ spanId: "spawn", parentSpanId: "root", kind: "runtime",
      status: "error", name: "runtime.spawn", attributes: {} });
    const cause = span({ spanId: "cause", parentSpanId: "spawn", status: "error",
      attributes: { command: "npm test", exitCode: 1 } });
    expect(problemSpans([root, wrapper, cause]).map((s) => s.spanId)).toEqual([
      "cause",
      "spawn",
      "root",
    ]);
  });

  it("ranks a step that failed above one that was only still open", () => {
    // What `endOpenSpans` produces: the step Codex had in flight when the Run
    // died is closed with a placeholder errorText, which looks like a diagnostic
    // but explains nothing. It is also the earlier of the two siblings, so
    // before the `unterminated` rule existed it won the ranking outright and
    // "Open failing step" pointed at it.
    const spawn = span({ spanId: "spawn", kind: "runtime", status: "error",
      name: "runtime.spawn", attributes: {} });
    const stillOpen = span({ spanId: "chat", parentSpanId: "spawn", kind: "llm",
      name: "chat", status: "error", startedAt: "2026-01-01T00:00:00.040Z",
      attributes: {
        errorText: "Run ended before this step completed",
        unterminated: true,
      } });
    const failed = span({ spanId: "shell", parentSpanId: "spawn", status: "error",
      startedAt: "2026-01-01T00:00:01.600Z",
      attributes: { command: "node --test", exitCode: 1 } });
    // Passed in trace order, which is the order the placeholder used to win on.
    // `spawn` is an empty envelope and still ends up above the placeholder:
    // neither explains anything, and rule 1 runs before the diagnostics rule,
    // so the span that was merely closed by the Run's collapse sorts last.
    expect(
      problemSpans([spawn, stillOpen, failed]).map((s) => s.spanId),
    ).toEqual(["shell", "spawn", "chat"]);
    expect(pickFailingSpan([spawn, stillOpen, failed])?.spanId).toBe("shell");
  });

  it("keeps ranking by depth when no span carries the unterminated marker", () => {
    // Guards the shape of the rule, not just its outcome: reading the attribute
    // straight would make this `Number(undefined) - Number(undefined)` = NaN,
    // `if (x !== 0) return x` is true for NaN, and every later rule would stop
    // running — leaving the depth and order rules silently dead.
    const outer = span({ spanId: "outer", kind: "agent", status: "error",
      name: "invoke_agent B", attributes: { errorText: "failed" } });
    const inner = span({ spanId: "inner", parentSpanId: "outer", status: "error",
      attributes: { exitCode: 2 } });
    expect(problemSpans([outer, inner]).map((s) => s.spanId)).toEqual([
      "inner",
      "outer",
    ]);
  });

  it("prices from the configured rate, and not at all without one", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateCostUsd(usage, null)).toBeNull();
    expect(
      estimateCostUsd(usage, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }),
    ).toBeCloseTo(3, 8);
  });

  it("summarises a Run the same way the compare endpoint does", () => {
    const run = (over: Partial<AgentRun>): AgentRun => ({
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
      ...over,
    });
    const compared = compareRuns(run({ id: "left" }), run({ id: "right" }), null);
    expect(compared.left.runId).toBe("left");
    expect(compared.left.durationMs).toBe(2000);
    // No rate configured means no invented price on either side.
    expect(compared.left.estimatedCostUsd).toBeNull();
  });
});
