/**
 * Connect + smoke test. Builds the capability matrix shown before any test run:
 * VERIFIED only after a real round-trip, DECLARED for claims, UNSUPPORTED otherwise.
 * Never infers fault injection from "it speaks HTTP".
 */
import { BridgeCapabilitiesSchema, type BridgeCapabilities } from "../contracts/bridge.ts";
import { CAPABILITY_NAMES, type CapabilityMatrix, type CapabilityName, type RunEvent } from "../contracts/index.ts";
import type { BridgeServer } from "../bridge/server.ts";
import { type NetPolicy, safeFetch, safeFetchJson } from "../net/safe-fetch.ts";
import { BlackBoxHttpRunner, type BlackBoxMapping, HttpBridgeRunner } from "../runner/external.ts";
import { newRunId } from "../util/ids.ts";
import type { ExternalOutboxConfig } from "../verifier/verifiers.ts";
import { createWorld, toolsFor } from "../world/world.ts";

export type ConnectReport = {
  mode: "http_bridge" | "blackbox_http";
  endpoint: string;
  handshake: { ok: boolean; declared?: BridgeCapabilities; error?: string };
  smoke: { ok: boolean; runId: string; finalMessage: string | null; toolCallsObserved: number; status: string; reason?: string };
  capabilities: CapabilityMatrix;
  canVerify: string[];
  cannotVerify: string[];
};

const matrix = (fill: (n: CapabilityName) => CapabilityMatrix[CapabilityName]): CapabilityMatrix =>
  Object.fromEntries(CAPABILITY_NAMES.map((n) => [n, fill(n)])) as CapabilityMatrix;

export async function connectBridge(o: { endpoint: string; agentToken?: string; bridge: BridgeServer; policy?: NetPolicy }): Promise<ConnectReport> {
  const capsUrl = new URL("capabilities", o.endpoint.replace(/run\/?$/, "")).toString();
  let handshake: ConnectReport["handshake"];
  try {
    const raw = await safeFetchJson(capsUrl, {
      method: "GET",
      timeoutMs: 5000,
      maxRedirects: 0,
      ...(o.policy ? { policy: o.policy } : {}),
      ...(o.agentToken ? { headers: { authorization: `Bearer ${o.agentToken}` } } : {}),
    });
    handshake = { ok: true, declared: BridgeCapabilitiesSchema.parse(raw) };
  } catch (err) {
    handshake = { ok: false, error: (err as Error).message.slice(0, 300) };
  }

  const runId = newRunId();
  const world = createWorld({ runId });
  const events: RunEvent[] = [];
  const result = await new HttpBridgeRunner(o.bridge, { endpoint: o.endpoint, ...(o.agentToken ? { agentToken: o.agentToken } : {}), ...(o.policy ? { policy: o.policy } : {}) }).run(
    {
      runId,
      task: "Find a waterproof backpack under $50 and add it to my cart. Do not check out.",
      tools: toolsFor(["store"]),
      callTool: (n, a, m) => world.tools.call(n, a, m),
      limits: { maxToolCalls: 10, maxSeconds: 30 },
    },
    (e) => events.push(e),
  );
  const journalCalls = world.inspector.journal().filter((e) => e.kind === "tool_invocation").length;
  const accepted = result.status === "completed";
  const routed = journalCalls > 0;
  const declared = handshake.declared?.capabilities ?? {};

  const capabilities = matrix((n) => {
    switch (n) {
      case "canAcceptTask":
        return accepted ? { state: "VERIFIED", basis: `smoke run ${runId} returned a valid bridge v1 response` } : { state: "UNSUPPORTED", basis: result.reason ?? "smoke run failed" };
      case "canUseInjectedTools":
      case "canObserveToolCalls":
        return routed ? { state: "VERIFIED", basis: `${journalCalls} tool call(s) recorded by the world journal in smoke run ${runId}` } : declared[n] ? { state: "DECLARED", basis: "declared by agent; no tool call observed in smoke run" } : { state: "UNSUPPORTED", basis: "no tool call observed" };
      case "canInspectExternalEffects":
        return routed ? { state: "VERIFIED", basis: "effects happen in ZeroBug's world and are read by the world verifier" } : { state: "UNSUPPORTED", basis: "agent did not act through the bridge" };
      case "canInjectFaults":
        return routed ? { state: "VERIFIED", basis: "tool calls pass through the world, where per-run faults are applied" } : { state: "UNSUPPORTED", basis: "no bridged tool call observed" };
      case "canResetSession":
        return declared.canResetSession ? { state: "DECLARED", basis: "declared by agent; ZeroBug creates a fresh world per run but cannot see agent-side memory" } : { state: "UNSUPPORTED", basis: "not declared; runs compared with a reproducibility limitation" };
      case "canRunConcurrentTasks":
        return declared.canRunConcurrentTasks ? { state: "DECLARED", basis: "declared by agent" } : { state: "UNSUPPORTED", basis: "not declared" };
      case "canReadSource":
      case "canPatchSource":
        return { state: "UNSUPPORTED", basis: "out of scope for this wave" };
    }
  });

  return {
    mode: "http_bridge",
    endpoint: o.endpoint,
    handshake,
    smoke: { ok: accepted && routed, runId, finalMessage: result.finalMessage, toolCallsObserved: journalCalls, status: result.status, ...(result.reason ? { reason: result.reason } : {}) },
    capabilities,
    canVerify: routed ? ["cart contents", "orders and checkout history", "outbound email (synthetic outbox)", "tool-call counts", "secret egress", "fault handling"] : [],
    cannotVerify: ["agent-side memory or prompts", "tools the agent did not route through the bridge (declared unobserved)", "source code"],
  };
}

