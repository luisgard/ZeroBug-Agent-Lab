/**
 * Intent-to-outcome planning contracts (AL-06). A plan is a proposal: it is validated here,
 * shown to a person, and only approved, READY scenarios run. Nothing a planner (rules or model)
 * returns is trusted without passing these schemas and the scenario validator.
 */
import { z } from "zod";
import { CheckSchema } from "../scenarios/schema.ts";

export const NeedKind = z.enum(["email", "order", "payment"]);
export type NeedKind = z.infer<typeof NeedKind>;

/** Placeholder evidence-source names the access planner replaces with a real connection. */
export const PLACEHOLDER_SOURCE: Record<NeedKind, string> = { email: "need-email", order: "need-order", payment: "need-payment" };

export const PlanRequestSchema = z.strictObject({
  agentMode: z.enum(["WEB_UI", "HTTP_API", "BRIDGE", "SAMPLE"]).default("WEB_UI"),
  agentUrl: z.string().url().optional(),
  description: z.string().trim().min(10, "Describe what your agent does (at least a sentence)").max(4000),
  specifics: z.string().trim().max(2000).default(""),
  lang: z.enum(["es", "en"]).default("es"),
});
export type PlanRequest = z.infer<typeof PlanRequestSchema>;

export const GeneratedScenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().min(3).max(120),
  task: z.string().min(5).max(2000),
  source: z.enum(["AUTO", "USER", "HYBRID"]),
  capability: z.enum(["email", "jobs", "shopping", "payments", "support"]),
  checks: z.array(CheckSchema).min(1).max(12),
  needs: z.array(z.strictObject({ kind: NeedKind, why: z.string().max(300) })).max(4),
  risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
  approvalRequired: z.boolean(),
  limitations: z.array(z.string().max(300)).max(8).default([]),
});
export type GeneratedScenario = z.infer<typeof GeneratedScenarioSchema>;
export type GeneratedScenarioInput = z.input<typeof GeneratedScenarioSchema>;

export type Readiness = "READY" | "NEEDS_ACCESS" | "NEEDS_REVIEW" | "UNSUPPORTED";

export type PlannedScenario = GeneratedScenario & {
  readiness: Readiness;
  readinessReason: string;
  /** Need kind -> connection/source name chosen by the access planner. */
  assignments: Partial<Record<NeedKind, string>>;
  /** Need kind -> every connection that could serve it, when more than one does and none was chosen. */
  choices?: Partial<Record<NeedKind, string[]>>;
};

export type PlannerInfo = { name: string; kind: "agents_api" | "offline_rules"; note: string };

export type Plan = {
  planId: string;
  createdAt: string;
  request: PlanRequest;
  planner: PlannerInfo;
  capabilitiesDetected: string[];
  scenarios: PlannedScenario[];
  /** User asks that could not be turned into a verifiable criterion, with the reason. Never silently dropped. */
  unsupported: { text: string; why: string }[];
};

export type AvailableSource = { name: string; provides: NeedKind[]; verified: boolean; account?: string; origin: "connection" | "file" };
