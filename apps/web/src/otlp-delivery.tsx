import { api, ApiError } from "./api";
import type { RunOtlpDelivery } from "./types";

const descriptions: Record<RunOtlpDelivery["state"], { label: string; detail: string }> = {
  disabled: { label: "Export off", detail: "OTLP export is disabled. The local trace remains available." },
  awaiting_completion: { label: "Waiting for Run", detail: "Export starts after this Run finishes." },
  pending: { label: "Pending", detail: "The local trace is queued. Collector retries run in the background." },
  paused: { label: "Paused", detail: "Collector configuration changed. Pending traces stay with their original destination." },
  delivered: { label: "Delivered", detail: "The collector acknowledged all exported spans." },
  partial: { label: "Partial delivery", detail: "Some spans were rejected. Settled batches will not be resent." },
  rejected: { label: "Rejected", detail: "The collector rejected the exported spans. No retry is scheduled." },
  uncertain: { label: "Acceptance uncertain", detail: "Some span acknowledgments are uncertain. Affected batches will not be resent." },
  recovery_needed: { label: "Recovery needed", detail: "The local trace is retained. Restart the server to reconcile its missing queue record; earlier remote acceptance is unknown." },
  unavailable: { label: "No exportable trace", detail: "No final exportable local spans are available." },
};

export function DeliveryStatus({ delivery, refreshError }: {
  delivery: RunOtlpDelivery | null;
  refreshError: string | null;
}) {
  const description = delivery ? descriptions[delivery.state] : null;
  const hasRecord = delivery && !["disabled", "awaiting_completion", "recovery_needed", "unavailable"].includes(delivery.state);
  return <div className={"otlp-delivery otlp-" + (delivery?.state ?? "loading")}
    aria-label="OTLP delivery" role="status" aria-live="polite">
    <div className="otlp-delivery-heading"><span className="eyebrow">OTLP delivery</span>
      <strong>{description?.label ?? "Loading delivery status"}</strong></div>
    {description ? <p>{description.detail}</p> : null}
    {hasRecord ? <p className="otlp-delivery-counts">
      {delivery.acceptedSpans} accepted · {delivery.rejectedSpans} rejected · {delivery.uncertainSpans} uncertain spans
      {delivery.pendingBatches > 0 ? " · " + delivery.pendingBatches + " batches remaining" : ""}
      {delivery.attempts > 0 ? " · " + delivery.attempts + " retry attempts for current batch" : ""}
      {delivery.warningBatches > 0 ? " · " + delivery.warningBatches + " collector warnings" : ""}
    </p> : null}
    {delivery?.checkpointPending ? <p>Response received; saving the local acknowledgment. Restarting before it is saved may replay the batch.</p> : null}
    {delivery?.corruptionEvidence ? <p>A damaged queue record was isolated; its earlier remote acceptance may be unknown.</p> : null}
    {refreshError ? <p className="otlp-refresh-error">{refreshError}</p> : null}
  </div>;
}

function pollDelay(delivery: RunOtlpDelivery): number | null {
  if (delivery.checkpointPending || delivery.state === "pending") return 2000;
  if (delivery.state === "paused") return 10000;
  if (delivery.state === "recovery_needed") return 5000;
  return null;
}

/** Poll collector delivery independently after execution finishes. Stop on
 * settled outcomes, selection changes or unmount; stale responses are ignored. */
export function watchRunDelivery(runId: string, initial: RunOtlpDelivery | null,
  onUpdate: (delivery: RunOtlpDelivery) => void, onError: (message: string | null) => void): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (delay: number) => { timer = setTimeout(() => { void refresh(); }, delay); };
  const refresh = async () => {
    try {
      const trace = await api.runDelivery(runId);
      if (cancelled) return;
      onUpdate(trace.delivery); onError(null);
      const delay = pollDelay(trace.delivery);
      if (delay !== null) schedule(delay);
    } catch (error) {
      if (cancelled) return;
      onError("Delivery status could not be refreshed. The last observation is shown.");
      if (!(error instanceof ApiError && [401, 404].includes(error.status))) schedule(5000);
    }
  };
  const delay = initial ? pollDelay(initial) : 2000;
  if (delay !== null) schedule(delay);
  return () => { cancelled = true; if (timer !== undefined) clearTimeout(timer); };
}
