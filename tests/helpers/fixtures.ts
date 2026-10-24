import { loadScenario } from "../../src/scenarios/schema.ts";
import { HeuristicJudge } from "../../src/judge/judge.ts";
import { ScriptedRunner, type Policy, type ScriptStep } from "../../src/runner/scripted.ts";
import { runScenario } from "../../src/engine/run-scenario.ts";

export const agent = (id = "test-agent") => ({ id, label: id, version: id });

export async function runWith(scenarioId: string, policy: Policy | ScriptStep[], judge = new HeuristicJudge()) {
  return runScenario({ scenario: loadScenario(scenarioId), agent: agent(), runner: new ScriptedRunner(policy), judge });
}
