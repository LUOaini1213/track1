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

/**
 * A dotenv reference that is not a committed template.
 *
 * `.env.example` and its siblings are checked into this repository and the
 * README tells operators to copy one, so denying them is a false positive on
 * the project's own documented setup path. `.env.local` is deliberately NOT
 * exempt — it is a real secret file, not a template.
 */
const DOTENV_NOT_A_TEMPLATE =
  /\.env\b(?!\.(?:example|sample|template|dist)\b)/i;

/** Names a credential. Every credential rule is gated on this. */
const CREDENTIAL =
  /\b(ARK_API_KEY|OPENAI_API_KEY|FAKE_ARK_API_KEY|api[ _-]?key|secret[ _-]?key|access[ _-]?token|credentials?)\b/i;

/** Asking to see it. */
const READ_INTENT =
  /\b(print|echo|cat|type|Get-Content|dump|show|reveal|exfil|display|output)\b/i;

/**
 * Asking to move it somewhere. Separated from READ_INTENT because the two
 * describe different acts: one puts the secret on screen, the other puts it
 * somewhere it outlives the Run.
 */
const EGRESS_INTENT =
  /\b(base64|encode|obfuscat\w*|upload|post|send|curl|wget|fetch|webhook|commit|push|paste|exfiltrat\w*|(write|save|append|copy|store)\b[^.]{0,40}\b(to|into|in)\b)\b/i;

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
      (DOTENV_NOT_A_TEMPLATE.test(text) &&
        /\b(cat|type|Get-Content|print|show|read|dump|open|contents?)\b/i.test(
          text,
        )),
  },
  {
    id: "print-ark-secret",
    reason: "Attempt to print or dump Ark / API credentials",
    test: (text) => CREDENTIAL.test(text) && READ_INTENT.test(text),
  },
  {
    // Reading a credential out loud is only one way to leak it. Encoding it,
    // writing it to a file, or posting it anywhere are the same act with an
    // extra hop, and none of them use a READ_INTENT verb.
    //
    // Deliberately gated on CREDENTIAL rather than on the verbs alone: "encode",
    // "write" and "upload" are everyday coding words, and a rule that fired on
    // them without a credential in the same prompt would deny ordinary work.
    id: "credential-egress",
    reason: "Attempt to encode, store, or transmit credentials",
    test: (text) => CREDENTIAL.test(text) && EGRESS_INTENT.test(text),
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
