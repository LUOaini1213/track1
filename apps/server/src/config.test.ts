import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  NODE_ENV: "test" as const,
  LOG_LEVEL: "silent",
  APP_DATA_DIR: ".data",
  AGENT_WORKSPACE_ROOT: "workspaces",
  CODEX_HOME: "codex-home",
};

describe("configuration", () => {
  it("binds loopback by default so no token is needed for a local server", () => {
    const config = loadConfig({ ...base });
    expect(config.host).toBe("127.0.0.1");
    expect(config.authToken).toBe("");
  });

  it("requires a real token for any non-loopback bind, in every mode", () => {
    // The guard used to be scoped to NODE_ENV=production, so `npm run dev` on
    // the default HOST=0.0.0.0 served an unauthenticated API to the network.
    for (const NODE_ENV of ["development", "test", "production"] as const) {
      expect(() => loadConfig({ ...base, NODE_ENV, HOST: "0.0.0.0" })).toThrow(
        /APP_AUTH_TOKEN/,
      );
      expect(() =>
        loadConfig({
          ...base,
          NODE_ENV,
          HOST: "0.0.0.0",
          APP_AUTH_TOKEN: "replace-with-a-long-random-demo-token",
        }),
      ).toThrow(/replace-/);
      expect(() =>
        loadConfig({ ...base, NODE_ENV, HOST: "0.0.0.0", APP_AUTH_TOKEN: "too-short" }),
      ).toThrow(/24 characters/);
    }
  });

  it("accepts a non-loopback bind once a strong token is supplied", () => {
    const config = loadConfig({
      ...base,
      HOST: "0.0.0.0",
      APP_AUTH_TOKEN: "a-token-of-at-least-24-characters",
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.authToken).toBe("a-token-of-at-least-24-characters");
  });

  it("treats every loopback spelling as local", () => {
    for (const HOST of ["127.0.0.1", "::1", "localhost"]) {
      expect(loadConfig({ ...base, HOST }).host).toBe(HOST);
    }
  });
});
