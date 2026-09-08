import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTicks, formatMs, layoutSpans } from "./waterfall";
import type { TraceSpan } from "./types";

const at = (offsetMs: number) =>
  new Date(Date.parse("2026-01-01T00:00:00.000Z") + offsetMs).toISOString();

const span = (over: Partial<TraceSpan>): TraceSpan => ({
  traceId: "t",
  spanId: "s",
  parentSpanId: null,
  runId: "r",
  agentId: "a",
  name: "execute_tool shell",
  kind: "tool",
  status: "ok",
  startedAt: at(0),
  endedAt: at(1000),
  durationMs: 1000,
  attributes: {},
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("waterfall geometry", () => {
  it("scales bars against the whole trace, not each span", () => {
    const { layout, totalMs } = layoutSpans([
      span({ spanId: "root", startedAt: at(0), endedAt: at(4000), durationMs: 4000 }),
      span({ spanId: "a", parentSpanId: "root", startedAt: at(0), endedAt: at(1000), durationMs: 1000 }),
      span({ spanId: "b", parentSpanId: "root", startedAt: at(2000), endedAt: at(4000), durationMs: 2000 }),
    ]);
    expect(totalMs).toBe(4000);
    expect(layout.get("a")?.offsetPercent).toBe(0);
    expect(layout.get("a")?.widthPercent).toBe(25);
    expect(layout.get("b")?.offsetPercent).toBe(50);
    expect(layout.get("b")?.widthPercent).toBe(50);
  });

  it("indents by parent chain, not by array position", () => {
    const { layout } = layoutSpans([
      span({ spanId: "deep", parentSpanId: "mid" }),
      span({ spanId: "root", parentSpanId: null }),
      span({ spanId: "mid", parentSpanId: "root" }),
    ]);
    expect(layout.get("root")?.depth).toBe(0);
    expect(layout.get("mid")?.depth).toBe(1);
    expect(layout.get("deep")?.depth).toBe(2);
  });

  it("keeps an in-flight span on the track instead of clipping it away", () => {
    // An open span contributed only its own start to the time base, so it landed
    // at offset 100% with the minimum width — outside a track that clips, which
    // meant the one row a user watches during a run showed an empty bar.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(at(8000))));
    const { layout } = layoutSpans([
      span({ spanId: "root", startedAt: at(0), endedAt: null, durationMs: null }),
      span({ spanId: "done", parentSpanId: "root", startedAt: at(1000), endedAt: at(3000), durationMs: 2000 }),
      span({ spanId: "live", parentSpanId: "root", startedAt: at(4000), endedAt: null, durationMs: null }),
    ]);
    const live = layout.get("live");
    expect(live?.offsetPercent).toBeCloseTo(50, 5);
    expect(live?.widthPercent).toBeCloseTo(50, 5);
    expect((live?.offsetPercent ?? 0) + (live?.widthPercent ?? 0)).toBeLessThanOrEqual(100.5);
  });

  it("never starts a bar past the end of the track", () => {
    const { layout } = layoutSpans([
      span({ spanId: "root", startedAt: at(0), endedAt: at(10_000), durationMs: 10_000 }),
      span({ spanId: "last", parentSpanId: "root", startedAt: at(10_000), endedAt: at(10_000), durationMs: 0 }),
    ]);
    expect(layout.get("last")?.offsetPercent).toBeLessThanOrEqual(98.5);
  });

  it("survives a cycle in the parent chain", () => {
    const { layout } = layoutSpans([
      span({ spanId: "a", parentSpanId: "b" }),
      span({ spanId: "b", parentSpanId: "a" }),
    ]);
    expect(layout.size).toBe(2);
  });

  it("does not divide by zero when a trace is instantaneous", () => {
    const { layout, totalMs, ticks } = layoutSpans([
      span({ spanId: "x", startedAt: at(0), endedAt: at(0), durationMs: 0 }),
    ]);
    expect(totalMs).toBe(1);
    expect(ticks).toEqual([]);
    expect(Number.isFinite(layout.get("x")?.widthPercent)).toBe(true);
  });

  it("handles an empty trace", () => {
    expect(layoutSpans([])).toEqual({ layout: new Map(), totalMs: 0, ticks: [] });
  });

  it("does not overflow the stack on a large trace", () => {
    // Math.min(...spans) threw RangeError here; the fold does not.
    const many = Array.from({ length: 200_000 }, (_, i) =>
      span({ spanId: "s" + i, startedAt: at(i), endedAt: at(i + 1), durationMs: 1 }),
    );
    expect(() => layoutSpans(many)).not.toThrow();
  });
});

describe("axis ticks", () => {
  it("chooses round 1/2/5 steps inside the trace", () => {
    expect(buildTicks(4000)).toEqual([1000, 2000, 3000]);
    expect(buildTicks(900)).toEqual([200, 400, 600, 800]);
  });

  it("labels the axis rather than leaving a single tick on it", () => {
    // Rounding the step up instead of to the nearest candidate left 900ms and
    // 9s traces with one tick for the whole axis.
    for (const total of [300, 900, 1500, 2400, 4000, 9000, 12_659, 26_607]) {
      expect(buildTicks(total).length, String(total)).toBeGreaterThan(1);
    }
  });

  it("emits nothing for a trace too short to label", () => {
    expect(buildTicks(1)).toEqual([]);
    expect(buildTicks(0)).toEqual([]);
  });

  it("never places a tick at or past the total", () => {
    for (const total of [37, 250, 1234, 45_678, 3_600_000]) {
      for (const tick of buildTicks(total)) {
        expect(tick).toBeLessThan(total);
        expect(tick).toBeGreaterThan(0);
      }
    }
  });
});

describe("duration formatting", () => {
  it("switches to seconds above a second and drops the decimal above ten", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(999)).toBe("999ms");
    expect(formatMs(1000)).toBe("1.0s");
    expect(formatMs(12_659)).toBe("13s");
  });
});
