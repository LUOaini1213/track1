import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, setAuthToken } from "./api";

const respond = (status: number, body: unknown, ok = status < 400) =>
  ({ ok, status, json: async () => body }) as Response;

afterEach(() => {
  vi.unstubAllGlobals();
  setAuthToken("");
});

describe("api client", () => {
  it("surfaces the server's message and status, not a generic failure", async () => {
    // The control plane answers {error: "..."} with a hand-written sentence.
    // Losing it here is what made a 409 read as "Request failed" in the UI.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        respond(409, { error: "Stop the active run before editing this Agent" }),
      ),
    );
    await expect(api.listAgents()).rejects.toMatchObject({
      message: "Stop the active run before editing this Agent",
      status: 409,
    });
  });

  it("still raises an ApiError when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      }) as unknown as Response),
    );
    const failure = await api.system().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(502);
  });

  it("sends the bearer token once set, and stops when cleared", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => respond(200, { agents: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const headersOf = (index: number) =>
      (fetchMock.mock.calls[index]?.[1]?.headers ?? {}) as Record<string, string>;

    await api.listAgents();
    expect(headersOf(0)).not.toHaveProperty("Authorization");

    setAuthToken("  a-token-with-padding  ");
    await api.listAgents();
    // Trimmed: a pasted token usually arrives with whitespace.
    expect(headersOf(1).Authorization).toBe("Bearer a-token-with-padding");

    setAuthToken("");
    await api.listAgents();
    expect(headersOf(2)).not.toHaveProperty("Authorization");
  });

  it("declares JSON only when it is actually sending a body", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => respond(200, {}),
    );
    vi.stubGlobal("fetch", fetchMock);
    await api.listAgents();
    expect(
      (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>,
    ).not.toHaveProperty("Content-Type");
  });
});
