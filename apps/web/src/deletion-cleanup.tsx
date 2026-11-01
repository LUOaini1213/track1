import { api, ApiError } from "./api";
import type { DeletionCleanupEntry } from "./types";

type PendingEntry = Omit<DeletionCleanupEntry, "runCount"> & { runCount: number | null; label?: string };
export interface CleanupView {
  availability: "loading" | "available" | "unsupported" | "error";
  pending: PendingEntry[];
  notice: string | null;
  error: string | null;
  refreshing: boolean;
  retryingId: string | null;
}
export const initialCleanupView = (): CleanupView => ({ availability: "loading", pending: [], notice: null,
  error: null, refreshing: false, retryingId: null });
const pendingNotice = "Agent record removed. Final workspace and trace cleanup is pending; the server retries automatically.";
const completeNotice = "Agent record removed. Workspace and trace cleanup completed.";
const errorMessage = (error: unknown) => "Cleanup status could not be confirmed"
  + (error instanceof ApiError ? ` (HTTP ${error.status})` : "") + ". The last observation is shown.";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkedSnapshot(body: { pending: DeletionCleanupEntry[] }): DeletionCleanupEntry[] {
  if (!Array.isArray(body.pending) || !body.pending.every((entry) => entry && typeof entry.id === "string" && uuid.test(entry.id)
    && ["agent", "orphan_traces"].includes(entry.kind) && Number.isSafeInteger(entry.runCount) && entry.runCount >= 0)) {
    throw new Error("Invalid cleanup snapshot");
  }
  // Keep an explicit allowlist even if an older proxy adds journal fields.
  return body.pending.map(({ id, kind, runCount }) => ({ id, kind, runCount }));
}

/** One read at a time, versioned against mutations; no journal data in browser storage. */
export class DeletionCleanupController {
  view = initialCleanupView();
  private stopped = false;
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loading: Promise<DeletionCleanupEntry[] | null> | null = null;
  private blocked = false;
  private observedVersion = -1;
  constructor(private publish: (view: CleanupView) => void) {}

  private update(change: Partial<CleanupView>) {
    if (this.stopped) return;
    this.view = { ...this.view, ...change };
    this.publish(this.view);
  }
  private clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private schedule() {
    this.clearTimer();
    if (!this.stopped && !this.blocked && this.view.availability !== "unsupported"
      && (this.view.pending.length || this.view.availability === "error")) {
      this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, 5000);
    }
  }
  async start() { this.stopped = false; this.version++; await this.refresh(); }
  stop() { this.stopped = true; this.version++; this.clearTimer(); }
  dismiss() { this.update({ notice: null }); }

  async refresh(): Promise<DeletionCleanupEntry[] | null> {
    if (this.stopped) return null;
    if (this.loading) {
      const result = await this.loading;
      if (this.stopped) return null;
      return this.observedVersion === this.version ? result : this.refresh();
    }
    const version = this.version;
    this.blocked = false;
    this.update({ refreshing: true });
    const reading = (async () => {
      try {
        const pending = checkedSnapshot(await api.deletionCleanup());
        if (this.stopped || version !== this.version) return null;
        this.observedVersion = version;
        const finished = this.view.pending.filter((old) => !pending.some((entry) => entry.id === old.id));
        const named = pending.map((entry) => ({ ...entry, label: this.view.pending.find((old) => old.id === entry.id)?.label }));
        this.update({ availability: "available", pending: named, error: null,
          ...(finished.length ? { notice: `${finished.length} cleanup ${finished.length === 1 ? "task" : "tasks"} completed.` } : {}) });
        return pending;
      } catch (error) {
        if (this.stopped || version !== this.version) return null;
        this.observedVersion = version;
        const unsupported = error instanceof ApiError && error.status === 404;
        this.blocked = error instanceof ApiError && error.status === 401;
        this.update({ availability: unsupported ? "unsupported" : "error", error: unsupported
          ? this.view.pending.length ? "This server cannot report pending cleanup. Completion has not been confirmed; refresh after upgrading the server." : this.view.error
          : errorMessage(error) });
        return null;
      }
    })();
    this.loading = reading;
    const result = await reading;
    this.loading = null;
    if (!this.stopped && version !== this.version) return this.refresh();
    this.update({ refreshing: false });
    this.schedule();
    return result;
  }

  private completed(id: string) {
    const orphan = this.view.pending.find((entry) => entry.id === id)?.kind === "orphan_traces";
    this.update({ pending: this.view.pending.filter((entry) => entry.id !== id),
      notice: orphan ? "Orphan trace cleanup completed." : completeNotice, error: null });
  }

  /** A 404 is a receipt only after BOTH fresh reads succeed and confirm absence. */
  private async reconcile(id: string): Promise<"pending" | "complete" | "present" | "unknown"> {
    const version = ++this.version;
    try {
      const [snapshot, agents] = await Promise.all([api.deletionCleanup(), api.listAgents()]);
      const pending = checkedSnapshot(snapshot);
      if (!Array.isArray(agents.agents) || !agents.agents.every((agent) => agent && typeof agent.id === "string" && uuid.test(agent.id))) {
        throw new Error("Invalid Agent snapshot");
      }
      if (this.stopped || version !== this.version) return "unknown";
      // A concurrent journal read may have captured an earlier snapshot while
      // these receipt checks ran. It cannot overwrite the receipt's conclusion.
      this.version++;
      if (agents.agents.some((agent) => agent.id === id)) {
        this.update({ pending: pending.map((item) => ({ ...item,
          label: this.view.pending.find((old) => old.id === item.id)?.label })), notice: null,
          error: "Agent record is still present. Deletion was not confirmed; refresh before trying again." });
        return "present";
      }
      const entry = pending.find((item) => item.id === id);
      if (entry) {
        this.update({ availability: "available", pending: pending.map((item) => ({ ...item,
          label: this.view.pending.find((old) => old.id === item.id)?.label })), notice: pendingNotice, error: null });
        return "pending";
      }
      this.completed(id); return "complete";
    } catch (error) {
      this.blocked = error instanceof ApiError && error.status === 401;
      this.update({ availability: "error", error: errorMessage(error) }); return "unknown";
    }
  }

  async remove(id: string, label?: string, retry = false) {
    if (this.stopped || this.view.retryingId || (retry && !this.view.pending.some((entry) => entry.id === id))) return;
    // The synchronous lock also protects a double click before React rerenders.
    this.version++; this.clearTimer(); this.update({ retryingId: id, error: null, notice: null });
    try {
      if (retry && await this.reconcile(id) !== "pending") return;
      try {
        const result = await api.deleteAgent(id);
        if (this.stopped) return;
        if (!(typeof result.archivedWorkspace === "string" || result.archivedWorkspace === null)
          || (result.cleanupPending !== undefined && typeof result.cleanupPending !== "boolean")) throw new Error("Invalid deletion receipt");
        // Invalidate even reads started AFTER admission but BEFORE DELETE commit.
        this.version++;
        if (result.cleanupPending === true) {
          const previous = this.view.pending.find((entry) => entry.id === id);
          this.update({ pending: [...this.view.pending.filter((entry) => entry.id !== id),
            previous ?? { id, kind: "agent", runCount: null, label }], notice: pendingNotice });
        } else if (result.cleanupPending === false) this.completed(id);
        else {
          // Legacy 200 confirms removal, not the new journal's cleanup guarantee.
          this.update({ notice: "Agent record removed. This older server does not report cleanup completion." });
          await this.reconcile(id);
        }
      } catch {
        const outcome = await this.reconcile(id);
        if (outcome === "present" || outcome === "unknown") return;
      }
      // Reconcile auto-cleanup and refresh-safe discovery without persisting paths.
      await this.refresh();
    } finally { this.update({ retryingId: null }); this.schedule(); }
  }
}

