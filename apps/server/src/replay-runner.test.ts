import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPLAY_STARTER_PROMPTS } from "@launchpad/contract";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { PROTECTED_FIXTURE_SECRET } from "./policy.js";
import { clearRegisteredSecrets } from "./redact.js";
import {
  DEFAULT_REPLAY_FIXTURE_DIR,
  ReplayRunner,
  loadReplayFixtures,
  selectReplayFixture,
} from "./replay-runner.js";
import { pickFailingSpan, problemSpans } from "./run-compare.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  clearRegisteredSecrets();
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })),
  );
});

/** The control plane exactly as `npm run demo` starts it: replay, no Ark key. */
async function makeReplayService(): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-replay-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    RUNTIME_PROVIDER: "replay",
    REPLAY_SPEED: "1000",
    // Present on a developer machine; a replay must not name it in its spans.
    ARK_MODEL: "ep-local-endpoint",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    createRunner(config),
  );
  await service.initialize();
  return service;
}

const fastRunner = () =>
  new ReplayRunner({ fixtureDir: DEFAULT_REPLAY_FIXTURE_DIR, speed: 1000 });

describe("replay fixtures", () => {
  it("ship as valid Codex event streams with exactly one default", async () => {
    const fixtures = await loadReplayFixtures(DEFAULT_REPLAY_FIXTURE_DIR);
    expect(fixtures.map((fixture) => fixture.name)).toEqual([
      "hello-world-cli",
      "failing-test-run",
      "live-deny-config-files",
    ]);
    expect(fixtures.filter((fixture) => fixture.default)).toHaveLength(1);
    for (const fixture of fixtures) {
      expect(fixture.source, fixture.name).not.toBe("");
      expect(fixture.events[0]?.event.type).toBe("thread.started");
      let previous = 0;
      for (const entry of fixture.events) {
        expect(typeof entry.event.type).toBe("string");
        expect(entry.atMs).toBeGreaterThanOrEqual(previous);
        previous = entry.atMs;
      }
    }
  });

  it("are chosen by prompt keyword, with the default as the fallback", async () => {
    const fixtures = await loadReplayFixtures(DEFAULT_REPLAY_FIXTURE_DIR);
    const pick = (prompt: string) => selectReplayFixture(fixtures, prompt).name;
    expect(pick("Run the tests and fix the failing test.")).toBe("failing-test-run");
    expect(pick("Summarize the config files in this workspace.")).toBe(
      "live-deny-config-files",
    );
    expect(pick("Create a TypeScript hello-world CLI")).toBe("hello-world-cli");
    expect(pick("something else entirely")).toBe("hello-world-cli");
  });

  it("are all reachable from the prompts the demo actually offers", async () => {
    // The Playground's starter buttons and the README's demo lines both read
    // REPLAY_STARTER_PROMPTS. Nothing else connected them to the fixtures: the
    // only record of which words reach which recording is the `match` array
    // inside each fixture, so the starter kit's original three suggestions
    // matched none of them and every button replayed the same successful Run.
    // Editing a prompt, a `match` array or a fixture name now has to keep them
    // lined up or this fails.
    const fixtures = await loadReplayFixtures(DEFAULT_REPLAY_FIXTURE_DIR);
    expect(
      REPLAY_STARTER_PROMPTS.map(
        (item) => selectReplayFixture(fixtures, item.prompt).name,
      ),
    ).toEqual(REPLAY_STARTER_PROMPTS.map((item) => item.fixture));
    // One prompt per fixture, so none of the three example Runs is orphaned.
    expect(new Set(REPLAY_STARTER_PROMPTS.map((item) => item.fixture)).size).toBe(
      fixtures.length,
    );
  });
});

