import { describe, expect, it } from "vitest";
import { REPLAY_STARTER_PROMPTS } from "@launchpad/contract";
import { runtimeConfigWarning, starterPromptsFor } from "./system";
import type { SystemInfo } from "./types";

// The Playground's first screen had no test behind it at all, and both of the
// things it got wrong were invisible to the server-side suite: the no-key demo
// the README leads with opened on a "Runtime configuration needed" banner, and
// none of its starter buttons reached the failed or denied example Runs.
const system = (over: Partial<SystemInfo> = {}): SystemInfo => ({
  arkConfigured: true,
  arkBaseUrl: "https://ark.example/api/v3",
  arkModel: "a-model",
  codexAvailable: true,
  codexSandboxMode: "workspace-write",
  runtimeProvider: "local-process",
  replay: false,
  containerEngine: null,
  runtime: "Codex CLI",
  ...over,
});

// What apps/server/src/replay-runner.test.ts asserts GET /api/system returns in
// replay: no key, no model, and `replay: true`.
const replaySystem = system({
  arkConfigured: false,
  arkModel: null,
  runtimeProvider: "replay",
  replay: true,
  runtime: "Replay of recorded Codex events (no model, no key)",
});

describe("first-screen runtime warning", () => {
  it("says nothing while /api/system is still in flight", () => {
    // `system` starts as null. Reading `!system?.arkConfigured` off it is true,
    // so every mode used to flash the banner before the first response landed.
    expect(runtimeConfigWarning(null)).toBeNull();
  });

  it("says nothing in replay, which has no key by design", () => {
    expect(runtimeConfigWarning(replaySystem)).toBeNull();
  });

  it("still asks for a key when a live runtime is missing one", () => {
    expect(runtimeConfigWarning(system({ arkConfigured: false }))).toContain(
      "ARK_API_KEY",
    );
  });

  it("names the container engine rather than Codex when that is what is missing", () => {
    expect(
      runtimeConfigWarning(
        system({ codexAvailable: false, runtimeProvider: "container" }),
      ),
    ).toContain("npm run poc");
    expect(runtimeConfigWarning(system({ codexAvailable: false }))).toContain(
      "@openai/codex",
    );
  });

  it("says nothing when the live runtime is ready", () => {
    expect(runtimeConfigWarning(system())).toBeNull();
  });
});

describe("starter prompts", () => {
  it("offers the replay prompts, in the order the demo walks them", () => {
    expect(starterPromptsFor(replaySystem)).toEqual(
      REPLAY_STARTER_PROMPTS.map((item) => item.prompt),
    );
  });

  it("keeps the starter kit's open-ended suggestions for live runtimes", () => {
    // Those need a model to answer; suggesting them in replay is what sent all
    // three buttons to the same recorded Run.
    expect(starterPromptsFor(system())).not.toEqual(
      starterPromptsFor(replaySystem),
    );
    expect(starterPromptsFor(null)).toEqual(starterPromptsFor(system()));
  });
});
