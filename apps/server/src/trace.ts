import { randomUUID } from "node:crypto";
import { redactDeep } from "./redact.js";
import type { SpanKind, SpanStatus, TraceSpan } from "./types.js";

const now = () => new Date().toISOString();

/**
 * Attributes that carry no user or workspace content, and so survive
 * `TRACE_CAPTURE_CONTENT=false`. OpenTelemetry keeps the equivalent GenAI
 * content attributes Opt-In because of the PII risk, so the same switch exists
 * here. It defaults ON: an audit tool whose deliverable is "which command
 * failed, and with what exit code" would gut its own root-cause story with
 * content off.
 *
 * This is an allowlist rather than a denylist because a denylist fails open.
 * The previous version listed the five content-bearing keys it knew about, and
 * `error` — which AgentService writes on the root span, carrying up to 16 KB of
 * Codex stderr — was not among them, so the switch silently half-worked. Now an
 * attribute the next call site invents is withheld until it is named safe.
 *
 * `ruleId` and `reason` are our own static rule text, not user data.
 */
const STRUCTURAL_ATTRIBUTE_KEYS = new Set([
  "promptChars",
  "chars",
  "exitCode",
  "itemType",
  "ruleId",
  "reason",
  "threadId",
  "codexType",
  "keys",
  "retryOfItemId",
  "retriedSpanId",
  "fileCount",
  "unterminated",
]);

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
  private turnSpanId: string | null = null;
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
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === null) {
        continue;
      }
      const structural =
        key.startsWith("gen_ai.") || STRUCTURAL_ATTRIBUTE_KEYS.has(key);
      if (!structural) {
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

  /**
   * Close every span the runtime left open. Codex opens a span on item.started
   * and closes it on item.completed, so a Run that is denied, cancelled or dies
   * mid-command left that span at status "ok" with endedAt null — stored that
   * way forever, rendered as a still-running "…" in a finished Run, and in the
   * deny case the denied command was the one green span in the trace.
   *
   * Walks in reverse so children close before their parents.
   */
  endOpenSpans(status: SpanStatus, attributes: TraceSpan["attributes"] = {}): void {
    for (let index = this.spans.length - 1; index >= 0; index -= 1) {
      const span = this.spans[index];
      if (span && span.endedAt === null) {
        this.endSpan(span.spanId, status, { ...attributes, unterminated: true });
      }
    }
  }

  private chatSpanName(): string {
    return this.modelName ? "chat " + this.modelName : "chat";
  }

  /**
   * End the turn span opened by turn.started, or synthesise one when the
   * runtime never sent turn.started (older Codex builds, or a stream that began
   * mid-turn) so usage is still recorded.
   */
  private closeTurnSpan(
    status: SpanStatus,
    attributes: TraceSpan["attributes"],
    parentSpanId: string,
  ): void {
    const spanId =
      this.turnSpanId ??
      this.startSpan(this.chatSpanName(), "llm", parentSpanId, attributes);
    this.turnSpanId = null;
    this.endSpan(spanId, status, attributes);
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

    // A turn is the model's own work: it opens before the first item and closes
    // when the model is done. Creating the span only on turn.completed made
    // every `chat` span 0 ms, so the component that consumed almost all the wall
    // time — 7.6-26.6 s per Run in the stored traces — had no width in the
    // waterfall and a reader could not tell a model stall from a slow tool.
    //
    // Items stay parented to runtime.spawn rather than to this span. Nesting
    // them here would be more faithful, but it changes depth for every existing
    // consumer, and the turn span already covers their wall time.
    if (type === "turn.started") {
      this.turnSpanId = this.startSpan(this.chatSpanName(), "llm", parentSpanId, {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": this.modelName,
      });
      return;
    }

    if (type === "turn.completed") {
      const usage =
        event.usage && typeof event.usage === "object"
          ? (event.usage as Record<string, unknown>)
          : {};
      const usageAttributes: TraceSpan["attributes"] = {
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
      };
      this.closeTurnSpan("ok", usageAttributes, parentSpanId);
      return;
    }

    // Codex reports a failed turn — a 429, a context overflow — with the reason
    // under `error`. With no branch for it this fell through to the generic
    // green runtime.event span and the message was dropped, leaving the Run to
    // report only "Codex exited with code 1: No error detail".
    if (type === "turn.failed") {
      const message = errorMessageOf(event.error) ?? "Codex turn failed";
      this.closeTurnSpan(
        "error",
        {
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": this.modelName,
          errorText: message,
          failedStep: message,
        },
        parentSpanId,
      );
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

/** Codex reports turn errors as `{message}` on some events and a bare string on others. */
function errorMessageOf(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.slice(0, 500);
  }
  if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.slice(0, 500);
    }
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

/** Like firstString, but keeps the END — where a failure explains itself. */
function lastString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trimEnd().slice(-240);
    }
  }
  return null;
}

function itemAttributes(
  item: Record<string, unknown>,
): TraceSpan["attributes"] {
  // `command` is the command. Assistant and reasoning text used to fall through
  // into it, so a chat span claimed to have executed its own prose.
  const command = Array.isArray(item.command)
    ? item.command.map(String).join(" ")
    : typeof item.command === "string"
      ? item.command
      : null;
  const text = typeof item.text === "string" ? item.text : null;
  const failed = itemStatus(item) === "error";
  // Head-first for fields that are already a message; tail-first for captured
  // output, where the reason a command failed is at the end. `npm test` failing
  // after twelve green files used to show the banner and the passing lines.
  const errorText = failed
    ? (firstString(item.message, item.stderr, item.error) ??
      lastString(item.aggregated_output, item.output))
    : null;
  const changes = Array.isArray(item.changes) ? item.changes : null;
  return {
    itemType: typeof item.type === "string" ? item.type : null,
    command,
    text: text ? text.slice(0, 240) : null,
    chars: text ? text.length : null,
    exitCode: typeof item.exit_code === "number" ? item.exit_code : null,
    // A file_change item's only payload is which files it touched.
    files: changes
      ? changes
          .map((change) => {
            const entry = change as { kind?: unknown; path?: unknown };
            return [entry.kind, entry.path].filter(Boolean).join(" ");
          })
          .filter(Boolean)
          .join(", ")
          .slice(0, 240) || null
      : null,
    fileCount: changes ? changes.length : null,
    query: typeof item.query === "string" ? item.query.slice(0, 240) : null,
    errorText,
    // Only a failure has a failing step. This was set on every span, so the
    // Playground printed "failing step: npm test" next to a command that exited
    // 0, and "failing step: <assistant prose>" on green chat spans.
    failedStep: failed
      ? (command ?? errorText ?? String(item.type ?? "step")) +
        (typeof item.exit_code === "number"
          ? " (exit " + String(item.exit_code) + ")"
          : "")
      : null,
  };
}
