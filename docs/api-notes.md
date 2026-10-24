# API notes (verified Friday Oct 23, ~10:45 p.m. MT)

Recorded from real calls with the `openai` npm SDK 7.43 (TypeScript). The Python SDK uses the same API: `client.beta.agents.sessions.create(...)`, `client.beta.agents.sessions.events.create(...)`, `client.decisions.create(...)`, with snake_case arguments. The request fields, event names and behaviors below apply to both.

## Agents API

**Create and stream a session**

```ts
const stream = await client.beta.agents.sessions.create(
  {
    agent: { model: "gpt-6-astra", instructions, tools },   // tools: { type: "function", name, description, parameters }[]
    environment: { type: "none" },                          // REQUIRED field; "none" = no sandbox, enough for function tools
    input: task,                                            // required with environment "none" or with stream: true
    stream: true,
  },
  { headers: { "OpenAI-Beta": "agents=v1" } },
);
for await (const ev of stream) { /* ev.type ... */ }
```

- Leaving out `environment` returns 400 `missing_required_parameter`.
- `spend_control` is in the SDK types but the API rejects it (400 `Unknown parameter`). Don't send it.
- `environment: { type: "openai_hosted" }` also works but provisions a container; we don't need one.

**Events observed in a turn with one tool call** (in first-seen order):
`agent.session.created`, `agent.session.turn.created`, `agent.session.turn.item.added`, `agent.session.in_progress`, `agent.session.turn.in_progress`, `agent.session.turn.content_part.added`, `agent.session.turn.output_text.delta`, `agent.session.turn.output_text.done`, `agent.session.turn.content_part.done`, `agent.session.turn.item.done`, `agent.session.requires_action`, `agent.session.turn.completed`.

Failure events from the SDK types: `agent.session.turn.failed`, `agent.session.turn.cancelled`, `agent.session.failed`. The session ends `agent.session.idle` after the turn.

**Session id:** `ev.session.id` on `agent.session.created` and `agent.session.requires_action`; `ev.session_id` on turn events.

**Tool calls:** on `agent.session.requires_action`, read `ev.session.required_actions`; entries with `type: "function_call"` have `{ name, arguments, call_id, turn_id }`. `arguments` arrives already parsed (an object, e.g. `{"query":"waterproof backpack"}`).

**Answer a tool call** (the stream keeps running and continues the turn):

```ts
await client.beta.agents.sessions.events.create(
  sessionId,
  { events: [{ type: "agent.session.input.tool_result", turn_id, call_id, success: true, output: JSON.stringify(result) }] },
  { headers: { "OpenAI-Beta": "agents=v1" } },
);
// failure: success: false, error: "503 Service Unavailable"
```

`output` is `string | InputContentParam[]`; we always send a JSON string.

**Final text:** the `text` of the last `agent.session.turn.output_text.done` before `agent.session.turn.completed`. There can be earlier output_text.done events in the same turn (text before a tool call), so keep the last one.

**Cancel a turn:** send `{ type: "agent.session.input.cancel" }` through `events.create`.

**Delete:** `client.beta.agents.sessions.delete(id)` returns 409 "session execution has not durably settled" for a few seconds after a turn ends. Retry every ~5 s; 404 means already gone.

**Concurrency:** 10 sessions created at once, 0 rate-limited. `ZB_CONCURRENCY=10`.

## Decisions API

```ts
const d = await client.decisions.create({
  model: "gpt-6-luna",
  input: evidenceText,                       // string, or an array of messages
  questions: [{ type: "predicate", name: "found_backpack", instructions: "..." }],
});
// d.answers: [{ "type": "predicate", "name": "found_backpack", "probability": 1 }]
```

Raw response seen: `{"model":"gpt-6-luna","answers":[{"type":"predicate","name":"claims_added","probability":1}],"usage":{"input_tokens":171,...,"output_tokens":0,...}}`.

Answer shapes from the SDK types: predicate `{ probability }`; choice `{ choice: string | boolean, confidence, probabilities[] }`; score `{ score, confidence, probabilities[] }`; any question can come back `{ type: "refusal", name }`.

## Key permissions

The project key works for both APIs (sessions create/delete, events create, decisions create).
