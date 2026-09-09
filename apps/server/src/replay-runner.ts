import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseCodexEventLine, type ParsedEvents } from "./codex-runner.js";
import { completeCodexRun } from "./codex-stream.js";
import { RunCancelledError } from "./errors.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";

/**
 * Replays a recorded Codex `exec --json` session through the same parser,
 * TraceCollector and policy gate a live Run uses.
 *
 * Why it exists: the Trace Plane can only be seen with a model key and a Codex
 * install, and a reviewer has neither. `RUNTIME_PROVIDER=replay` swaps the
 * AgentRunner for this class and nothing else. The control plane cannot tell
 * the difference, which is the point: every span, redaction and denial in a
 * replayed Run is produced by the real middleware path, not by a mock.
 *
 * What it is not: evidence of how Codex behaves. Each fixture's `source` field
 * says whether it is a verbatim recording or was authored in the event schema,
 * and the UI labels the runtime as a replay.
 */
const fixtureSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  /** Provenance: verbatim recording, or authored in the event schema. */
  source: z.string().default(""),
  recordedAt: z.string().nullable().default(null),
  /**
   * Case-insensitive substrings. The first fixture (in file-name order) with a
   * keyword that appears in the prompt is the one replayed.
   */
  match: z.array(z.string().min(1)).default([]),
  /** Replayed when no keyword matches. Exactly one fixture should set it. */
  default: z.boolean().default(false),
  /** Exit code of the Codex process after its last event. */
  exitCode: z.number().int().default(0),
  stderr: z.string().default(""),
  events: z
    .array(
      z.object({
        /** Offset from the start of the Run, before REPLAY_SPEED is applied. */
        atMs: z.number().nonnegative(),
        /** One Codex `--json` event, exactly as the CLI would print it. */
        event: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1),
});

export type ReplayFixture = z.infer<typeof fixtureSchema>;

export const DEFAULT_REPLAY_FIXTURE_DIR = fileURLToPath(
  new URL("../fixtures/replay/", import.meta.url),
);

export async function loadReplayFixtures(
  directory: string,
): Promise<ReplayFixture[]> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const fixtures: ReplayFixture[] = [];
  for (const name of names) {
    const raw = await readFile(path.join(directory, name), "utf8");
    const result = fixtureSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      throw new Error(
        "Invalid replay fixture " + name + ": " + result.error.message,
      );
    }
    fixtures.push(result.data);
  }
  if (fixtures.length === 0) {
    throw new Error("No replay fixtures found in " + directory);
  }
  return fixtures;
}

export function selectReplayFixture(
  fixtures: ReplayFixture[],
  prompt: string,
): ReplayFixture {
  const haystack = prompt.toLowerCase();
  const matched = fixtures.find((fixture) =>
    fixture.match.some((keyword) => haystack.includes(keyword.toLowerCase())),
  );
  const chosen =
    matched ?? fixtures.find((fixture) => fixture.default) ?? fixtures[0];
  if (!chosen) {
    throw new Error("No replay fixture available");
  }
  return chosen;
}

export interface ReplayRunnerOptions {
  fixtureDir: string;
  /** 1 replays at the recorded pace; 10 is ten times faster. */
  speed: number;
}

export class ReplayRunner implements AgentRunner {
  private readonly active = new Map<string, () => void>();
  private fixtures: Promise<ReplayFixture[]> | null = null;

  constructor(private readonly options: ReplayRunnerOptions) {}

  private load(): Promise<ReplayFixture[]> {
    if (!this.fixtures) {
      this.fixtures = loadReplayFixtures(this.options.fixtureDir).catch(
        (error: unknown) => {
          this.fixtures = null;
          throw error;
        },
      );
    }
    return this.fixtures;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.load();
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const interrupt = this.active.get(agentId);
    if (!interrupt) {
      return false;
    }
    interrupt();
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active replay");
    }
    const fixture = selectReplayFixture(await this.load(), request.prompt);
    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    let cancelled = false;
    let wake: (() => void) | null = null;
    this.active.set(request.agentId, () => {
      cancelled = true;
      wake?.();
    });
    try {
      let clock = 0;
      for (const entry of fixture.events) {
        const delayMs = Math.max(0, entry.atMs - clock) / this.options.speed;
        clock = Math.max(clock, entry.atMs);
        if (delayMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              wake = null;
              resolve();
            }, delayMs);
            wake = () => {
              clearTimeout(timer);
              wake = null;
              resolve();
            };
          });
        }
        if (cancelled) {
          throw new RunCancelledError();
        }
        // The live policy gate runs inside the sink. A PolicyDeniedError it
        // throws ends the replay at the same event where a live Run's Codex
        // process would have been terminated.
        parseCodexEventLine(
          JSON.stringify(entry.event),
          parsed,
          request.onCodexEvent,
        );
      }
      if (cancelled) {
        throw new RunCancelledError();
      }
      return completeCodexRun(parsed, fixture.exitCode, fixture.stderr);
    } finally {
      this.active.delete(request.agentId);
    }
  }
}
