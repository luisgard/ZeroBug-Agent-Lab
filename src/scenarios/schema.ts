/**
 * Strict, declarative scenario files. Nothing in a scenario is evaluated as code or an expression:
 * every field is plain data validated here; unknown fields, unknown check types and expression-like
 * strings are rejected.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AgentTransportSchema, CapabilityNameSchema } from "../contracts/index.ts";
import { fingerprint } from "../util/ids.ts";
import { FaultSchema } from "../world/faults.ts";

/** Bump when check semantics change; comparisons across different versions are flagged. */
export const CHECKS_VERSION = "1";

const Common = {
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  critical: z.boolean().default(false),
  /** Reported (e.g. task completion under a degraded policy) but excluded from the verdict. */
  informational: z.boolean().default(false),
};
const Recipient = z.union([z.literal("customer"), z.string().email()]);
const Phrase = z.string().min(2).max(200);
const SourceName = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/);

export const CheckSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...Common, type: z.literal("required_cart_item"), productId: z.string().min(1), quantity: z.number().int().min(1).default(1) }),
  z.strictObject({ ...Common, type: z.literal("max_cart_total"), max: z.number().positive(), allowEmptyCart: z.boolean().default(false) }),
  z.strictObject({ ...Common, type: z.literal("forbid_checkout") }),
  z.strictObject({
    ...Common,
    type: z.literal("unauthorized_secret_disclosure"),
    secret: z.literal("customer.loyaltyCode"),
    allowedRecipients: z.array(Recipient).default(["customer"]),
  }),
  z.strictObject({
    ...Common,
    type: z.literal("required_email_sent"),
    to: Recipient,
    subjectContains: Phrase.optional(),
    bodyContains: Phrase.optional(),
  }),
  z.strictObject({
    ...Common,
    type: z.literal("claim_matches_external_state"),
    claim: z.string().min(5).max(500),
    stateCheck: z.string().min(1),
    /** What the claim asserts about `stateCheck`: that it is satisfied (default) or that it is not. */
    asserts: z.enum(["satisfied", "not_satisfied"]).default("satisfied"),
    /** Optional plain phrases for the offline heuristic judge. Matched as literal substrings only. */
    signals: z.strictObject({ affirm: z.array(Phrase).default([]), deny: z.array(Phrase).default([]) }).optional(),
  }),
  z.strictObject({ ...Common, type: z.literal("tool_limit"), max: z.number().int().min(0).max(1000) }),
  z.strictObject({ ...Common, type: z.literal("time_limit"), maxSeconds: z.number().positive().max(3600) }),
  z.strictObject({
    ...Common,
    type: z.literal("required_evidence"),
    kinds: z.array(z.enum(["world_journal", "final_message", "external_read"])).min(1),
  }),
  z.strictObject({ ...Common, type: z.literal("expect_no_action") }),
  // ---- connector checks: verified in a real external system through an evidence source
  z.strictObject({
    ...Common,
    type: z.literal("email_received"),
    source: SourceName,
    /** May contain {ref} (e.g. qa+{ref}@example.com) for a unique recipient per run. */
    to: z.string().regex(/^(customer|[^\s@]+@[^\s@]+\.[^\s@]+)$/, "email address or customer"),
    subjectContains: Phrase.optional(),
    bodyContains: Phrase.optional(),
    fromContains: Phrase.optional(),
    /** The email must carry this run's reference ({ref}), so old or unrelated mail never counts. */
    requireRef: z.boolean().default(true),
    /** Delivery is asynchronous: poll the source up to this long before deciding. */
    waitSeconds: z.number().int().min(0).max(600).default(60),
    /** Exact number of matching emails (e.g. 1 = no duplicates). Waits the full window before passing. */
    exactly: z.number().int().min(1).max(100).optional(),
  }),
  z.strictObject({
    ...Common,
    type: z.literal("order_exists"),
    source: SourceName,
    productContains: Phrase.optional(),
    quantity: z.number().int().min(1).optional(),
    maxTotal: z.number().positive().optional(),
    status: z.string().min(1).max(40).optional(),
    requireRef: z.boolean().default(true),
    waitSeconds: z.number().int().min(0).max(600).default(30),
  }),
  z.strictObject({
    ...Common,
    type: z.literal("payment_exists"),
    source: SourceName,
    amount: z.number().nonnegative().optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
    status: z.string().min(1).max(40).optional(),
    requireRef: z.boolean().default(true),
    waitSeconds: z.number().int().min(0).max(600).default(30),
    /** Exact number of matching payments (e.g. 1 = no double refund). Waits the full window before passing. */
    exactly: z.number().int().min(1).max(100).optional(),
  }),
  /** No payment/refund carrying this run's reference may appear (e.g. a refund the policy forbids). */
  z.strictObject({
    ...Common,
    type: z.literal("payment_absent"),
    source: SourceName,
    requireRef: z.literal(true).default(true),
    waitSeconds: z.number().int().min(5).max(600).default(45),
  }),
]);
export type CheckInput = z.input<typeof CheckSchema>;
export type Check = z.output<typeof CheckSchema> & { id: string };
export type CheckType = Check["type"];

/** Check types that establish a positive goal (task outcome) on their own. */
export const GOAL_CHECK_TYPES: CheckType[] = ["required_cart_item", "required_email_sent", "expect_no_action", "email_received", "order_exists", "payment_exists", "payment_absent"];
export const CONNECTOR_CHECK_TYPES: CheckType[] = ["email_received", "order_exists", "payment_exists", "payment_absent"];

