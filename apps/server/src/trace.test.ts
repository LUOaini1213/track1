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

  it("marks a command span as error when Codex reports a non-zero exit code", () => {
    const collector = new TraceCollector("run-1", "agent-1");
    const parent = collector.startSpan("runtime.spawn", "runtime", null);
    collector.recordCodexEvent(parent, {
      type: "item.completed",
      item: {
        id: "item-fail",
        type: "command_execution",
        command: "npm test",
        exit_code: 1,
      },
    });
    const command = collector
      .snapshot()
      .find((span) => span.name === "tool.command_execution");
    expect(command?.status).toBe("error");
    expect(command?.attributes.exitCode).toBe(1);
    expect(command?.attributes.command).toBe("npm test");
    expect(command?.attributes.failedStep).toContain("exit 1");
  });

  it("links a retry item to the earlier span id", () => {
    const collector = new TraceCollector("run-1", "agent-1");
    const parent = collector.startSpan("runtime.spawn", "runtime", null);
    collector.recordCodexEvent(parent, {
      type: "item.completed",
      item: {
        id: "item-a",
        type: "command_execution",
        command: "npm test",
        exit_code: 1,
        stderr: "failing test",
      },
    });
    collector.recordCodexEvent(parent, {
      type: "item.completed",
      item: {
        id: "item-b",
        type: "command_execution",
        command: "npm test",
        exit_code: 0,
        retry_of: "item-a",
      },
    });
    const spans = collector.snapshot();
    const first = spans.find((span) => span.attributes.exitCode === 1);
    const retry = spans.find((span) => span.attributes.retriedSpanId);
    expect(first?.spanId).toBeTruthy();
    expect(retry?.attributes.retriedSpanId).toBe(first?.spanId);
    expect(first?.attributes.errorText).toBe("failing test");
  });
});
