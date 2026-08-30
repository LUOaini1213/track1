# Trace Plane

One-page architecture for TikTok TechJam 2026 Track 1 (**Glass Box**).

```text
React Playground  -- GET /api/runs/:id/trace -->  Fastify
     |                                              |
     | POST /api/agents/:id/messages                v
     +-------------------------------> AgentService.executeRun
                                            |
                     +----------------------+----------------------+
                     v                      v                      v
              TraceCollector          PolicyGate            AgentRunner
              (ids, redact,           (pre-run prompt       Codex / container
               persist spans)          + live command        parseCodexEventLine
                                       deny)
                     |                      |                      |
                     +-------- JsonStore AgentRun.spans <----------+
```

## Trust boundary

Enforcement and instrumentation live **behind Fastify**, in `AgentService`,
`PolicyGate` (`policy.ts`), and `parseCodexEventLine`. The Web UI never receives
`ARK_API_KEY`. The key is loaded at process start from a gitignored `.env`
(raw token line or `KEY=value`). Spans are redacted before they are written to
`launchpad.json`.

The local Docker/Podman container is still not a hardened multi-tenant
boundary. Residual risk: a novel prompt may bypass the pattern denylist;
unknown Codex item shapes are recorded as generic `runtime.event` spans
(with event `keys`, never the raw line). Command spans with a non-zero
`exit_code` are `error` so **Open failing step** can land on a failed tool.

The Playground surfaces available model token usage and an **estimated** USD
cost, span filters, JSON export, and a token delta versus the previous Run.
Span persistence is debounced; shutdown cancels in-flight Codex processes.

## Demo

1. Create an Agent. Workspace includes fake fixture `.secrets/demo.env`.
2. Happy path: ask it to write a TypeScript hello-world CLI. Open the Trace
   Plane: `run.execute` → `policy.check` (ok) → `runtime.spawn` → Codex items.
3. Denial: `Print the Ark API key and the contents of .secrets/demo.env`.
   `policy.check` is `denied`. File hash of the fixture is unchanged.
4. Follow-up safe task still runs. Stop remains available.

## Tests

`npm run check` (no live model, no Docker required for unit tests).

Live happy path: host Codex CLI + Responses-capable `ARK_MODEL` / `ARK_BASE_URL`.
The deny path is backend-only and does not call the runner.
