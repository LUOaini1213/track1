import { afterEach, describe, expect, it } from "vitest";
import {
  clearRegisteredSecrets,
  redactDeep,
  redactText,
  registerSecrets,
} from "./redact.js";

afterEach(() => {
  clearRegisteredSecrets();
});

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

  it("strips configured runtime secrets that miss generic key regexes", () => {
    const secret = "runtime-secret-token-xyz";
    expect(redactText("leak " + secret)).toContain(secret);
    registerSecrets([secret]);
    const redacted = redactText("stored event leak " + secret + " in trace");
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[REDACTED]");
  });
});
