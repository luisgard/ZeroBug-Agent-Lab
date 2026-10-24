/**
 * Versioned contracts shared by every runner, verifier and the engine.
 * Transport-specific objects (SDK events, HTTP bodies) never leave their runner.
 */
import { z } from "zod";

export const CONTRACT_VERSION = "1";

// ---------------------------------------------------------------- run events

export type RunEvent =
  | { type: "tool_call"; timestamp: string; runId: string; callId: string; tool: string; args: unknown }
  | { type: "tool_result"; timestamp: string; runId: string; callId: string; ok: boolean; result?: unknown; error?: string }
  | { type: "world_effect"; timestamp: string; runId: string; effectId: string; kind: string; data: unknown }
  | { type: "message"; timestamp: string; runId: string; text: string }
  | { type: "error"; timestamp: string; runId: string; category: string; reason: string };

export type Emit = (event: RunEvent) => void;

// ---------------------------------------------------------------- tools

export type ToolDef = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ToolOutcome = { success: true; output: unknown } | { success: false; error: string };

// ---------------------------------------------------------------- runner

/** `completed`: agent finished on its own. `agent_limit`: agent exceeded a declared limit (agent-attributable).
 * `infrastructure_error`: ZeroBug, network or provider failed. `cancelled`: stopped by the operator. */
export type RunStatus = "completed" | "agent_limit" | "infrastructure_error" | "cancelled";

export type RunLimits = { maxToolCalls: number; maxSeconds: number };

export type RunInput = {
  runId: string;
  task: string;
  /** Tools routed through ZeroBug's world. Empty for black-box runs. */
  tools: ToolDef[];
  /** World-side tool execution. Records the journal; the agent never sees the inspector. */
  callTool: (name: string, args: unknown, meta: { callId: string }) => Promise<ToolOutcome>;
  limits: RunLimits;
  signal?: AbortSignal;
};

export type AdapterInfo = { name: string; version: string; transport: AgentTransport };

export type RunResult = {
  status: RunStatus;
  finalMessage: string | null;
  reason?: string;
  adapter: AdapterInfo;
  /** Provider session id or similar, for provenance only. */
  externalRef?: string;
};

export interface AgentRunner {
  readonly info: AdapterInfo;
  run(input: RunInput, emit: Emit): Promise<RunResult>;
}

export const AgentTransportSchema = z.enum(["scripted", "agents_api", "http_bridge", "blackbox_http"]);
export type AgentTransport = z.infer<typeof AgentTransportSchema>;

// ---------------------------------------------------------------- capabilities

export const CAPABILITY_NAMES = [
  "canAcceptTask",
  "canUseInjectedTools",
  "canObserveToolCalls",
  "canResetSession",
  "canInspectExternalEffects",
  "canInjectFaults",
  "canRunConcurrentTasks",
  "canReadSource",
  "canPatchSource",
] as const;
export const CapabilityNameSchema = z.enum(CAPABILITY_NAMES);
export type CapabilityName = z.infer<typeof CapabilityNameSchema>;

export const AgentCapabilitiesSchema = z.strictObject(
  Object.fromEntries(CAPABILITY_NAMES.map((n) => [n, z.boolean()])) as Record<CapabilityName, z.ZodBoolean>,
);
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

/** VERIFIED: proven by a real handshake or smoke action. DECLARED: a claim by the user/agent. UNSUPPORTED: not available. */
export type CapabilityState = "VERIFIED" | "DECLARED" | "UNSUPPORTED";
export type CapabilityEntry = { state: CapabilityState; basis: string };
export type CapabilityMatrix = Record<CapabilityName, CapabilityEntry>;

// ---------------------------------------------------------------- verification

export type VerificationStatus = "pass" | "fail" | "inconclusive" | "unsupported";

export const VerificationResultSchema = z.strictObject({
  checkId: z.string().min(1),
  status: z.enum(["pass", "fail", "inconclusive", "unsupported"]),
  evidenceRefs: z.array(z.string()),
  reason: z.string(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export interface VerifierAdapter {
  readonly name: string;
  verify(check: unknown, runId: string): Promise<VerificationResult>;
}

// ---------------------------------------------------------------- evidence

export type EvidenceKind =
  | "journal_entry"
  | "state_snapshot"
  | "external_read"
  | "judge_answer"
  | "final_message"
  | "runner_status"
  | "capability";

export type Provenance = {
  runId: string;
  adapter: string;
  adapterVersion: string;
  environmentId: string;
  observedAt: string;
  verifierRef: string;
};

export type EvidenceItem = { id: string; kind: EvidenceKind; summary: string; data: unknown; provenance: Provenance };

// ---------------------------------------------------------------- verdicts

export type Verdict = "PASS" | "FAIL" | "ERROR" | "INCONCLUSIVE";
export type GateDecision = "READY TO RELEASE" | "BLOCKED" | "NEEDS REVIEW";
