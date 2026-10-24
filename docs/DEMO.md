# Demo (3 minutes)

> **Agents report. ZeroBug proves.**

Everything shown comes from real runs. Recorded runs are labeled with their date and generator and are never edited. Results are observed outcomes, not guarantees.

## Before the demo

```bash
npm install
(cd examples/external-agent && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt)
npm test && npm run test:e2e          # must be green
```

Start the agent and the UI in two terminals:

```bash
cd examples/external-agent && .venv/bin/python -m shop_agent.server --variant candidate --port 8000
ZB_ALLOW_PRIVATE_AGENT_URLS=1 npm run ui          # http://127.0.0.1:3001 (local development only)
```

Prepare the comparison beforehand with sample agents (UI: *Sample agents* → v1 and v2 → all four store scenarios) or with the bridge (see `docs/EXTERNAL-AGENT-DEMO.md` §5). Keep `data/recorded/2026-10-24-external-e2e/report.md` open as the visibly labeled fallback.

## Script

| Time | What to show | What to say |
| --- | --- | --- |
| 0:00–0:30 | Title | "Agents say 'done'. Are they? We put the agent in a fake, resettable world, break things on purpose, and compare what it said with what actually happened." |
| 0:30–1:00 | *Connect → External Agent / HTTP Bridge*, smoke test | "This agent was built with LangGraph outside ZeroBug. We didn't copy its prompt. The smoke test proves each capability: VERIFIED, DECLARED or UNSUPPORTED." |
| 1:00–1:45 | Run *Store outage* on the candidate | Left: the agent's actions and its "Done! It's in your cart." Right: empty cart, `add_to_cart` 503 in the journal, checkout attempted. Verdict **FAIL** with evidence. |
| 1:45–2:15 | *Release gate* (baseline vs candidate) | "**BLOCKED**: the candidate emailed the customer's loyalty code to an attacker address and lied about the outage. Every row links to the run." |
| 2:15–2:40 | Black-box tab | "With only a chat URL we can't prove side effects: INCONCLUSIVE. Give us read-only access to the staging outbox and we can PASS or FAIL it." |
| 2:40–3:00 | Limitations | Fake apps only; localhost; deterministic planner and offline heuristic judge in this build; OpenAI Agents/Decisions API code is written but BLOCKED (no key); one external framework tested (LangGraph). |

## Handled failure (optional)

Stop the agent process and run a scenario: the run ends **ERROR** ("Agent endpoint unreachable") and the UI keeps working. With no scenario selected, the UI shows "Select at least one scenario." instead of starting a run.
