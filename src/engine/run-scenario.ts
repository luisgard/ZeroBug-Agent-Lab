/**
 * The single testing engine. Every transport (scripted, Agents API, HTTP bridge, black-box) runs
 * through this function and the same checks, claim logic and verdict.
 */
import type {
  AdapterInfo,
  AgentRunner,
  CapabilityMatrix,
  EvidenceItem,
  RunEvent,
  RunStatus,
  Verdict,
  VerifierAdapter,
} from "../contracts/index.ts";
import { type Judge, type JudgeAnswer, type JudgeInfo, JudgeUnavailableError, buildQuestions, formatEvidence } from "../judge/judge.ts";
import { CHECKS_VERSION, type Scenario } from "../scenarios/schema.ts";
import { newRunId, nowIso } from "../util/ids.ts";
import { type CheckResult, type Outcome, decideVerdict, evaluateClaim } from "../verdict/verdict.ts";
import {
  type ExternalOutboxConfig,
  ExternalOutboxVerifier,
  MessageOnlyVerifier,
  type RunFacts,
  WorldVerifier,
  verifyWith,
} from "../verifier/verifiers.ts";
import { describeFault } from "../world/faults.ts";
import { type JournalEntry, type WorldSnapshot, createWorld, fixturesFingerprint, loadFixtures, toolsFor } from "../world/world.ts";
import { EvidenceLog } from "./evidence.ts";
import type { RunStore } from "./store.ts";

export type AgentDescriptor = {
  id: string;
  label: string;
  /** Version fingerprint of the agent under test (prompt hash, git sha, image tag...). */
  version: string;
  endpoint?: string;
};

export type RunRecord = {
  runId: string;
  source: "live";
  scenarioId: string;
  scenarioVersion: string;
  checksVersion: string;
  fixturesVersion: string;
  faults: string[];
  agent: AgentDescriptor;
  adapter: AdapterInfo;
  judge: JudgeInfo;
  verifiers: string[];
  environmentId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  executionStatus: RunStatus;
  executionReason?: string;
  verdict: Verdict;
  reason: string;
  outcome: Outcome;
  taskCompletion: "completed" | "not_completed" | "unknown";
  faultsFired: string[];
  checks: CheckResult[];
  judgeAnswers: JudgeAnswer[] | null;
  finalMessage: string | null;
  events: RunEvent[];
  /** Only for instrumented runs: the world ZeroBug owns. Null when not observable. */
  worldSnapshot: Omit<WorldSnapshot, "catalog" | "customer"> | null;
  journal: JournalEntry[] | null;
  capabilities: CapabilityMatrix | null;
  evidence: EvidenceItem[];
  notes: string[];
};

export type RunScenarioOptions = {
  scenario: Scenario;
  agent: AgentDescriptor;
  runner: AgentRunner;
  judge: Judge;
  store?: RunStore;
  runId?: string;
  capabilities?: CapabilityMatrix;
  /** Black-box only: separately granted read-only verification interface. */
  externalOutbox?: ExternalOutboxConfig;
  onEvent?: (e: RunEvent) => void;
};

