import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { batchSpans, exportableSpans, OtlpDeliveryError, postOtlpBatch, toOtlpPayload } from "./otlp.js";
import { redactDeep, redactText, registerSecrets } from "./redact.js";
import type { TraceSpan } from "./types.js";

const recordSchema = z.object({
  version: z.literal(1), runId: z.string().uuid(), endpoint: z.string().url(),
  state: z.enum(["pending", "delivered", "partial", "rejected", "uncertain"]), createdAt: z.number().finite(),
  batches: z.array(z.string()), nextBatch: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(), nextAttemptAt: z.number().finite(),
  settledAt: z.number().finite().nullable(), lastError: z.string().nullable(),
  acceptedSpans: z.number().int().nonnegative(), rejectedSpans: z.number().int().nonnegative(),
  uncertainSpans: z.number().int().nonnegative(), warningBatches: z.number().int().nonnegative(),
});
type Record = z.infer<typeof recordSchema>;
type Summary = Pick<Record, "state" | "endpoint" | "nextAttemptAt" | "createdAt" | "rejectedSpans" | "uncertainSpans" | "warningBatches">;

/** A single-process, file-backed outbox. Payloads are immutable; acknowledgments
 * are persisted per batch. It offers at-least-once delivery, not exactly-once
 * OTLP ingestion. Only summaries are retained in memory while idle. */
export class OtlpOutbox {
  private readonly directory: string;
  private readonly known = new Map<string, Summary>();
  // A response already received is never sent again merely because persisting
  // its checkpoint failed. Retain that checkpoint and retry disk only.
  private readonly checkpoints = new Map<string, Record>();
  private mutations: Promise<unknown> = Promise.resolve();
  private worker: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private current: { runId: string; controller: AbortController } | null = null;
  private stopped = false;

  constructor(private readonly config: AppConfig, private readonly log: (message: string) => void = () => {}) {
    this.directory = path.join(config.dataDirectory, "otlp-outbox");
    registerSecrets(Object.values(config.otlpHeaders));
  }

  private file(runId: string): string {
    if (!z.string().uuid().safeParse(runId).success) throw new Error("Invalid outbox run id");
    return path.join(this.directory, runId + ".json");
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.catch(() => undefined).then(operation);
    this.mutations = result.catch(() => undefined);
    return result;
  }

  private async read(runId: string): Promise<Record> {
    const record = recordSchema.parse(JSON.parse(await readFile(this.file(runId), "utf8")));
    if (record.runId !== runId || record.nextBatch > record.batches.length ||
        (record.state === "pending" && record.nextBatch >= record.batches.length)) {
      throw new Error("Invalid outbox progress");
    }
    return record;
  }

