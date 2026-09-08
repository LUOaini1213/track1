import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, PolicyDeniedError, RunCancelledError } from "./errors.js";
import {
  commandFromCodexEvent,
  inspectForSecretExfiltration,
} from "./policy.js";
import { redactText, registerSecrets } from "./redact.js";
import { exportTrace } from "./otlp.js";
import { SpanStore } from "./span-store.js";
import { JsonStore } from "./store.js";
import { estimateCostUsd } from "./cost.js";
import { compareRuns } from "./run-compare.js";
import { TraceCollector } from "./trace.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  RunUsage,
  TraceSpan,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

/**
 * A failed or denied Run never reaches the runner's usage result, but the model
 * spans already collected still carry the tokens the Run spent. The Track A gate
 * asks for the failing step *and* available usage on the same trace, so recover
 * it from the spans instead of persisting `usage: null`.
 *
 * Codex reports usage on `turn.completed` as a running total for the thread,
 * not as a per-turn delta — `parseCodexEventLine` assigns rather than adds
 * (codex-runner.ts), so the success path already reports the last value seen.
 * Summing here would make a failed Run report a different number than a
 * successful one for the same events, so take the last reading too.
 */
function usageFromSpans(spans: TraceSpan[]): RunUsage | null {
  let latest: RunUsage | null = null;
  for (const span of spans) {
    if (span.kind !== "llm") {
      continue;
    }
    const input = span.attributes["gen_ai.usage.input_tokens"];
    const output = span.attributes["gen_ai.usage.output_tokens"];
    const cached = span.attributes["gen_ai.usage.cache_read.input_tokens"];
    if (typeof input !== "number" && typeof output !== "number") {
      continue;
    }
    latest = {
      ...(typeof input === "number" ? { inputTokens: input } : {}),
      ...(typeof cached === "number" ? { cachedInputTokens: cached } : {}),
      ...(typeof output === "number" ? { outputTokens: output } : {}),
    };
  }
  if (!latest) {
    return null;
  }
  const total = (latest.inputTokens ?? 0) + (latest.outputTokens ?? 0);
  return total > 0 ? latest : null;
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly spanStore: SpanStore = new SpanStore(
      path.join(config.dataDirectory, "spans"),
    ),
  ) {
    registerSecrets([config.arkApiKey, config.authToken]);
  }

  /**
   * Terminal Run outcomes went to no log at all: a denied Run, a failed Run and
   * a Run that stranded its Agent were indistinguishable from a healthy one in
   * the server output. Kept deliberately small — a seam, not a logging library.
   */
  private log(level: "warn" | "error", message: string): void {
    if (this.config.logLevel === "silent") {
      return;
    }
    if (level === "error") {
      console.error("[launchpad] " + message);
    } else {
      console.warn("[launchpad] " + message);
    }
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.spanStore.initialize();
    await this.workspaces.initialize();

    // Spans used to live inside launchpad.json. Move any that are still there
    // into their own files, so an existing store keeps working and the main
    // document stops growing with them.
    const inline = this.store.read((database) =>
      database.runs
        .filter((run) => Array.isArray(run.spans) && run.spans.length > 0)
        .map((run) => ({ id: run.id, spans: run.spans })),
    );
    for (const run of inline) {
      const existing = await this.spanStore.read(run.id);
      if (existing.length === 0) {
        await this.spanStore.write(run.id, run.spans);
      }
    }

    await this.store.mutate((database) => {
      for (const run of database.runs) {
        run.spans = [];
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });

    // A Run interrupted by a restart left its spans open, so a finished Run
    // rendered as permanently running. Close them in their own file now.
    for (const run of this.store.read((database) =>
      database.runs.filter((item) => item.status === "cancelled"),
    )) {
      const spans = await this.spanStore.read(run.id);
      let changed = false;
      for (const span of spans) {
        if (span.endedAt === null) {
          const endedAt = run.completedAt ?? now();
          span.status = "cancelled";
          span.endedAt = endedAt;
          span.durationMs = Math.max(
            0,
            Date.parse(endedAt) - Date.parse(span.startedAt),
          );
          span.attributes = {
            ...span.attributes,
            errorText: run.error,
            unterminated: true,
          };
          changed = true;
        }
      }
      if (changed) {
        await this.spanStore.write(run.id, spans);
      }
    }

    const known = new Set(this.store.read((database) => database.runs.map((r) => r.id)));
    const orphans = await this.spanStore.orphans(known);
    if (orphans.length > 0) {
      await this.spanStore.delete(orphans);
    }
  }

  listAgents(): Agent[] {
    return this.store
      .read((database) => database.agents)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.read((database) =>
      database.agents.find((item) => item.id === id),
    );
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  /**
   * The prompt gate stops "print the Ark API key and .secrets/demo.env", but the
   * same sentence in an Agent's instructions went straight through — and Codex
   * reads AGENTS.md on every turn, so a benign prompt afterwards ("follow your
   * instructions") steered the model into exactly what the gate exists to stop.
   *
   * Rejected rather than redacted on purpose: the edit form loads stored
   * instructions back (App.tsx:593), so rewriting them here would persist
   * "[REDACTED]" into the operator's own system prompt on their next save. A
   * 422 tells them what happened and leaves their text intact.
   */
  private assertAgentTextAllowed(input: {
    name?: string | undefined;
    description?: string | undefined;
    instructions?: string | undefined;
  }): void {
    const text = [input.name, input.description, input.instructions]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (!text.trim()) {
      return;
    }
    const decision = inspectForSecretExfiltration(text);
    if (!decision.allowed) {
      throw new HttpError(
        422,
        "Policy denied: " + decision.ruleId + " (" + decision.reason + ")",
      );
    }
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    this.assertAgentTextAllowed(input);
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    this.assertAgentTextAllowed(input);
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    // Codex reads AGENTS.md, so write it before committing: previously the store
    // was updated first and a write failure left a 500 for the caller, a store
    // saying "updated", and an AGENTS.md still holding the old instructions.
    await this.workspaces.writeInstructions({
      ...current,
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined
        ? { description: input.description.trim() }
        : {}),
      ...(input.instructions !== undefined
        ? { instructions: input.instructions.trim() }
        : {}),
    });
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    return updated;
  }

  async deleteAgent(
    id: string,
  ): Promise<{ archivedWorkspace: string | null }> {
    const agent = this.getAgent(id);
    // Same ordering as stopAgent, and for a sharper reason: archive() renames
    // the workspace, and without the mark a Run admitted a moment earlier kept
    // executing inside the directory being moved out from under it.
    await this.setStatus(id, "stopped");
    await this.cancelExecution(id);
    // Remove the record first. Archiving used to come first and, when it threw,
    // left the Agent in the store with its workspace already moved — every
    // retry then failed with ENOENT and the Agent could never be deleted.
    const runIds = this.store.read((database) =>
      database.runs.filter((run) => run.agentId === id).map((run) => run.id),
    );
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    await this.spanStore.delete(runIds);
    const archivedWorkspace = await this.workspaces.archive(agent);
    if (!archivedWorkspace) {
      this.log(
        "warn",
        "agent " + id + " deleted, but its workspace could not be archived: " +
          agent.workspacePath,
      );
    }
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  /**
   * Mark first, then cancel. Cancelling first left a window: a sendMessage
   * whose admission was already queued in the store had not yet set
   * activeExecutions, so cancelExecution found nothing to cancel and the
   * request was cleared again before executeRun looked at it. The Agent was
   * then marked "stopped" while Codex ran to completion, and the finishing Run
   * flipped it back to "ready". Marking first makes the store queue order the
   * decision: the admission either lands before the mark and is visible to
   * cancelExecution, or lands after it and is rejected as stopped.
   */
  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    const stopped = await this.setStatus(id, "stopped");
    await this.cancelExecution(id);
    return stopped;
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .read((database) =>
        database.messages.filter((message) => message.agentId === agentId),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.read((database) =>
      database.runs.find((item) => item.id === runId),
    );
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  async getTrace(runId: string): Promise<{
    run: AgentRun;
    traceId: string;
    spans: AgentRun["spans"];
    usage: AgentRun["usage"];
    estimatedCostUsd: number | null;
  }> {
    const run = this.getRun(runId);
    const spans = await this.spanStore.read(runId);
    return {
      run: { ...run, spans },
      traceId: run.traceId,
      spans,
      usage: run.usage,
      estimatedCostUsd: estimateCostUsd(run.usage, this.config.costRates),
    };
  }

  async shutdown(): Promise<void> {
    const ids = [...this.activeExecutions.keys()];
    await Promise.all(ids.map((id) => this.cancelExecution(id)));
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .read((database) => database.runs.filter((run) => run.agentId === agentId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async compareAgentRuns(
    agentId: string,
    leftId?: string,
    rightId?: string,
  ): Promise<{
    agentId: string;
    left: ReturnType<typeof compareRuns>["left"];
    right: ReturnType<typeof compareRuns>["right"];
  }> {
    const runs = this.getRuns(agentId);
    const pick = (id: string | undefined, fallback: AgentRun | undefined) => {
      if (!id) {
        return fallback;
      }
      const match = runs.find((run) => run.id === id);
      if (!match) {
        throw new HttpError(404, "Run not found for this Agent");
      }
      return match;
    };
    const left = pick(leftId, runs[1]);
    const right = pick(rightId, runs[0]);
    if (!left || !right) {
      throw new HttpError(404, "Need two Runs on this Agent to compare");
    }
    const [leftSpans, rightSpans] = await Promise.all([
      this.spanStore.read(left.id),
      this.spanStore.read(right.id),
    ]);
    const compared = compareRuns(
      { ...left, spans: leftSpans },
      { ...right, spans: rightSpans },
      this.config.costRates,
    );
    return { agentId, ...compared };
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const storedPrompt = redactText(prompt);
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt: storedPrompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
      traceId: randomUUID(),
      spans: [],
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: storedPrompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async persistTrace(
    runId: string,
    collector: TraceCollector,
  ): Promise<void> {
    collector.flush();
    const spans = collector.snapshot();
    await this.spanStore.write(runId, spans);
    // Fire-and-forget: an unreachable trace backend must never turn a finished
    // Run into a failed one. The Run's own record is already durable above.
    void exportTrace(this.config, runId, spans)
      .then((result) => {
        if (result) {
          this.log(
            "warn",
            "exported " + result.exported + " spans for run " + runId + " to " +
              result.endpoint,
          );
        }
      })
      .catch((error: unknown) => {
        this.log(
          "warn",
          "OTLP export failed for run " + runId + ": " +
            (error instanceof Error ? error.message : String(error)),
        );
      });
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    const collector = new TraceCollector(run.id, agentAtStart.id, {
      modelName: this.config.arkModel || null,
      captureContent: this.config.traceCaptureContent,
      onChange: (spans) => {
        void this.spanStore
          .write(run.id, spans)
          // Debounced best-effort persistence: a failed interim write must not
          // become an unhandled rejection and take the process down mid-run.
          // The final trace is written again by persistTrace.
          .catch(() => undefined);
      },
    });
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
        storedRun.traceId = collector.traceId;
      }
    });
    let persistenceFailed = false;
    const rootSpanId = collector.startSpan(
      "invoke_agent " + agentAtStart.name,
      "agent",
      null,
      {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.id": agentAtStart.id,
        "gen_ai.agent.name": agentAtStart.name,
        promptChars: run.prompt.length,
      },
    );
    const policySpanId = collector.startSpan(
      "policy.check",
      "policy",
      rootSpanId,
    );
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const decision = inspectForSecretExfiltration(run.prompt);
      if (!decision.allowed) {
        collector.endSpan(policySpanId, "denied", {
          ruleId: decision.ruleId,
          reason: decision.reason,
        });
        collector.endSpan(rootSpanId, "denied");
        throw new PolicyDeniedError(decision.ruleId);
      }
      collector.endSpan(policySpanId, "ok", { ruleId: "allow" });

      const runtimeSpanId = collector.startSpan(
        "runtime.spawn",
        "runtime",
        rootSpanId,
        { workspace: agentAtStart.workspacePath },
      );
      let succeeded = false;
      try {
        const result = await this.runner.run({
          agentId: agentAtStart.id,
          workspacePath: agentAtStart.workspacePath,
          prompt: run.prompt,
          threadId: agentAtStart.codexThreadId,
          onCodexEvent: (event) => {
            collector.recordCodexEvent(runtimeSpanId, event);
            const command = commandFromCodexEvent(event);
            if (!command) {
              return;
            }
            const live = inspectForSecretExfiltration(command);
            if (!live.allowed) {
              const denyId = collector.startSpan(
                "policy.live",
                "policy",
                runtimeSpanId,
                { ruleId: live.ruleId, reason: live.reason },
              );
              collector.endSpan(denyId, "denied");
              throw new PolicyDeniedError(live.ruleId);
            }
          },
        });
        // Codex opened these on item.started and never sent item.completed.
        // They are not successes; leaving them open stored a finished Run whose
        // trace claimed a step was still running.
        collector.endOpenSpans("error", {
          errorText: "Codex never reported this step as completed",
        });
        collector.endSpan(runtimeSpanId, "ok");
        collector.endSpan(rootSpanId, "ok");
        const completedAt = now();
        const output = redactText(result.output);
        // Codex has succeeded. From here the only thing that can fail is the
        // store, and a store failure is not a Codex failure: recording it as one
        // used to relabel the already-green runtime.spawn span as the culprit
        // and drop the output, the assistant message and the thread id, so the
        // next turn resumed nothing. `succeeded` moves the remaining work out of
        // the runner's catch.
        succeeded = true;
        await this.persistTrace(run.id, collector);
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          const agent = database.agents.find((item) => item.id === agentAtStart.id);
          if (!storedRun || !agent) return;
          storedRun.status = "completed";
          storedRun.output = output;
          storedRun.usage = result.usage;
          storedRun.completedAt = completedAt;
          storedRun.traceId = collector.traceId;
          database.messages.push({
            id: randomUUID(),
            agentId: agent.id,
            runId: run.id,
            role: "assistant",
            content: output,
            createdAt: completedAt,
          });
          // An operator who pressed Stop while this Run was finishing gets to
          // keep that decision; the Run's own completion must not undo it.
          if (agent.status !== "stopped") {
            agent.status = "ready";
          }
          agent.codexThreadId = result.threadId;
          agent.lastError = null;
          agent.updatedAt = completedAt;
        });
      } catch (error) {
        if (succeeded) {
          // Codex finished; the store did not. Leave the trace's verdict on the
          // runtime alone and let the outer handler record a persistence
          // failure, not a Codex one.
          persistenceFailed = true;
          throw error;
        }
        const runtimeStatus =
          error instanceof PolicyDeniedError
            ? "denied"
            : error instanceof RunCancelledError
              ? "cancelled"
              : "error";
        collector.endOpenSpans(runtimeStatus, {
          errorText:
            runtimeStatus === "denied"
              ? "Terminated by the policy gate before this step completed"
              : "Run ended before this step completed",
        });
        collector.endSpan(runtimeSpanId, runtimeStatus);
        throw error;
      }
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const denied = error instanceof PolicyDeniedError;
      const raw = error instanceof Error ? error.message : String(error);
      // Codex already produced a result; only the store failed. Saying so keeps
      // the operator looking at the disk rather than at the model.
      const message = persistenceFailed
        ? "The Agent finished, but its result could not be saved: " + raw
        : raw;
      const rootStatus = cancelled ? "cancelled" : denied ? "denied" : "error";
      collector.endOpenSpans(rootStatus, {
        errorText: "Run ended before this step completed",
      });
      if (
        collector.spans.some(
          (span) => span.spanId === rootSpanId && span.endedAt === null,
        )
      ) {
        collector.endSpan(rootSpanId, rootStatus, {
          error: redactText(message),
        });
      }
      this.log(
        cancelled || denied ? "warn" : "error",
        (denied ? "run denied" : cancelled ? "run cancelled" : "run failed") +
          " runId=" +
          run.id +
          " agentId=" +
          agentAtStart.id +
          ": " +
          message,
      );
      await this.persistTrace(run.id, collector);
      const spans = collector.snapshot();
      const partialUsage = usageFromSpans(spans);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = redactText(message);
          storedRun.completedAt = completedAt;
          storedRun.traceId = collector.traceId;
          storedRun.usage = partialUsage;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled || denied ? "ready" : "error";
          }
          agent.lastError = cancelled || denied ? null : redactText(message);
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
