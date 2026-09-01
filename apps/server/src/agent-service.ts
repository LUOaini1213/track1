import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, PolicyDeniedError, RunCancelledError } from "./errors.js";
import {
  commandFromCodexEvent,
  inspectForSecretExfiltration,
} from "./policy.js";
import { redactText, registerSecrets } from "./redact.js";
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
 */
function usageFromSpans(spans: TraceSpan[]): RunUsage | null {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const span of spans) {
    if (span.kind !== "llm") {
      continue;
    }
    const input = span.attributes["gen_ai.usage.input_tokens"];
    const output = span.attributes["gen_ai.usage.output_tokens"];
    if (typeof input === "number") inputTokens += input;
    if (typeof output === "number") outputTokens += output;
  }
  if (inputTokens <= 0 && outputTokens <= 0) {
    return null;
  }
  return { inputTokens, outputTokens };
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {
    registerSecrets([config.arkApiKey, config.authToken]);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
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
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
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
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
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
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getTrace(runId: string): {
    run: AgentRun;
    traceId: string;
    spans: AgentRun["spans"];
    usage: AgentRun["usage"];
    estimatedCostUsd: number | null;
  } {
    const run = this.getRun(runId);
    return {
      run,
      traceId: run.traceId,
      spans: run.spans,
      usage: run.usage,
      estimatedCostUsd: estimateCostUsd(run.usage),
    };
  }

  async shutdown(): Promise<void> {
    const ids = [...this.activeExecutions.keys()];
    await Promise.all(ids.map((id) => this.cancelExecution(id)));
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  compareAgentRuns(
    agentId: string,
    leftId?: string,
    rightId?: string,
  ): {
    agentId: string;
    left: ReturnType<typeof compareRuns>["left"];
    right: ReturnType<typeof compareRuns>["right"];
  } {
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
    const compared = compareRuns(left, right);
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
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      if (storedRun) {
        storedRun.traceId = collector.traceId;
        storedRun.spans = spans;
      }
    });
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    const collector = new TraceCollector(run.id, agentAtStart.id, {
      modelName: this.config.arkModel || null,
      captureContent: this.config.traceCaptureContent,
      onChange: (spans) => {
        void this.store
          .mutate((database) => {
            const storedRun = database.runs.find((item) => item.id === run.id);
            if (storedRun) {
              storedRun.traceId = collector.traceId;
              storedRun.spans = spans;
            }
          })
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
        collector.endSpan(runtimeSpanId, "ok");
        collector.endSpan(rootSpanId, "ok");
        const completedAt = now();
        const output = redactText(result.output);
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
          storedRun.spans = collector.snapshot();
          database.messages.push({
            id: randomUUID(),
            agentId: agent.id,
            runId: run.id,
            role: "assistant",
            content: output,
            createdAt: completedAt,
          });
          agent.status = "ready";
          agent.codexThreadId = result.threadId;
          agent.lastError = null;
          agent.updatedAt = completedAt;
        });
      } catch (error) {
        const runtimeStatus =
          error instanceof PolicyDeniedError
            ? "denied"
            : error instanceof RunCancelledError
              ? "cancelled"
              : "error";
        collector.endSpan(runtimeSpanId, runtimeStatus);
        throw error;
      }
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const denied = error instanceof PolicyDeniedError;
      const message = error instanceof Error ? error.message : String(error);
      const rootStatus = cancelled ? "cancelled" : denied ? "denied" : "error";
      if (
        collector.spans.some(
          (span) => span.spanId === rootSpanId && span.endedAt === null,
        )
      ) {
        collector.endSpan(rootSpanId, rootStatus, {
          error: redactText(message),
        });
      }
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
          storedRun.spans = spans;
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
