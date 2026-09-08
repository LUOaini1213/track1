/**
 * Server-only shapes. Everything that crosses the HTTP boundary lives in
 * @launchpad/contract and is re-exported here so existing imports keep working
 * and the two sides cannot drift apart again.
 */
export * from "@launchpad/contract";
import type { Agent, AgentRun, Message, RunUsage } from "@launchpad/contract";

export interface Database {
  version: 2;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  onCodexEvent?: ((event: Record<string, unknown>) => void) | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
