import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type {
  Agent,
  AgentRun,
  Message,
  RunCompareSide,
  SystemInfo,
  TraceSpan,
} from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

type TraceFilter =
  | "all"
  | "problems"
  | "llm"
  | "tool"
  | "policy"
  | "sandbox";

// Mirrors pickFailingSpan in apps/server/src/run-compare.ts. A failure marks
// every span on the path to it, but run.execute and runtime.spawn are wrappers
// with no diagnostics, so "Open failing step" must land on the innermost span
// that actually explains the failure.
const DIAGNOSTIC_KEYS = [
  "errorText",
  "exitCode",
  "reason",
  "ruleId",
  "error",
  "failedStep",
];

function pickFailingSpan(spans: TraceSpan[]): TraceSpan | undefined {
  const problems = spans.filter(
    (span) => span.status === "error" || span.status === "denied",
  );
  if (problems.length === 0) {
    return undefined;
  }
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const depthOf = (span: TraceSpan): number => {
    let depth = 0;
    let current: TraceSpan | undefined = span;
    const seen = new Set<string>();
    while (current?.parentSpanId && !seen.has(current.spanId)) {
      seen.add(current.spanId);
      current = byId.get(current.parentSpanId);
      depth += 1;
    }
    return depth;
  };
  const ranked = [...problems].sort(
    (left, right) => depthOf(right) - depthOf(left),
  );
  return (
    ranked.find((span) =>
      DIAGNOSTIC_KEYS.some((key) => {
        const value = span.attributes[key];
        return value !== undefined && value !== null;
      }),
    ) ?? ranked[0]
  );
}

function formatUsage(
  usage: AgentRun["usage"],
  estimatedCostUsd: number | null,
): string | null {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  if (input <= 0 && output <= 0 && estimatedCostUsd == null) {
    return null;
  }
  const cost =
    estimatedCostUsd != null ? " · est. $" + estimatedCostUsd.toFixed(6) : "";
  return input + " in / " + output + " out tokens" + cost;
}

/**
 * Waterfall geometry. Depth and the time base are computed over the FULL span
 * list, never the filtered one — filtering must not re-flatten the hierarchy or
 * re-scale the bars.
 */
interface SpanLayout {
  depth: number;
  offsetPercent: number;
  widthPercent: number;
  hasChildren: boolean;
}

function layoutSpans(spans: TraceSpan[]): Map<string, SpanLayout> {
  const layout = new Map<string, SpanLayout>();
  if (spans.length === 0) {
    return layout;
  }
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const parents = new Set(
    spans.map((span) => span.parentSpanId).filter((id): id is string => !!id),
  );
  const starts = spans.map((span) => Date.parse(span.startedAt));
  const base = Math.min(...starts);
  const end = Math.max(
    ...spans.map((span) =>
      span.endedAt ? Date.parse(span.endedAt) : Date.parse(span.startedAt),
    ),
  );
  // A trace that starts and ends inside the same millisecond would divide by
  // zero; clamp so every bar still renders at a visible minimum width.
  const total = Math.max(1, end - base);
  for (const span of spans) {
    let depth = 0;
    let current: TraceSpan | undefined = span;
    const seen = new Set<string>();
    while (current?.parentSpanId && !seen.has(current.spanId)) {
      seen.add(current.spanId);
      current = byId.get(current.parentSpanId);
      depth += 1;
    }
    const offset = Date.parse(span.startedAt) - base;
    const duration = span.durationMs ?? Math.max(0, end - Date.parse(span.startedAt));
    layout.set(span.spanId, {
      depth,
      offsetPercent: (offset / total) * 100,
      widthPercent: Math.max(1.5, (duration / total) * 100),
      hasChildren: parents.has(span.spanId),
    });
  }
  return layout;
}

