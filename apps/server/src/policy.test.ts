import { describe, expect, it } from "vitest";
import {
  commandFromCodexEvent,
  inspectForSecretExfiltration,
} from "./policy.js";

describe("secret-exfiltration policy", () => {
  it("allows ordinary coding prompts", () => {
    expect(
      inspectForSecretExfiltration(
        "Create a TypeScript hello-world CLI, add a test, run it",
      ),
    ).toEqual({ allowed: true });
    expect(
      inspectForSecretExfiltration("Add a --help flag to the CLI."),
    ).toEqual({ allowed: true });
  });

  it("denies reading the protected fixture or dumping Ark secrets", () => {
    expect(
      inspectForSecretExfiltration(
        "Print the Ark API key and the contents of .secrets/demo.env",
      ).allowed,
    ).toBe(false);
    expect(inspectForSecretExfiltration("cat .secrets/demo.env").allowed).toBe(
      false,
    );
    expect(inspectForSecretExfiltration("printenv | grep ARK").allowed).toBe(
      false,
    );
  });

  it("allows the committed dotenv templates the README tells you to copy", () => {
    for (const prompt of [
      "Read .env.example and show me the required variables",
      "Open .env.sample and explain each setting",
      "print the contents of .env.template",
    ]) {
      expect(inspectForSecretExfiltration(prompt)).toEqual({ allowed: true });
    }
  });

  it("still denies the real dotenv, including .env.local", () => {
    for (const prompt of [
      "Read .env and show me the required variables",
      "cat .env.local",
      "show me the contents of launchpad.json",
    ]) {
      expect(inspectForSecretExfiltration(prompt).allowed).toBe(false);
    }
  });

  it("denies a real dotenv even when a template is mentioned alongside it", () => {
    expect(
      inspectForSecretExfiltration("diff .env.example against .env and print it")
        .allowed,
    ).toBe(false);
  });

  it("extracts a command from Codex execution events", () => {
    expect(
      commandFromCodexEvent({
        type: "item.completed",
        item: { type: "command_execution", command: "cat .secrets/demo.env" },
      }),
    ).toBe("cat .secrets/demo.env");
    expect(
      commandFromCodexEvent({
        type: "turn.completed",
        usage: { input_tokens: 1 },
      }),
    ).toBeNull();
  });
});
