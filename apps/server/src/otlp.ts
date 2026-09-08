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
function toUnixNano(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? String(BigInt(ms) * 1_000_000n) : "0";
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
              startTimeUnixNano: toUnixNano(span.startedAt),
              // An unfinished span still has to carry an end time; use its start
              // so the receiver sees a zero-length span rather than one running
              // since 1970.
              endTimeUnixNano: toUnixNano(span.endedAt ?? span.startedAt),
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
  if (!config.otlpEndpoint || spans.length === 0) {
    return null;
  }
  const endpoint = config.otlpEndpoint.replace(/\/+$/, "") + "/v1/traces";
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
        toOtlpPayload(spans, { serviceName: config.otlpServiceName, runId }),
      ),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        "OTLP endpoint answered " + response.status + " " + response.statusText,
      );
    }
    return { exported: spans.length, endpoint };
  } finally {
    clearTimeout(timer);
  }
}
