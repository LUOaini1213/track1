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
 *
 * The lookbehind keeps `process.env` out of it: the `.env` in
 * `process.env.PORT` is a property access, not a file, and "read the port
 * from process.env" was being denied as a dotenv read.
 */
const DOTENV_NOT_A_TEMPLATE =
  /(?<![\w.])\.env\b(?!\.(?:example|sample|template|dist)\b)/i;

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

/**
 * Getting at a file's bytes by any of the usual routes: pagers and filters
 * (`head`, `grep`, `sed`), copies (`cp`, `scp`), encoders (`base64`, `xxd`),
 * shell sourcing, and the read calls of the runtimes an Agent scripts in.
 * `cat` on its own is a denylist entry, not a policy.
 */
const FILE_READ =
  /\b(cat|type|Get-Content|gc|print|show|read|dump|open|contents?|head|tail|less|more|grep|sed|awk|cp|copy|scp|mv|move|base64|xxd|od|hexdump|strings|tac|nl|tee|source|readFile\w*|read_text|read_bytes)\b/i;

/**
 * Dumping the whole environment, which is where the real key lives. Bare
 * `env` only counts as a command — at the start, after a shell separator or
 * an opening quote — and only when nothing but a pipe, a redirect or the end
 * follows it, so "set up the dev env" and "(env)" in prose stay allowed.
 */
const ENV_DUMP: RegExp[] = [
  /\bprintenv\b/i,
  /(?:^|[;&|"'`]\s*|\bsudo\s+|\bexec\s+)env\s*(?:$|[|>;&"'`])/,
  /\bexport\s+-p\b/,
  /\bdeclare\s+-[a-z]*[xp]\b/,
  /\b(?:Get-ChildItem|gci|dir|ls)\s+env:/i,
  /\bGetEnvironmentVariables\b/i,
  // Whole-object dumps of the runtime's environment map. A single lookup
  // (`process.env.PORT`, `os.environ.get(...)`) is ordinary code.
  /\b(?:console\.log|log|print\w*|echo|dump|JSON\.stringify|vars|pprint)\s*\(?\s*(?:dict\(\s*)?(?:process\.env|os\.environ)\b(?!\s*[.\[])/i,
  /\bObject\.(?:keys|entries|values)\(\s*process\.env\s*\)/,
  /\{\s*\*\*os\.environ\s*\}/,
];

const RULES: {
  id: string;
  reason: string;
  test: (text: string) => boolean;
}[] = [
  {
    // Anything under the protected directory, globs and encoders included:
    // `cat .secrets/*` and `base64 .secrets/demo.env` are the same act as
    // `cat .secrets/demo.env`.
    id: "protected-env-file",
    reason: "Attempt to read the protected secret fixture",
    test: (text) =>
      /\.secrets\s*[\\/]/i.test(text) ||
      (/\bdemo\.env\b/i.test(text) && FILE_READ.test(text)),
  },
  {
    id: "host-dotenv",
    reason: "Attempt to read a dotenv or launchpad metadata file",
    test: (text) =>
      /\blaunchpad\.json\b/i.test(text) ||
      (DOTENV_NOT_A_TEMPLATE.test(text) && FILE_READ.test(text)),
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
    test: (text) => ENV_DUMP.some((pattern) => pattern.test(text)),
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