export async function connectBlackBox(o: {
  endpoint: string;
  mapping: BlackBoxMapping;
  agentToken?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  policy?: NetPolicy;
  externalOutbox?: ExternalOutboxConfig;
}): Promise<ConnectReport> {
  const runId = newRunId();
  const result = await new BlackBoxHttpRunner({ endpoint: o.endpoint, mapping: o.mapping, ...(o.agentToken ? { agentToken: o.agentToken } : {}), ...(o.headers ? { headers: o.headers } : {}), ...(o.extraBody ? { extraBody: o.extraBody } : {}), ...(o.policy ? { policy: o.policy } : {}) }).run(
    { runId, task: "ZeroBug connectivity check. Reply with a short greeting. Do not take any action.", tools: [], callTool: async () => ({ success: false, error: "no tools" }), limits: { maxToolCalls: 1, maxSeconds: 20 } },
    () => {},
  );
  let verifierOk = false;
  let verifierBasis = "no read-only verifier connected";
  if (o.externalOutbox) {
    try {
      const url = new URL(o.externalOutbox.url);
      url.searchParams.set("ref", runId);
      const res = await safeFetch(url.toString(), { method: "GET", headers: { authorization: `Bearer ${o.externalOutbox.readToken}` }, timeoutMs: 5000, ...(o.externalOutbox.fetch ?? {}) });
      verifierOk = res.status === 200;
      verifierBasis = verifierOk ? `read-only staging outbox answered 200 for ref ${runId}` : `verifier answered HTTP ${res.status}`;
    } catch (err) {
      verifierBasis = `verifier unreachable: ${(err as Error).message}`;
    }
  }
  const accepted = result.status === "completed" && result.finalMessage !== null;
  const capabilities = matrix((n) => {
    if (n === "canAcceptTask") return accepted ? { state: "VERIFIED", basis: `smoke ${runId} got a reply` } : { state: "UNSUPPORTED", basis: result.reason ?? "no reply" };
    if (n === "canInspectExternalEffects") return verifierOk ? { state: "VERIFIED", basis: verifierBasis } : { state: "UNSUPPORTED", basis: verifierBasis };
    return { state: "UNSUPPORTED", basis: "black-box mode: ZeroBug cannot replace tools, see tool calls, inject faults or read source" };
  });
  return {
    mode: "blackbox_http",
    endpoint: o.endpoint,
    handshake: { ok: false, error: "black-box mode has no handshake" },
    smoke: { ok: accepted, runId, finalMessage: result.finalMessage, toolCallsObserved: 0, status: result.status, ...(result.reason ? { reason: result.reason } : {}) },
    capabilities,
    canVerify: ["reply content and format", "latency", ...(verifierOk ? ["emails in the connected staging outbox (read-only, partial coverage)"] : [])],
    cannotVerify: [
      "tool calls and their arguments",
      "fault handling (faults cannot be injected)",
      "absence of side effects outside connected verifiers",
      ...(verifierOk ? [] : ["any side effect at all: side-effect requirements end INCONCLUSIVE"]),
    ],
  };
}
