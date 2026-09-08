import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TraceSpan } from "./types.js";

/**
 * Spans, one file per Run.
 *
 * They used to live inside launchpad.json, so appending a span rewrote every
 * Agent, every message and every other Run's spans along with it. Measured on
 * this machine: one write cost 2.7ms at 0.1MB but 255.9ms at 31.8MB, and the
 * trace collector issues one every 300ms while a Run is active — the cost of
 * recording a Run grew with the history behind it.
 *
 * A Run's spans are written whole each time, which is fine: the unit of write
 * is now the Run rather than the store, and a Run's span list is bounded by the
 * work that Run did.
 */
export class SpanStore {
  /**
   * One write at a time per Run, and each write gets its own temporary name.
   *
   * The trace collector's debounced write is fire-and-forget, so it can still be
   * in flight when the Run's final write starts. Sharing a temporary path made
   * the two clobber each other and one rename fail with ENOENT — which is not a
   * transient condition, so it surfaced as a failed Run. It made roughly one
   * test run in three go red before this queue existed.
   *
   * Serialising also fixes ordering: the last write queued is the one that
   * lands, so a debounced snapshot cannot overwrite the terminal one.
   */
  private readonly queues = new Map<string, Promise<void>>();
  private writeCounter = 0;

  constructor(private readonly directory: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  private fileFor(runId: string): string {
    // Run ids are UUIDs from randomUUID, but this is a filesystem path built
    // from a value that also arrives over HTTP, so refuse anything else.
    if (!/^[0-9a-fA-F-]{36}$/.test(runId)) {
      throw new Error("Refusing to build a span path from " + JSON.stringify(runId));
    }
    return path.join(this.directory, runId + ".json");
  }

  async read(runId: string): Promise<TraceSpan[]> {
    try {
      const raw = await readFile(this.fileFor(runId), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as TraceSpan[]) : [];
    } catch (error) {
      // A Run with no spans yet, or a file lost to a crash, is not an error:
      // the Run record is the source of truth for whether the Run exists.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      if (error instanceof SyntaxError) {
        return [];
      }
      throw error;
    }
  }

  /** Same atomic write and transient-rename retry as the main store. */
  async write(runId: string, spans: TraceSpan[]): Promise<void> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const mine = previous
      .catch(() => undefined)
      .then(() => this.writeNow(runId, spans));
    // Identity, not existence: `get` returns the entry that was just stored, so
    // a truthiness check here could never fire and the map grew by one entry for
    // every Run the process ever wrote. Compare against this write's own tail
    // and only the last writer for a Run clears it.
    const tail = mine.catch(() => undefined);
    this.queues.set(runId, tail);
    try {
      await mine;
    } finally {
      if (this.queues.get(runId) === tail) {
        this.queues.delete(runId);
      }
    }
  }

  private async writeNow(runId: string, spans: TraceSpan[]): Promise<void> {
    const target = this.fileFor(runId);
    this.writeCounter += 1;
    const temporary =
      target + "." + process.pid + "." + this.writeCounter + ".tmp";
    await writeFile(temporary, JSON.stringify(spans), { encoding: "utf8", mode: 0o600 });
    const transient = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
    let delay = 20;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (attempt >= 8 || !transient.has(code)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 250);
      }
    }
  }

  async delete(runIds: string[]): Promise<void> {
    await Promise.all(
      runIds.map((runId) =>
        rm(this.fileFor(runId), { force: true }).catch(() => undefined),
      ),
    );
  }

  /** Span files whose Run no longer exists, left by an interrupted delete. */
  async orphans(knownRunIds: Set<string>): Promise<string[]> {
    try {
      const files = await readdir(this.directory);
      return files
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -".json".length))
        .filter((runId) => !knownRunIds.has(runId));
    } catch {
      return [];
    }
  }
}
