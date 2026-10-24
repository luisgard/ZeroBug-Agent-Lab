# API Proof (Spec 01 §7) — Status: **BLOCKED**

**Result:** no real Agents API or Decisions API call has been made. The environment where this wave was built has no `OPENAI_API_KEY`. Per Spec 01, this is reported as BLOCKED and the project proceeds with deterministic offline runners. **We do not claim the OpenAI integration passed.**

## What exists

| Item | Status |
| --- | --- |
| SDK | `openai@7.43.0`, pinned. Exposes `client.beta.agents.sessions` and `client.decisions`. |
| `AgentsApiRunner` (`src/runner/agents-api.ts`) | Written against the installed SDK type definitions. Contract-tested with a fake client (`tests/agents-api.test.ts`). **Never run live.** |
| `DecisionsJudge` (`src/judge/judge.ts`) | Same: contract-tested with a fake client. **Never run live.** |
| Proof script | `npm run proof` → prints `API PROOF: BLOCKED` and exits 3 without a key. |
| Live test | `ZB_LIVE=1 OPENAI_API_KEY=... npm run test:e2e` → `tests/live/real-api.test.ts`, labeled REAL. |

## Shapes taken from the SDK type definitions (not yet confirmed live)

**Create and stream a session**

```ts
const stream = await client.beta.agents.sessions.create({
  stream: true,
  environment: { type: "none" },            // "none" requires `input`
  agent: { model, instructions, tools: [{ type: "function", name, description, parameters }] },
  input: task,
  metadata: { zerobug_run_id: runId },
});
for await (const event of stream) { /* AgentSessionEvent */ }
```

**Events the runner handles**

| Event `type` | Runner action |
| --- | --- |
| `agent.session.requires_action` | For each `event.session.required_actions[]` with `type: "function_call"` (`call_id`, `turn_id`, `name`, `arguments`): execute in the world, then submit the result. |
| `agent.session.turn.output_text.done` | Keep `event.text` as the latest output text. |
| `agent.session.turn.completed` | Final message = last output text (or `null`). |
| `agent.session.turn.failed`, `agent.session.turn.cancelled`, `agent.session.failed`, `error` | `infrastructure_error`. |
| no event for `stallMs` (30 s) | `infrastructure_error`. |

**Submit a tool result**

```ts
await client.beta.agents.sessions.events.create(sessionId, {
  events: [{ type: "agent.session.input.tool_result", turn_id, call_id, success: true, output: JSON.stringify(output) }],
  // on failure: success: false, error: "<message>"
});
```

Cancel: `{ type: "agent.session.input.cancel" }`. Cleanup: `client.beta.agents.sessions.delete(sessionId)`.

**Decisions**

```ts
const d = await client.decisions.create({
  model: "gpt-6-luna",                       // only supported model per SDK docs
  input: [{ role: "user", content: evidenceText }],
  questions: [{ type: "predicate", name: "claim:<checkId>", instructions: "..." }, /* choice, score */],
});
// d.answers[i]: { type: "predicate", probability } | { type: "choice", choice, confidence } |
//               { type: "score", score, confidence } | { type: "refusal", name }
```

## Open questions that only a live run can answer

1. Does the creation stream keep delivering events after a tool result is submitted, or must the runner switch to `sessions.events.stream(sessionId)`? (The runner assumes the creation stream continues, which the SDK's `toolHandlers` helper suggests.)
2. Are `function_call.arguments` delivered as an object or a JSON string? (The runner accepts both.)
3. Exact event order around `requires_action`, and which permissions/scopes the key needs.
4. Real latency, cost and the highest concurrency without rate-limit errors (Spec 01 asks to measure, not assume).

## How to unblock

1. Put `OPENAI_API_KEY=...` in `.env.local` (never commit it) or the environment.
2. Run `npm run proof`. It writes sanitized evidence to `data/api-proof/<timestamp>.json` and prints `API PROOF OK` or the failure.
3. Run `ZB_LIVE=1 npm run test:e2e`.
4. Update this file with the observed event list, one raw Decisions response, versions and measured concurrency; then mark GATE C / GATE 8 in `WAVE_STATUS.md`.
