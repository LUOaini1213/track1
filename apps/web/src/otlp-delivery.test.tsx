import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryStatus, watchRunDelivery } from "./otlp-delivery";
import type { RunOtlpDelivery } from "./types";

const delivery = (state: RunOtlpDelivery["state"], extra: Partial<RunOtlpDelivery> = {}): RunOtlpDelivery => ({
  state, acceptedSpans: 0, rejectedSpans: 0, uncertainSpans: 0, warningBatches: 0, attempts: 0, pendingBatches: 0,
  queuedAt: null, settledAt: null, nextRetryAt: null, checkpointPending: false, recoveryPossible: false,
  corruptionEvidence: false, ...extra,
});
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("rendered OTLP delivery status", () => {
  it.each([
    ["disabled", "Export off", "local trace remains available"],
    ["awaiting_completion", "Waiting for Run", "after this Run finishes"],
    ["pending", "Pending", "retries run in the background"],
    ["paused", "Paused", "original destination"],
    ["delivered", "Delivered", "acknowledged all exported spans"],
    ["partial", "Partial delivery", "will not be resent"],
    ["rejected", "Rejected", "No retry is scheduled"],
    ["uncertain", "Acceptance uncertain", "will not be resent"],
    ["recovery_needed", "Recovery needed", "Restart the server"],
    ["unavailable", "No exportable trace", "No final exportable local spans"],
  ] as const)("renders %s with a useful explanation separate from Run execution", (state, label, detail) => {
    const html = renderToStaticMarkup(<DeliveryStatus delivery={delivery(state)} refreshError={null} />);
    expect(html).toContain('aria-label="OTLP delivery"'); expect(html).toContain('role="status"');
    expect(html).toContain(label); expect(html).toContain(detail);
    expect(html).not.toContain("Run failed");
  });

  it("renders loss, warning and pending acknowledgment information together without hiding counts", () => {
    const html = renderToStaticMarkup(<DeliveryStatus delivery={delivery("uncertain", {
      acceptedSpans: 7, rejectedSpans: 2, uncertainSpans: 3, warningBatches: 1, checkpointPending: true,
      corruptionEvidence: true,
    })} refreshError="Delivery status could not be refreshed. The last observation is shown." />);
    expect(html).toContain("7 accepted · 2 rejected · 3 uncertain spans"); expect(html).toContain("1 collector warnings");
    expect(html).toContain("saving the local acknowledgment"); expect(html).toContain("damaged queue record was isolated");
    expect(html).toContain("last observation is shown");
  });

  it("keeps unconfigured export concise without an alarming loss counter", () => {
    const html = renderToStaticMarkup(<DeliveryStatus delivery={delivery("disabled")} refreshError={null} />);
    expect(html).not.toContain("uncertain spans"); expect(html).not.toContain("retry attempts");
  });
});

describe("delivery refresh after a Run completes", () => {
  it("recovers an initially unavailable delivery observation instead of loading forever", async () => {
    vi.useFakeTimers(); const update = vi.fn();
    const fetch = vi.fn(async () => response({ delivery: delivery("disabled") })); vi.stubGlobal("fetch", fetch);
    const stop = watchRunDelivery("run", null, update, vi.fn());
    await vi.advanceTimersByTimeAsync(2000); expect(update).toHaveBeenLastCalledWith(delivery("disabled"));
    await vi.advanceTimersByTimeAsync(10000); expect(fetch).toHaveBeenCalledTimes(1); stop();
  });
  it("refreshes pending to delivered and renders the new result without another model run", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => response({ run: { status: "completed" }, delivery: delivery("delivered", { acceptedSpans: 12 }) }));
    vi.stubGlobal("fetch", fetch);
    let shown = delivery("pending", { pendingBatches: 1 });
    const errors: (string | null)[] = [];
    const stop = watchRunDelivery("run-a", shown, (next) => { shown = next; }, (error) => errors.push(error));
    await vi.advanceTimersByTimeAsync(1999); expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const html = renderToStaticMarkup(<DeliveryStatus delivery={shown} refreshError={null} />);
    expect(html).toContain("Delivered"); expect(html).toContain("12 accepted");
    expect(fetch).toHaveBeenCalledWith("/api/runs/run-a/trace", expect.any(Object));
    await vi.advanceTimersByTimeAsync(30000); expect(fetch).toHaveBeenCalledTimes(1); expect(errors).toEqual([null]); stop();
  });

  it("ignores an old Run's in-flight response after selection changes", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const update = vi.fn(), error = vi.fn();
    const stop = watchRunDelivery("old-run", delivery("pending"), update, error);
    await vi.advanceTimersByTimeAsync(2000); stop();
    finish(response({ delivery: delivery("delivered") }));
    await vi.advanceTimersByTimeAsync(10000); expect(update).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });

  it("preserves the last observation through a temporary outage and clears the error on recovery", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(response({ error: "private-server-detail" }, 503))
      .mockResolvedValueOnce(response({ run: { status: "failed" }, delivery: delivery("partial", { acceptedSpans: 5, rejectedSpans: 1 }) }));
    vi.stubGlobal("fetch", fetch);
    const update = vi.fn(), error = vi.fn();
    const stop = watchRunDelivery("run-a", delivery("pending"), update, error);
    await vi.advanceTimersByTimeAsync(2000); expect(update).not.toHaveBeenCalled();
    expect(error).toHaveBeenLastCalledWith("Delivery status could not be refreshed. The last observation is shown.");
    await vi.advanceTimersByTimeAsync(5000); expect(update).toHaveBeenLastCalledWith(delivery("partial", { acceptedSpans: 5, rejectedSpans: 1 }));
    expect(error).toHaveBeenLastCalledWith(null); stop();
  });

  it.each(["disabled", "awaiting_completion", "delivered", "partial", "rejected", "uncertain", "unavailable"] as const)(
    "does not background-poll %s", async (state) => {
      vi.useFakeTimers(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
      const stop = watchRunDelivery("run", delivery(state), vi.fn(), vi.fn());
      await vi.advanceTimersByTimeAsync(60000); expect(fetch).not.toHaveBeenCalled(); stop();
    });

  it("keeps polling an unpersisted terminal acknowledgment until the checkpoint is saved", async () => {
    vi.useFakeTimers(); const update = vi.fn();
    const fetch = vi.fn(async () => response({ delivery: delivery("delivered", { acceptedSpans: 5 }) })); vi.stubGlobal("fetch", fetch);
    const stop = watchRunDelivery("run", delivery("delivered", { acceptedSpans: 5, checkpointPending: true }), update, vi.fn());
    await vi.advanceTimersByTimeAsync(2000); expect(update).toHaveBeenLastCalledWith(delivery("delivered", { acceptedSpans: 5 }));
    await vi.advanceTimersByTimeAsync(10000); expect(fetch).toHaveBeenCalledTimes(1); stop();
  });

  it.each([401, 404])("stops on HTTP %s while preserving the displayed observation", async (status) => {
    vi.useFakeTimers(); const fetch = vi.fn(async () => response({ error: "gone" }, status)); vi.stubGlobal("fetch", fetch);
    const update = vi.fn(), error = vi.fn();
    const stop = watchRunDelivery("run", delivery("pending"), update, error);
    await vi.advanceTimersByTimeAsync(30000); expect(fetch).toHaveBeenCalledTimes(1); expect(update).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1); stop();
  });
});
