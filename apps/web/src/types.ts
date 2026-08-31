export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export type SpanKind =
  | "orchestration"
  | "runtime"
  | "model"
  | "tool"
  | "sandbox"
  | "policy";

export type SpanStatus = "ok" | "error" | "denied" | "cancelled";

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  runId: string;
  agentId: string;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  attributes: Record<string, string | number | boolean | null>;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
  traceId?: string;
  spans?: TraceSpan[];
}

export interface RunCompareSide {
  runId: string;
  status: RunStatus;
  durationMs: number | null;
  usage: AgentRun["usage"];
  estimatedCostUsd: number | null;
  failingSpan: {
    spanId: string;
    name: string;
    kind: string;
    status: string;
    command: string | null;
    exitCode: number | null;
    errorText: string | null;
  } | null;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
