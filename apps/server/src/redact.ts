const REDACTED = "[REDACTED]";
const MIN_CONFIGURED_SECRET_LENGTH = 12;
const configuredSecrets = new Set<string>();

const PATTERNS: RegExp[] = [
  /\bBearer\s+\S+/gi,
  /\b(sk|ep)-[A-Za-z0-9_-]{8,}\b/g,
  /\b(ARK_API_KEY|OPENAI_API_KEY|API_KEY|AUTHORIZATION)\s*[=:]\s*\S+/gi,
  /\bdemo-not-a-real-key\b/gi,
  /\bFAKE_ARK_API_KEY\s*[=:]\s*\S+/gi,
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
    next = next.replace(pattern, (match) => {
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
