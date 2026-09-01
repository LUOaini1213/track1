import { estimateCostUsd } from "./cost.js";
import type { AgentRun, TraceSpan } from "./types.js";

export interface FailingSpanIdentity {
  spanId: string;
  name: string;
  kind: string;
  status: string;
  command: string | null;
  exitCode: number | null;
  errorText: string | null;
}

export interface RunCompareSide {
  runId: string;
  status: AgentRun["status"];
  durationMs: number | null;
  usage: AgentRun["usage"];
  estimatedCostUsd: number | null;
  failingSpan: FailingSpanIdentity | null;
}

export function runDurationMs(run: AgentRun): number | null {
  if (!run.startedAt || !run.completedAt) {
    return null;
  }
  return Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt));
}

/** Attributes that let a reviewer say *why* the Run failed. */
const DIAGNOSTIC_KEYS = [
  "errorText",
  "exitCode",
  "reason",
  "ruleId",
  "error",
  "failedStep",
] as const;

function hasDiagnostics(span: TraceSpan): boolean {
  return DIAGNOSTIC_KEYS.some((key) => {
    const value = span.attributes[key];
    return value !== undefined && value !== null;
  });
}

function spanDepth(span: TraceSpan, byId: Map<string, TraceSpan>): number {
  let depth = 0;
  let current: TraceSpan | undefined = span;
  const seen = new Set<string>();
  while (current?.parentSpanId && !seen.has(current.spanId)) {
    seen.add(current.spanId);
    current = byId.get(current.parentSpanId);
    depth += 1;
  }
  return depth;
}

/**
 * A failure marks every span on the path to it — `run.execute` and
 * `runtime.spawn` are flagged too, but they are wrappers with no diagnostic
 * attributes. Pick the innermost problem span that actually explains the
 * failure, so "Open failing step" lands on the denied policy rule or the
 * command that exited non-zero rather than on an empty envelope.
 */
export function pickFailingSpan(spans: TraceSpan[]): TraceSpan | null {
  const problems = spans.filter(
    (item) => item.status === "error" || item.status === "denied",
  );
  if (problems.length === 0) {
    return null;
  }
  const byId = new Map(spans.map((item) => [item.spanId, item]));
  const ranked = [...problems].sort(
    (left, right) => spanDepth(right, byId) - spanDepth(left, byId),
  );
  return ranked.find(hasDiagnostics) ?? ranked[0] ?? null;
}

export function failingSpanIdentity(
  spans: TraceSpan[] | undefined,
): FailingSpanIdentity | null {
  const span = pickFailingSpan(spans ?? []);
  if (!span) {
    return null;
  }
  return {
    spanId: span.spanId,
    name: span.name,
    kind: span.kind,
    status: span.status,
    command:
      typeof span.attributes.command === "string"
        ? span.attributes.command
        : null,
    exitCode:
      typeof span.attributes.exitCode === "number"
        ? span.attributes.exitCode
        : null,
    errorText:
      typeof span.attributes.errorText === "string"
        ? span.attributes.errorText
        : null,
  };
}

export function summarizeRun(run: AgentRun): RunCompareSide {
  return {
    runId: run.id,
    status: run.status,
    durationMs: runDurationMs(run),
    usage: run.usage,
    estimatedCostUsd: estimateCostUsd(run.usage),
    failingSpan: failingSpanIdentity(run.spans),
  };
}

export function compareRuns(
  left: AgentRun,
  right: AgentRun,
): { left: RunCompareSide; right: RunCompareSide } {
  return { left: summarizeRun(left), right: summarizeRun(right) };
}
