import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function applyEnvFile(
  contents: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const applied: string[] = [];
  const trimmed = contents.trim();
  if (!trimmed) {
    return applied;
  }

  const looksLikeRawSecret =
    !trimmed.includes("\n") &&
    !trimmed.includes("\r") &&
    !trimmed.includes("=");

  if (looksLikeRawSecret) {
    if (env.ARK_API_KEY === undefined || env.ARK_API_KEY === "") {
      env.ARK_API_KEY = trimmed;
      applied.push("ARK_API_KEY");
    }
    return applied;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    const value = stripQuotes(line.slice(separator + 1).trim());
    if (env[key] === undefined || env[key] === "") {
      env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

export function loadLocalEnv(
  startDir: string,
  env: NodeJS.ProcessEnv = process.env,
): { file: string | null; keys: string[] } {
  let directory = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(directory, ".env");
    if (existsSync(candidate)) {
      const keys = applyEnvFile(readFileSync(candidate, "utf8"), env);
      return { file: candidate, keys };
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return { file: null, keys: [] };
}
