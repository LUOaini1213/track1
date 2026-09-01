import { describe, expect, it } from "vitest";
import { TraceCollector } from "./trace.js";

describe("TraceCollector", () => {
  it("creates parent/child spans with durations", async () => {
    const collector = new TraceCollector("run-1", "agent-1");
    const root = collector.startSpan("invoke_agent Builder", "agent", null);
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
    expect(names).toContain("execute_tool shell");
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
      .find((span) => span.name === "execute_tool shell");
    expect(command?.status).toBe("error");
    expect(command?.attributes.exitCode).toBe(1);
    expect(command?.attributes.command).toBe("npm test");
    expect(command?.attributes.failedStep).toContain("exit 1");
  });

  it("withholds content attributes when capture is disabled but keeps the diagnosis", () => {
    const collector = new TraceCollector("run-1", "agent-1", {
      captureContent: false,
    });
    const parent = collector.startSpan("runtime.spawn", "runtime", null);
    collector.recordCodexEvent(parent, {
      type: "item.completed",
      item: {
        id: "item-fail",
        type: "command_execution",
        command: "cat /etc/passwd",
        exit_code: 1,
        stderr: "Permission denied",
      },
    });
    const command = collector
      .snapshot()
      .find((span) => span.name === "execute_tool shell");
    // Content is withheld...
    expect(command?.attributes.command).toBe("[content capture disabled]");
    expect(command?.attributes.errorText).toBe("[content capture disabled]");
    // ...but the structural diagnosis survives.
    expect(command?.status).toBe("error");
    expect(command?.attributes.exitCode).toBe(1);
    expect(command?.attributes["gen_ai.tool.name"]).toBe("shell");
  });

  it("records model usage under the OTel GenAI token keys", () => {
    const collector = new TraceCollector("run-1", "agent-1", {
      modelName: "ep-test",
    });
    const parent = collector.startSpan("runtime.spawn", "runtime", null);
    collector.recordCodexEvent(parent, {
      type: "turn.completed",
      usage: { input_tokens: 900, output_tokens: 120 },
    });
    const turn = collector.snapshot().find((span) => span.kind === "llm");
    expect(turn?.name).toBe("chat ep-test");
    expect(turn?.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(turn?.attributes["gen_ai.request.model"]).toBe("ep-test");
    expect(turn?.attributes["gen_ai.usage.input_tokens"]).toBe(900);
    expect(turn?.attributes["gen_ai.usage.output_tokens"]).toBe(120);
    // Provenance is recorded rather than a conformance claim being implied.
    expect(turn?.attributes["gen_ai.usage.source"]).toBe("codex turn.completed");
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

  it("surfaces a Codex error item as an errored span with its message", () => {
    const collector = new TraceCollector("run-1", "agent-1");
    const parent = collector.startSpan("runtime.spawn", "runtime", null);
    collector.recordCodexEvent(parent, {
      type: "item.completed",
      item: {
        id: "err-1",
        type: "error",
        message: "stream disconnected before completion",
      },
    });
    const span = collector.snapshot().find((s) => s.name === "runtime.error");
    // The item carries no `status` field, so checking status alone missed it
    // and the span was recorded green with every attribute null.
    expect(span?.status).toBe("error");
    expect(span?.attributes.errorText).toBe(
      "stream disconnected before completion",
    );
    // Never the bare word "command" — an error item has no command.
    expect(span?.attributes.failedStep).toBe(
      "stream disconnected before completion",
    );
  });
});
