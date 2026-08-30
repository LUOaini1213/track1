import { describe, expect, it } from "vitest";
import { redactDeep, redactText } from "./redact.js";

describe("redact", () => {
  it("removes key-like strings and keeps ordinary task text", () => {
    expect(redactText("Create a TypeScript hello-world CLI")).toBe(
      "Create a TypeScript hello-world CLI",
    );
    expect(redactText("ARK_API_KEY=ep-secretvalue999")).toContain("[REDACTED]");
    expect(redactText("Authorization: Bearer abcdef")).toContain("[REDACTED]");
    expect(redactText("token sk-abcdefghijklmnop")).toContain("[REDACTED]");
    expect(redactText("FAKE_ARK_API_KEY=demo-not-a-real-key")).not.toContain(
      "demo-not-a-real-key",
    );
  });

  it("redacts nested objects before persistence", () => {
    const redacted = redactDeep({
      prompt: "Bearer super-secret-token",
      nested: { command: "echo demo-not-a-real-key" },
    });
    expect(redacted.prompt).toContain("[REDACTED]");
    expect(redacted.nested.command).toContain("[REDACTED]");
  });
});
