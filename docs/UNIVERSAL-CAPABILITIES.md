# Universal Capabilities — Audit and Honest Integration Matrix

Last updated: 2026-10-24. This page answers one question for each kind of agent: **what can ZeroBug actually prove today, and how do we know?**

## 1. Audit (U01)

Starting point of this wave (commit `1c878d5`): the repository contained only planning documents (`docs/PLAN.md`, `docs/agent-testing-spec.md`, `docs/plans/2026-10-23-zerobug-hackathon-plan.md`), a `.env.example` and an unrelated `review-qa-suggest` skill. **No Spec 01 code existed** — no runners, no world, no checks, no tests.

Consequence: Spec 02 depends on Spec 01, so this wave implemented the Spec 01 core first and then extended it, reusing one engine (`src/engine/run-scenario.ts`), one hard oracle (`src/checks/hard.ts`), one verdict function (`src/verdict/verdict.ts`) and one release gate (`src/comparison/gate.ts`) for every transport.

Decisions taken during the audit:

| Topic | Planning docs said | This implementation | Why |
| --- | --- | --- | --- |
| Check names | `cart_contains`, `no_order_placed`… (hackathon plan) | Spec 01 names: `required_cart_item`, `forbid_checkout`, `unauthorized_secret_disclosure`, `claim_matches_external_state`… | Spec 01 is the newer, attached specification. |
| Scenario format | snake_case limits, no `schemaVersion` | `schemaVersion: 1`, camelCase `limits`, `goals`, `degradedOutcome`, `requiresCapabilities`, `agentTransport` | Spec 01 §6 and Spec 02 §8. |
| Reference HTTP agent | Plain function calling, hosted inside the Next.js app | Independent **LangGraph** project in `examples/external-agent/`, separate process | Spec 02 §6: the agent must not depend on ZeroBug internals. |
| UI stack | Next.js + shadcn | Minimal page served by a Node process (`scripts/ui-server.ts`, `ui/index.html`) | Keeps one engine in one long-lived process with no build step; a Next.js port is open work (see `WAVE_STATUS.md`). |

## 2. Integration matrix (what was actually tested)

Legend: **TESTED** = a test or recorded run in this repo exercises it end to end. **BLOCKED** = code exists but could not be run (reason given). **PROPOSAL** = design only, no code path tested.

| Agent type | Transport | Status | Evidence | What ZeroBug can prove |
| --- | --- | --- | --- | --- |
| Deterministic sample agents (v1, v2, wrong-item) | `scripted` (in process) | **TESTED** | `tests/engine.test.ts`, `tests/gate.test.ts` | Everything in §3 (instrumented) |
| LangGraph 1.2.17 agent, separate Python process | `http_bridge` | **TESTED** | `tests/e2e/external-agent.test.ts`, `data/recorded/2026-10-24-external-e2e/` | Everything in §3 (instrumented) |
| Same LangGraph project, chat endpoint | `blackbox_http` | **TESTED** | `tests/blackbox.test.ts`, E2E (with and without staging verifier) | Reply content; emails in the connected staging outbox only |
| OpenAI Agents API (`client.beta.agents.sessions`) | `agents_api` | **BLOCKED** — no `OPENAI_API_KEY` in this environment | Contract test with a fake client built from `openai@7.43.0` type definitions (`tests/agents-api.test.ts`); live test `tests/live/real-api.test.ts` is opt-in | Would be instrumented once a live run passes |
| Decisions API (`client.decisions.create`, `gpt-6-luna`) | judge | **BLOCKED** — no key | Contract test with fake client (`tests/agents-api.test.ts`) | Claim interpretation only (advisory) |
| LangGraph agent with a real model planner | `http_bridge` | **BLOCKED** — no key | `shop_agent/llm_planner.py` exists, never executed | — |
| OpenAI Agents SDK, CrewAI, LlamaIndex, custom Node/Python | `http_bridge` | **PROPOSAL** | Contract in `docs/HTTP-BRIDGE-CONTRACT.md`; no example built | Same as §3 *if* they implement the contract |
| Browser/UI chat agents | `blackbox_http` (browser runner) | **TESTED locally** (own test page only) | `tests/browser.test.ts` (real headless Chromium) | Reply; side effects via connectors |
| Any agent + real inbox / store / payment | connector checks | **BLOCKED** — no QA credentials yet | `tests/connectors.test.ts`, `docs/CONNECTORS.md` | Emails, orders, payments in the real system (read-only) |
| Voice/realtime agents | — | **Out of scope (P2)** | — | — |
| Remote/public agent endpoints | `http_bridge` / `blackbox_http` | **NOT TESTED** | Only `127.0.0.1` with explicit address approval was used | SSRF controls are unit-tested, public networking is not |

**We do not claim universal support.** One independently built LangGraph agent on localhost works end to end; other frameworks should work through the same contract but have not been tried.

## 3. What each mode can and cannot verify

| Question | Instrumented (bridge / Agents API / scripted) | Black-box, no verifier | Black-box + read-only staging verifier |
| --- | --- | --- | --- |
| Did the agent reply, and what did it say? | Yes | Yes | Yes |
| Which tools did it call, with which arguments? | Yes (world journal) | **No** | **No** |
| Is the right item in the cart? Was checkout ever called? | Yes | **No → INCONCLUSIVE** | **No → INCONCLUSIVE** |
| Did an email reach the right person? | Yes (synthetic outbox) | **No → INCONCLUSIVE** | Yes, for that staging outbox |
| Did a secret leave to someone else? | Yes (complete coverage) | **No** | Only partial coverage → cannot PASS an absence claim |
| How does it handle a 503 / poisoned page? | Yes (faults injected per run) | **No** (faults cannot be injected) | **No** |
| Is the agent's success claim true? | Yes (claim vs. state) | **No → INCONCLUSIVE** | Yes, for effects the verifier can see |

## 4. Capability states

Each connection produces a matrix of the nine Spec 02 capabilities, each in one of three states:

- **VERIFIED** — proven by a real round-trip in the smoke run (for example: a tool call appeared in ZeroBug's world journal).
- **DECLARED** — the agent or user says so; not proven (for example: `canResetSession`, because ZeroBug cannot see agent memory).
- **UNSUPPORTED** — not available. Dependent checks become `unsupported` and the verdict becomes INCONCLUSIVE, never PASS and never an agent defect.

`canInjectFaults` is never inferred from "it speaks HTTP": in bridge mode it becomes VERIFIED only when a smoke tool call is observed passing through the world (where faults are applied); in black-box mode it is always UNSUPPORTED.

`canReadSource` and `canPatchSource` are UNSUPPORTED everywhere: automatic repair (AL-05) is out of scope for this wave.
