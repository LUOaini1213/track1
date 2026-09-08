import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "./cost.js";

const deepseek = { inputUsdPerMillion: 0.14, outputUsdPerMillion: 0.28 };

describe("estimateCostUsd", () => {
  it("returns null without usage", () => {
    expect(estimateCostUsd(null, deepseek)).toBeNull();
    expect(estimateCostUsd({ inputTokens: 0, outputTokens: 0 }, deepseek)).toBeNull();
  });

  it("returns null when no rate is configured, rather than guessing one", () => {
    // The old version applied DeepSeek's list price to every model, so a
    // deployment on an Ark endpoint saw a confident figure billed at someone
    // else's rate card. Showing tokens without a price is the honest answer.
    expect(
      estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, null),
    ).toBeNull();
  });

  it("estimates from input and output tokens at the configured rate", () => {
    expect(
      estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, deepseek),
    ).toBeCloseTo(0.42, 8);
  });

  it("tracks the configured rate, so a pricier model shows a higher cost", () => {
    // The point of the compare view is to show what changed between two Runs.
    // With the rate hardcoded, switching models changed nothing on screen.
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const cheap = estimateCostUsd(usage, deepseek);
    const pricey = estimateCostUsd(usage, {
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
    });
    expect(pricey).toBeGreaterThan(cheap!);
    expect(pricey).toBeCloseTo(18, 8);
  });
});