export async function runScenario(o: RunScenarioOptions): Promise<RunRecord> {
  const { scenario, runner, judge } = o;
  const runId = o.runId ?? newRunId();
  const startedAt = nowIso();
  const t0 = Date.now();
  const events: RunEvent[] = [];
  const emit = (e: RunEvent) => {
    events.push(e);
    o.onEvent?.(e);
  };
  const notes: string[] = [];
  const fixtures = loadFixtures();
  const world = createWorld({ runId, faults: scenario.faults, fixtures, onEffect: emit });
  const instrumented = runner.info.transport !== "blackbox_http";
  const ev = new EvidenceLog({ runId, adapter: runner.info.name, adapterVersion: runner.info.version, environmentId: world.inspector.environmentId });

  // ---- preflight
  let preflightBlock: string | null = null;
  if (scenario.agentTransport !== "any" && scenario.agentTransport !== runner.info.transport) {
    preflightBlock = `Scenario requires transport ${scenario.agentTransport}, agent uses ${runner.info.transport}`;
  }
  if (!instrumented && scenario.faults.length) {
    notes.push("Fault injection is not available in black-box mode; declared faults were NOT applied to the agent.");
  }
  for (const cap of scenario.requiresCapabilities) {
    const entry = o.capabilities?.[cap];
    if (entry?.state === "UNSUPPORTED") notes.push(`Required capability ${cap} is UNSUPPORTED (${entry.basis}); dependent checks cannot pass.`);
    else if (entry?.state === "DECLARED") notes.push(`Required capability ${cap} is only DECLARED, not verified.`);
  }

  // ---- execute
  let result: Awaited<ReturnType<AgentRunner["run"]>>;
  if (preflightBlock) {
    result = { status: "cancelled", finalMessage: null, reason: preflightBlock, adapter: runner.info };
    notes.push(`Preflight: ${preflightBlock}`);
  } else {
    result = await runner.run(
      {
        runId,
        task: scenario.task,
        tools: instrumented ? toolsFor(scenario.apps) : [],
        callTool: (name, args, meta) => world.tools.call(name, args, meta),
        limits: scenario.limits,
      },
      emit,
    );
  }
  const durationMs = Date.now() - t0;
  const facts = (): RunFacts => ({ finalMessage: result.finalMessage, durationMs, customerEmail: fixtures.customer.email });
  ev.add("runner_status", `execution ${result.status}`, { status: result.status, reason: result.reason, externalRef: result.externalRef });
  if (result.finalMessage) ev.add("final_message", "agent final message (agent-reported, not proof)", { text: result.finalMessage });

  // ---- verify (world access != verification access: the agent never had these verifiers)
  const verifiers: VerifierAdapter[] = instrumented
    ? [new WorldVerifier(ev.add, world.inspector, facts)]
    : [
        ...(o.externalOutbox ? [new ExternalOutboxVerifier(ev.add, o.externalOutbox, facts)] : []),
        new MessageOnlyVerifier(ev.add, facts),
      ];
  if (!instrumented && !o.externalOutbox) {
    notes.push("No independent verifier connected: side-effect requirements cannot PASS from the agent's words alone.");
  }

  const checks: CheckResult[] = [];
  const meta = (id: string) => {
    const c = scenario.checks.find((x) => x.id === id)!;
    return { checkId: c.id, type: c.type, critical: c.critical, informational: c.informational, goal: scenario.goals.includes(c.id) };
  };
  for (const c of scenario.checks) {
    if (c.type === "claim_matches_external_state") continue;
    const r = await verifyWith(verifiers, c, runId);
    checks.push({ ...meta(c.id), status: r.status, reason: r.reason, evidenceRefs: r.evidenceRefs, verifier: r.verifier });
  }

  // ---- judge (advisory; claims only interpret what the agent said)
  let answers: JudgeAnswer[] | null = null;
  const questions = buildQuestions(scenario);
  const needsJudge = scenario.checks.some((c) => c.type === "claim_matches_external_state") || scenario.judge.length > 0;
  if (needsJudge && result.status !== "infrastructure_error" && result.status !== "cancelled") {
    try {
      answers = await judge.ask(formatEvidence({ task: scenario.task, events, finalMessage: result.finalMessage }), questions, scenario);
      for (const a of answers) ev.add("judge_answer", `[${judge.info.name}] ${a.name} (interpretation, not proof)`, a);
    } catch (err) {
      if (!(err instanceof JudgeUnavailableError)) throw err;
      notes.push(`Judge unavailable: ${err.message}`);
    }
  }
  for (const c of scenario.checks) {
    if (c.type !== "claim_matches_external_state") continue;
    const state = checks.find((x) => x.checkId === c.stateCheck);
    const r = evaluateClaim(c, { finalMessage: result.finalMessage, answers, state, isGoal: scenario.goals.includes(c.id) });
    const refs = [...(state?.evidenceRefs ?? []), ...ev.items.filter((i) => i.kind === "judge_answer" && i.summary.includes(`claim:${c.id}`)).map((i) => i.id)];
    checks.push({ ...meta(c.id), status: r.status, reason: r.reason, evidenceRefs: refs, verifier: `${judge.info.name}+${state?.verifier ?? "none"}` });
  }

  // ---- verdict
  const journal = instrumented ? [...world.inspector.journal()] : null;
  const faultsFired = (journal ?? []).filter((e) => e.kind === "tool_invocation" && e.fault).map((e) => `${(e as any).tool}: ${(e as any).fault}`);
  const decision = decideVerdict({
    executionStatus: result.status,
    ...(result.reason ? { runReason: result.reason } : {}),
    checks,
    scenario,
    faultsFired,
  });
  const snap = world.inspector.snapshot();
  const record: RunRecord = {
    runId,
    source: "live",
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    checksVersion: CHECKS_VERSION,
    fixturesVersion: fixturesFingerprint(fixtures),
    faults: scenario.faults.map(describeFault),
    agent: o.agent,
    adapter: runner.info,
    judge: judge.info,
    verifiers: verifiers.map((v) => v.name),
    environmentId: world.inspector.environmentId,
    startedAt,
    finishedAt: nowIso(),
    durationMs,
    executionStatus: result.status,
    ...(result.reason ? { executionReason: result.reason } : {}),
    verdict: decision.verdict,
    reason: decision.reason,
    outcome: decision.outcome,
    taskCompletion: decision.taskCompletion,
    faultsFired,
    checks,
    judgeAnswers: answers,
    finalMessage: result.finalMessage,
    events,
    worldSnapshot: instrumented ? { cart: [...snap.cart], orders: [...snap.orders], outbox: [...snap.outbox] } : null,
    journal,
    capabilities: o.capabilities ?? null,
    evidence: ev.items,
    notes,
  };
  if (o.store) await o.store.save(record);
  return record;
}
