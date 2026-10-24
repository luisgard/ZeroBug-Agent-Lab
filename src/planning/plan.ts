/**
 * Builds a plan: planner proposal -> schema validation -> engine validation -> access planning.
 * Only scenarios that compile into the existing scenario engine are kept; anything else is reported.
 */
import { type Scenario, validateScenario } from "../scenarios/schema.ts";
import { newToken, nowIso } from "../util/ids.ts";
import { OFFLINE_PLANNER, offlinePlan } from "./offline-planner.ts";
import {
  type AvailableSource,
  type GeneratedScenario,
  GeneratedScenarioSchema,
  type NeedKind,
  PLACEHOLDER_SOURCE,
  type Plan,
  type PlannedScenario,
  type PlannerInfo,
  type PlanRequest,
} from "./types.ts";

export type PlannerOutput = { capabilities: string[]; scenarios: unknown[]; unsupported: { text: string; why: string }[] };
export type ModelPlanner = { info: PlannerInfo; plan(req: PlanRequest, sources: AvailableSource[]): Promise<PlannerOutput> };

export async function buildPlan(req: PlanRequest, sources: AvailableSource[], model?: ModelPlanner): Promise<Plan> {
  let planner: PlannerInfo = OFFLINE_PLANNER;
  let out: PlannerOutput;
  if (model) {
    try {
      out = await model.plan(req, sources);
      planner = model.info;
    } catch (err) {
      out = offlinePlan(req, sources);
      planner = { ...OFFLINE_PLANNER, note: `${OFFLINE_PLANNER.note} Agents API planner failed: ${(err as Error).message.slice(0, 200)}` };
    }
  } else out = offlinePlan(req, sources);

  const unsupported = [...out.unsupported];
  const scenarios: PlannedScenario[] = [];
  const seen = new Set<string>();
  for (const raw of out.scenarios.slice(0, 12)) {
    const parsed = GeneratedScenarioSchema.safeParse(raw);
    if (!parsed.success) {
      unsupported.push({ text: String((raw as { title?: unknown })?.title ?? "scenario"), why: `Rejected by schema: ${parsed.error.issues[0]?.message ?? "invalid"}` });
      continue;
    }
    const g = parsed.data;
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    const planned = planAccess(g, sources);
    try {
      toScenario(planned); // must compile into the existing engine
    } catch (err) {
      unsupported.push({ text: g.title, why: `Rejected by scenario validation: ${(err as Error).message.slice(0, 200)}` });
      continue;
    }
    scenarios.push(planned);
  }
  return { planId: newToken(12), createdAt: nowIso(), request: req, planner, capabilitiesDetected: out.capabilities, scenarios, unsupported };
}

/** Decides readiness from the real connections, never from what the planner claims exists. */
export function planAccess(g: GeneratedScenario, sources: AvailableSource[]): PlannedScenario {
  const assignments: Partial<Record<NeedKind, string>> = {};
  const missing: NeedKind[] = [];
  const unverified: string[] = [];
  for (const need of g.needs) {
    const candidates = sources.filter((s) => s.provides.includes(need.kind));
    const pick = candidates.find((s) => s.verified) ?? candidates[0];
    if (!pick) missing.push(need.kind);
    else {
      assignments[need.kind] = pick.name;
      if (!pick.verified) unverified.push(pick.name);
    }
  }
  // A planner may name a source directly; it only counts if that source really exists.
  const known = new Set([...sources.map((s) => s.name), ...Object.values(PLACEHOLDER_SOURCE)]);
  const invented = g.checks.flatMap((c) => ("source" in c && !known.has(c.source) ? [c.source] : []));
  if (invented.length) {
    return { ...g, assignments, readiness: "NEEDS_ACCESS", readinessReason: `Unknown evidence source: ${[...new Set(invented)].join(", ")}` };
  }
  if (missing.length) {
    return { ...g, assignments, readiness: "NEEDS_ACCESS", readinessReason: `Missing evidence source for: ${missing.join(", ")}` };
  }
  if (unverified.length) {
    return { ...g, assignments, readiness: "NEEDS_REVIEW", readinessReason: `Connection not verified: ${unverified.join(", ")} (test it in Connections)` };
  }
  if (/\[(PRODUCTO|PRODUCT|MONTO|AMOUNT)\]/.test(g.task)) {
    return { ...g, assignments, readiness: "NEEDS_REVIEW", readinessReason: "Fill in the placeholders in the task before running" };
  }
  return { ...g, assignments, readiness: "READY", readinessReason: g.approvalRequired ? "Ready; needs your explicit approval (real-world effects)" : "Ready" };
}

/** Compiles a planned scenario (with any task edit) into a validated engine scenario. */
export function toScenario(p: PlannedScenario, edits: { task?: string; runs?: number } = {}): Scenario {
  const placeholderToSource = Object.fromEntries(
    (Object.keys(PLACEHOLDER_SOURCE) as NeedKind[]).map((k) => [PLACEHOLDER_SOURCE[k], p.assignments[k] ?? PLACEHOLDER_SOURCE[k]]),
  );
  const checks = p.checks.map((c) => ("source" in c ? { ...c, source: placeholderToSource[c.source] ?? c.source } : c));
  const apps = p.capability === "email" || p.capability === "jobs" || p.capability === "support" ? ["outbox"] : ["store"];
  return validateScenario(
    {
      schemaVersion: 1,
      id: p.id,
      title: p.title,
      task: edits.task ?? p.task,
      apps,
      runs: edits.runs ?? 1,
      limits: { maxToolCalls: 50, maxSeconds: 300 },
      checks,
    },
    `plan:${p.id}`,
  );
}
