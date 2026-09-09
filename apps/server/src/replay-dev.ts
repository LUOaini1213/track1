// Entry point for `npm run demo`: the control plane against recorded Codex
// events, with no model key and no Codex install. A `.env` cannot override
// this — loadLocalEnv only fills variables that are still unset.
process.env.RUNTIME_PROVIDER = "replay";
await import("./index.js");
