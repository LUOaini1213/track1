import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { SpanKind, TraceSpan } from "./types.js";

/**
 * Export a Run's trace over OTLP/HTTP as JSON.
 *
 * The span model is already shaped by the OpenTelemetry GenAI semantic
 * conventions, so this is a mapping and a POST rather than a new abstraction:
 * the operator's existing Jaeger, Tempo, Datadog or collector receives Agent
 * Runs alongside everything else, with no new UI to adopt.
 *
 * Deliberately dependency-free. The OTLP/JSON encoding is small and stable
 * enough to write out, and pulling in the OpenTelemetry SDK for one exporter
 * would add far more surface than it removes.
 */

/**
 * OTLP wants a 16-byte trace id and an 8-byte span id, hex encoded. Ours are
 * UUIDs, whose hyphens and version bits do not fit that shape, so hash them.
 * SHA-256 truncated is deterministic and collision-resistant enough here: the
 * same Run always exports under the same ids, and re-exporting is idempotent.
 */
function toTraceId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function toSpanId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** OTLP timestamps are nanoseconds since the epoch, as a decimal string. */
function toUnixNano(iso: string): string | null {
  const ms = Date.parse(iso);
  // Falling back to 0 would place the span at the epoch, and a collector would
  // show a 1970 trace that nobody can tie back to anything. A span whose start
  // cannot be read is dropped instead.
  return Number.isFinite(ms) ? String(BigInt(ms) * 1_000_000n) : null;
}

/** Spans a collector can accept: a readable start time is the minimum. */
export function exportableSpans(spans: TraceSpan[]): TraceSpan[] {
  return spans.filter((span) => toUnixNano(span.startedAt) !== null);
}

/**
 * Split into batches a collector will accept. The OTLP/HTTP default body limit
 * is 4MB in the collector and most vendors; a single Run of 20k spans
 * serialises to 6.6MB, so an unbatched export of a long Run would be rejected
 * whole rather than partially delivered.
 */
export function batchSpans(spans: TraceSpan[], maxBytes: number): TraceSpan[][] {
  const batches: TraceSpan[][] = [];
  let current: TraceSpan[] = [];
  let size = 0;
  for (const span of spans) {
    // Measuring the encoded span is the honest unit; JSON.stringify of the raw
    // span is within a few percent of it and far cheaper than encoding twice.
    const cost = JSON.stringify(span).length + 256;
    if (current.length > 0 && size + cost > maxBytes) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(span);
    size += cost;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/**
 * SpanKind in OTLP is about the call's role, not the work's category. Our own
 * `kind` is the category, so it travels as an attribute and this maps to the
 * closest structural meaning: a tool call leaves the process (CLIENT), the rest
 * is work inside it (INTERNAL).
 */
function toOtlpKind(kind: SpanKind): number {
  return kind === "tool" || kind === "llm" ? 3 : 1; // CLIENT : INTERNAL
}

function toAnyValue(value: string | number | boolean | null): Record<string, unknown> {
  if (value === null) return { stringValue: "" };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}

export function toOtlpPayload(
  spans: TraceSpan[],
  options: { serviceName: string; runId: string },
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: options.serviceName } },
            { key: "launchpad.run.id", value: { stringValue: options.runId } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "launchpad-trace-plane" },
            spans: spans.map((span) => ({
              traceId: toTraceId(span.traceId),
              spanId: toSpanId(span.spanId),
              ...(span.parentSpanId
                ? { parentSpanId: toSpanId(span.parentSpanId) }
                : {}),
              name: span.name,
              kind: toOtlpKind(span.kind),
              startTimeUnixNano: toUnixNano(span.startedAt) ?? "0",
              // An unfinished span still has to carry an end time; use its start
              // so the receiver sees a zero-length span rather than one running
              // since 1970.
              endTimeUnixNano:
                toUnixNano(span.endedAt ?? span.startedAt) ??
                toUnixNano(span.startedAt) ??
                "0",
              attributes: [
                { key: "launchpad.span.kind", value: { stringValue: span.kind } },
                { key: "launchpad.agent.id", value: { stringValue: span.agentId } },
                ...Object.entries(span.attributes)
                  .filter(([, value]) => value !== null && value !== undefined)
                  .map(([key, value]) => ({ key, value: toAnyValue(value) })),
              ],
              status:
                span.status === "ok"
                  ? { code: 1 }
                  : {
                      code: 2,
                      message:
                        typeof span.attributes.errorText === "string"
                          ? span.attributes.errorText
                          : span.status,
                    },
            })),
          },
        ],
      },
    ],
  };
}

export interface OtlpExportResult {
  exported: number;
  endpoint: string;
  batches: number;
}

/**
 * Best-effort by design: a trace backend being unreachable must never turn a
 * successful Agent Run into a failed one. The caller logs what happened.
 */
export async function exportTrace(
  config: AppConfig,
  runId: string,
  spans: TraceSpan[],
): Promise<OtlpExportResult | null> {
  const usable = exportableSpans(spans);
  if (!config.otlpEndpoint || usable.length === 0) {
    return null;
  }
  const endpoint = config.otlpEndpoint.replace(/\/+$/, "") + "/v1/traces";
  const batches = batchSpans(usable, config.otlpMaxBatchBytes);
  for (const batch of batches) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.otlpTimeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...config.otlpHeaders,
        },
        body: JSON.stringify(
          toOtlpPayload(batch, { serviceName: config.otlpServiceName, runId }),
        ),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          "OTLP endpoint answered " + response.status + " " + response.statusText,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return { exported: usable.length, endpoint, batches: batches.length };
}
