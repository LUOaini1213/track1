import { estimateCostUsd, type CostRates } from "./cost.js";
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

/**
 * Depth of every span, computed once. Walking the parent chain inside a sort
 * comparator recomputes the same chain O(log n) times per span; this is O(n·d)
 * and the result is reused by every caller that needs the hierarchy.
 */
export function spanDepths(spans: TraceSpan[]): Map<string, number> {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const depths = new Map<string, number>();
  const resolve = (span: TraceSpan, seen: Set<string>): number => {
    const cached = depths.get(span.spanId);
    if (cached !== undefined) {
      return cached;
    }
    // A parent outside this trace, or a cycle, terminates the walk.
    const parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
    const depth =
      !parent || seen.has(parent.spanId)
        ? span.parentSpanId
          ? 1
          : 0
        : resolve(parent, new Set(seen).add(span.spanId)) + 1;
    depths.set(span.spanId, depth);
    return depth;
  };
  for (const span of spans) {
    resolve(span, new Set([span.spanId]));
  }
  return depths;
}

/**
 * A failure marks every span on the path to it — `run.execute` and
 * `runtime.spawn` are flagged too, but they are wrappers with no diagnostic
 * attributes, and the steps that were merely mid-flight when the Run died get
 * flagged as well. Pick the innermost problem span that actually explains the
 * failure, so "Open failing step" lands on the denied policy rule or the
 * command that exited non-zero rather than on an empty envelope.
 */
export function problemSpans(spans: TraceSpan[]): TraceSpan[] {
  const problems = spans.filter(
    (item) => item.status === "error" || item.status === "denied",
  );
  if (problems.length === 0) {
    return [];
  }
  const depths = spanDepths(spans);
  const order = new Map(spans.map((span, index) => [span.spanId, index]));
  return [...problems].sort((left, right) => {
    // 1. A span that failed on its own beats one that was merely still open
    //    when the Run ended. `endOpenSpans` closes those with a placeholder
    //    errorText ("Run ended before this step completed"), and rule 2 below
    //    cannot tell that placeholder apart from a real exit code — so this
    //    rule has to come first. Without it the `chat` span Codex left open
    //    outranked the command that actually exited 1: it tied on diagnostics,
    //    tied on depth (siblings under `runtime.spawn`), and won "earliest
    //    first" because it opened 40ms in while the command failed at 1600ms.
    //    "Open failing step" then landed on a sentence that says nothing, on
    //    both failure fixtures — including the denied-policy Run the demo
    //    script is built around.
    //    Compare booleans, not the raw attribute: `Number(undefined)` is NaN,
    //    and a comparator that can return NaN is no longer a total order, so
    //    the remaining rules would silently stop running.
    const unterminated =
      (left.attributes.unterminated === true ? 1 : 0) -
      (right.attributes.unterminated === true ? 1 : 0);
    if (unterminated !== 0) return unterminated;
    // 2. A span that can explain the failure beats one that cannot.
    const explains = Number(hasDiagnostics(right)) - Number(hasDiagnostics(left));
    if (explains !== 0) return explains;
    // 3. Innermost first — the wrappers on the path carry no detail.
    const depth = (depths.get(right.spanId) ?? 0) - (depths.get(left.spanId) ?? 0);
    if (depth !== 0) return depth;
    // 4. Earliest first. When one Run fails several times the first failure is
    //    usually the cause and the rest are cascades, so it is the better
    //    landing point. This previously fell out of sort stability by accident.
    return (order.get(left.spanId) ?? 0) - (order.get(right.spanId) ?? 0);
  });
}

export function pickFailingSpan(spans: TraceSpan[]): TraceSpan | null {
  return problemSpans(spans)[0] ?? null;
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

export function summarizeRun(
  run: AgentRun,
  rates: CostRates | null,
): RunCompareSide {
  return {
    runId: run.id,
    status: run.status,
    durationMs: runDurationMs(run),
    usage: run.usage,
    estimatedCostUsd: estimateCostUsd(run.usage, rates),
    failingSpan: failingSpanIdentity(run.spans),
  };
}

export function compareRuns(
  left: AgentRun,
  right: AgentRun,
  rates: CostRates | null,
): { left: RunCompareSide; right: RunCompareSide } {
  return { left: summarizeRun(left, rates), right: summarizeRun(right, rates) };
}
