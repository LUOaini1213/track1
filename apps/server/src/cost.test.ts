import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "./cost.js";

describe("estimateCostUsd", () => {
  it("returns null without token usage", () => {
    expect(estimateCostUsd(null)).toBeNull();
    expect(estimateCostUsd({ inputTokens: 0, outputTokens: 0 })).toBeNull();
  });

  it("estimates from input and output tokens", () => {
    const usd = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(usd).toBe(0.42);
  });
});