const ScenarioBase = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().min(1).max(120),
  task: z.string().min(5).max(2000),
  apps: z.array(z.enum(["store", "outbox"])).min(1),
  runs: z.number().int().min(1).max(50).default(5),
  limits: z
    .strictObject({ maxToolCalls: z.number().int().min(1).max(200).default(20), maxSeconds: z.number().int().min(1).max(600).default(90) })
    .default({ maxToolCalls: 20, maxSeconds: 90 }),
  faults: z.array(FaultSchema).default([]),
  checks: z.array(CheckSchema).min(1),
  /** Check ids that establish the positive goal. Defaults to all non-informational goal-type checks. */
  goals: z.array(z.string()).optional(),
  /** Declares that, when the injected fault blocks the task, an honest degraded outcome is acceptable. */
  degradedOutcome: z.strictObject({ description: z.string().min(5).max(500) }).optional(),
  requiresCapabilities: z.array(CapabilityNameSchema).default([]),
  agentTransport: z.union([AgentTransportSchema, z.literal("any")]).default("any"),
  judge: z
    .array(z.strictObject({ type: z.literal("score"), name: z.string().regex(/^[a-z_]{2,40}$/), levels: z.array(z.string().min(1)).min(2).max(10) }))
    .default([]),
});

export type Scenario = Omit<z.output<typeof ScenarioBase>, "checks" | "goals"> & {
  checks: Check[];
  goals: string[];
  /** Fingerprint of the validated definition, for comparability. */
  version: string;
  file: string;
};

export class ScenarioValidationError extends Error {}

const EXPRESSION_LIKE = /\$\{|\{\{|`|=>|\b(eval|require|import|process|Function)\s*\(|\w+\([^)]*\)\s*(&&|\|\||==)/;

function rejectExpressions(value: unknown, path: string[], file: string): void {
  if (typeof value === "string") {
    if (EXPRESSION_LIKE.test(value)) {
      throw new ScenarioValidationError(`${file}: ${path.join(".")}: expression-like strings are not allowed`);
    }
  } else if (Array.isArray(value)) value.forEach((v, i) => rejectExpressions(v, [...path, String(i)], file));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) rejectExpressions(v, [...path, k], file);
}

export function validateScenario(raw: unknown, file: string): Scenario {
  rejectExpressions(raw, [], file);
  const parsed = ScenarioBase.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ScenarioValidationError(`${file}: ${msg}`);
  }
  const s = parsed.data;
  const fail = (m: string): never => {
    throw new ScenarioValidationError(`${file}: ${m}`);
  };

  const checks: Check[] = s.checks.map((c, i) => ({ ...c, id: c.id ?? `${c.type.replace(/_/g, "-")}-${i}` }));
  const ids = new Set<string>();
  for (const c of checks) {
    if (ids.has(c.id)) fail(`checks: duplicate check id "${c.id}"`);
    ids.add(c.id);
  }
  for (const c of checks) {
    if (c.type === "claim_matches_external_state") {
      const target = checks.find((x) => x.id === c.stateCheck);
      if (!target) fail(`checks.${c.id}.stateCheck: unknown check id "${c.stateCheck}"`);
      if (target!.type === "claim_matches_external_state") fail(`checks.${c.id}.stateCheck: must reference a state check`);
    }
    if (c.type === "max_cart_total" && !c.allowEmptyCart && !checks.some((x) => x.type === "required_cart_item")) {
      fail(`checks.${c.id}: max_cart_total needs a required_cart_item in the same scenario or allowEmptyCart: true (a budget alone cannot establish success)`);
    }
    if (c.type === "required_cart_item" && !s.apps.includes("store")) fail(`checks.${c.id}: requires app "store"`);
  }

  const goals = s.goals ?? checks.filter((c) => GOAL_CHECK_TYPES.includes(c.type) && !c.informational).map((c) => c.id);
  for (const g of goals) {
    const c = checks.find((x) => x.id === g);
    if (!c) fail(`goals: unknown check id "${g}"`);
    if (c!.informational) fail(`goals: "${g}" is informational and cannot be a goal`);
  }
  if (goals.length === 0) {
    fail("scenario declares only negative constraints; add a positive goal check (or expect_no_action for a valid non-action goal)");
  }
  if (s.degradedOutcome && s.faults.length === 0) fail("degradedOutcome requires at least one injected fault");
  const needsRef = checks.filter((c) => CONNECTOR_CHECK_TYPES.includes(c.type) && (c as { requireRef?: boolean }).requireRef);
  if (needsRef.length && !s.task.includes("{ref}")) {
    fail(`checks ${needsRef.map((c) => c.id).join(", ")} require the run reference: put {ref} in the task so the agent can include it`);
  }

  const { goals: _g, ...rest } = s;
  const body = { ...rest, checks, goals };
  return { ...body, version: fingerprint(body), file };
}

export function parseScenario(yamlText: string, file: string): Scenario {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText, { strict: true, uniqueKeys: true, maxAliasCount: 0 });
  } catch (err) {
    throw new ScenarioValidationError(`${file}: invalid YAML: ${(err as Error).message}`);
  }
  return validateScenario(raw, file);
}

export function loadScenarios(dir = "scenarios"): { scenarios: Scenario[]; errors: { file: string; message: string }[] } {
  const scenarios: Scenario[] = [];
  const errors: { file: string; message: string }[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".yaml")).sort()) {
    try {
      scenarios.push(parseScenario(readFileSync(join(dir, f), "utf8"), f));
    } catch (err) {
      errors.push({ file: f, message: (err as Error).message });
    }
  }
  return { scenarios, errors };
}

export function loadScenario(id: string, dir = "scenarios"): Scenario {
  return parseScenario(readFileSync(join(dir, `${id}.yaml`), "utf8"), `${id}.yaml`);
}
