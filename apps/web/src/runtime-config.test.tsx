import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RuntimeConfigBanner } from "./App";
import type { SystemInfo } from "./types";

const system: SystemInfo = { arkConfigured: false, arkBaseUrl: "", arkModel: null, codexAvailable: false,
  codexSandboxMode: "workspace-write", runtimeProvider: "local-process", replay: false,
  containerEngine: null, runtime: "Local Codex" };
describe("runtime configuration banner", () => {
  it("does not ask for model credentials or Codex in a zero-key replay", () => {
    const html = renderToStaticMarkup(<RuntimeConfigBanner system={{ ...system, runtimeProvider: "replay", replay: true }} />);
    expect(html).toBe("");
  });
  it("keeps the model configuration warning for live runtimes", () => {
    const html = renderToStaticMarkup(<RuntimeConfigBanner system={system} />);
    expect(html).toContain("Runtime configuration needed"); expect(html).toContain("Set ARK_API_KEY and ARK_MODEL");
  });
  it("keeps a missing local Codex warning when the live model is configured", () => {
    const html = renderToStaticMarkup(<RuntimeConfigBanner system={{ ...system, arkConfigured: true }} />);
    expect(html).toContain("Codex CLI was not found");
  });
  it("keeps the container runtime warning when the live model is configured", () => {
    const html = renderToStaticMarkup(<RuntimeConfigBanner system={{ ...system, arkConfigured: true, runtimeProvider: "container" }} />);
    expect(html).toContain("local container engine or Agent Runtime image is unavailable");
  });
  it("does not flash a warning before system information arrives or when live runtime is ready", () => {
    expect(renderToStaticMarkup(<RuntimeConfigBanner system={null} />)).toBe("");
    expect(renderToStaticMarkup(<RuntimeConfigBanner system={{ ...system, arkConfigured: true, codexAvailable: true }} />)).toBe("");
  });
});
