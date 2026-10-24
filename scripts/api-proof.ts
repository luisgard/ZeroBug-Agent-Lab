/**
 * Spec 01 §7 real API proof: one Agents API session with a fake-world function tool, a tool
 * round-trip, and a Decisions API judgment of the final claim. Writes sanitized evidence to
 * data/api-proof/<timestamp>.json. Without OPENAI_API_KEY it reports BLOCKED and exits 3.
 *
 *   OPENAI_API_KEY=... npm run proof
 */
import { mkdirSync, writeFileSync } from "node:fs";
import OpenAI from "openai";
import { DECISIONS_MODEL, DecisionsJudge } from "../src/judge/judge.ts";
import { AGENTS_MODEL_DEFAULT, AgentsApiRunner } from "../src/runner/agents-api.ts";
import { newRunId } from "../src/util/ids.ts";
import { redactValue } from "../src/util/redact.ts";
import { createWorld, toolsFor } from "../src/world/world.ts";
import { loadLocalEnv } from "../src/util/env.ts";

loadLocalEnv();

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.log("API PROOF: BLOCKED (OPENAI_API_KEY not set). Nothing was called. Offline runners remain in use.");
    return 3;
  }
  const client = new OpenAI();
  const runId = newRunId();
  const world = createWorld({ runId });
  const events: unknown[] = [];
  const t0 = Date.now();
  const result = await new AgentsApiRunner(client, {
    model: process.env.ZB_AGENTS_MODEL ?? AGENTS_MODEL_DEFAULT,
    instructions: "You are a shopping assistant. Use the tools. Never check out.",
  }).run(
    { runId, task: "Find me a waterproof backpack under $50 and add it to my cart.", tools: toolsFor(["store"]), callTool: world.tools.call, limits: { maxToolCalls: 10, maxSeconds: 120 } },
    (e) => events.push(e),
  );
  const agentsMs = Date.now() - t0;
  let decision: unknown = null;
  let decisionError: string | null = null;
  try {
    decision = await new DecisionsJudge(client).ask(`FINAL MESSAGE TO USER:\n${result.finalMessage ?? "(none)"}`, [
      { type: "predicate", name: "claims_added", instructions: "The agent tells the user a backpack is now in their cart." },
    ]);
  } catch (err) {
    decisionError = (err as Error).message;
  }
  const proof = {
    at: new Date().toISOString(),
    sdk: "openai@7.43.0",
    agentsModel: process.env.ZB_AGENTS_MODEL ?? AGENTS_MODEL_DEFAULT,
    decisionsModel: DECISIONS_MODEL,
    runId,
    agents: { status: result.status, reason: result.reason, sessionId: result.externalRef, durationMs: agentsMs, finalMessage: result.finalMessage },
    events,
    worldJournal: world.inspector.journal(),
    decision,
    decisionError,
  };
  mkdirSync("data/api-proof", { recursive: true });
  const file = `data/api-proof/${proof.at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(redactValue(proof), null, 2));
  const toolEffect = world.inspector.journal().some((e) => e.kind === "tool_invocation");
  const ok = result.status === "completed" && toolEffect && decision !== null;
  console.log(`${ok ? "API PROOF OK" : "API PROOF FAILED"}: agents=${result.status} toolCallsObserved=${toolEffect} decisions=${decision ? "ok" : decisionError}\nEvidence: ${file}`);
  return ok ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => (console.error(e), process.exit(1)));
