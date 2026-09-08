/** Types that cross the HTTP boundary. Server-only shapes stay in the server. */

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

/**
 * Aligned with the OpenTelemetry GenAI semantic conventions (Development
 * stage): `agent` and `llm` carry the `invoke_agent` and `chat` operations.
 * `policy`, `runtime` and `sandbox` have no well-known equivalent and remain
 * custom values, which the spec permits.
 * See docs/TRACE_PLANE.md for the full mapping table.
 */
export type SpanKind =
  | "agent"
  | "runtime"
  | "llm"
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
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  traceId: string;
  spans: TraceSpan[];
}
