export * from "@launchpad/contract";

export interface DeletionCleanupEntry {
  id: string;
  kind: "agent" | "orphan_traces";
  runCount: number;
}

export interface DeleteAgentResult {
  archivedWorkspace: string | null;
  /** Absent on servers before recoverable deletion was introduced. */
  cleanupPending?: boolean;
}

/** Shape of GET /api/system, which the browser reads and the server assembles. */
export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container" | "replay";
  replay: boolean;
  containerEngine: string | null;
  runtime: string;
}
