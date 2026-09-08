import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SpanStore } from "./span-store.js";
import type { TraceSpan } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function store() {
  const root = await mkdtemp(path.join(tmpdir(), "spanstore-"));
  directories.push(root);
  const spans = new SpanStore(path.join(root, "spans"));
  await spans.initialize();
  return { spans, root: path.join(root, "spans") };
}

const RUN = "11111111-1111-4111-8111-111111111111";
const span = (id: string): TraceSpan => ({
  traceId: "t", spanId: id, parentSpanId: null, runId: RUN, agentId: "a",
  name: "execute_tool shell", kind: "tool", status: "ok",
  startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z",
  durationMs: 1000, attributes: {},
});

describe("SpanStore", () => {
  it("round-trips a Run's spans", async () => {
    const { spans } = await store();
    await spans.write(RUN, [span("a"), span("b")]);
    expect((await spans.read(RUN)).map((s) => s.spanId)).toEqual(["a", "b"]);
  });

  it("treats a Run with no span file as having no spans", async () => {
    // The Run record is the source of truth for whether a Run exists; a missing
    // span file means nothing was recorded, not that the read failed.
    const { spans } = await store();
    expect(await spans.read(RUN)).toEqual([]);
  });

  it("survives a span file truncated by a crash", async () => {
    const { spans, root } = await store();
    await spans.write(RUN, [span("a")]);
    await writeFile(path.join(root, RUN + ".json"), '[{"spanId":"a"', "utf8");
    expect(await spans.read(RUN)).toEqual([]);
  });

  it("refuses to build a path from a Run id it did not mint", async () => {
    // runId reaches this from an HTTP route.
    const { spans } = await store();
    for (const hostile of ["../../etc/passwd", "..", "a/b", ""]) {
      await expect(spans.read(hostile)).rejects.toThrow(/Refusing/);
    }
  });

  it("deletes the files for the Runs it is given, and tolerates absent ones", async () => {
    const { spans, root } = await store();
    const other = "22222222-2222-4222-8222-222222222222";
    await spans.write(RUN, [span("a")]);
    await spans.delete([RUN, other]);
    await expect(readFile(path.join(root, RUN + ".json"))).rejects.toThrow();
    expect(await spans.read(RUN)).toEqual([]);
  });

  it("reports span files whose Run is gone", async () => {
    const { spans } = await store();
    const orphan = "33333333-3333-4333-8333-333333333333";
    await spans.write(RUN, [span("a")]);
    await spans.write(orphan, [span("b")]);
    expect(await spans.orphans(new Set([RUN]))).toEqual([orphan]);
  });

  it("writes atomically, leaving no temporary file behind", async () => {
    const { spans, root } = await store();
    await spans.write(RUN, [span("a")]);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(root)).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("serialises concurrent writes to one Run instead of clobbering them", async () => {
    // The collector's debounced write is fire-and-forget, so it can still be in
    // flight when the Run's terminal write starts. Sharing one temporary
    // filename made them destroy each other and a rename fail with ENOENT,
    // which is not transient — it surfaced as a failed Run, in roughly one test
    // run in three.
    const { spans } = await store();
    const batches = Array.from({ length: 40 }, (_, i) =>
      Array.from({ length: i + 1 }, (_, j) => span("s" + i + "-" + j)),
    );
    await Promise.all(batches.map((batch) => spans.write(RUN, batch)));

    const stored = await spans.read(RUN);
    // Whichever write landed last, the file must be one whole batch — never a
    // mix of two, and never missing.
    expect(stored.length).toBeGreaterThan(0);
    const prefix = stored[0]?.spanId.split("-")[0];
    expect(stored.every((s) => s.spanId.startsWith(prefix + "-"))).toBe(true);
    expect(stored).toHaveLength(Number(prefix?.slice(1)) + 1);
  }, 20_000);

  it("leaves no temporary files behind after concurrent writes", async () => {
    const { spans, root } = await store();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => spans.write(RUN, [span("s" + i)])),
    );
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(root)).filter((f) => f.includes(".tmp"))).toEqual([]);
  }, 20_000);

  it("does not accumulate a queue entry for every Run it has written", async () => {
    // The first version of the write queue cleared its entry with a truthiness
    // check on a map it had just populated, so the branch could never fire and
    // the map grew by one entry per Run for the life of the process.
    const { spans } = await store();
    const internals = spans as unknown as { queues: Map<string, unknown> };
    const ids = Array.from(
      { length: 60 },
      (_, i) => "5" + String(i).padStart(7, "0") + "-0000-4000-8000-000000000000",
    );
    for (const id of ids) {
      await spans.write(id, [span("s")]);
    }
    expect(internals.queues.size).toBe(0);

    await Promise.all(
      Array.from({ length: 20 }, () => spans.write(ids[0]!, [span("s")])),
    );
    expect(internals.queues.size).toBe(0);
  }, 20_000);
});
