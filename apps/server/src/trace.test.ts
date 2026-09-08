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

  it("withholds content the denylist used to miss, including the root error", () => {
    const collector = new TraceCollector("run-1", "agent-1", {
      captureContent: false,
    });
    const root = collector.startSpan("invoke_agent Builder", "agent", null, {
      promptChars: 62,
    });
    // AgentService writes this on the root span; for a non-zero Codex exit it
    // embeds up to 16 KB of stderr. `error` was not in the old denylist, so the
    // switch withheld the child spans and published the root verbatim.
    collector.endSpan(root, "error", {
      error: "Codex exited with code 1: /home/u/secret-project/.env not found",
      somethingAddedLater: "invented after this filter was written",
    });
    const span = collector.snapshot()[0];
    expect(span?.attributes.error).toBe("[content capture disabled]");
    // An attribute nobody has classified yet fails closed.
    expect(span?.attributes.somethingAddedLater).toBe(
      "[content capture disabled]",
    );
    // Structure survives, so the trace is still navigable.
    expect(span?.status).toBe("error");
    expect(span?.attributes.promptChars).toBe(62);
    expect(span?.attributes["gen_ai.operation.name"]).toBeUndefined();
  });

  it("keeps every gen_ai.* attribute when content capture is off", () => {
    const collector = new TraceCollector("run-1", "agent-1", {
      modelName: "ep-test",
      captureContent: false,
    });
    const parent = collector.startSpan("runtime.spawn", "runtime", null);
    collector.recordCodexEvent(parent, {
      type: "turn.completed",
      usage: { input_tokens: 900, output_tokens: 120 },
    });
    const turn = collector.snapshot().find((s) => s.kind === "llm");
    expect(turn?.attributes["gen_ai.usage.input_tokens"]).toBe(900);
    expect(turn?.attributes["gen_ai.request.model"]).toBe("ep-test");
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

  it("gives the model turn real duration instead of a zero-width span", async () => {
    // The chat span used to be created and ended inside the turn.completed
    // handler, so it was structurally 0 ms. In the stored traces that left
    // 7.6-26.6 s of wall time per Run with no span carrying it — the slowest
    // component had no bar in the waterfall.
    const collector = new TraceCollector("run-1", "agent-1", {
      modelName: "ep-test",
    });
    const parent = collector.startSpan("runtime.spawn", "runtime", null);
    collector.recordCodexEvent(parent, { type: "turn.started" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    collector.recordCodexEvent(parent, {
      type: "turn.completed",
      usage: { input_tokens: 900, output_tokens: 120 },
    });
    const turns = collector.snapshot().filter((span) => span.kind === "llm");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.name).toBe("chat ep-test");
    expect(turns[0]?.durationMs).toBeGreaterThanOrEqual(10);
    expect(turns[0]?.attributes["gen_ai.usage.input_tokens"]).toBe(900);
    // turn.started must not also leave a generic runtime.event behind.
    expect(
      collector.snapshot().filter((span) => span.name === "runtime.event"),
    ).toHaveLength(0);
  });

  it("still records usage when the runtime never sends turn.started", () => {
    const collector = new TraceCollector("run-1", "agent-1", {
      modelName: "ep-test",
    });
    const parent = collector.startSpan("runtime.spawn", "runtime", null);
    collector.recordCodexEvent(parent, {
      type: "turn.completed",
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    const turn = collector.snapshot().find((span) => span.kind === "llm");
    expect(turn?.attributes["gen_ai.usage.input_tokens"]).toBe(5);
    expect(turn?.status).toBe("ok");
  });

  it("records turn.failed as an error carrying the provider's reason", () => {
    // This fell through to a green runtime.event and the message was dropped,
    // so the Run reported only "Codex exited with code 1: No error detail".
    const collector = new TraceCollector("run-1", "agent-1", {
      modelName: "ep-test",
    });
    const parent = collector.startSpan("runtime.spawn", "runtime", null);
    collector.recordCodexEvent(parent, { type: "turn.started" });
    collector.recordCodexEvent(parent, {
      type: "turn.failed",
      error: { message: "Request failed with status 429: rate limit exceeded" },
    });
    const turn = collector.snapshot().find((span) => span.kind === "llm");
    expect(turn?.status).toBe("error");
    expect(turn?.attributes.errorText).toContain("429");
    expect(turn?.attributes.failedStep).toContain("rate limit");
  });

  it("closes spans the runtime left open, instead of storing them as running", () => {
    const collector = new TraceCollector("run-1", "agent-1");
    const parent = collector.startSpan("runtime.spawn", "runtime", null);
    collector.recordCodexEvent(parent, {
      type: "item.started",
      item: { id: "c1", type: "command_execution", command: "npm install" },
    });
    const open = collector.snapshot().find((s) => s.name === "execute_tool shell");
    expect(open?.endedAt).toBeNull();

    collector.endOpenSpans("denied", { errorText: "stopped mid-command" });
    const closed = collector.snapshot().find((s) => s.name === "execute_tool shell");
    expect(closed?.status).toBe("denied");
    expect(closed?.endedAt).not.toBeNull();
    expect(closed?.durationMs).not.toBeNull();
    expect(closed?.attributes.unterminated).toBe(true);
    // The root wrapper is closed too, children first.
    expect(collector.snapshot().every((s) => s.endedAt !== null)).toBe(true);
  });

  it("labels a failing step only when the step failed", () => {
    const collector = new TraceCollector("run-1", "agent-1");
    const parent = collector.startSpan("runtime.spawn", "runtime", null);
    collector.recordCodexEvent(parent, {
      type: "item.completed",
      item: { id: "c1", type: "command_execution", command: "npm test", exit_code: 0 },
    });
    collector.recordCodexEvent(parent, {
      type: "item.completed",
      item: { id: "a1", type: "agent_message", text: "Here is what I did." },
    });
    const spans = collector.snapshot();
    const ok = spans.find((s) => s.attributes.command === "npm test");
    const message = spans.find((s) => s.name === "chat agent_message");
    // "failing step: npm test" next to a command that exited 0.
    expect(ok?.failedStep).toBeUndefined();
    expect(ok?.attributes.failedStep).toBeNull();
    expect(message?.attributes.failedStep).toBeNull();
    // Assistant prose is text, not a command the span claims to have run.
    expect(message?.attributes.command).toBeNull();
    expect(message?.attributes.text).toBe("Here is what I did.");
  });

  it("keeps the end of captured output, where a command says why it failed", () => {
    const collector = new TraceCollector("run-1", "agent-1");
    const parent = collector.startSpan("runtime.spawn", "runtime", null);
    const passing = Array.from(
      { length: 40 },
      (_, i) => " ok src/module" + i + ".test.ts (4 tests) 10ms",
    ).join("\n");
    collector.recordCodexEvent(parent, {
      type: "item.completed",
      item: {
        id: "c1",
        type: "command_execution",
        command: "npm test",
        exit_code: 1,
        aggregated_output: [
          "> vitest run",
          passing,
          "AssertionError: expected 3 to be 4",
        ].join("\n"),
      },
    });
    const span = collector.snapshot().find((s) => s.name === "execute_tool shell");
    // The head is the banner and forty passing files; the reason is at the tail.
    expect(span?.attributes.errorText).toContain("AssertionError");
    expect(span?.attributes.errorText).not.toContain("vitest run");
  });

  it("records which files a patch touched", () => {
    const collector = new TraceCollector("run-1", "agent-1");
    const parent = collector.startSpan("runtime.spawn", "runtime", null);
    collector.recordCodexEvent(parent, {
      type: "item.completed",
      item: {
        id: "f1",
        type: "file_change",
        changes: [
          { kind: "add", path: "src/cli.ts" },
          { kind: "modify", path: "package.json" },
        ],
      },
    });
    const span = collector
      .snapshot()
      .find((s) => s.name === "execute_tool apply_patch");
    expect(span?.attributes.fileCount).toBe(2);
    expect(span?.attributes.files).toContain("src/cli.ts");
    expect(span?.attributes.files).toContain("package.json");
  });
});
