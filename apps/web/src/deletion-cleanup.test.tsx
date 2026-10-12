import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeletionCleanupController, DeletionCleanupPanel, initialCleanupView } from "./deletion-cleanup";
import { setAuthToken } from "./api";

const id = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002";
const item = { id, kind: "agent" as const, runCount: 2 };
const respond = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const controllers: DeletionCleanupController[] = [];
function controller() { const model = new DeletionCleanupController(vi.fn()); controllers.push(model); return model; }
function render(model: DeletionCleanupController) { return renderToStaticMarkup(<DeletionCleanupPanel view={model.view}
  onRetry={vi.fn()} onRefresh={vi.fn()} onDismiss={vi.fn()} />); }
afterEach(() => { controllers.splice(0).forEach((model) => model.stop()); vi.useRealTimers(); vi.unstubAllGlobals(); setAuthToken(""); });

describe("refresh-safe deletion cleanup", () => {
  it("recovers persisted pending entries on a fresh mount without paths or secret fields", async () => {
    setAuthToken("test-token");
    const fetch = vi.fn(async () => respond({ pending: [{ ...item, workspacePath: "private-directory", credential: "private-key" }] }));
    vi.stubGlobal("fetch", fetch);
    const model = controller(); await model.start();
    expect(model.view.pending).toEqual([item]);
    expect(fetch).toHaveBeenCalledWith("/api/deletion-cleanup", expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }));
    const html = render(model); expect(html).toContain("Deleted Agent 00000000"); expect(html).toContain("2 related Runs");
    expect(html).toContain("Retry cleanup"); expect(html).not.toMatch(/private-directory|private-key|archived successfully/);
  });

  it.each([null, "private-archive-path"])('reports pending cleanup independently from archivedWorkspace=%s', async (archivedWorkspace) => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => init?.method === "DELETE"
      ? respond({ archivedWorkspace, cleanupPending: true }) : respond({ pending: [item] }));
    vi.stubGlobal("fetch", fetch); const model = controller(); await model.remove(id, "Removed Agent");
    expect(model.view.notice).toContain("Agent record removed"); expect(model.view.pending).toHaveLength(1);
    expect(render(model)).toContain("Removed Agent"); expect(render(model)).toContain("cleanup is pending");
    expect(JSON.stringify(model.view)).not.toContain("private-archive-path");
  });

  it("accepts completed cleanup with an absent workspace and permits dismissing the receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.method === "DELETE"
      ? respond({ archivedWorkspace: null, cleanupPending: false }) : respond({ pending: [] })));
    const model = controller(); await model.remove(id, "Removed");
    expect(model.view.notice).toContain("cleanup completed"); expect(model.view.pending).toEqual([]);
    model.dismiss(); expect(render(model)).toBe("");
  });

  it("keeps pending status on an outage, then reports automatic completion without another DELETE", async () => {
    vi.useFakeTimers(); const fetch = vi.fn().mockResolvedValueOnce(respond({ pending: [item] }))
      .mockResolvedValueOnce(respond({ error: "private-directory/secret" }, 503)).mockResolvedValueOnce(respond({ pending: [] }));
    vi.stubGlobal("fetch", fetch); const model = controller(); await model.start();
    await vi.advanceTimersByTimeAsync(5000); expect(model.view.pending).toHaveLength(1); expect(model.view.error).toContain("HTTP 503");
    expect(render(model)).not.toContain("private-directory"); await vi.advanceTimersByTimeAsync(5000);
    expect(model.view.pending).toEqual([]); expect(model.view.notice).toBe("1 cleanup task completed.");
    await vi.advanceTimersByTimeAsync(20000); expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("stops unauthorized automatic queries until an explicit refresh", async () => {
    vi.useFakeTimers(); const fetch = vi.fn().mockResolvedValueOnce(respond({}, 401)).mockResolvedValueOnce(respond({ pending: [] }));
    vi.stubGlobal("fetch", fetch); const model = controller(); await model.start();
    await vi.advanceTimersByTimeAsync(60000); expect(fetch).toHaveBeenCalledTimes(1);
    await model.refresh(); expect(model.view.error).toBeNull();
  });

  it.each([{}, { pending: null }, { pending: [{ ...item, runCount: -1 }] }, { pending: [{ ...item, id: [id] }] }])("never treats malformed success as an empty journal: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(respond({ pending: [item] })).mockResolvedValueOnce(respond(body)));
    const model = controller(); await model.start(); await model.refresh();
    expect(model.view.pending).toHaveLength(1); expect(model.view.error).toContain("could not be confirmed");
    expect(model.view.notice).toBeNull();
  });

  it("ignores an old in-flight snapshot after a newer deletion receipt", async () => {
    let finish!: (response: Response) => void, reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "DELETE") return respond({ archivedWorkspace: null, cleanupPending: true });
      if (++reads === 1) return new Promise<Response>((resolve) => { finish = resolve; });
      return respond({ pending: [item] });
    }));
    const model = controller(), starting = model.start();
    const removing = model.remove(id, "Pending"); await Promise.resolve(); await Promise.resolve();
    finish(respond({ pending: [] })); await Promise.all([starting, removing]);
    expect(model.view.pending).toHaveLength(1); expect(model.view.notice).toContain("cleanup is pending");
  });

  it("ignores responses after the view is disposed", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    const model = controller(), pending = model.start(); model.stop(); finish(respond({ pending: [item] })); await pending;
    expect(model.view.pending).toEqual([]);
  });

  it("invalidates a restarted empty read captured before DELETE commit but returned after its pending receipt", async () => {
    let first!: (response: Response) => void, second!: (response: Response) => void, receipt!: (response: Response) => void;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (init?.method === "DELETE") return new Promise<Response>((resolve) => { receipt = resolve; });
      if (++reads === 1) return new Promise<Response>((resolve) => { first = resolve; });
      if (reads === 2) return new Promise<Response>((resolve) => { second = resolve; });
      return respond({ pending: [item] });
    }));
    const model = controller(), starting = model.start(), removing = model.remove(id, "Pending");
    first(respond({ pending: [] })); await vi.waitFor(() => expect(second).toBeTypeOf("function"));
    receipt(respond({ archivedWorkspace: null, cleanupPending: true }));
    await vi.waitFor(() => expect(model.view.pending).toHaveLength(1));
    second(respond({ pending: [] })); await Promise.all([starting, removing]);
    expect(model.view.pending).toHaveLength(1); expect(model.view.notice).toContain("cleanup is pending");
    expect(model.view.notice).not.toContain("completed");
  });
});

