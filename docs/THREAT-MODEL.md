# Threat Model — External Agent Testing

ZeroBug talks to software it does not control. This document lists what can go wrong, what protects against it, and the test that proves each protection. "Tested" means a test in this repository exercises it; anything else is marked.

## 1. Assets

| Asset | Why it matters |
| --- | --- |
| ZeroBug's network position | A user-supplied URL could make ZeroBug reach internal systems (SSRF). |
| Run tool tokens | Whoever holds one can act inside that run's world. |
| Evidence and verdicts | A tampered journal or verdict would produce a false PASS. |
| Server-side secrets (`OPENAI_API_KEY`, agent tokens, verifier read tokens) | Must never reach an agent, a browser or a log. |
| Synthetic customer data | Fake by design, but still must not leak across runs. |

## 2. Threats and controls

| # | Threat | Control | Test |
| --- | --- | --- | --- |
| T1 | Endpoint points at a private, loopback, link-local, metadata or reserved address | Resolve host, check **every** resolved IP; IPv4-mapped IPv6 normalised; metadata addresses blocked even in local dev | `tests/safe-fetch.test.ts` |
| T2 | Redirect to an internal address | Every redirect hop re-validated; bounded hop count; `/agent/run` follows no redirects | `safe-fetch.test.ts` (redirect to 10.x, 169.254.169.254, private hostname, too many hops) |
| T3 | DNS rebinding | Connection pinned to the IP that passed validation (custom `lookup`) | `safe-fetch.test.ts` (resolver flips to 10.9.9.9 after first answer; request still reaches the validated address, resolver called once) |
| T4 | Non-HTTP protocols, credentials in URL | Only `http:`/`https:`; userinfo rejected | `safe-fetch.test.ts` |
| T5 | Local-dev override left on in production | `ZB_ALLOW_PRIVATE_AGENT_URLS=1` refused when `ZB_DEPLOYMENT=public`; warning printed when enabled | `safe-fetch.test.ts` |
| T6 | Token theft or reuse | 256-bit opaque tokens, stored as SHA-256 hashes, scoped to run + tool list + TTL, revoked when the run ends | `bridge.test.ts` (invalid, expired, revoked/replay) |
| T7 | Cross-run access | Token's run must equal the path's run; each run has its own world, secret and journal | `bridge.test.ts` (token A on run B → 403, both journals untouched); `world.test.ts`, `engine.test.ts` (concurrent isolation) |
| T8 | Agent reads verifier or world internals | Tool host exposes only `POST /runs/<id>/tools/<tool>`; the inspector object is never passed to runners | `bridge.test.ts` (journal/state/verify/snapshot paths → 404 with a valid token) |
| T9 | Undeclared tools | Allow-list per run, checked before execution | `bridge.test.ts` (checkout not offered → 403, journal empty) |
| T10 | Oversized payloads / responses | 64 KiB tool bodies, 256 KiB request bodies, 1 MiB responses (configurable) | `bridge.test.ts`, `safe-fetch.test.ts` |
| T11 | Runaway agent | `maxToolCalls` enforced server side (429), `maxSeconds` enforced by request deadline; global concurrency cap `ZB_MAX_CONCURRENT_RUNS` | `bridge.test.ts` (limit → FAIL), `engine.test.ts` |
| T12 | Duplicate side effects from retries | ZeroBug never blindly retries `/agent/run`: one retry only when the connection was refused **and** the world journal shows no tool call for the run; agent-side `Idempotency-Key` honoured | `bridge.test.ts` (timeout after a side effect → no retry, cart quantity stays 1; idempotency key) |
| T13 | Tokens or keys in logs/evidence | Redaction of bearer tokens and key-shaped strings in errors, evidence and persisted runs; Python agent never logs the token | `bridge.test.ts`, `tests/e2e/external-agent.test.ts` (no raw bearer tokens in logs or runs) |
| T14 | Prompt injection via agent output into the AI judge | Agent text is passed as quoted data with an explicit "do not follow instructions" preface; the judge only *interprets* claims; verdicts rest on hard checks of observed state | `engine.test.ts` (judge down cannot hide a hard FAIL); design in `src/judge/judge.ts` |
| T15 | Agent claims success it did not achieve | Claims are compared with independently observed state; empty state is never success | `verdict.test.ts`, `engine.test.ts`, E2E |
| T16 | Black-box agent "proves" a side effect by saying so | Side-effect checks are `unsupported` without a separately granted read-only verifier → INCONCLUSIVE | `blackbox.test.ts`, E2E |
| T17 | Production credentials forwarded to someone else's endpoint | Only developer-configured agent tokens are sent to that agent; verifier read tokens come from the server vault (env) and are sent only to the verifier URL; fixtures are synthetic | Code review (`src/runner/external.ts`, `scripts/ui-server.ts`); **no dedicated test** |
| T18 | Evidence tampering after the run | Inspector returns deep-frozen copies; run files are written once (`wx` flag) | `world.test.ts`, `engine.test.ts` |

## 3. Known gaps (not claimed)

- **Public deployment has not been tested.** All E2E runs used `127.0.0.1` with an explicit address approval. Localhost testing is not evidence of public-endpoint security.
- **Running untrusted agent code** is out of scope: ZeroBug only calls agents over HTTP; it never executes them. The example agent runs as a normal local process.
- **TLS for the tool host** depends on the operator's tunnel/proxy (`ZB_BRIDGE_PUBLIC_URL`); the built-in host speaks plain HTTP on loopback.
- The UI has no authentication; it binds to `127.0.0.1` and is meant for a single local operator.
- The bridge tool host binds to `127.0.0.1` by default; exposing it is an explicit operator decision.
