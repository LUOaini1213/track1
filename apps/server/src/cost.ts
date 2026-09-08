import type { RunUsage } from "./types.js";

/**
 * Per-million-token prices for the model actually in use.
 *
 * There is no default on purpose. The previous version hardcoded DeepSeek's
 * list price and applied it to every model, so a deployment running
 * `ARK_MODEL=ep-…` on Ark — the documented path — saw a confident dollar figure
 * computed from a rate card for a model it was not billed by. Worse for the
 * compare view, whose whole point is to show what changed between two Runs:
 * switching to a pricier model showed no cost change at all, because both sides
 * used the same constants.
 *
 * When rates are unset the estimate is null and the UI shows tokens without a
 * price. No number beats a wrong number.
 */
export interface CostRates {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export function estimateCostUsd(
  usage: RunUsage | null | undefined,
  rates: CostRates | null | undefined,
): number | null {
  if (!usage || !rates) {
    return null;
  }
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  if (input <= 0 && output <= 0) {
    return null;
  }
  const usd =
    (input / 1_000_000) * rates.inputUsdPerMillion +
    (output / 1_000_000) * rates.outputUsdPerMillion;
  return Number(usd.toFixed(8));
}
