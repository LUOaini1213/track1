/**
 * The contract between the control plane and the Playground.
 *
 * These declarations used to be hand-mirrored in apps/server/src/types.ts and
 * apps/web/src/types.ts, with `problemSpans` and its DIAGNOSTIC_KEYS copied
 * alongside them. Nothing in the build spanned the boundary, so the copies were
 * free to disagree — and they had: the server always sends `traceId` and
 * `spans`, while the web declared both optional, so the client carried
 * defensive branches for a case that cannot happen.
 *
 * Everything here is pure. It imports nothing from either app, so the
 * dependency only ever points inwards.
 */
export * from "./types.js";
export * from "./cost.js";
export * from "./run-compare.js";
