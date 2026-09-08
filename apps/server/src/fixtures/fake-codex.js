#!/usr/bin/env node
// Stands in for the Codex CLI so CodexRunner.run can be tested end to end:
// real spawn, real stdout framing, real exit codes. The scenario is the last
// argv entry (the runner passes the prompt last).
const scenario = process.argv[process.argv.length - 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

const item = (id, type, extra = {}) => ({ id, type, ...extra });

async function main() {
  emit({ type: "thread.started", thread_id: "thread-fake" });

  if (scenario === "deny") {
    // The control plane should deny this and terminate us. If it does not, the
    // agent_message below arrives and the Run wrongly succeeds.
    emit({ type: "item.started", item: item("c1", "command_execution", {
      command: "cat .secrets/demo.env" }) });
    await new Promise((r) => setTimeout(r, 4000));
    emit({ type: "item.completed", item: item("a1", "agent_message", {
      text: "leaked the fixture" }) });
    emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    return;
  }

  if (scenario === "hang") {
    // A pending promise is not a handle, so it does not hold the event loop
    // open — node would exit immediately and the child would never hang.
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return;
  }

  if (scenario === "fail-silently") {
    process.exit(1);
  }

  if (scenario === "error-then-exit-zero") {
    emit({ type: "error", message: "401 Unauthorized: invalid API key" });
    process.exit(0);
  }

  if (scenario === "throwing-event") {
    emit({ type: "boom" });
    await new Promise((r) => setTimeout(r, 3000));
    emit({ type: "item.completed", item: item("a1", "agent_message", { text: "survived" }) });
    return;
  }

  emit({ type: "item.completed", item: item("c1", "command_execution", {
    command: "npm test", exit_code: 0 }) });
  emit({ type: "item.completed", item: item("a1", "agent_message", { text: "all good" }) });
  emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } });
}

main();