  /** Flush the temporary file before atomic publication. On POSIX also sync the
   * directory. Windows cannot portably fsync a directory; power-loss durability
   * depends on the filesystem. Process-crash recovery is tested on both paths. */
  private async write(record: Record): Promise<void> {
    const target = this.file(record.runId);
    const temporary = target + "." + randomUUID() + ".tmp";
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(record), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, target); break; }
        catch (error) {
          if (attempt >= 8 || !["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(20 * 2 ** attempt, 250)));
        }
      }
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      this.known.set(record.runId, this.summary(record));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async initialize(): Promise<void> {
    if (!this.config.otlpEndpoint) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.directory)) {
      if (!file.endsWith(".json")) continue;
      const runId = file.slice(0, -5);
      try {
        const record = await this.read(runId);
        this.known.set(runId, this.summary(record));
        if (record.state === "pending" && record.endpoint !== this.endpoint()) {
          this.log("OTLP outbox destination changed for " + runId + "; retained without forwarding to a different collector");
        }
      } catch {
        // Preserve corrupt files for diagnosis; reconciliation can recover the
        // final payload from SpanStore, and stable ids limit ambiguous duplicates.
        if (z.string().uuid().safeParse(runId).success) {
          await rename(this.file(runId), this.file(runId) + ".corrupt." + randomUUID());
        }
        this.log("OTLP outbox record unreadable for " + runId + "; recovering from local spans");
      }
    }
  }

  has(runId: string): boolean { return this.known.has(runId); }

  private summary(record: Record): Summary {
    return { state: record.state, endpoint: record.endpoint, nextAttemptAt: record.nextAttemptAt, createdAt: record.createdAt,
      rejectedSpans: record.rejectedSpans, uncertainSpans: record.uncertainSpans, warningBatches: record.warningBatches };
  }

  status() {
    const entries = [...this.known.values()], pending = entries.filter((entry) => entry.state === "pending");
    return { enabled: Boolean(this.config.otlpEndpoint), pending: pending.length,
      delivered: entries.filter((entry) => entry.state === "delivered").length,
      partial: entries.filter((entry) => entry.state === "partial").length,
      rejected: entries.filter((entry) => entry.state === "rejected").length,
      uncertain: entries.filter((entry) => entry.state === "uncertain").length,
      rejectedSpans: entries.reduce((total, entry) => total + entry.rejectedSpans, 0),
      uncertainSpans: entries.reduce((total, entry) => total + entry.uncertainSpans, 0),
      warningBatches: entries.reduce((total, entry) => total + entry.warningBatches, 0),
      pausedDestination: pending.filter((entry) => entry.endpoint !== this.endpoint()).length,
      oldestPendingAgeMs: pending.length ? Math.max(0, Date.now() - pending.reduce((oldest, entry) => Math.min(oldest, entry.createdAt), Infinity)) : null };
  }

  async retain(runIds: Set<string>): Promise<void> {
    await this.forget([...this.known.keys()].filter((runId) => !runIds.has(runId)));
  }

  async enqueue(runId: string, spans: TraceSpan[]): Promise<void> {
    if (!this.config.otlpEndpoint) return;
    await this.serialize(async () => {
      if (this.known.has(runId)) return;
      const usable = exportableSpans(redactDeep(spans));
      if (!usable.length) return;
      const batches: string[] = [];
      // Measure actual UTF-8 payload bytes, including the OTLP envelope. Split
      // again if the lightweight span estimate undershot for an attribute.
      const encode = (items: TraceSpan[]) => {
        const body = JSON.stringify(toOtlpPayload(items, { serviceName: this.config.otlpServiceName, runId }));
        if (Buffer.byteLength(body) > this.config.otlpMaxBatchBytes && items.length > 1) {
          const middle = Math.floor(items.length / 2);
          encode(items.slice(0, middle)); encode(items.slice(middle));
        } else batches.push(body);
      };
      for (const items of batchSpans(usable, this.config.otlpMaxBatchBytes)) encode(items);
      await this.write({ version: 1, runId, endpoint: this.config.otlpEndpoint.replace(/\/+$/, "") + "/v1/traces",
        state: "pending", createdAt: Date.now(), batches, nextBatch: 0, attempts: 0,
        nextAttemptAt: Date.now(), settledAt: null, lastError: null,
        acceptedSpans: 0, rejectedSpans: 0, uncertainSpans: 0, warningBatches: 0 });
    });
    this.start();
  }

  /** Start only after AgentService has reconciled terminal spans at startup. */
  start(): void {
    if (this.stopped || !this.config.otlpEndpoint || this.worker) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.worker = this.pump().catch((error: unknown) => {
      this.log("OTLP outbox worker failed: " + redactText(error instanceof Error ? error.message : String(error)));
    }).finally(() => { this.worker = null; this.schedule(); });
  }

  private endpoint(): string { return this.config.otlpEndpoint.replace(/\/+$/, "") + "/v1/traces"; }

  private schedule(): void {
    if (this.stopped) return;
    const pending = [...this.known.values()].filter((record) => record.state === "pending" && record.endpoint === this.endpoint());
    if (!pending.length) return;
    // Avoid a busy loop even when disk persistence, rather than HTTP, failed.
    const delay = Math.max(100, pending.reduce((next, record) => Math.min(next, record.nextAttemptAt), Infinity) - Date.now());
    this.timer = setTimeout(() => { this.timer = null; this.start(); }, Math.min(delay, 2_147_483_647));
    this.timer.unref();
  }

  private async pump(): Promise<void> {
    while (!this.stopped) {
      const due = [...this.known.entries()].filter(([, record]) => record.state === "pending" &&
        record.endpoint === this.endpoint() && record.nextAttemptAt <= Date.now())
        .sort((left, right) => left[1].nextAttemptAt - right[1].nextAttemptAt)[0];
      if (!due) return;
      const [runId] = due;
      const checkpoint = this.checkpoints.get(runId);
      if (checkpoint) {
        try {
          await this.serialize(async () => {
            if (this.known.has(runId)) await this.write(checkpoint);
            this.checkpoints.delete(runId);
          });
        } catch {
          const summary = this.known.get(runId);
          if (summary) summary.nextAttemptAt = Date.now() + this.config.otlpRetryInitialMs;
          this.log("OTLP acknowledgment disk retry pending runId=" + runId);
          return;
        }
        continue;
      }
      const record = await this.read(runId);
      const controller = new AbortController();
      this.current = { runId, controller };
      const spanCount = JSON.parse(record.batches[record.nextBatch]!).resourceSpans[0].scopeSpans[0].spans.length as number;
      try {
        const result = await postOtlpBatch(this.config, record.endpoint, record.batches[record.nextBatch]!, controller.signal);
        if (result.rejectedSpans > spanCount) {
          await this.advance(record, 0, 0, spanCount, result.warning, "Collector rejection count exceeded batch size");
        } else {
          await this.advance(record, spanCount - result.rejectedSpans, result.rejectedSpans, 0, result.warning,
            result.rejectedSpans ? "Collector partially rejected batch; retry prohibited" : null);
        }
      } catch (error) {
        if (this.stopped || !this.known.has(runId)) return;
        if (this.checkpoints.has(runId)) {
          this.known.get(runId)!.nextAttemptAt = Date.now() + this.config.otlpRetryInitialMs;
          this.log("OTLP acknowledgment disk retry pending runId=" + runId);
          return;
        }
        if (error instanceof OtlpDeliveryError && !error.retryable) {
          await this.advance(record, 0, error.deliveryUnknown ? 0 : spanCount, error.deliveryUnknown ? spanCount : 0,
            false, error.message);
          continue;
        }
        const backoff = Math.min(this.config.otlpRetryMaxMs, this.config.otlpRetryInitialMs * 2 ** Math.min(record.attempts, 20));
        const retryAfter = error instanceof OtlpDeliveryError ? error.retryAfterMs : 0;
        record.attempts++;
        // Honor Retry-After, capped at one day to reject pathological headers.
        const jittered = backoff * (0.8 + Math.random() * 0.4);
        record.nextAttemptAt = Date.now() + Math.max(jittered, Number.isFinite(retryAfter) ? Math.min(retryAfter, 86_400_000) : 0);
        record.lastError = redactText(error instanceof Error ? error.message : String(error)).slice(0, 500);
        await this.serialize(async () => { if (this.known.has(runId)) await this.write(record); });
        this.log("OTLP export pending runId=" + runId + " attempt=" + record.attempts + ": " + record.lastError);
      } finally { this.current = null; }
    }
  }

  private async advance(record: Record, accepted: number, rejected: number, uncertain: number, warning: boolean, error: string | null): Promise<void> {
    await this.serialize(async () => {
      if (!this.known.has(record.runId)) return;
      const acknowledged = structuredClone(record);
      acknowledged.nextBatch++; acknowledged.attempts = 0; acknowledged.nextAttemptAt = Date.now();
      acknowledged.acceptedSpans += accepted; acknowledged.rejectedSpans += rejected;
      acknowledged.uncertainSpans += uncertain; acknowledged.warningBatches += warning ? 1 : 0;
      acknowledged.lastError = error ?? (record.rejectedSpans || record.uncertainSpans ? record.lastError : null);
      if (acknowledged.nextBatch === acknowledged.batches.length) {
        acknowledged.state = acknowledged.uncertainSpans ? "uncertain" : acknowledged.rejectedSpans
          ? acknowledged.acceptedSpans ? "partial" : "rejected" : "delivered";
        acknowledged.settledAt = Date.now(); acknowledged.batches = []; acknowledged.nextBatch = 0;
      }
      this.checkpoints.set(record.runId, acknowledged);
      await this.write(acknowledged);
      this.checkpoints.delete(record.runId);
      if (error) this.log("OTLP batch terminal runId=" + record.runId + ": " + error);
    });
  }

  async forget(runIds: string[]): Promise<void> {
    await this.serialize(async () => {
      for (const runId of runIds) {
        this.known.delete(runId);
        this.checkpoints.delete(runId);
        if (this.current?.runId === runId) this.current.controller.abort();
        await rm(this.file(runId), { force: true });
      }
    });
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.current?.controller.abort();
    await this.worker;
    await this.mutations;
  }
}
