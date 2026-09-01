const REDACTED = "[REDACTED]";
const MIN_CONFIGURED_SECRET_LENGTH = 12;
const configuredSecrets = new Set<string>();

// A safety net behind the exact-match pass, not a secret scanner. Shapes are
// drawn from the credential formats that public scanners (gitleaks,
// detect-secrets) treat as high-confidence: a fixed prefix plus a length floor,
// which is what keeps the false-positive rate low enough to run on every span.
// No pattern survives a value the Agent transforms; the policy gate, not this,
// is the control that keeps a secret out of a Run.
const PATTERNS: RegExp[] = [
  /\bBearer\s+\S+/gi,
  // Trailing boundary is deliberately a lookahead, not \b: a key ending in
  // "-" or "_" has no word boundary after it and would otherwise be missed.
  /\b(sk|ep)-[A-Za-z0-9_-]{8,}(?![A-Za-z0-9])/g,
  /\b\w*(ARK_API_KEY|OPENAI_API_KEY|API_KEY|AUTHORIZATION)\s*[=:]\s*\S+/gi,
  /\bdemo-not-a-real-key\b/gi,
  /\bFAKE_ARK_API_KEY\s*[=:]\s*\S+/gi,
  // JSON Web Token: three base64url segments, header always starts "eyJ".
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
  // PEM private key block, including the body.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAKLT[A-Za-z0-9_-]{16,}(?![A-Za-z0-9])/g, // Volcengine access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bxox[baprs]-[0-9A-Za-z-]{10,}(?![A-Za-z0-9])/g, // Slack token
  /\bgh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g, // GitHub token
  // Credentials embedded in a connection string: scheme://user:secret@host
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi,
];

export function registerSecrets(values: Array<string | undefined | null>): void {
  for (const value of values) {
    const secret = value?.trim() ?? "";
    if (secret.length >= MIN_CONFIGURED_SECRET_LENGTH) {
      configuredSecrets.add(secret);
    }
  }
}

export function clearRegisteredSecrets(): void {
  configuredSecrets.clear();
}

export function redactText(value: string): string {
  let next = value;
  for (const secret of configuredSecrets) {
    if (next.includes(secret)) {
      next = next.split(secret).join(REDACTED);
    }
  }
  for (const pattern of PATTERNS) {
    next = next.replace(pattern, (match: string, ...groups: unknown[]) => {
      // Connection string: keep the scheme, user and host readable, drop only
      // the password — a redacted DSN is still useful for diagnosis.
      if (match.endsWith("@") && match.includes("://")) {
        const prefix = groups.find((g) => typeof g === "string");
        return (prefix ?? match.split(":").slice(0, -1).join(":")) + ":" + REDACTED + "@";
      }
      const separator = match.match(/[=:]/);
      if (separator && /key|authorization/i.test(match)) {
        const name = match.slice(0, match.indexOf(separator[0]) + 1);
        return name + REDACTED;
      }
      if (match.toLowerCase().startsWith("bearer ")) {
        return "Bearer " + REDACTED;
      }
      return REDACTED;
    });
  }
  return next;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redactText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item)) as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, nested]) => [key, redactDeep(nested)],
    );
    return Object.fromEntries(entries) as T;
  }
  return value;
}
