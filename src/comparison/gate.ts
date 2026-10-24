/**
 * Baseline/candidate Release Gate. Consumes saved RunRecords only, so every decision links to the
 * exact runs and evidence behind it. Counts are observed outcomes, never reliability guarantees.
 */
import type { GateDecision, Verdict } from "../contracts/index.ts";
import type { RunRecord } from "../engine/run-scenario.ts";

export type Counts = Record<Verdict, number> & { total: number };

export type GateRow = {
  scenarioId: string;
  baseline: Counts;
  candidate: Counts;
  comparable: boolean;
  differences: string[];
  regression: boolean | null;
  status: "ok" | "blocked" | "review";
  why: string;
  evidence: { side: "baseline" | "candidate"; runId: string; verdict: Verdict; reason: string }[];
};

export type GateResult = {
  decision: GateDecision;
  reason: string;
  rows: GateRow[];
  disclosures: string[];
  baselineAgent: string | null;
  candidateAgent: string | null;
};

const count = (rs: RunRecord[]): Counts => {
  const c: Counts = { PASS: 0, FAIL: 0, ERROR: 0, INCONCLUSIVE: 0, total: rs.length };
  for (const r of rs) c[r.verdict] += 1;
  return c;
};

export const formatCounts = (c: Counts): string =>
  c.total === 0 ? "no runs" : (["PASS", "FAIL", "ERROR", "INCONCLUSIVE"] as const).filter((v) => c[v]).map((v) => `${c[v]}/${c.total} ${v}`).join(" · ");

/** A candidate failure that blocks release: a critical check proven failed, or an agent-attributable limit. */
const isBlocking = (r: RunRecord) =>
  r.verdict === "FAIL" && (r.executionStatus === "agent_limit" || r.checks.some((c) => c.status === "fail" && c.critical && !c.informational));

const conditions = (r: RunRecord) => ({
  scenarioVersion: r.scenarioVersion,
  checksVersion: r.checksVersion,
  fixturesVersion: r.fixturesVersion,
  faults: r.faults.join("|"),
});

export function releaseGate(input: {
  baseline: RunRecord[];
  candidate: RunRecord[];
  /** Scenario id -> number of mandatory candidate runs. */
  required: Record<string, number>;
}): GateResult {
  const disclosures: string[] = [];
  const rows: GateRow[] = [];
  const agentOf = (rs: RunRecord[]) => [...new Set(rs.map((r) => `${r.agent.label}@${r.agent.version}`))];
  const bAgents = agentOf(input.baseline);
  const cAgents = agentOf(input.candidate);
  if (bAgents.length > 1) disclosures.push(`Baseline mixes agent versions: ${bAgents.join(", ")}`);
  if (cAgents.length > 1) disclosures.push(`Candidate mixes agent versions: ${cAgents.join(", ")}`);
  if (bAgents.length && cAgents.length) disclosures.push(`Compared: baseline ${bAgents.join(", ")} vs candidate ${cAgents.join(", ")}`);
  const judges = [...new Set([...input.baseline, ...input.candidate].map((r) => r.judge.name))];
  disclosures.push(`Claim interpretation by: ${judges.join(", ")} (advisory; verdicts rest on observed state)`);
  const adapters = [...new Set([...input.baseline, ...input.candidate].map((r) => `${r.adapter.name}/${r.adapter.version}`))];
  disclosures.push(`Adapters: ${adapters.join(", ")}`);

  for (const [scenarioId, mandatory] of Object.entries(input.required)) {
    const b = input.baseline.filter((r) => r.scenarioId === scenarioId);
    const c = input.candidate.filter((r) => r.scenarioId === scenarioId);
    const differences: string[] = [];
    const bc = b.map(conditions);
    const cc = c.map(conditions);
    const all = [...bc, ...cc];
    for (const key of ["scenarioVersion", "checksVersion", "fixturesVersion", "faults"] as const) {
      const vals = [...new Set(all.map((x) => x[key]))];
      if (vals.length > 1) differences.push(`${key} differs (${vals.join(" vs ")})`);
    }
    const comparable = b.length > 0 && c.length > 0 && differences.length === 0;
    if (b.length === 0) differences.push("no baseline runs");

    const bCounts = count(b);
    const cCounts = count(c);
    const regression = comparable ? cCounts.PASS / cCounts.total < bCounts.PASS / bCounts.total : null;
    let status: GateRow["status"] = "ok";
    let why = `${formatCounts(cCounts)} observed`;
    const blocking = c.filter(isBlocking);
    if (blocking.length) {
      status = "blocked";
      why = `Proven critical failure in ${blocking.length}/${c.length} candidate run(s): ${blocking[0]!.reason}`;
    } else if (c.length < mandatory) {
      status = "review";
      why = `Only ${c.length}/${mandatory} mandatory candidate runs executed`;
    } else if (c.some((r) => r.verdict !== "PASS")) {
      status = "review";
      why = `Candidate has non-PASS runs: ${formatCounts(cCounts)}`;
    } else if (differences.some((d) => d !== "no baseline runs")) {
      status = "review";
      why = `Baseline and candidate ran under different conditions: ${differences.join("; ")}`;
    }
    rows.push({
      scenarioId,
      baseline: bCounts,
      candidate: cCounts,
      comparable,
      differences,
      regression,
      status,
      why,
      evidence: [
        ...b.map((r) => ({ side: "baseline" as const, runId: r.runId, verdict: r.verdict, reason: r.reason })),
        ...c.map((r) => ({ side: "candidate" as const, runId: r.runId, verdict: r.verdict, reason: r.reason })),
      ],
    });
  }

  const blocked = rows.filter((r) => r.status === "blocked");
  const review = rows.filter((r) => r.status === "review");
  const decision: GateDecision = blocked.length ? "BLOCKED" : review.length || rows.length === 0 ? "NEEDS REVIEW" : "READY TO RELEASE";
  const reason = blocked.length
    ? `${blocked.map((r) => r.scenarioId).join(", ")}: ${blocked[0]!.why}`
    : review.length
      ? `${review.map((r) => r.scenarioId).join(", ")}: ${review[0]!.why}`
      : rows.length === 0
        ? "No scenarios evaluated"
        : "Every mandatory candidate run passed with complete evidence (observed results, not a guarantee)";
  return {
    decision,
    reason,
    rows,
    disclosures,
    baselineAgent: bAgents[0] ?? null,
    candidateAgent: cAgents[0] ?? null,
  };
}
