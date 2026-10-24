# ZeroBug Agent Labs

> **Agents report. ZeroBug proves.**

An AI agent says "Done! I added it to your cart." Is that true? ZeroBug puts the agent in a fake, resettable world (a store and an outbox), gives it a task, breaks things on purpose, and compares **what the agent said** with **what actually happened**. Repeated runs of a baseline and a candidate version become an evidence-backed release decision.

- **PASS** only with independent positive evidence. Empty state is never success.
- **FAIL** for proven violations: wrong item, checkout when told not to, a secret emailed to an attacker, a false success claim.
- **ERROR** when infrastructure fails; **INCONCLUSIVE** when ZeroBug cannot see enough to decide.

Current status by gate (what is done, partial or blocked, and why): [`WAVE_STATUS.md`](WAVE_STATUS.md).

## Ways to connect an agent

| Mode | For | What ZeroBug can prove |
| --- | --- | --- |
| Sample agents (scripted) | Offline tests and demos | Everything (instrumented) |
| HTTP bridge | An existing agent you control (LangGraph, Agents SDK, custom…). It calls ZeroBug's run-scoped tool URLs. | Tool calls, cart, orders, emails, secret egress, fault handling |
| Black-box HTTP | Only a chat URL | The reply. Side effects only through a separately granted read-only verifier; otherwise INCONCLUSIVE |
| Browser chat (beta) | Only a chat web page | The reply, read in a headless browser. Side effects through connectors |
| OpenAI Agents API | Agents defined by instructions | Everything (instrumented). **BLOCKED in this build: no API key** |

**Real side effects:** with evidence connectors (Gmail API, order/payment APIs, any MCP connector) ZeroBug checks that the email really arrived or the order really exists, for any of the modes above. Setup and validation status: [`docs/CONNECTORS.md`](docs/CONNECTORS.md). Not yet run against a real inbox (needs a QA Gmail account).

Tested end to end: sample agents and one independently built **LangGraph** agent (bridge and black-box), on localhost. Other frameworks follow the same contract but are untested. See [`docs/UNIVERSAL-CAPABILITIES.md`](docs/UNIVERSAL-CAPABILITIES.md).

**Run it locally (Spanish, step by step):** [`docs/LOCAL-SETUP.md`](docs/LOCAL-SETUP.md) — includes a 5-minute demo: describe an email agent, ZeroBug proposes tests, runs them 3×, and proves each email arrived (and catches an agent that only claims it).

## Quick start

Requires Node.js 20+ (Python 3.10+ for the external agent example).

```bash
npm install
npm test                                                     # offline engine, security, gate
npm run zb -- scenarios                                      # list validated scenarios
npm run zb -- run --agent scripted-v2 --scenario store-outage
npm run zb -- run --agent scripted-v1 --scenario store-outage --scenario poisoned-product --runs 3
npm run zb -- run --agent scripted-v2 --scenario store-outage --scenario poisoned-product --runs 3
npm run zb -- gate --baseline scripted-v1 --candidate scripted-v2 --runs 3
```

External agent (two processes) and UI:

```bash
(cd examples/external-agent && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt)
npm run demo:external                                        # full E2E, writes data/e2e/<timestamp>/report.md
npm run ui                                                   # http://127.0.0.1:3001 (4-step wizard; /advanced for all options)
```

Full instructions for Windows, macOS and Linux: [`docs/EXTERNAL-AGENT-DEMO.md`](docs/EXTERNAL-AGENT-DEMO.md).

Real OpenAI APIs (optional): put `OPENAI_API_KEY` in `.env.local` (never committed), then `npm run proof`. See [`docs/API-PROOF.md`](docs/API-PROOF.md).

## Documentation

| Document | Content |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Modules, verdict precedence, degraded outcomes, release gate |
| [`docs/SCENARIOS.md`](docs/SCENARIOS.md) | Scenario format and check types |
| [`docs/CONNECTORS.md`](docs/CONNECTORS.md) | Verifying real emails, orders and payments (Gmail, HTTP, MCP) |
| [`docs/HTTP-BRIDGE-CONTRACT.md`](docs/HTTP-BRIDGE-CONTRACT.md) | Bridge protocol v1 for external agents |
| [`docs/UNIVERSAL-CAPABILITIES.md`](docs/UNIVERSAL-CAPABILITIES.md) | Audit and honest integration matrix |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) | Threats, controls and the tests that prove them |
| [`docs/EXTERNAL-AGENT-DEMO.md`](docs/EXTERNAL-AGENT-DEMO.md) | Setup and run of the two-process demo |
| [`docs/API-PROOF.md`](docs/API-PROOF.md) | OpenAI Agents/Decisions API status (BLOCKED) and exact SDK shapes |
| [`docs/DEMO.md`](docs/DEMO.md) | 3-minute demo script |
| [`docs/PLAN.md`](docs/PLAN.md), [`docs/agent-testing-spec.md`](docs/agent-testing-spec.md) | Earlier planning documents |

## Limits (said plainly)

Fake apps only. Localhost only. In this build the external agent's planner is deterministic and the claim judge is an offline heuristic; the OpenAI integrations are written but not run. Results are observed outcomes, not reliability guarantees.
