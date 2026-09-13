import { REPLAY_STARTER_PROMPTS } from "@launchpad/contract";
import type { SystemInfo } from "./types";

// The official starter kit's suggestions. They are open-ended on purpose and
// only make sense against a real model.
const liveStarterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

/**
 * Replay answers from three committed recordings and picks between them on
 * keywords, so a prompt that matches none of them falls through to the default
 * recording. All three suggestions above do exactly that, which left the failed
 * Run and the mid-Run policy denial — the two the trace plane exists to show —
 * reachable only by reading the fixture JSON. In replay, suggest the prompts
 * that reach them instead.
 */
export function starterPromptsFor(system: SystemInfo | null): string[] {
  return system?.replay
    ? REPLAY_STARTER_PROMPTS.map((item) => item.prompt)
    : liveStarterPrompts;
}

/**
 * The sentence under "Runtime configuration needed", or null when there is
 * nothing wrong to report.
 *
 * Two cases used to produce a warning that was not true. Before `GET
 * /api/system` answers, `system` is null and `!system?.arkConfigured` is true,
 * so every mode flashed the banner on first paint. And replay deliberately runs
 * with no key and no model — `arkConfigured` is false there by design, and the
 * server accepts Playground messages anyway — so the no-key demo the README
 * leads with opened on an amber banner telling the reader to go and configure a
 * key they do not need.
 */
export function runtimeConfigWarning(system: SystemInfo | null): string | null {
  if (!system || system.replay) {
    return null;
  }
  if (!system.arkConfigured) {
    return "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground.";
  }
  if (system.codexAvailable) {
    return null;
  }
  return system.runtimeProvider === "container"
    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
    : "Codex CLI was not found. Use the Docker image or install @openai/codex.";
}
