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

The Playground renders the span tree as a waterfall — indented by
`parentSpanId`, offset by `startedAt`, bar width proportional to `durationMs` —
and surfaces available model token usage and an **estimated** USD
cost, span filters, JSON export, a token delta versus the previous Run, retry
linkage (`retriedSpanId`), failing-step diagnostics, and a two-Run compare from
`GET /api/agents/:id/runs/compare`. Span persistence is debounced; shutdown
cancels in-flight Codex processes.

## Span vocabulary

Aligned with the OpenTelemetry GenAI semantic conventions
([open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai),
**Development stage** as of 2026-08-31 — the spec permits breaking changes and
has no tagged release, so this is alignment, not compliance). Span names follow
the `{operation} {name}` form the spec asks for, kept low-cardinality.

| Source event | Span kind | Span name | OTel operation |
| --- | --- | --- | --- |
| Run started | `agent` | `invoke_agent {agent.name}` | `invoke_agent` |
| Pre-run policy gate | `policy` | `policy.check` | *(custom)* |
| Live command gate | `policy` | `policy.live` | *(custom)* |
| Runner spawn | `runtime` | `runtime.spawn` | *(custom)* |
| Codex `thread.started` | `runtime` | `runtime.thread` | *(custom)* |
| Codex `turn.completed` | `llm` | `chat {model}` | `chat` |
| Codex `command_execution` | `tool` | `execute_tool shell` | `execute_tool` |
| Codex `file_change` | `sandbox` | `execute_tool apply_patch` | `execute_tool` |
| Codex `agent_message` / `reasoning` | `llm` | `chat {itemType}` | `chat` |
| Unrecognized Codex item | `runtime` | `runtime.{itemType}` | *(custom)* |

`policy`, `runtime` and `sandbox` have no well-known equivalent in the spec,
which explicitly permits custom values rather than forcing a bad fit.

Token counts are written as `gen_ai.usage.input_tokens` /
`gen_ai.usage.output_tokens`. **Caveat we do not paper over:** OTel expects
those to be the billed, cache-inclusive counts. Ours are whatever Codex reports
on `turn.completed`; the span records that provenance in
`gen_ai.usage.source`, and the UI keeps the dollar figure labelled `est.`.

### Content capture

OTel keeps GenAI content attributes (`gen_ai.input.messages` and friends)
**Opt-In** because of the PII risk. `TRACE_CAPTURE_CONTENT` is the equivalent
switch here. It defaults **on**: the failing command and its exit code are the
deliverable of an audit trace, so a default-off tool would gut its own
root-cause story. Set it to `false` and commands, error text and workspace
paths become `[content capture disabled]` while status, `exitCode`,
`gen_ai.tool.name` and the span tree survive — the failure stays diagnosable
without the content.

Native OTLP export is post-hackathon roadmap; today the trace is served as JSON
from `GET /api/runs/:id/trace` and exported from the Playground.

## Demo

1. Create an Agent. Workspace includes fake fixture `.secrets/demo.env`.
2. Happy path: ask it to write a TypeScript hello-world CLI. Open the Trace
   Plane: `invoke_agent {name}` → `policy.check` (ok) → `runtime.spawn` → Codex
   item spans, drawn as a waterfall.
3. Denial: `Print the Ark API key and the contents of .secrets/demo.env`.
   `policy.check` is `denied`. File hash of the fixture is unchanged.
4. Follow-up safe task still runs. Stop remains available.

## Tests

`npm run check` (no live model, no Docker required for unit tests).

Live happy path: host Codex CLI + Responses-capable `ARK_MODEL` / `ARK_BASE_URL`.
The deny path is backend-only and does not call the runner.
