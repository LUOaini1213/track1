import { randomUUID } from "node:crypto";
import { redactDeep } from "./redact.js";
import type { SpanKind, SpanStatus, TraceSpan } from "./types.js";

const now = () => new Date().toISOString();

/**
 * Attributes that can echo user or workspace content. OpenTelemetry keeps the
 * equivalent GenAI content attributes Opt-In because of the PII risk, so the
 * same switch exists here (`TRACE_CAPTURE_CONTENT`). It defaults ON: an audit
 * tool whose deliverable is "which command failed, and with what exit code"
 * would gut its own root-cause story with content off.
 */
const CONTENT_ATTRIBUTE_KEYS = [
  "command",
  "errorText",
  "failedStep",
  "message",
  "workspace",
];

const CONTENT_WITHHELD = "[content capture disabled]";

/**
 * How long to coalesce span writes before persisting mid-Run.
 *
 * Every interim persist rewrites the whole store, so its cost grows with total
 * history, not with this Run: measured at 2.5ms for a 63KB store but 237ms at
 * 18MB. The only consumer of these interim writes is the Playground, which
 * polls an active Run every 900ms — so a 40ms debounce was firing roughly 22
 * times per poll to produce state nobody read, and at scale the writes could
 * not keep up with the interval that scheduled them.
 *
 * 300ms still lands several updates inside every poll while cutting the write
 * volume ~7x. The authoritative write is `persistTrace` at the end of the Run.
 */
const PERSIST_DEBOUNCE_MS = 300;

export interface TraceCollectorOptions {
  onChange?: (spans: TraceSpan[]) => void | Promise<void>;
  persistDebounceMs?: number;
  /** `gen_ai.request.model`, used to build low-cardinality `chat {model}` names. */
  modelName?: string | null;
  /** Mirrors the OTel Opt-In rule for content attributes. Defaults to true. */
  captureContent?: boolean;
}

export class TraceCollector {
  readonly traceId: string;
  readonly spans: TraceSpan[] = [];
  private readonly itemSpans = new Map<string, string>();
  private readonly onChange:
    | ((spans: TraceSpan[]) => void | Promise<void>)
    | undefined;
  private readonly persistDebounceMs: number;
  private readonly modelName: string | null;
  private readonly captureContent: boolean;

  constructor(
    private readonly runId: string,
    private readonly agentId: string,
    options: TraceCollectorOptions = {},
  ) {
    this.traceId = randomUUID();
    this.onChange = options.onChange;
    this.persistDebounceMs = options.persistDebounceMs ?? PERSIST_DEBOUNCE_MS;
    this.modelName = options.modelName ?? null;
    this.captureContent = options.captureContent ?? true;
  }

  private applyContentPolicy(
    attributes: TraceSpan["attributes"],
  ): TraceSpan["attributes"] {
    if (this.captureContent) {
      return attributes;
    }
    const next = { ...attributes };
    for (const key of CONTENT_ATTRIBUTE_KEYS) {
      if (next[key] !== undefined && next[key] !== null) {
        next[key] = CONTENT_WITHHELD;
      }
    }
    return next;
  }

  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private schedulePersist(): void {
    if (!this.onChange) {
      return;
    }
    if (this.persistDebounceMs <= 0) {
      void this.onChange(this.snapshot());
      return;
    }
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.onChange?.(this.snapshot());
    }, this.persistDebounceMs);
    this.persistTimer.unref?.();
  }

  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    void this.onChange?.(this.snapshot());
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
      attributes: redactDeep(this.applyContentPolicy(attributes)),
    });
    this.schedulePersist();
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
    span.attributes = redactDeep(
      this.applyContentPolicy({ ...span.attributes, ...attributes }),
    );
    this.schedulePersist();
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
      const name = spanNameForItem(itemType);
      const attributes = this.withRetryLink(
        { ...itemAttributes(item), ...otelItemAttributes(itemType) },
        item,
      );
      const status = itemStatus(item);
      if (type === "item.started") {
        const spanId = this.startSpan(name, kind, parentSpanId, attributes);
        this.itemSpans.set(itemId, spanId);
        return;
      }
      const existing = this.itemSpans.get(itemId);
      if (existing) {
        this.endSpan(existing, status, attributes);
        return;
      }
      const spanId = this.startSpan(name, kind, parentSpanId, attributes);
      this.itemSpans.set(itemId, spanId);
      this.endSpan(spanId, status);
      return;
    }

    if (type === "turn.completed") {
      const usage =
        event.usage && typeof event.usage === "object"
          ? (event.usage as Record<string, unknown>)
          : {};
      const spanId = this.startSpan(
        this.modelName ? "chat " + this.modelName : "chat",
        "llm",
        parentSpanId,
        {
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": this.modelName,
          "gen_ai.usage.input_tokens":
            typeof usage.input_tokens === "number" ? usage.input_tokens : null,
          "gen_ai.usage.output_tokens":
            typeof usage.output_tokens === "number" ? usage.output_tokens : null,
          "gen_ai.usage.cache_read.input_tokens":
            typeof usage.cached_input_tokens === "number"
              ? usage.cached_input_tokens
              : null,
          // Provenance, not a conformance claim: these are the counts Codex
          // reports on turn.completed. OTel expects gen_ai.usage.input_tokens
          // to be the billed, cache-inclusive count; we do not know that the
          // Codex number is either, so the USD figure stays labelled "est.".
          "gen_ai.usage.source": "codex turn.completed",
        },
      );
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
      keys: Object.keys(event).sort().join(","),
      chars: typeof event.chars === "number" ? event.chars : null,
    });
    this.endSpan(spanId, "ok");
  }

  private withRetryLink(
    attributes: TraceSpan["attributes"],
    item: Record<string, unknown>,
  ): TraceSpan["attributes"] {
    const retryOfItem = retrySourceId(item);
    if (!retryOfItem) {
      return attributes;
    }
    const retriedSpanId = this.itemSpans.get(retryOfItem) ?? null;
    return {
      ...attributes,
      retryOfItemId: retryOfItem,
      retriedSpanId,
    };
  }
}

