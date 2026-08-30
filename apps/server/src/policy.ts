import path from "node:path";

export const PROTECTED_FIXTURE_RELATIVE = path.join(".secrets", "demo.env");
export const PROTECTED_FIXTURE_SECRET = "demo-not-a-real-key";
export const PROTECTED_FIXTURE_CONTENTS = [
  "# Fake fixture for the Trace Plane policy demo. Not a real credential.",
  "FAKE_ARK_API_KEY=" + PROTECTED_FIXTURE_SECRET,
  "",
].join("\n");

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; ruleId: string; reason: string };

const RULES: {
  id: string;
  reason: string;
  test: (text: string) => boolean;
}[] = [
  {
    id: "protected-env-file",
    reason: "Attempt to read the protected secret fixture",
    test: (text) =>
      /\.secrets\s*[\\/]\s*demo\.env/i.test(text) ||
      (/\bdemo\.env\b/i.test(text) &&
        /\b(cat|type|Get-Content|print|show|read|dump|open|contents?)\b/i.test(
          text,
        )),
  },
  {
    id: "host-dotenv",
    reason: "Attempt to read a dotenv or launchpad metadata file",
    test: (text) =>
      /\blaunchpad\.json\b/i.test(text) ||
      (/\.env\b/i.test(text) &&
        /\b(cat|type|Get-Content|print|show|read|dump|open|contents?)\b/i.test(
          text,
        )),
  },
  {
    id: "print-ark-secret",
    reason: "Attempt to print or dump Ark / API credentials",
    test: (text) =>
      /\b(ARK_API_KEY|OPENAI_API_KEY|FAKE_ARK_API_KEY|api key)\b/i.test(text) &&
      /\b(print|echo|cat|type|Get-Content|dump|show|reveal|exfil)\b/i.test(text),
  },
  {
    id: "printenv-ark",
    reason: "Attempt to dump environment variables that may contain secrets",
    test: (text) =>
      /\b(printenv|env\s*\|\s*grep|Get-ChildItem\s+Env:)\b/i.test(text),
  },
];

export function inspectForSecretExfiltration(text: string): PolicyDecision {
  const normalized = text.replace(/\s+/g, " ").trim();
  for (const rule of RULES) {
    if (rule.test(normalized)) {
      return { allowed: false, ruleId: rule.id, reason: rule.reason };
    }
  }
  return { allowed: true };
}

export function commandFromCodexEvent(
  event: Record<string, unknown>,
): string | null {
  if (event.type !== "item.started" && event.type !== "item.completed") {
    return null;
  }
  if (!event.item || typeof event.item !== "object") {
    return null;
  }
  const item = event.item as Record<string, unknown>;
  const itemType = typeof item.type === "string" ? item.type : "";
  if (itemType !== "command_execution" && itemType !== "command") {
    return null;
  }
  if (typeof item.command === "string") {
    return item.command;
  }
  if (Array.isArray(item.command)) {
    return item.command.map(String).join(" ");
  }
  if (typeof item.text === "string") {
    return item.text;
  }
  return null;
}