describe("ReplayRunner", () => {
  it("forwards every event to the sink and returns the last agent message", async () => {
    const types: string[] = [];
    const result = await fastRunner().run({
      agentId: "a",
      workspacePath: "/w",
      prompt: "hello",
      threadId: null,
      onCodexEvent: (event) => {
        types.push(String(event.type));
      },
    });
    expect(types[0]).toBe("thread.started");
    expect(types.at(-1)).toBe("turn.completed");
    expect(types.filter((type) => type === "item.started")).toHaveLength(3);
    expect(result.threadId).toBe("0199f0c2-4a5e-7d3b-8a11-2f6b7c9e1d42");
    expect(result.output).toContain("hello-world CLI");
    expect(result.usage).toEqual({
      inputTokens: 21518,
      cachedInputTokens: 15872,
      outputTokens: 1093,
    });
  });

  it("fails with the exit code and last error of the recorded process", async () => {
    await expect(
      fastRunner().run({
        agentId: "a",
        workspacePath: "/w",
        prompt: "fix the failing test",
        threadId: null,
      }),
    ).rejects.toThrow(
      "Codex exited with code 1: stream error: 429 Too Many Requests",
    );
  });

  it("can be cancelled while it waits for the next event", async () => {
    // At this speed the second event is ~40 s away.
    const runner = new ReplayRunner({
      fixtureDir: DEFAULT_REPLAY_FIXTURE_DIR,
      speed: 0.001,
    });
    // Wait on the first replayed event, not on a fixed sleep: after it the
    // runner is waiting for the second one, however slow the disk was.
    let firstEvent!: () => void;
    const waiting = new Promise<void>((resolve) => {
      firstEvent = resolve;
    });
    const pending = runner.run({
      agentId: "a",
      workspacePath: "/w",
      prompt: "hello",
      threadId: null,
      onCodexEvent: () => firstEvent(),
    });
    await waiting;
    expect(await runner.cancel("a")).toBe(true);
    await expect(pending).rejects.toThrow("Run cancelled");
    expect(await runner.cancel("a")).toBe(false);
  });

  it("honors a cancel pressed while the fixtures are still loading", async () => {
    const runner = fastRunner();
    let events = 0;
    const pending = runner.run({
      agentId: "a",
      workspacePath: "/w",
      prompt: "hello",
      threadId: null,
      onCodexEvent: () => {
        events += 1;
      },
    });
    // Nothing has been awaited yet, so the fixture files are not read.
    expect(await runner.cancel("a")).toBe(true);
    await expect(pending).rejects.toThrow("Run cancelled");
    expect(events).toBe(0);
    expect(await runner.cancel("a")).toBe(false);
  });
});