function itemStatus(item: Record<string, unknown>): SpanStatus {
  if (typeof item.exit_code === "number" && item.exit_code !== 0) {
    return "error";
  }
  if (item.status === "failed" || item.status === "error") {
    return "error";
  }
  // Codex also surfaces errors as an item whose *type* is "error", carrying a
  // message and nothing else. `status` is absent on those, so checking it is
  // not enough. The Run itself can still complete — an errored span under a
  // successful root is exactly what a waterfall is for.
  if (item.type === "error") {
    return "error";
  }
  return "ok";
}

function kindForItem(itemType: string): SpanKind {
  if (itemType === "command_execution" || itemType === "command") {
    return "tool";
  }
  if (itemType === "file_change" || itemType === "files") {
    return "sandbox";
  }
  if (itemType === "agent_message" || itemType === "reasoning") {
    return "llm";
  }
  return "runtime";
}

/** The OTel tool name a Codex item maps onto, or null when it is not a tool. */
function toolNameForItem(itemType: string): string | null {
  if (itemType === "command_execution" || itemType === "command") {
    return "shell";
  }
  if (itemType === "file_change" || itemType === "files") {
    return "apply_patch";
  }
  return null;
}

/**
 * OTel forms span names as `{operation} {name}` and asks them to stay
 * low-cardinality, so the tool name is used rather than the command itself.
 */
function spanNameForItem(itemType: string): string {
  const toolName = toolNameForItem(itemType);
  if (toolName) {
    return "execute_tool " + toolName;
  }
  if (itemType === "agent_message" || itemType === "reasoning") {
    return "chat " + itemType;
  }
  return "runtime." + itemType;
}

function otelItemAttributes(itemType: string): TraceSpan["attributes"] {
  const toolName = toolNameForItem(itemType);
  if (toolName) {
    return {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": toolName,
      "gen_ai.tool.type": "extension",
    };
  }
  if (itemType === "agent_message" || itemType === "reasoning") {
    return { "gen_ai.operation.name": "chat" };
  }
  return {};
}

function retrySourceId(item: Record<string, unknown>): string | null {
  if (typeof item.retry_of === "string") {
    return item.retry_of;
  }
  if (typeof item.previous_item_id === "string") {
    return item.previous_item_id;
  }
  return null;
}

function firstString(
  ...values: unknown[]
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.slice(0, 240);
    }
  }
  return null;
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
  const failed = itemStatus(item) === "error";
  const errorText = failed
    ? firstString(
        item.message,
        item.stderr,
        item.error,
        item.aggregated_output,
        item.output,
      )
    : null;
  return {
    itemType: typeof item.type === "string" ? item.type : null,
    command,
    chars:
      typeof item.text === "string" ? item.text.length : null,
    exitCode:
      typeof item.exit_code === "number" ? item.exit_code : null,
    errorText,
    // Never fall back to the bare word "command": an error item has no command,
    // and "failing step: command" is worse than saying what actually happened.
    failedStep: failed
      ? (command ?? errorText ?? String(item.type ?? "step")) +
        (typeof item.exit_code === "number"
          ? " (exit " + String(item.exit_code) + ")"
          : "")
      : command,
  };
}
