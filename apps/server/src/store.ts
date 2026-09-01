import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRun, Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 2,
  agents: [],
  messages: [],
  runs: [],
});

function migrateDatabase(parsed: unknown): Database {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Unsupported database format");
  }
  const candidate = parsed as Partial<Database> & { version?: number };
  if (
    !Array.isArray(candidate.agents) ||
    !Array.isArray(candidate.messages) ||
    !Array.isArray(candidate.runs)
  ) {
    throw new Error("Unsupported database format");
  }
  const runs: AgentRun[] = candidate.runs.map((run) => ({
    ...run,
    traceId: run.traceId ?? randomUUID(),
    spans: Array.isArray(run.spans) ? run.spans : [],
  }));
  return {
    version: 2,
    agents: candidate.agents,
    messages: candidate.messages,
    runs,
  };
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.data = migrateDatabase(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  /**
   * Clone only what the caller asked for.
   *
   * `snapshot()` deep-clones the entire database, so answering "give me one
   * Run" used to copy every Agent, every message and every span in the store.
   * The Playground polls an active Run roughly once a second, which made the
   * cost of a single read grow with total history rather than with the Run.
   *
   * The selector runs against live data and must not mutate it; only its
   * result crosses the boundary, and that result is cloned.
   */
  read<T>(selector: (database: Database) => T): T {
    return structuredClone(selector(this.data));
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
