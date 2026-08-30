import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyEnvFile, loadLocalEnv } from "./env-file.js";

describe("applyEnvFile", () => {
  it("maps a raw token line to ARK_API_KEY without KEY=value", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyEnvFile("sk-testtokenvalue123456", env)).toEqual(["ARK_API_KEY"]);
    expect(env.ARK_API_KEY).toBe("sk-testtokenvalue123456");
  });

  it("parses KEY=value and does not override a non-empty process env", () => {
    const env: NodeJS.ProcessEnv = { ARK_MODEL: "already-set" };
    applyEnvFile("ARK_API_KEY=from-file\nARK_MODEL=from-file\n", env);
    expect(env.ARK_API_KEY).toBe("from-file");
    expect(env.ARK_MODEL).toBe("already-set");
  });
});

describe("loadLocalEnv", () => {
  it("loads the nearest gitignored .env walking toward the repo root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-env-"));
    const nested = path.join(root, "apps", "server");
    await writeFile(
      path.join(root, ".env"),
      "ARK_API_KEY=sk-nested-file-token\nARK_MODEL=ep-from-file\n",
      "utf8",
    );
    const { mkdir } = await import("node:fs/promises");
    await mkdir(nested, { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    const loaded = loadLocalEnv(nested, env);
    expect(loaded.file).toBe(path.join(root, ".env"));
    expect(env.ARK_API_KEY).toBe("sk-nested-file-token");
    expect(env.ARK_MODEL).toBe("ep-from-file");
  });
});
