import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import { HttpError } from "./errors.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
  getTrace: (id: string) => {
    if (id === "00000000-0000-4000-8000-000000000099") {
      throw new HttpError(404, "Run not found");
    }
    return {
      run: { id, spans: [], traceId: "trace-1" },
      traceId: "trace-1",
      spans: [],
    };
  },
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it(
    "protects API routes with the configured shared token",
    async () => {
    const app = await createApp(
      loadConfig({
        NODE_ENV: "test",
        LOG_LEVEL: "silent",
        APP_AUTH_TOKEN: "a-strong-test-token",
      }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  },
    20_000,
  );

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      service,
    );
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("exposes a run trace endpoint", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      service,
    );
    const found = await app.inject({
      method: "GET",
      url: "/api/runs/00000000-0000-4000-8000-000000000001/trace",
    });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ traceId: "trace-1" });

    const missing = await app.inject({
      method: "GET",
      url: "/api/runs/00000000-0000-4000-8000-000000000099/trace",
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
