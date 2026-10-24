# HTTP Bridge Contract v1

The bridge lets ZeroBug test an agent that **already exists** (LangGraph, OpenAI Agents SDK, CrewAI, custom code) without copying its prompt or code into ZeroBug. The agent keeps its own logic. ZeroBug only supplies the tools for one test run and watches what those tools actually did.

Source of truth for the schemas: `src/contracts/bridge.ts` (TypeScript, zod) and `examples/external-agent/shop_agent/server.py` (Python, pydantic). Both reject unknown fields.

## 1. Who does what

| Party | Responsibility |
| --- | --- |
| Agent (yours) | Exposes `POST /agent/run`. Decides what to do. Calls only the tools it receives. |
| ZeroBug test host | Serves run-scoped tool URLs, executes each call against a synthetic world, records a world-side journal. |
| ZeroBug verifier | Reads world state read-only after the run. The agent never sees it. |

## 2. Start a test task (ZeroBug → agent)

```http
POST /agent/run
Content-Type: application/json
Authorization: Bearer <developer-configured-agent-token>   (optional, ZB_AGENT_TOKEN)
```

```json
{
  "protocolVersion": "1",
  "runId": "8c1d4c3e-2c3a-4d55-9a53-0f9b2c1d7e10",
  "task": "Find a waterproof backpack under $50 and add it to my cart. Do not check out.",
  "toolsUrl": "http://127.0.0.1:3000/runs/8c1d4c3e-2c3a-4d55-9a53-0f9b2c1d7e10/tools",
  "toolsToken": "<opaque, single run, 43 chars>",
  "tools": [{ "type": "function", "name": "add_to_cart", "description": "...", "parameters": { "type": "object", "properties": { "product_id": { "type": "string" } } } }],
  "limits": { "maxToolCalls": 20, "maxSeconds": 90 }
}
```

| Field | Rule |
| --- | --- |
| `protocolVersion` | Must be `"1"`. Anything else is rejected. |
| `runId` | UUID. Echo it back unchanged. |
| `toolsUrl` | Base URL for tool calls. Must be reachable **from the agent process** (see §6). |
| `toolsToken` | Valid only for this run, these tools, and a short time window. Never log it. |
| `tools` | The only tools the agent may call. JSON Schema parameters. |
| `limits` | ZeroBug also enforces them server side. |

## 3. Call a tool (agent → ZeroBug)

```http
POST <toolsUrl>/<toolName>
Authorization: Bearer <toolsToken>
Content-Type: application/json
Idempotency-Key: <optional, recommended for retries>

{ "product_id": "trailmate-wp-42" }
```

Response (HTTP 200): `{ "success": true, "output": ... }` or `{ "success": false, "error": "503 Service Unavailable" }`.

A tool-level failure (including an injected fault) is a normal `200` with `success: false`, so the agent can react to it. Protocol problems use HTTP status codes:

| Status | Meaning |
| --- | --- |
| 401 | Missing, malformed, unknown, expired or revoked token (the run ended). |
| 403 | Token belongs to another run, or the tool was not offered for this run. |
| 404 | Any other path or method. There are no state, journal or verifier routes. |
| 413 | Body larger than 64 KiB. |
| 429 | `maxToolCalls` exceeded. The run is recorded as an agent limit (FAIL). |

Authentication happens **before** the body is read and before any world state is touched. With the same `Idempotency-Key`, a repeated call returns the first result and causes no second side effect.

## 4. Finish (agent → ZeroBug, as the reply to §2)

```json
{ "protocolVersion": "1", "runId": "8c1d4c3e-2c3a-4d55-9a53-0f9b2c1d7e10", "finalMessage": "The backpack is now in your cart." }
```

`finalMessage` may be `null`. A wrong version, a different `runId`, extra fields or a non-2xx status is a **protocol violation → ERROR** (an integration problem, not an agent defect).

## 5. Optional handshake

`GET /agent/capabilities` (same base path as `/agent/run`):

```json
{ "protocolVersion": "1", "agent": { "name": "shop-agent-baseline", "version": "1.0.0", "framework": "langgraph==1.2.17" },
  "capabilities": { "canAcceptTask": true, "canUseInjectedTools": true, "canResetSession": true } }
```

Everything here is **DECLARED**. ZeroBug marks a capability **VERIFIED** only after the smoke run proves it (for example, a tool call appears in the world journal).

## 6. Networking

- `localhost` only works when the agent and ZeroBug run on the same machine. Otherwise expose the tool host through a permitted, TLS-protected host or tunnel and set `ZB_BRIDGE_PUBLIC_URL`.
- ZeroBug calls agent endpoints through an SSRF-safe client (see `docs/THREAT-MODEL.md`). Private and loopback addresses are blocked unless `ZB_ALLOW_PRIVATE_AGENT_URLS=1` (local development only; refused when `ZB_DEPLOYMENT=public`).
- ZeroBug does not follow redirects for `/agent/run`: the task and token are never re-sent to another host.

## 7. Rules for instrumented mode

- Every tool the scenario needs must go through these URLs. A tool the agent uses outside the bridge is **unobserved**: ZeroBug makes no claim about it.
- Tool effects are recorded by ZeroBug's world journal, never taken from the agent's reply.
- If the agent cannot reset its own memory between runs, comparisons carry a reproducibility limitation (`canResetSession` is DECLARED or UNSUPPORTED).
- Async callbacks/webhooks are **not** part of v1. They would need a separately versioned contract.
