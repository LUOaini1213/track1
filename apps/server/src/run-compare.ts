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

export function failingSpanIdentity(
  spans: TraceSpan[] | undefined,
): FailingSpanIdentity | null {
  const span = (spans ?? []).find(
    (item) => item.status === "error" || item.status === "denied",
  );
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
