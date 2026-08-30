import type { RunUsage } from "./types.js";

/** Published-list DeepSeek chat-scale estimates; labeled as estimates in the UI. */
export const ESTIMATED_INPUT_USD_PER_MILLION = 0.14;
export const ESTIMATED_OUTPUT_USD_PER_MILLION = 0.28;

export function estimateCostUsd(usage: RunUsage | null | undefined): number | null {
  if (!usage) {
    return null;
  }
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  if (input <= 0 && output <= 0) {
    return null;
  }
  const usd =
    (input / 1_000_000) * ESTIMATED_INPUT_USD_PER_MILLION +
    (output / 1_000_000) * ESTIMATED_OUTPUT_USD_PER_MILLION;
  return Number(usd.toFixed(8));
}
