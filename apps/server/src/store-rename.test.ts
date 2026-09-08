import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// store.ts binds `rename` as a named import, so spying on the module object
// after the fact cannot intercept it — the mock has to be in place before
// store.ts is loaded.
const { renameCalls, failuresRemaining } = vi.hoisted(() => ({
  renameCalls: { count: 0 },
  failuresRemaining: { count: 0 },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      renameCalls.count += 1;
      if (failuresRemaining.count > 0) {
        failuresRemaining.count -= 1;
        const error = new Error("EPERM: operation not permitted, rename");
        (error as NodeJS.ErrnoException).code = "EPERM";
        throw error;
      }
      return actual.rename(from, to);
    },
  };
});

const { JsonStore } = await import("./store.js");

const directories: string[] = [];
afterEach(async () => {
  renameCalls.count = 0;
  failuresRemaining.count = 0;
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function freshStore() {
  const root = await mkdtemp(path.join(tmpdir(), "store-rename-"));
  directories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  return store;
}

describe("JsonStore durability", () => {
  it("retries a rename that Windows briefly refuses", async () => {
    // An antivirus scanner or the search indexer holding launchpad.json open
    // for a few milliseconds makes rename fail with EPERM. Without a retry that
    // transient condition surfaced at the top of the app as a failed Run, and
    // the Codex output, assistant message and thread id were discarded with it.
    const store = await freshStore();
    renameCalls.count = 0;
    failuresRemaining.count = 3;

    await store.mutate((database) => {
      database.agents.push({ id: "a1", name: "Survivor" } as never);
    });

    expect(failuresRemaining.count).toBe(0);
    expect(renameCalls.count).toBe(4);
    expect(store.read((database) => database.agents.length)).toBe(1);
  }, 20_000);

  it("gives up on a rename that keeps failing rather than hanging", async () => {
    const store = await freshStore();
    failuresRemaining.count = 999;
    await expect(
      store.mutate((database) => {
        database.agents.push({ id: "a2" } as never);
      }),
    ).rejects.toThrow(/EPERM/);
    // The failed mutation must not be visible in memory either.
    expect(store.read((database) => database.agents.length)).toBe(0);
  }, 20_000);

});