export function DeletionCleanupPanel({ view, onRetry, onRefresh, onDismiss }: {
  view: CleanupView; onRetry: (id: string) => void; onRefresh: () => void; onDismiss: () => void;
}) {
  if (view.availability === "available" && !view.pending.length && !view.notice && !view.error) return null;
  // Older servers cannot have the new durable journal: keep compatibility quiet
  // until a pending operation or an explicit result needs explanation.
  if (view.availability === "unsupported" && !view.pending.length && !view.notice && !view.error) return null;
  return <section className="cleanup-panel" aria-label="Deletion cleanup">
    <div className="cleanup-heading"><strong>Deletion cleanup</strong>
      <button className="button button-secondary" disabled={view.refreshing || !!view.retryingId} onClick={onRefresh}>
        {view.refreshing ? "Checking…" : "Refresh status"}</button></div>
    {view.availability === "loading" && <p role="status">Checking pending cleanup…</p>}
    {view.notice && <div className="cleanup-notice" role="status"><span>{view.notice}</span>
      <button aria-label="Dismiss cleanup notice" onClick={onDismiss}>×</button></div>}
    {view.error && <p role="alert">{view.error}</p>}
    {view.pending.length > 0 && <><p>Final workspace or trace cleanup is pending. Deleted Agent records will not be restored.
      The server retries automatically; fixing file access may be necessary.</p>
      <ul>{view.pending.map((entry) => <li key={entry.id}><div><strong>{entry.kind === "agent"
        ? entry.label ?? "Deleted Agent " + entry.id.slice(0, 8) : "Orphan trace cleanup " + entry.id.slice(0, 8)}</strong>
        {entry.runCount !== null && <span>{entry.runCount} related {entry.runCount === 1 ? "Run" : "Runs"}</span>}</div>
        <button className="button button-secondary" disabled={!!view.retryingId || view.refreshing}
          onClick={() => onRetry(entry.id)} aria-label={"Retry cleanup " + entry.id}>
          {view.retryingId === entry.id ? "Retrying…" : "Retry cleanup"}</button></li>)}</ul></>}
  </section>;
}
