import { randomUUID } from "node:crypto";
import { redactDeep } from "./redact.js";
import type { SpanKind, SpanStatus, TraceSpan } from "./types.js";

const now = () => new Date().toISOString();

export class TraceCollector {
  readonly traceId: string;
  readonly spans: TraceSpan[] = [];
  private readonly itemSpans = new Map<string, string>();

  constructor(
    private readonly runId: string,
    private readonly agentId: string,
    private readonly onChange?: (spans: TraceSpan[]) => void | Promise<void>,
  ) {
    this.traceId = randomUUID();
  }

  snapshot(): TraceSpan[] {
    return redactDeep(structuredClone(this.spans));
  }

  startSpan(
    name: string,
    kind: SpanKind,
    parentSpanId: string | null,
    attributes: TraceSpan["attributes"] = {},
  ): string {
    const spanId = randomUUID();
    this.spans.push({
      traceId: this.traceId,
      spanId,
      parentSpanId,
      runId: this.runId,
      agentId: this.agentId,
      name,
      kind,
      status: "ok",
      startedAt: now(),
      endedAt: null,
      durationMs: null,
      attributes: redactDeep(attributes),
    });
    void this.onChange?.(this.snapshot());
    return spanId;
  }

  endSpan(
    spanId: string,
    status: SpanStatus,
    attributes: TraceSpan["attributes"] = {},
  ): void {
    const span = this.spans.find((item) => item.spanId === spanId);
    if (!span) {
      return;
    }
    const endedAt = now();
    span.status = status;
    span.endedAt = endedAt;
    span.durationMs = Math.max(
      0,
      Date.parse(endedAt) - Date.parse(span.startedAt),
    );
    span.attributes = redactDeep({ ...span.attributes, ...attributes });
    void this.onChange?.(this.snapshot());
  }

  recordCodexEvent(parentSpanId: string, event: Record<string, unknown>): void {
    const type = typeof event.type === "string" ? event.type : "unknown";
    if (type === "thread.started") {
      const spanId = this.startSpan("runtime.thread", "runtime", parentSpanId, {
        threadId:
          typeof event.thread_id === "string" ? event.thread_id : null,
      });
      this.endSpan(spanId, "ok");
      return;
    }

    if (
      (type === "item.started" || type === "item.completed") &&
      event.item &&
      typeof event.item === "object"
    ) {
      const item = event.item as Record<string, unknown>;
      const itemId = typeof item.id === "string" ? item.id : randomUUID();
      const itemType = typeof item.type === "string" ? item.type : "item";
      const kind = kindForItem(itemType);
      const name = kind + "." + itemType;
      const attributes = itemAttributes(item);
      if (type === "item.started") {
        const spanId = this.startSpan(name, kind, parentSpanId, attributes);
        this.itemSpans.set(itemId, spanId);
        return;
      }
      const existing = this.itemSpans.get(itemId);
      if (existing) {
        this.endSpan(existing, "ok", attributes);
        return;
      }
      const spanId = this.startSpan(name, kind, parentSpanId, attributes);
      this.endSpan(spanId, "ok");
      return;
    }

    if (type === "turn.completed") {
      const usage =
        event.usage && typeof event.usage === "object"
          ? (event.usage as Record<string, unknown>)
          : {};
      const spanId = this.startSpan("model.turn", "model", parentSpanId, {
        inputTokens:
          typeof usage.input_tokens === "number" ? usage.input_tokens : null,
        outputTokens:
          typeof usage.output_tokens === "number" ? usage.output_tokens : null,
      });
      this.endSpan(spanId, "ok");
      return;
    }

    if (type === "error") {
      const spanId = this.startSpan("runtime.error", "runtime", parentSpanId, {
        message:
          typeof event.message === "string"
            ? event.message
            : typeof event.error === "string"
              ? event.error
              : "Codex error",
      });
      this.endSpan(spanId, "error");
      return;
    }

    const spanId = this.startSpan("runtime.event", "runtime", parentSpanId, {
      codexType: type,
    });
    this.endSpan(spanId, "ok");
  }
}

function kindForItem(itemType: string): SpanKind {
  if (itemType === "command_execution" || itemType === "command") {
    return "tool";
  }
  if (itemType === "file_change" || itemType === "files") {
    return "sandbox";
  }
  if (itemType === "agent_message" || itemType === "reasoning") {
    return "model";
  }
  return "runtime";
}

function itemAttributes(
  item: Record<string, unknown>,
): TraceSpan["attributes"] {
  const command = Array.isArray(item.command)
    ? item.command.map(String).join(" ")
    : typeof item.command === "string"
      ? item.command
      : typeof item.text === "string"
        ? item.text.slice(0, 180)
        : null;
  return {
    itemType: typeof item.type === "string" ? item.type : null,
    command,
    chars:
      typeof item.text === "string" ? item.text.length : null,
    exitCode:
      typeof item.exit_code === "number" ? item.exit_code : null,
  };
}
