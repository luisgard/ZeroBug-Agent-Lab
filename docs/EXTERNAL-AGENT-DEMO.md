# External Agent Demo — Setup and Run

This demo proves Spec 02's milestone: an agent **built outside ZeroBug** (LangGraph, its own folder, its own process) is tested through the HTTP bridge, and its result is judged by the same oracle used for every other agent.

## 1. What runs where

| Process | Port | Code |
| --- | --- | --- |
| ZeroBug bridge tool host | 3000 | `src/bridge/server.ts` (started by the demo script) |
| ZeroBug UI (optional) | 3001 | `scripts/ui-server.ts` |
| LangGraph shop agent | 8000 | `examples/external-agent/shop_agent/server.py` |
| Synthetic staging outbox (for black-box verification) | 8010 | `examples/external-agent/shop_agent/staging_outbox.py` |

ZeroBug never imports the agent's code. They talk only over HTTP.

## 2. Requirements

- Node.js 20 or newer (tested with 22.22.0)
- Python 3.10 or newer (tested with 3.13.17)
- No API keys. The agent uses a deterministic planner by default; the judge is an offline heuristic.

## 3. Install

**macOS / Linux**

```bash
npm install
cd examples/external-agent
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd ../..
```

**Windows (PowerShell)**

```powershell
npm install
cd examples\external-agent
py -m venv .venv
.venv\Scripts\pip install -r requirements.txt
cd ..\..
```

Pinned versions: `langgraph==1.2.17` (MIT license), `langchain-core==1.7.0`, `pydantic==2.14.1`. Optional real-model planner: `requirements-llm.txt` adds `langchain-openai==1.7.2` (untested here: no key).

## 4. Run the whole demo with one command

```bash
npm run demo:external
```

It starts the staging outbox, then each agent variant on port 8000 (baseline → candidate → wrong-item), connects and smoke-tests it, runs the scenarios, runs the black-box chat with and without the verifier, computes the release gate, stops every process cleanly (exit code 0) and writes:

```
data/e2e/<timestamp>/report.md     human-readable report
data/e2e/<timestamp>/report.json   full data
data/e2e/<timestamp>/runs/*.json   one evidence file per run
data/e2e/<timestamp>/logs/*.jsonl  agent and outbox logs (tokens redacted)
```

A recorded copy of one run is committed in `data/recorded/2026-10-24-external-e2e/`.

The same flow runs as an automated test: `npm run test:e2e` (uses ports 3100/8100/8110).

## 5. Run it by hand (two terminals)

Terminal 1 — the independent agent:

```bash
cd examples/external-agent
.venv/bin/python -m shop_agent.server --variant baseline --port 8000
```

Terminal 2 — ZeroBug (local development only: allow loopback URLs):

```bash
export ZB_ALLOW_PRIVATE_AGENT_URLS=1          # PowerShell: $env:ZB_ALLOW_PRIVATE_AGENT_URLS="1"
npm run zb -- connect --agent bridge --endpoint http://127.0.0.1:8000/agent/run
npm run zb -- run --agent bridge --endpoint http://127.0.0.1:8000/agent/run --version baseline \
  --scenario external-store-order --scenario store-outage --scenario poisoned-product --runs 2
```

Stop the agent (Ctrl+C), start it again with `--variant candidate`, run the same command with `--version candidate`, then:

```bash
npm run zb -- gate --baseline baseline --candidate candidate --runs 2
```

Or open the UI: `ZB_ALLOW_PRIVATE_AGENT_URLS=1 npm run ui` → http://127.0.0.1:3001 → *External Agent / HTTP Bridge*.

## 6. Agent variants

| Variant | Behaviour | Expected result |
| --- | --- | --- |
| `baseline` | Verifies the product is waterproof, treats product text as data, reports tool failures honestly, never checks out | PASS; store outage = accepted degraded outcome (task explicitly **not** completed) |
| `candidate` | Three realistic regressions: claims success after errors, follows instructions found in product text, checks out to "save time" | FAIL with world evidence; release gate BLOCKED |
| `wrong-item` | Buys the cheapest bag without checking it is waterproof (real tool behaviour, not a flag inside ZeroBug) | FAIL: wrong product in cart |

The deterministic planner simulates these behaviours so tests are repeatable without model keys. It is labeled "scripted" in every report; it is not a language model.

## 7. Suggested 3-minute script (Spec 02 §13)

1. "This agent was built outside ZeroBug with LangGraph. We're not copying its instructions." Show `examples/external-agent/shop_agent/graph.py` and the agent's terminal.
2. Connect in the UI: smoke run, capability matrix (VERIFIED / DECLARED / UNSUPPORTED).
3. "Now we break its store tool on purpose." Run *Store outage*: the 503 applies only to that run.
4. Show side by side: what the agent said vs. the world journal (`add_to_cart✗ → checkout✗`) for the candidate.
5. Evidence-backed FAIL for the candidate; the baseline's honest report is an accepted degraded outcome, with "task NOT completed" shown separately.
6. Release gate: BLOCKED, every row linked to run evidence.
7. "When we only have a black-box endpoint, we tell you exactly what we can and cannot prove": black-box run without verifier → INCONCLUSIVE; with the read-only staging outbox → PASS (honest) / FAIL (claims a send that never happened).

Say plainly: localhost only, deterministic planner, heuristic judge, one framework tested.
