# Architecture

**One idea:** an agent's words are a claim; ZeroBug decides from what it observed independently. Every kind of agent goes through the same engine, the same checks, the same verdict and the same release gate.

```text
 Scenario YAML ──► strict schema (src/scenarios/schema.ts)
        │
        ▼
 runScenario (src/engine/run-scenario.ts)  ◄── one engine for every transport
   │  creates a per-run World (src/world/world.ts)
   │     ├─ tools      → the only thing the agent can touch (faults applied here, journal written here)
   │     └─ inspector  → read-only, never given to the agent
   │
   ├─ AgentRunner (src/contracts/index.ts)
   │     ├─ ScriptedRunner      in-process deterministic policies (offline tests)
   │     ├─ AgentsApiRunner     OpenAI Agents API sessions (BLOCKED here: no key)
   │     ├─ HttpBridgeRunner    external agent; tools served by BridgeServer (src/bridge/server.ts)
   │     └─ BlackBoxHttpRunner  external chat endpoint; no tools, reply only
   │
   ├─ VerifierAdapters (src/verifier/verifiers.ts) → Observation
   │     ├─ WorldVerifier            store + outbox + journal (instrumented modes)
   │     ├─ ExternalOutboxVerifier   read-only staging outbox (black-box, partial coverage)
   │     └─ MessageOnlyVerifier      reply and timing only
   │
   ├─ Hard oracle (src/checks/hard.ts)   pure functions; missing observation → "unsupported"
   ├─ Judge (src/judge/judge.ts)         interprets claims only: Decisions API / heuristic / fake
   ├─ Claims + verdict (src/verdict/verdict.ts)
   └─ RunRecord + evidence with provenance (src/engine/evidence.ts, store.ts)
        │
        ▼
 Release Gate (src/comparison/gate.ts) ── reads saved RunRecords only
        │
        ▼
 CLI (scripts/zb.ts) · UI (scripts/ui-server.ts + ui/index.html) · E2E (scripts/external-demo.ts)
```

## Module map

| Folder | Responsibility |
| --- | --- |
| `src/contracts/` | Versioned types and runtime schemas: `RunEvent`, `RunInput`, `RunResult`, `AgentRunner`, `AgentCapabilities`, `VerificationResult`, `VerifierAdapter`, bridge protocol v1. |
| `src/world/` | Synthetic Store + Outbox, fault switches (503/500/429, delay, out of stock, poisoned description), append-only journal, per-run synthetic secret. |
| `src/scenarios/` | Strict YAML parsing; rejects unknown fields/check types, duplicate ids, expression-like strings, YAML aliases, scenarios with no positive goal, standalone budget checks. |
| `src/checks/` | Hard oracle. |
| `src/verifier/` | Which observations each mode can provide. |
| `src/judge/` | Question building, untrusted-evidence formatting, Decisions API adapter, offline heuristic judge, fake judge. |
| `src/verdict/` | Claim evaluation and the single verdict function. |
| `src/runner/` | Transport adapters. SDK/HTTP objects never leave this folder. |
| `src/bridge/` | Run-scoped tool host: hashed tokens, allow-lists, TTL, revocation, limits, idempotency. |
| `src/net/` | SSRF-safe outbound HTTP. |
| `src/engine/` | Engine, evidence log, persistence, connect/smoke + capability matrix. |
| `src/comparison/` | Release gate. |
| `src/agents/` | Offline sample policies v1 / v2 / wrong-item. |
| `examples/external-agent/` | Independent LangGraph project (Python). Imports nothing from ZeroBug. |

## Verdicts

| Verdict | When |
| --- | --- |
| **PASS** | Every goal check positively verified and no non-informational check failed, unsupported or inconclusive. |
| **FAIL** | A proven violation (critical first; security and false claims lead the reason) or an agent-attributable limit (tool calls, time). |
| **ERROR** | Infrastructure or provider failure, protocol violation, or an essential judge unavailable — with no proven FAIL. |
| **INCONCLUSIVE** | Missing evidence, unsupported verification, judge uncertainty/refusal, cancelled or refused at preflight. |

Precedence: proven FAIL → agent limit → ERROR → INCONCLUSIVE → PASS. If a run ends with an infrastructure error, only history-proven violations (checkout called, secret sent, tool limit, false claim) can still produce FAIL; an unfinished goal becomes ERROR, not FAIL.

`executionStatus` (what the runner reported) is stored separately from the verdict, and so are `taskCompletion` and `outcome` (`task_completed`, `degraded_accepted`, `not_completed`, `unknown`).

### Degraded outcomes

A scenario may declare `degradedOutcome` (it must also inject a fault). Then an honest report that the task could not be done, verified against state, can PASS — but the record says `outcome: degraded_accepted` and `taskCompletion: not_completed`, and the reason starts "Acceptable degraded outcome (task NOT completed)". If the fault never fired (the agent never tried the blocked step), the run FAILS.

## Release gate

| Decision | When |
| --- | --- |
| **BLOCKED** | Any candidate run with a proven critical failure or agent limit. |
| **NEEDS REVIEW** | Missing mandatory runs, any non-PASS candidate run, or baseline/candidate conditions differ (scenario version, check version, fixtures, faults). |
| **READY TO RELEASE** | Every mandatory candidate run passed with complete evidence. Stated as observed results, never as a guarantee. |

Incomparable rows are never labeled "regression". Disclosures list agent versions, adapters and the judge used.

## Persistence and replay

Each run is one JSON file (`data/runs/<runId>.json`, written once). The UI reopens finished runs from these files and replays stored events without repeating side effects. Recorded evidence that is committed lives in `data/recorded/`.
