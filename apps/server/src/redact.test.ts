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

  it("redacts the credential shapes public scanners treat as high-confidence", () => {
    const cases: [string, string][] = [
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk", "JWT"],
      ["AKIAIOSFODNN7EXAMPLE", "AWS access key id"],
      ["AKLTZmY1ZjYwNzk4NDU0NGQ2", "Volcengine access key id"],
      ["xoxb-123456789012-abcdefghijkl", "Slack token"],
      ["ghp_abcdefghijklmnopqrstuvwxyz0123", "GitHub token"],
      ["AIzaSyD-1234567890abcdefghijklmnopqrstu", "Google API key"],
    ];
    for (const [secret, label] of cases) {
      const out = redactText(`value ${secret} end`);
      expect(out, label).toContain("[REDACTED]");
      expect(out, label).not.toContain(secret);
    }
  });

  it("keeps a connection string diagnosable while dropping the password", () => {
    expect(redactText("postgres://appuser:hunter2@db.internal:5432/prod")).toBe(
      "postgres://appuser:[REDACTED]@db.internal:5432/prod",
    );
  });

  it("redacts a key that ends on a non-word character", () => {
    expect(redactText("token sk-abcdefghijkl-")).toContain("[REDACTED]");
  });
});
