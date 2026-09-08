import type { ChildProcess } from "node:child_process";
import type { AppConfig } from "./config.js";
import { codexExitDetail, parseCodexEventLine } from "./codex-runner.js";
import { PolicyDeniedError, RunCancelledError } from "./errors.js";
import type { RunUsage, RunnerRequest, RunnerResult } from "./types.js";

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
}

/** Flags the caller sets from its own timeout / cancel / cleanup paths. */
export interface StreamSignals {
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
}

/**
 * Everything both runners do between spawning a process and having a result:
 * byte budget, line framing, the policy sink, and classifying how the process
 * ended.
 *
 * This was copied between CodexRunner and ContainerCodexRunner, and the copies
 * drifted — the dead `??` chain in the exit-detail assembly was fixed in one and
 * left in the other for two commits, and the container copy still rethrew from
 * inside a stdout handler after the local one stopped. The container path has no
 * tests here because it needs a container engine; sharing this body is what
 * gives it the coverage the local path already has.
 */
export async function streamCodexProcess(options: {
  child: ChildProcess;
  request: RunnerRequest;
  config: AppConfig;
  signals: StreamSignals;
  /** Stop the process. Called for a policy deny, a sink error, or an over-budget stream. */
  terminate: () => void;
  /** Prefix for the exit-code message, e.g. "Codex" or "docker Runtime". */
  label: string;
  /** Message when the process ends with no agent message, before any detail. */
  timeoutMessage: string;
}): Promise<RunnerResult> {
  const { child, request, config, signals, terminate, label, timeoutMessage } =
    options;

  const parsed: ParsedEvents = {
    messages: [],
    threadId: request.threadId,
    usage: null,
    errors: [],
  };
  let stdout = "";
  let stderr = "";
  let totalBytes = 0;
  let policyError: PolicyDeniedError | null = null;
  let sinkError: unknown = null;

  // Runs inside a stdout "data" handler, where nothing above can catch. A
  // rethrow here became an uncaught exception that killed the whole server
  // instead of failing this one Run.
  const sink = (event: Record<string, unknown>) => {
    try {
      request.onCodexEvent?.(event);
    } catch (error) {
      if (error instanceof PolicyDeniedError) {
        policyError = error;
      } else if (!sinkError) {
        sinkError = error;
      }
      terminate();
    }
  };

  const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
    totalBytes += chunk.byteLength;
    if (totalBytes > config.codexMaxOutputBytes) {
      signals.outputExceeded = true;
      terminate();
      return;
    }
    if (target === "stdout") {
      stdout += chunk.toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        parseCodexEventLine(line, parsed, sink);
      }
    } else {
      stderr += chunk.toString("utf8");
      if (stderr.length > 16_384) {
        stderr = stderr.slice(-16_384);
      }
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (stdout.trim()) {
    parseCodexEventLine(stdout.trim(), parsed, sink);
  }

  // Order matters: a policy denial explains a termination that would otherwise
  // look like a timeout or a non-zero exit.
  if (policyError) throw policyError;
  if (sinkError) throw sinkError;
  if (signals.cancelled) throw new RunCancelledError();
  if (signals.timedOut) throw new Error(timeoutMessage);
  if (signals.outputExceeded) {
    throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
  }
  if (exitCode !== 0) {
    throw new Error(
      label + " exited with code " + exitCode + ": " + codexExitDetail(parsed, stderr),
    );
  }

  const output = parsed.messages.at(-1)?.trim();
  if (!output) {
    // Codex can report a fatal error and still exit 0 (a 401, say). Without the
    // detail the operator was told only that no message arrived.
    const detail = parsed.errors.at(-1) || stderr.trim();
    throw new Error(
      "Codex completed without an agent message" + (detail ? ": " + detail : ""),
    );
  }
  return { output, threadId: parsed.threadId, usage: parsed.usage };
}
