/**
 * Spec 02 mandatory real E2E (two processes). Requires the Python venv:
 *   cd examples/external-agent && python -m venv .venv && .venv/bin/pip install -r requirements.txt
 * Run: npm run test:e2e
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { type DemoReport, runExternalDemo } from "../../scripts/external-demo.ts";
import { pythonAvailable } from "../../scripts/lib/processes.ts";

let rep: DemoReport;
const ok = pythonAvailable();

describe.skipIf(!ok)("independent LangGraph agent over the HTTP bridge", () => {
  beforeAll(async () => {
    rep = await runExternalDemo({ runsPerScenario: 2, agentPort: 8100, zerobugPort: 3100, stagingPort: 8110 });
  });

  test("GATE 1/2: real task + tool round-trip through the bridge, proven by the world journal", () => {
    expect(rep.connect.baseline!.capabilities.canUseInjectedTools.state).toBe("VERIFIED");
    const r = rep.runs.baseline.find((x) => x.scenarioId === "external-store-order")!;
    expect(r.verdict).toBe("PASS");
    expect(r.adapter.transport).toBe("http_bridge");
    expect(r.journal!.some((e) => e.kind === "effect" && e.effect === "cart_item_added")).toBe(true);
    expect(r.checks.find((c) => c.checkId === "backpack-in-cart")!.verifier).toBe("zerobug-world");
  });

  test("GATE 4: 503 hits only the targeted runs and the external agent sees it through the bridge", () => {
    const outage = rep.runs.baseline.filter((x) => x.scenarioId === "store-outage");
    const others = rep.runs.baseline.filter((x) => x.scenarioId !== "store-outage");
    expect(outage.every((r) => r.faultsFired.includes("add_to_cart: error:503"))).toBe(true);
    expect(others.every((r) => r.faultsFired.length === 0)).toBe(true);
    // Honest handling: accepted degraded outcome, task explicitly not completed.
    expect(outage.every((r) => r.verdict === "PASS" && r.outcome === "degraded_accepted" && r.taskCompletion === "not_completed")).toBe(true);
    // Candidate: true FAIL with world evidence (checkout attempted after the outage).
    const cand = rep.runs.candidate.filter((x) => x.scenarioId === "store-outage");
    expect(cand.every((r) => r.verdict === "FAIL")).toBe(true);
  });

  test("security regressions are caught from world state, not agent labels", () => {
    const poisoned = rep.runs.candidate.filter((x) => x.scenarioId === "poisoned-product");
    expect(poisoned.every((r) => r.checks.find((c) => c.checkId === "no-secret-egress")!.status === "fail")).toBe(true);
    expect(poisoned[0]!.reason).toMatch(/^no-secret-egress/);
    expect(rep.runs.wrongItem.every((r) => r.verdict === "FAIL")).toBe(true);
  });

  test("GATE 3: black-box claim without verifier is INCONCLUSIVE; with read-only staging proof it can PASS", () => {
    const bb = rep.runs.blackbox;
    expect(bb.filter((r) => /no verifier/.test(r.agent.label)).every((r) => r.verdict === "INCONCLUSIVE")).toBe(true);
    expect(bb.find((r) => /baseline.*staging verifier/.test(r.agent.label))!.verdict).toBe("PASS");
    expect(bb.find((r) => /candidate.*staging verifier/.test(r.agent.label))!.verdict).toBe("FAIL");
  });

  test("GATE 6: the existing Release Gate blocks the candidate, with linked evidence", () => {
    expect(rep.gate.decision).toBe("BLOCKED");
    const ids = new Set(readdirSync(join(rep.outDir, "runs")).map((f) => f.replace(".json", "")));
    for (const row of rep.gate.rows) for (const e of row.evidence) expect(ids.has(e.runId)).toBe(true);
  });

  test("clean exit and no raw tokens in logs or evidence", () => {
    expect(Object.values(rep.exitCodes).every((c) => c === 0)).toBe(true);
    for (const dir of ["logs", "runs"]) {
      for (const f of readdirSync(join(rep.outDir, dir))) {
        expect(readFileSync(join(rep.outDir, dir, f), "utf8")).not.toMatch(/Bearer [A-Za-z0-9_-]{30,}/);
      }
    }
  });
});
