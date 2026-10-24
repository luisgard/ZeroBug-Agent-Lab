# Shop Agent — independent LangGraph reference agent

A small agent built with **LangGraph 1.2.17** that lives outside ZeroBug. It imports nothing from ZeroBug; it only speaks the [HTTP bridge contract v1](../../docs/HTTP-BRIDGE-CONTRACT.md) and a plain chat endpoint.

```text
plan ──► act ──► plan ──► … ──► respond
 │        └─ POST <toolsUrl>/<tool> with the run's bearer token
 └─ scripted planner (default) or real model (AGENT_PLANNER=openai, optional, untested here)
```

## Run

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m shop_agent.server --variant baseline --port 8000    # or candidate | wrong-item
.venv/bin/python -m unittest discover -s tests                          # agent's own tests (fake host, no ZeroBug code)
```

Endpoints: `GET /health`, `GET /agent/capabilities`, `POST /agent/run` (bridge), `POST /chat` (black-box: `{message, conversation_id}` → `{reply}`).

Black-box invoices go to a separate synthetic staging outbox: `STAGING_WRITE_TOKEN=... STAGING_READ_TOKEN=... .venv/bin/python -m shop_agent.staging_outbox --port 8010`, and the agent needs `STAGING_OUTBOX_URL` and `STAGING_WRITE_TOKEN`. The agent can only write; ZeroBug's verifier can only read.

| Env var | Meaning |
| --- | --- |
| `AGENT_VARIANT` / `--variant` | `baseline`, `candidate` (three realistic regressions), `wrong-item` (predictable failure) |
| `AGENT_PLANNER` | `scripted` (default, deterministic) or `openai` (needs `requirements-llm.txt` and `OPENAI_API_KEY`; not exercised in this repo) |
| `AGENT_MODEL` | Model name for the `openai` planner |
| `AGENT_API_TOKEN` | If set, `/agent/run` and `/chat` require `Authorization: Bearer <token>` |
| `AGENT_HOST`, `AGENT_PORT` | Bind address (default `127.0.0.1:8000`) |

The deterministic planner simulates each variant's behaviour so tests are repeatable without model keys. It is not a language model and is labeled "scripted" in ZeroBug reports.
