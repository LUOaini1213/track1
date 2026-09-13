/**
 * The three prompts the no-key replay demo is meant to be driven with.
 *
 * They live in the contract package because three places have to agree on them
 * and none of them can import the others: the Playground's starter buttons
 * (`apps/web`), the README's demo instructions, and `scripts/smoke-replay.mjs`
 * in CI. Until they were written down here, the only record of which words
 * reach which recording was the `match` array inside each fixture JSON, and the
 * Playground's starter buttons — the official starter kit's, unchanged — hit
 * none of them: all three fell through to the default fixture, so a reader
 * following the README could only ever reproduce the successful Run. The failed
 * Run and the mid-Run policy denial, which are the two the trace plane exists
 * to show, were reachable only by reading the fixture files.
 *
 * `fixture` is the fixture `name` the prompt has to select and `status` the Run
 * it ends on; `apps/server/src/replay-runner.test.ts` asserts both against the
 * committed fixtures, so editing a prompt here without checking it still lands
 * turns CI red rather than quietly breaking the demo again.
 */
export interface ReplayDemoPrompt {
  /** Exact text of the starter button, and of the README's copy-paste line. */
  prompt: string;
  /** `name` of the fixture in apps/server/fixtures/replay that must be chosen. */
  fixture: string;
  /** Status the replayed Run finishes on. */
  status: "completed" | "failed";
  /** What a reader is supposed to see, in one line. */
  demonstrates: string;
}

export const REPLAY_STARTER_PROMPTS: readonly ReplayDemoPrompt[] = [
  {
    prompt: "Create a TypeScript hello-world CLI, add a test, and run it.",
    fixture: "hello-world-cli",
    status: "completed",
    demonstrates:
      "A successful Run: the full span waterfall, per-span timings and token usage.",
  },
  {
    prompt: "Fix the failing test in this workspace.",
    fixture: "failing-test-run",
    status: "failed",
    demonstrates:
      'A failed Run: "Open failing step" lands on the command that exited 1.',
  },
  {
    prompt: "Summarize the config files in this workspace.",
    fixture: "live-deny-config-files",
    status: "failed",
    demonstrates:
      "A denial mid-Run: a harmless prompt, but the Agent's third command reads " +
      "the protected fixture and is cut off when it starts.",
  },
];
