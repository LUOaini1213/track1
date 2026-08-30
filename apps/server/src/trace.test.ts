import { describe, expect, it } from "vitest";
import { TraceCollector } from "./trace.js";

describe("TraceCollector", () => {
  it("creates parent/child spans with durations", async () => {
    const collector = new TraceCollector("run-1", "agent-1");
    const root = collector.startSpan("run.execute", "orchestration", null);
    const child = collector.startSpan("policy.check", "policy", root);
    await new Promise((resolve) => setTimeout(resolve, 5));
    collector.endSpan(child, "ok");
    collector.endSpan(root, "ok");
    const [rootSpan, childSpan] = collector.snapshot();
    expect(rootSpan?.parentSpanId).toBeNull();
    expect(childSpan?.parentSpanId).toBe(root);
    expect(rootSpan?.durationMs).toBeGreaterThanOrEqual(0);
    expect(childSpan?.status).toBe("ok");
  });

  it("maps Codex events and ignores malformed lines via recordCodexEvent", () => {
    const collector = new TraceCollector("run-1", "agent-1");
    const parent = collector.startSpan("runtime.spawn", "runtime", null);
    collector.recordCodexEvent(parent, {
      type: "thread.started",
      thread_id: "thread-1",
    });
    collector.recordCodexEvent(parent, {
      type: "item.completed",
      item: {
        id: "item-1",
        type: "command_execution",
        command: "npm test",
        exit_code: 0,
      },
    });
    collector.recordCodexEvent(parent, {
      type: "not-a-documented-shape",
    });
    const names = collector.snapshot().map((span) => span.name);
    expect(names).toContain("runtime.thread");
    expect(names).toContain("tool.command_execution");
    expect(names).toContain("runtime.event");
  });
});