describe("replay through the control plane", () => {
  it("completes the hello-world fixture with the span tree a live Run gets", async () => {
    const service = await makeReplayService();
    expect(await service.systemInfo()).toMatchObject({
      replay: true,
      codexAvailable: true,
      arkConfigured: false,
      runtimeProvider: "replay",
    });
    const agent = await service.createAgent({ name: "Builder" });
    // The prompt the Playground's first starter button sends in replay, and
    // the status it advertises — so the button and this test cannot drift.
    const demo = REPLAY_STARTER_PROMPTS[0]!;
    const { run } = await service.sendMessage(agent.id, demo.prompt);
    await expect
      .poll(() => service.getRun(run.id).status, { timeout: 5_000 })
      .toBe(demo.status);
    const trace = await service.getTrace(run.id);
    const names = trace.spans.map((span) => span.name);
    expect(names.slice(0, 3)).toEqual([
      "invoke_agent Builder",
      "policy.check",
      "runtime.spawn",
    ]);
    expect(names.filter((name) => name === "execute_tool shell")).toHaveLength(3);
    expect(names).toContain("execute_tool apply_patch");
    expect(names).toContain("chat agent_message");
    expect(names).toContain("chat");
    expect(names.some((name) => name.includes("ep-local-endpoint"))).toBe(false);
    expect(trace.spans.every((span) => span.endedAt !== null)).toBe(true);
    expect(trace.spans.every((span) => span.status === "ok")).toBe(true);
    expect(trace.usage).toEqual({
      inputTokens: 21518,
      cachedInputTokens: 15872,
      outputTokens: 1093,
    });
    expect(service.getRun(run.id).output).toContain("Hello, TechJam!");
    expect(service.getAgent(agent.id).codexThreadId).toBe(
      "0199f0c2-4a5e-7d3b-8a11-2f6b7c9e1d42",
    );
  });

  it("fails the failing-test fixture and lands Open failing step on the first failed command", async () => {
    const service = await makeReplayService();
    const agent = await service.createAgent({ name: "Fixer" });
    const demo = REPLAY_STARTER_PROMPTS[1]!;
    const { run } = await service.sendMessage(agent.id, demo.prompt);
    await expect
      .poll(() => service.getRun(run.id).status, { timeout: 5_000 })
      .toBe(demo.status);
    const stored = service.getRun(run.id);
    // Spans live in the span store, not on the Run record.
    const storedSpans = (await service.getTrace(run.id)).spans;
    expect(stored.error).toContain("429 Too Many Requests");
    const problems = problemSpans(storedSpans);
    // This is the assertion the test title promises, and for a long time it was
    // not the one being made. The Run ends on a stream error, so `endOpenSpans`
    // closed the still-open `chat` span as an error with a placeholder
    // errorText; that used to tie the real failure on diagnostics and on depth
    // (siblings under `runtime.spawn`) and then win "earliest first", so
    // `problems[0]` was `chat` and this file asserted on `problems.find(...)`
    // to route around it. The ranker now sorts spans that were merely still
    // open behind spans that failed on their own, so `[0]` is the command that
    // exited 1 — which is where the UI's "Open failing step" button goes.
    const failedShell = problems[0];
    expect(failedShell).toMatchObject({
      name: "execute_tool shell",
      status: "error",
      attributes: { exitCode: 1 },
    });
    // errorText keeps the LAST 240 characters — a failing command explains
    // itself at the end, so the assertion detail survives and the "not ok 1"
    // header is what gets cut.
    expect(String(failedShell?.attributes.errorText)).toContain(
      "'Hello, TechJam' !== 'Hello, TechJam!'",
    );
    expect(problems.map((span) => span.name)).toContain("runtime.error");
    expect(storedSpans.every((span) => span.endedAt !== null)).toBe(true);
    expect(service.getAgent(agent.id).status).toBe("error");
  });

  it("denies the live command of the config-files fixture and never stores the fixture secret", async () => {
    const service = await makeReplayService();
    const agent = await service.createAgent({ name: "Reader" });
    const demo = REPLAY_STARTER_PROMPTS[2]!;
    const { run } = await service.sendMessage(agent.id, demo.prompt);
    await expect
      .poll(() => service.getRun(run.id).status, { timeout: 5_000 })
      .toBe(demo.status);
    const stored = service.getRun(run.id);
    // Spans live in the span store, not on the Run record.
    const storedSpans = (await service.getTrace(run.id)).spans;
    expect(stored.error).toContain("Policy denied");
    const shells = storedSpans.filter((span) => span.name === "execute_tool shell");
    expect(shells).toHaveLength(3);
    // The rule id lives on the `policy.live` span, not on the command it
    // stopped — asserted just below.
    expect(shells[2]).toMatchObject({
      status: "denied",
      attributes: { command: "bash -lc 'cat .secrets/demo.env'" },
    });
    expect(
      storedSpans.find((span) => span.name === "policy.live"),
    ).toMatchObject({ status: "denied", attributes: { ruleId: "protected-env-file" } });
    // …and it is also where "Open failing step" lands. The README's demo script
    // says "the denied policy span is highlighted", so that claim needs a test
    // behind it: a policy denial closes every span still in flight, and those
    // used to outrank the rule that did the denying.
    expect(pickFailingSpan(storedSpans)).toMatchObject({
      name: "policy.live",
      attributes: { ruleId: "protected-env-file" },
    });
    // The events after the denied command were never replayed.
    expect(storedSpans.some((span) => span.name === "chat agent_message")).toBe(false);
    expect(storedSpans.every((span) => span.endedAt !== null)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(PROTECTED_FIXTURE_SECRET);
    expect(service.getAgent(agent.id).status).toBe("ready");
  });
});
