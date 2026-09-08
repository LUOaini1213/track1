import type { TraceSpan } from "./types";

/**
 * Waterfall geometry. Depth and the time base are computed over the FULL span
 * list, never the filtered one — filtering must not re-flatten the hierarchy or
 * re-scale the bars.
 */
export interface SpanLayout {
  depth: number;
  offsetPercent: number;
  widthPercent: number;
  hasChildren: boolean;
}

export interface Waterfall {
  layout: Map<string, SpanLayout>;
  totalMs: number;
  ticks: number[];
}

export function layoutSpans(spans: TraceSpan[]): Waterfall {
  const layout = new Map<string, SpanLayout>();
  if (spans.length === 0) {
    return { layout, totalMs: 0, ticks: [] };
  }
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const parents = new Set(
    spans.map((span) => span.parentSpanId).filter((id): id is string => !!id),
  );
  // Fold rather than spread: Math.min(...arr) overflows the stack on a large
  // trace, and a long-running Agent can produce thousands of spans.
  let base = Infinity;
  let end = -Infinity;
  let hasOpenSpan = false;
  for (const span of spans) {
    const from = Date.parse(span.startedAt);
    const to = span.endedAt ? Date.parse(span.endedAt) : from;
    if (!span.endedAt) hasOpenSpan = true;
    if (from < base) base = from;
    if (to > end) end = to;
  }
  // An in-flight span has no end yet. Bounding the trace by its start put it at
  // offset 100% with the minimum width — off the right edge of a track that
  // clips — so the one row the user is watching showed an empty bar and "…".
  // Math.max keeps this correct when the server clock runs ahead of ours.
  if (hasOpenSpan) {
    end = Math.max(end, Date.now());
  }
  // A trace that starts and ends inside the same millisecond would divide by
  // zero; clamp so every bar still renders at a visible minimum width.
  const total = Math.max(1, end - base);
  for (const span of spans) {
    let depth = 0;
    let current: TraceSpan | undefined = span;
    const seen = new Set<string>();
    while (current?.parentSpanId && !seen.has(current.spanId)) {
      seen.add(current.spanId);
      current = byId.get(current.parentSpanId);
      depth += 1;
    }
    const offset = Date.parse(span.startedAt) - base;
    const duration = span.durationMs ?? Math.max(0, end - Date.parse(span.startedAt));
    layout.set(span.spanId, {
      depth,
      offsetPercent: Math.min(98.5, (offset / total) * 100),
      widthPercent: Math.max(1.5, (duration / total) * 100),
      hasChildren: parents.has(span.spanId),
    });
  }
  return { layout, totalMs: total, ticks: buildTicks(total) };
}

/**
 * Round tick values for the time axis: 1/2/5 x 10^n, aiming for ~4 ticks.
 *
 * Picks the candidate step *nearest* the ideal, not the first one at or above
 * it. Rounding up always overshoots, and on a 900ms or 9s trace it overshot far
 * enough to leave a single tick on the whole axis; across a dozen realistic run
 * durations it produced two ticks where four were intended.
 */
export function buildTicks(totalMs: number): number[] {
  if (totalMs <= 1) {
    return [];
  }
  const ideal = totalMs / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(ideal)));
  const step = [1, 2, 5, 10]
    .map((multiple) => multiple * magnitude)
    .reduce((best, candidate) =>
      Math.abs(candidate - ideal) < Math.abs(best - ideal) ? candidate : best,
    );
  const ticks: number[] = [];
  for (let at = step; at < totalMs; at += step) {
    ticks.push(at);
  }
  return ticks;
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? (ms / 1000).toFixed(ms >= 10_000 ? 0 : 1) + "s" : Math.round(ms) + "ms";
}
