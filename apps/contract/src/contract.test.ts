import { describe, expect, it } from "vitest";
import { problemSpans, estimateCostUsd, compareRuns } from "./index.js";
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
