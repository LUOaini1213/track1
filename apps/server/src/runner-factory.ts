import type { AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { DEFAULT_REPLAY_FIXTURE_DIR, ReplayRunner } from "./replay-runner.js";
import type { AgentRunner } from "./types.js";

export function createRunner(config: AppConfig): AgentRunner {
  if (config.runtimeProvider === "replay") {
    return new ReplayRunner({
      fixtureDir: config.replayFixtureDir ?? DEFAULT_REPLAY_FIXTURE_DIR,
      speed: config.replaySpeed,
    });
  }
  return config.runtimeProvider === "container"
    ? new ContainerCodexRunner(config)
    : new CodexRunner(config);
}
