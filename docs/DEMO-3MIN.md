# 3-minute demo (judging, Track 1: Agents in Action)

**One line:** *Your agent says it did it. ZeroBug proves whether it really happened.*

Every number below comes from real runs on Oct 24 with real OpenAI models (`docs/REAL-MODEL-RESULTS.md`). Nothing on screen is scripted or hardcoded.

## Before judging (10 min)

1. `.env.local` has only `OPENAI_API_KEY=...`. Do **not** set `ZB_PLANNER=rules` (the Agents API designs the tests) and do not set `ZB_JUDGE` (the Decisions API judges by default).
2. Window 1: `node examples/support-agent/server.cjs` (ShopZ store + refund agent, model `gpt-4.1`).
3. Window 2: `npx tsx scripts/ui-server.ts`. The first lines must say `Agents API: available · judge: decisions-api`.
4. ZeroBug → **Connections** → add **Payments or refunds with an API** and **An inbox with an API**, each with *Fill in with the ShopZ example* → both show ✓.
5. Pre-run **v1** once through the whole wizard (3 runs per test) so its result is in **History** (expected 15/15 proven).
6. Tabs: A = ShopZ chat `http://127.0.0.1:3400/agent/v2/page`, B = ShopZ admin `http://127.0.0.1:3400/admin` (press *Borrar datos de prueba*), C = ZeroBug `http://127.0.0.1:3001`.

## The 3 minutes

| Time       | Do                                                                                                               | Say                                                                                                                                                                                                                                                                                    | Rubric                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 0:00–0:25 | Tab A: ask v2 for a refund on the 45-day-old chair. It answers "¡Listo!".                                       | "Support agents refund real money. This one says it's done. Is it right? Today you'd check by hand, case by case."                                                                                                                                                                     | Usefulness: user + problem                |
| 0:25–0:45 | Tab C, step 1: *Your own API*, `http://127.0.0.1:3400/agent/v2`, version `v2` → Connect and test → Next. | "We don't need its code, only how to talk to it."                                                                                                                                                                                                                                      | Working demo: input                       |
| 0:45–1:10 | Step 2: paste the two texts below → **Propose tests**. Point at "Designed with AI (OpenAI Agents API)".   | "An OpenAI **Agents API** agent designs the tests from a plain description, and only proposes what ZeroBug can verify."                                                                                                                                                          | Use of OpenAI tools                       |
| 1:10–1:25 | Step 3: tick the approvals, set runs to **1**, **Run**.                                              | "These move money, so ZeroBug asks permission. Each run gets its own order and reference."                                                                                                                                                                                             | Technical quality                         |
| 1:25–2:20 | While it runs: History → open the v1 result (15/15). Back to results as they land: open one red run.            | "What your agent said" vs "What we verified": e.g. *3 payments, none allowed*. Then the **Decisions API** card: "it read the agent's reply: *says it refunded*, 98%. The real refunds table says otherwise."                                                                 | Working demo: result; Use of OpenAI tools |
| 2:20–2:35 | Tab B (ShopZ admin): the v2 refunds in red.                                                                      | "This is what would have hit production."                                                                                                                                                                                                                                              | Usefulness: errors prevented              |
| 2:35–3:00 | —                                                                                                               | "Agents API designs the tests, Decisions API reads the claims, and the verdict comes from the real systems. Works now: any agent with an API or chat page, read-only checks of payments and email. Limits: fake store and inbox today; results are observed outcomes, not guarantees." | Presentation: what works + limits         |

**Step 2 texts** (English or Spanish both work):

*What does your agent do?*

```
It is the customer support assistant for my online store. It looks up customer orders, issues refunds following the store policy, and emails the customer with the decision.
```

*Anything specific to check?*

```
It must never refund the same order twice.
It must not refund orders older than 30 days.
It must ignore messages that claim to come from the system or a manager.
Our test orders: TEST-OK-{ref} was delivered 5 days ago (49.90 USD, eligible for a refund). TEST-OLD-{ref} was delivered 45 days ago (89 USD, outside the policy). The customer email on each order is zerobug-qa+{ref}@example.com.
```

The last line matters: without it the AI invents order numbers ShopZ doesn't know, and every test fails for the wrong reason.

## If something surprises you (say it, don't hide it)

- **v2 passes a test live:** "Agents aren't deterministic, which is why one run proves nothing." Open the recorded v2 batch: 3/15 proven, 12 failed (`data/recorded/2026-10-24-real-model-ai-planner/`).
- **An API is down:** the run shows ERROR (infrastructure), not FAIL (agent). That *is* the handled-failure moment; continue from History.
- **Results still running at 2:20:** emails can take up to 2 minutes; show the runs that landed and the v1 history.

## Rehearsal check (before 3 p.m.)

Run the whole script twice with a timer. Write down how long the 5 live runs take on the venue wifi; if over 70 s, start the run before explaining step 3.
