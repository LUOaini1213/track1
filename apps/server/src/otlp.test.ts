import { describe, expect, it, vi, afterEach } from "vitest";
import { batchSpans, exportableSpans, exportTrace, toOtlpPayload } from "./otlp.js";
import { loadConfig } from "./config.js";
import type { TraceSpan } from "./types.js";

const span = (over: Partial<TraceSpan>): TraceSpan => ({
  traceId: "11111111-1111-4111-8111-111111111111",
  spanId: "22222222-2222-4222-8222-222222222222",
  parentSpanId: null,
  runId: "r",
  agentId: "a",
  name: "execute_tool shell",
  kind: "tool",
  status: "ok",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:01.500Z",
  durationMs: 1500,
  attributes: {},
  ...over,
});

const config = (extra: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: "test", LOG_LEVEL: "silent",
    APP_DATA_DIR: ".data", AGENT_WORKSPACE_ROOT: "workspaces", CODEX_HOME: "codex-home",
    ...extra,
  });

const payloadSpans = (spans: TraceSpan[]) =>
  (toOtlpPayload(spans, { serviceName: "svc", runId: "r" }) as never as {
    resourceSpans: { scopeSpans: { spans: Record<string, never>[] }[] }[];
  }).resourceSpans[0]!.scopeSpans[0]!.spans;

afterEach(() => vi.unstubAllGlobals());

describe("OTLP payload", () => {
  it("encodes ids at the widths OTLP requires", () => {
    // Our ids are UUIDs; OTLP wants 16 and 8 raw bytes as hex.
    const [encoded] = payloadSpans([span({})]);
    expect(encoded!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(encoded!.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("maps the same id to the same value every time", () => {
    const first = payloadSpans([span({})])[0];
    const second = payloadSpans([span({})])[0];
    expect(first!.traceId).toBe(second!.traceId);
    // Re-exporting a Run must not create a second trace in the backend.
  });

  it("links a child to its parent, and omits the field at the root", () => {
    const [child, root] = payloadSpans([
      span({ spanId: "33333333-3333-4333-8333-333333333333", parentSpanId: "22222222-2222-4222-8222-222222222222" }),
      span({}),
    ]);
    expect(child!.parentSpanId).toBe(root!.spanId);
    expect(root).not.toHaveProperty("parentSpanId");
  });

  it("uses nanosecond timestamps", () => {
    const [encoded] = payloadSpans([span({})]);
    expect(encoded!.startTimeUnixNano).toBe(
      String(BigInt(Date.parse("2026-01-01T00:00:00.000Z")) * 1_000_000n),
    );
    expect(encoded!.endTimeUnixNano).toBe(
      String(BigInt(Date.parse("2026-01-01T00:00:01.500Z")) * 1_000_000n),
    );
  });

  it("gives an unfinished span an end time rather than one running since 1970", () => {
    const [encoded] = payloadSpans([span({ endedAt: null, durationMs: null })]);
    expect(encoded!.endTimeUnixNano).toBe(encoded!.startTimeUnixNano);
    expect(encoded!.endTimeUnixNano).not.toBe("0");
  });

  it("marks a failed span with the OTLP error code and its reason", () => {
    const [encoded] = payloadSpans([
      span({ status: "error", attributes: { errorText: "AssertionError: expected 3 to be 4" } }),
    ]);
    expect(encoded!.status).toEqual({
      code: 2,
      message: "AssertionError: expected 3 to be 4",
    });
  });

  it("keeps the gen_ai attributes and types them", () => {
    const [encoded] = payloadSpans([
      span({
        attributes: {
          "gen_ai.usage.input_tokens": 900,
          "gen_ai.request.model": "ep-test",
          unterminated: true,
          dropped: null,
        },
      }),
    ]);
    const attributes = encoded!.attributes as unknown as {
      key: string;
      value: Record<string, unknown>;
    }[];
    const byKey = Object.fromEntries(attributes.map((a) => [a.key, a.value]));
    expect(byKey["gen_ai.usage.input_tokens"]).toEqual({ intValue: "900" });
    expect(byKey["gen_ai.request.model"]).toEqual({ stringValue: "ep-test" });
    expect(byKey["unterminated"]).toEqual({ boolValue: true });
    // A null attribute carries nothing; sending it as "" would be a lie.
    expect(byKey).not.toHaveProperty("dropped");
    // Our own taxonomy travels as an attribute, since OTLP's kind means
    // something else.
    expect(byKey["launchpad.span.kind"]).toEqual({ stringValue: "tool" });
  });
});

describe("OTLP export", () => {
  it("does nothing when no endpoint is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await exportTrace(config(), "r", [span({})])).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to /v1/traces with the configured headers", async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => ({ ok: true, status: 200, statusText: "OK" }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await exportTrace(
      config({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/",
        OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=secret, x-tenant = acme",
      }),
      "r",
      [span({})],
    );
    expect(result).toEqual({
      exported: 1,
      endpoint: "https://collector.example/v1/traces",
      batches: 1,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://collector.example/v1/traces");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("secret");
    expect(headers["x-tenant"]).toBe("acme");
  });

  it("raises when the collector rejects the batch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 413, statusText: "Payload Too Large" }) as Response),
    );
    await expect(
      exportTrace(
        config({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example" }),
        "r",
        [span({})],
      ),
    ).rejects.toThrow(/413/);
  });
});
describe("batching", () => {
  it("splits a trace too large for a collector's body limit", () => {
    // 20k spans serialise to 6.6MB; the OTLP/HTTP default limit is 4MB, so an
    // unbatched export of a long Run would be rejected whole.
    const many = Array.from({ length: 20_000 }, (_, i) => span({ spanId: "s" + i }));
    const batches = batchSpans(many, 3_500_000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toHaveLength(20_000);
    for (const batch of batches) {
      const bytes = JSON.stringify(
        toOtlpPayload(batch, { serviceName: "s", runId: "r" }),
      ).length;
      expect(bytes).toBeLessThan(4_000_000);
    }
  });

  it("keeps a normal trace in one request", () => {
    const spans = Array.from({ length: 12 }, (_, i) => span({ spanId: "s" + i }));
    expect(batchSpans(spans, 3_500_000)).toHaveLength(1);
  });

  it("never emits an empty batch, even for one oversized span", () => {
    expect(batchSpans([span({})], 1)).toHaveLength(1);
    expect(batchSpans([], 3_500_000)).toEqual([]);
  });

  it("posts every batch", async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => ({ ok: true, status: 200, statusText: "OK" }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    const many = Array.from({ length: 300 }, (_, i) => span({ spanId: "s" + i }));
    const result = await exportTrace(
      config({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
        OTEL_EXPORTER_OTLP_MAX_BATCH_BYTES: "64000",
      }),
      "r",
      many,
    );
    expect(result?.exported).toBe(300);
    expect(result!.batches).toBeGreaterThan(1);
    expect(fetchMock).toHaveBeenCalledTimes(result!.batches);
  });
});

describe("unreadable spans", () => {
  it("drops a span whose start time cannot be read, rather than dating it 1970", () => {
    // Exporting epoch would put the span in 1970 in the collector, where nobody
    // can tie it back to anything.
    const good = span({ spanId: "good" });
    const broken = span({ spanId: "broken", startedAt: "not a date" });
    expect(exportableSpans([good, broken]).map((s) => s.spanId)).toEqual(["good"]);
  });

  it("exports nothing when no span has a readable start", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await exportTrace(
      config({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example" }),
      "r",
      [span({ startedAt: "nonsense" })],
    );
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

