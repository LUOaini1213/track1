import { defineConfig } from "vitest/config";

// The server suite talks to real loopback HTTP collectors, real files and
// child processes. On an idle machine every test finishes in well under a
// second, but on a loaded or cold Windows host the defaults (5 s per test,
// 1 s per `expect.poll`) were shorter than one fsync-plus-HTTP round trip and
// produced red runs with nothing wrong in the code.
//
// These limits are ceilings, not sleeps: a passing poll returns as soon as its
// condition holds, so an idle run is exactly as fast as before.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    expect: {
      poll: { timeout: 10_000 },
    },
  },
});