describe("same-id cleanup retry and deletion receipts", () => {
  it("handles automatic cleanup racing the retry's DELETE 404 only after both fresh absence checks", async () => {
    let deleted = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { deleted = true; return respond({ error: "Agent not found" }, 404); }
      return respond(url === "/api/agents" ? { agents: [] } : { pending: deleted ? [] : [item] });
    });
    vi.stubGlobal("fetch", fetch); const model = controller(); await model.start(); await model.remove(id, undefined, true);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    expect(model.view.notice).toContain("cleanup completed"); expect(model.view.error).toBeNull();
    expect(model.view.pending).toEqual([]);
  });

  it("does not DELETE a stale pending id that is now a live Agent", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(respond({ pending: [item] }))
      .mockResolvedValueOnce(respond({ pending: [] })).mockResolvedValueOnce(respond({ agents: [{ id }] }));
    vi.stubGlobal("fetch", fetch); const model = controller(); await model.start(); await model.remove(id, undefined, true);
    expect(fetch).toHaveBeenCalledTimes(3); expect(model.view.error).toContain("record is still present");
    expect(model.view.notice).toBeNull();
  });

  it("retains a pending entry if a 404 receipt cannot be confirmed by fresh reads", async () => {
    let attempted = false;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (init?.method === "DELETE") { attempted = true; return respond({}, 404); }
      if (url === "/api/agents") return respond({ agents: [] });
      return attempted ? respond({ error: "private-path" }, 503) : respond({ pending: [item] });
    }));
    const model = controller(); await model.start(); await model.remove(id, undefined, true);
    expect(model.view.pending).toHaveLength(1); expect(model.view.notice).not.toContain("completed");
    expect(model.view.error).toContain("could not be confirmed"); expect(render(model)).not.toContain("private-path");
  });

  it("locks retries synchronously and binds the request to the pending row's id", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(async (url, init) => {
      if (init?.method === "DELETE") return new Promise<Response>((resolve) => { finish = resolve; });
      return respond(url === "/api/agents" ? { agents: [{ id: other }] } : { pending: [item] });
    });
    vi.stubGlobal("fetch", fetch); const model = controller(); await model.start();
    const first = model.remove(id, undefined, true), doubleClick = model.remove(id, undefined, true);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function")); finish(respond({ archivedWorkspace: null, cleanupPending: true }));
    await Promise.all([first, doubleClick]); const calls = fetch.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(calls).toHaveLength(1); expect(calls[0]?.[0]).toBe("/api/agents/" + id);
    await model.remove(other, undefined, true); expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("does not invent pending/complete status on a failed initial deletion with a live Agent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => init?.method === "DELETE"
      ? respond({ error: "EACCES private-directory private-secret" }, 500)
      : respond(url === "/api/agents" ? { agents: [{ id }] } : { pending: [] })));
    const model = controller(); await model.remove(id, "Still exists");
    expect(model.view.pending).toEqual([]); expect(model.view.notice).toBeNull();
    expect(render(model)).toContain("Deletion was not confirmed"); expect(render(model)).not.toContain("private-");
  });

  it("recovers a dropped initial response by querying the actual removed record and persisted cleanup", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (init?.method === "DELETE") throw new TypeError("Lost response");
      return respond(url === "/api/agents" ? { agents: [] } : { pending: [item] });
    }));
    const model = controller(); await model.remove(id, "Removed");
    expect(model.view.notice).toContain("Agent record removed"); expect(model.view.pending).toHaveLength(1);
  });

  it("supports a legacy removal receipt without claiming the new cleanup guarantee", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => init?.method === "DELETE"
      ? respond({ archivedWorkspace: "private-archive" }) : respond({}, 404)));
    const model = controller(); await model.start(); await model.remove(id, "Legacy");
    expect(model.view.notice).toContain("Agent record removed"); expect(model.view.notice).toContain("does not report cleanup completion");
    expect(render(model)).not.toContain("private-archive"); expect(model.view.pending).toEqual([]);
  });

  it("does not confirm absence from a malformed Agent list after a retry 404", async () => {
    let attempted = false;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (init?.method === "DELETE") { attempted = true; return respond({}, 404); }
      return respond(url === "/api/agents" ? { agents: attempted ? [{ id: [id] }] : [] } : { pending: attempted ? [] : [item] });
    }));
    const model = controller(); await model.start(); await model.remove(id, undefined, true);
    expect(model.view.pending).toHaveLength(1); expect(model.view.notice).not.toContain("completed");
    expect(model.view.error).toContain("could not be confirmed");
  });

  it("completes orphan cleanup without claiming an Agent or workspace was removed", async () => {
    let attempted = false;
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      if (init?.method === "DELETE") { attempted = true; return respond({ archivedWorkspace: null, cleanupPending: false }); }
      return respond(url === "/api/agents" ? { agents: [] } : { pending: attempted ? [] : [{ ...item, kind: "orphan_traces" }] });
    }));
    const model = controller(); await model.start(); await model.remove(id, undefined, true);
    expect(model.view.notice).toBe("Orphan trace cleanup completed."); expect(render(model)).not.toContain("Agent record removed");
  });

  it("renders orphan trace cleanup distinctly and keeps unavailable observations visible", () => {
    const html = renderToStaticMarkup(<DeletionCleanupPanel view={{ ...initialCleanupView(), availability: "error",
      pending: [{ id, kind: "orphan_traces", runCount: 1 }], error: "Last observation remains", retryingId: id }}
      onRetry={vi.fn()} onRefresh={vi.fn()} onDismiss={vi.fn()} />);
    expect(html).toContain("Orphan trace cleanup"); expect(html).toContain("1 related Run"); expect(html).toContain("Retrying…");
    expect(html).toContain("Last observation remains"); expect(html).not.toContain("Deleted Agent 00000000");
  });
});
