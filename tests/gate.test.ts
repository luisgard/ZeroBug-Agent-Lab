import { describe, expect, test } from "vitest";
import { SAMPLE_AGENTS } from "../src/agents/samples.ts";
import { releaseGate } from "../src/comparison/gate.ts";
import { runScenario } from "../src/engine/run-scenario.ts";
import { HeuristicJudge } from "../src/judge/judge.ts";
import { ScriptedRunner } from "../src/runner/scripted.ts";
import { loadScenario } from "../src/scenarios/schema.ts";

const SCENARIOS = ["normal-errand", "store-outage", "poisoned-product", "dont-overstep"];
async function suite(id: keyof typeof SAMPLE_AGENTS, runs = 2) {
  const a = SAMPLE_AGENTS[id];
  const out = [];
  for (const s of SCENARIOS) for (let i = 0; i < runs; i++) {
    out.push(await runScenario({ scenario: loadScenario(s), agent: { id, label: a.label, version: a.version }, runner: new ScriptedRunner(a.policy, id), judge: new HeuristicJudge() }));
  }
  return out;
}
const required = Object.fromEntries(SCENARIOS.map((s) => [s, 2]));

describe("release gate (GATE E / GATE 6)", () => {
  test("verified critical candidate failure -> BLOCKED, with linked evidence", async () => {
    const g = releaseGate({ baseline: await suite("scripted-v1"), candidate: await suite("scripted-v2"), required });
    expect(g.decision).toBe("BLOCKED");
    const row = g.rows.find((r) => r.scenarioId === "poisoned-product")!;
    expect(row.status).toBe("blocked");
    expect(row.evidence.filter((e) => e.side === "candidate").every((e) => e.runId.length === 36)).toBe(true);
  });

  test("complete hard requirements -> READY TO RELEASE", async () => {
    const g = releaseGate({ baseline: await suite("scripted-v1"), candidate: await suite("scripted-v1"), required });
    expect(g.decision).toBe("READY TO RELEASE");
    expect(g.reason).toMatch(/not a guarantee/);
  });

  test("missing mandatory runs -> NEEDS REVIEW", async () => {
    const cand = (await suite("scripted-v1")).filter((r) => r.scenarioId !== "dont-overstep");
    const g = releaseGate({ baseline: await suite("scripted-v1"), candidate: cand, required });
    expect(g.decision).toBe("NEEDS REVIEW");
  });

  test("ERROR/INCONCLUSIVE in candidate -> NEEDS REVIEW, never READY", async () => {
    const cand = await suite("scripted-v1");
    cand[0] = { ...cand[0]!, verdict: "ERROR", reason: "provider down" };
    const g = releaseGate({ baseline: await suite("scripted-v1"), candidate: cand, required });
    expect(g.decision).toBe("NEEDS REVIEW");
  });

  test("incomparable conditions are disclosed and not called a regression", async () => {
    const base = (await suite("scripted-v1")).map((r) => ({ ...r, scenarioVersion: "old-version" }));
    const g = releaseGate({ baseline: base, candidate: await suite("scripted-v1"), required });
    expect(g.decision).toBe("NEEDS REVIEW");
    expect(g.rows.every((r) => r.regression === null && !r.comparable)).toBe(true);
    expect(g.rows[0]!.differences.join()).toMatch(/scenarioVersion differs/);
  });
});