function TracePanel({
  spans,
  selectedId,
  onSelect,
  usage,
  estimatedCostUsd,
  previousUsage,
  compare,
  onExport,
}: {
  spans: TraceSpan[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  usage: AgentRun["usage"];
  estimatedCostUsd: number | null;
  previousUsage: AgentRun["usage"];
  compare: { left: RunCompareSide; right: RunCompareSide } | null;
  onExport: () => void;
}) {
  const [filter, setFilter] = useState<TraceFilter>("all");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  const failing = pickFailingSpan(spans);
  const selected = spans.find((span) => span.spanId === selectedId) ?? failing;
  const layout = layoutSpans(spans);

  const toggleCollapsed = (spanId: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }
      return next;
    });
  };

  // Hidden when any ancestor is collapsed — walk the chain, not just the parent.
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const hiddenByCollapse = (span: TraceSpan): boolean => {
    let current = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
    const seen = new Set<string>();
    while (current && !seen.has(current.spanId)) {
      if (collapsedIds.has(current.spanId)) {
        return true;
      }
      seen.add(current.spanId);
      current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
    }
    return false;
  };

  const visible = spans.filter((span) => {
    if (filter === "problems") {
      return span.status === "error" || span.status === "denied";
    }
    if (hiddenByCollapse(span)) {
      return false;
    }
    if (filter === "all") {
      return true;
    }
    return span.kind === filter;
  });

  // "Open failing step" is the 30-second root-cause affordance: selecting the
  // span is not enough if it is below the fold.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected?.spanId]);
  const usageLabel = formatUsage(usage, estimatedCostUsd);
  const delta =
    usage && previousUsage
      ? (usage.inputTokens ?? 0) +
        (usage.outputTokens ?? 0) -
        ((previousUsage.inputTokens ?? 0) + (previousUsage.outputTokens ?? 0))
      : null;
  return (
    <section className="trace-panel" aria-label="Run trace">
      <div className="trace-panel-header">
        <div>
          <span className="eyebrow">Trace Plane</span>
          <strong>Run timeline</strong>
          {usageLabel ? <span className="trace-usage">{usageLabel}</span> : null}
          {delta != null ? (
            <span className="trace-usage">
              vs previous run: {delta >= 0 ? "+" : ""}
              {delta} tokens
            </span>
          ) : null}
          {compare ? (
            <span className="trace-usage">
              compare {compare.left.runId.slice(0, 8)} (
              {compare.left.durationMs ?? "?"}ms
              {compare.left.failingSpan
                ? "; fail " +
                  (compare.left.failingSpan.command ?? compare.left.failingSpan.name)
                : ""}
              ) vs {compare.right.runId.slice(0, 8)} (
              {compare.right.durationMs ?? "?"}ms
              {compare.right.failingSpan
                ? "; fail " +
                  (compare.right.failingSpan.command ??
                    compare.right.failingSpan.name)
                : ""}
              )
            </span>
          ) : null}
        </div>
        <div className="trace-actions">
          {failing ? (
            <button
              type="button"
              className="button button-ghost"
              onClick={() => onSelect(failing.spanId)}
            >
              Open failing step
            </button>
          ) : (
            <span className="trace-count">{spans.length} spans</span>
          )}
          <button type="button" className="button button-ghost" onClick={onExport}>
            Export JSON
          </button>
        </div>
      </div>
      <div className="trace-filters" role="tablist" aria-label="Span filter">
        {(
          ["all", "problems", "llm", "tool", "policy", "sandbox"] as TraceFilter[]
        ).map(
          (item) => (
            <button
              key={item}
              type="button"
              className={"trace-filter" + (filter === item ? " selected" : "")}
              onClick={() => setFilter(item)}
            >
              {item}
            </button>
          ),
        )}
      </div>
      <ol className="trace-list">
        {visible.map((span) => {
          const geometry = layout.get(span.spanId);
          const collapsed = collapsedIds.has(span.spanId);
          return (
            <li key={span.spanId}>
              <button
                type="button"
                ref={
                  selected?.spanId === span.spanId ? selectedRowRef : undefined
                }
                className={
                  "trace-row trace-" +
                  span.status +
                  (selected?.spanId === span.spanId ? " selected" : "")
                }
                onClick={() => onSelect(span.spanId)}
              >
                <span
                  className="trace-label"
                  style={{ paddingLeft: (geometry?.depth ?? 0) * 12 }}
                >
                  {geometry?.hasChildren ? (
                    <span
                      className="trace-twisty"
                      role="button"
                      tabIndex={-1}
                      aria-label={collapsed ? "Expand" : "Collapse"}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleCollapsed(span.spanId);
                      }}
                    >
                      {collapsed ? "▸" : "▾"}
                    </span>
                  ) : (
                    <span className="trace-twisty trace-twisty-empty" />
                  )}
                  <span className={"trace-kind trace-kind-" + span.kind}>
                    {span.kind}
                  </span>
                  <span className="trace-name">{span.name}</span>
                  <span className="trace-status">{span.status}</span>
                </span>
                <span className="trace-track">
                  <span
                    className={"trace-bar trace-bar-" + span.kind}
                    style={{
                      marginLeft: (geometry?.offsetPercent ?? 0) + "%",
                      width: (geometry?.widthPercent ?? 100) + "%",
                    }}
                  />
                </span>
                <span className="trace-duration">
                  {span.durationMs != null ? span.durationMs + "ms" : "…"}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {selected ? (
        <pre className="trace-attributes">
          {selected.attributes.failedStep
            ? "failing step: " + String(selected.attributes.failedStep) + "\n"
            : ""}
          {selected.attributes.retriedSpanId
            ? "retry of span " + String(selected.attributes.retriedSpanId) + "\n"
            : ""}
          {JSON.stringify(selected.attributes, null, 2)}
        </pre>
      ) : null}
    </section>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [runUsage, setRunUsage] = useState<AgentRun["usage"]>(null);
  const [estimatedCostUsd, setEstimatedCostUsd] = useState<number | null>(null);
  const [previousUsage, setPreviousUsage] = useState<AgentRun["usage"]>(null);
  const [runCompare, setRunCompare] = useState<{
    left: RunCompareSide;
    right: RunCompareSide;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setSpans([]);
    setSelectedSpanId(null);
    setRunUsage(null);
    setEstimatedCostUsd(null);
    setPreviousUsage(null);
    setRunCompare(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(async ([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest) {
          const trace = await api.trace(latest.id).catch(() => null);
          if (selectedIdRef.current === selectedId && trace) {
            setSpans(trace.spans);
            setRunUsage(trace.usage);
            setEstimatedCostUsd(trace.estimatedCostUsd);
          }
          const previous = result.runs[1];
          setPreviousUsage(previous?.usage ?? null);
          if (previous) {
            const compared = await api
              .compareRuns(selectedId)
              .catch(() => null);
            if (selectedIdRef.current === selectedId && compared) {
              setRunCompare({ left: compared.left, right: compared.right });
            }
          }
        }
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const trace = await api.trace(runId);
        if (selectedIdRef.current === agentId) {
          setActiveRun(trace.run);
          setSpans(trace.spans);
          setRunUsage(trace.usage);
          setEstimatedCostUsd(trace.estimatedCostUsd);
        }
        if (!["queued", "running"].includes(trace.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        setSpans(result.run.spans ?? []);
        setSelectedSpanId(null);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              {spans.length > 0 ? (
                <TracePanel
                  spans={spans}
                  selectedId={selectedSpanId}
                  onSelect={setSelectedSpanId}
                  usage={runUsage}
                  estimatedCostUsd={estimatedCostUsd}
                  previousUsage={previousUsage}
                  compare={runCompare}
                  onExport={() => {
                    const payload = {
                      run: activeRun,
                      spans,
                      usage: runUsage,
                      estimatedCostUsd,
                    };
                    const blob = new Blob([JSON.stringify(payload, null, 2)], {
                      type: "application/json",
                    });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = "trace-" + (activeRun?.id ?? "run") + ".json";
                    link.click();
                    URL.revokeObjectURL(url);
                  }}
                />
              ) : null}

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
