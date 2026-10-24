/**
 * ZeroBug CLI (GATE D): one command runs an agent against a scenario and prints observed state,
 * independent evidence, verdict and reason. No UI needed.
 *
 *   npm run zb -- scenarios
 *   npm run zb -- run --agent scripted-v1 --scenario store-outage [--runs 3]
 *   npm run zb -- run --agent bridge --endpoint http://127.0.0.1:8000/agent/run --scenario external-store-order
 *   npm run zb -- run --agent blackbox --endpoint http://127.0.0.1:8000/chat --scenario blackbox-invoice \
 *        --task-field message --response-field reply --correlation-field conversation_id [--verifier-url URL]
 *   npm run zb -- run --agent agents-api --instructions "You are..." --scenario normal-errand   (needs OPENAI_API_KEY)
 *   npm run zb -- run --agent browser --endpoint https://vendor.example/chat --input-selector "#msg" \
 *        --send-selector "#send" --reply-selector ".bot" --scenario real-email-delivery
 *   npm run zb -- sources                 (proves read access to each evidence source in zerobug.sources.json)
 *   npm run zb -- connect --agent bridge --endpoint http://127.0.0.1:8000/agent/run
 *   npm run zb -- gate --baseline scripted-v1 --candidate scripted-v2 [--dir data/runs]
 */
import { parseArgs } from "node:util";
import OpenAI from "openai";
import { SAMPLE_AGENTS, type SampleAgentId } from "../src/agents/samples.ts";
import { BridgeServer } from "../src/bridge/server.ts";
import { formatCounts, releaseGate } from "../src/comparison/gate.ts";
import type { AgentRunner } from "../src/contracts/index.ts";
import { connectBlackBox, connectBridge } from "../src/engine/connect.ts";
import { type AgentDescriptor, type RunRecord, runScenario } from "../src/engine/run-scenario.ts";
import { RunStore } from "../src/engine/store.ts";
import { DecisionsJudge, HeuristicJudge, type Judge } from "../src/judge/judge.ts";
import { policyFromEnv } from "../src/net/safe-fetch.ts";
import { AGENTS_MODEL_DEFAULT, AgentsApiRunner } from "../src/runner/agents-api.ts";
import { BlackBoxHttpRunner, HttpBridgeRunner } from "../src/runner/external.ts";
import { ScriptedRunner } from "../src/runner/scripted.ts";
import { loadScenario, loadScenarios } from "../src/scenarios/schema.ts";
import { fingerprint } from "../src/util/ids.ts";
import { loadLocalEnv } from "../src/util/env.ts";
import { SourceRegistry } from "../src/connectors/registry.ts";
import { BrowserChatRunner } from "../src/runner/browser.ts";

loadLocalEnv();

const { positionals, values: a } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string" },
    scenario: { type: "string", multiple: true },
    runs: { type: "string" },
    endpoint: { type: "string" },
    label: { type: "string" },
    version: { type: "string" },
    instructions: { type: "string" },
    model: { type: "string" },
    "task-field": { type: "string", default: "message" },
    "response-field": { type: "string", default: "reply" },
    "correlation-field": { type: "string" },
    "verifier-url": { type: "string" },
    "input-selector": { type: "string" },
    "send-selector": { type: "string" },
    "reply-selector": { type: "string" },
    baseline: { type: "string" },
    candidate: { type: "string" },
    dir: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const judgeFromEnv = (): Judge =>
  process.env.ZB_JUDGE === "decisions" && process.env.OPENAI_API_KEY ? new DecisionsJudge(new OpenAI()) : new HeuristicJudge();

async function main() {
  const cmd = positionals[0];
  if (cmd === "scenarios") {
    const { scenarios, errors } = loadScenarios();
    for (const s of scenarios) console.log(`${s.id.padEnd(22)} ${s.title}  [transport: ${s.agentTransport}, runs: ${s.runs}, checks: ${s.checks.map((c) => c.id).join(", ")}]`);
    for (const e of errors) console.error(`INVALID ${e.file}: ${e.message}`);
    return errors.length ? 1 : 0;
  }
  if (cmd === "gate") return gate();
  if (cmd === "sources") return sources();
  if (cmd === "connect") return connect();
  if (cmd === "run") return run();
  console.log("Usage: zb scenarios | run | connect | gate | sources   (see header of scripts/zb.ts)");
  return 2;
}

async function run(): Promise<number> {
  const ids = a.scenario ?? [];
  if (!a.agent || ids.length === 0) throw new Error("--agent and --scenario are required");
  const store = new RunStore();
  const judge = judgeFromEnv();
  let bridge: BridgeServer | undefined;
  let runner: AgentRunner;
  let agent: AgentDescriptor;
  let externalOutbox;

  if (a.agent in SAMPLE_AGENTS) {
    const s = SAMPLE_AGENTS[a.agent as SampleAgentId];
    runner = new ScriptedRunner(s.policy, a.agent);
    agent = { id: a.agent, label: s.label, version: s.version };
  } else if (a.agent === "agents-api") {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set (server-side .env.local). Agents API runs are BLOCKED without it.");
    if (!a.instructions?.trim()) throw new Error("--instructions must not be empty");
    const model = a.model ?? AGENTS_MODEL_DEFAULT;
    runner = new AgentsApiRunner(new OpenAI(), { model, instructions: a.instructions });
    agent = { id: "agents-api", label: a.label ?? `Agents API (${model})`, version: a.version ?? `prompt-${fingerprint({ model, i: a.instructions })}` };
  } else if (a.agent === "browser") {
    if (!a.endpoint || !a["input-selector"] || !a["reply-selector"]) throw new Error("--endpoint, --input-selector and --reply-selector are required");
    runner = new BrowserChatRunner({ url: a.endpoint, inputSelector: a["input-selector"], replySelector: a["reply-selector"], ...(a["send-selector"] ? { sendSelector: a["send-selector"] } : {}), policy: policyFromEnv() });
    agent = { id: "browser", label: a.label ?? `Browser chat ${a.endpoint}`, version: a.version ?? "unversioned", endpoint: a.endpoint };
  } else if (a.agent === "bridge" || a.agent === "blackbox") {
    if (!a.endpoint) throw new Error("--endpoint is required");
    const policy = policyFromEnv();
    const agentToken = process.env.ZB_AGENT_TOKEN;
    agent = { id: a.agent, label: a.label ?? `${a.agent} ${a.endpoint}`, version: a.version ?? "unversioned", endpoint: a.endpoint };
    if (a.agent === "bridge") {
      bridge = new BridgeServer({ port: Number(process.env.ZB_BRIDGE_PORT ?? 3000), ...(process.env.ZB_BRIDGE_PUBLIC_URL ? { publicBaseUrl: process.env.ZB_BRIDGE_PUBLIC_URL } : {}) });
      await bridge.start();
      runner = new HttpBridgeRunner(bridge, { endpoint: a.endpoint, policy, ...(agentToken ? { agentToken } : {}) });
    } else {
      runner = new BlackBoxHttpRunner({
        endpoint: a.endpoint,
        policy,
        ...(agentToken ? { agentToken } : {}),
        mapping: { taskField: a["task-field"]!, responseField: a["response-field"]!, ...(a["correlation-field"] ? { correlationField: a["correlation-field"] } : {}) },
      });
      if (a["verifier-url"]) {
        const readToken = process.env.ZB_VERIFIER_READ_TOKEN;
        if (!readToken) throw new Error("ZB_VERIFIER_READ_TOKEN must be set to use --verifier-url");
        externalOutbox = { url: a["verifier-url"], readToken, fetch: { policy } };
      }
    }
  } else throw new Error(`Unknown agent: ${a.agent}`);

  const evidenceSources = SourceRegistry.load();
  let worst = 0;
  try {
    for (const id of ids) {
      const scenario = loadScenario(id);
      const n = Number(a.runs ?? 1);
      const recs: RunRecord[] = [];
      for (let i = 0; i < n; i++) {
        const rec = await runScenario({ scenario, agent, runner, judge, store, ...(externalOutbox ? { externalOutbox } : {}), ...(evidenceSources ? { sources: evidenceSources } : {}) });
        recs.push(rec);
        print(rec);
        if (rec.verdict !== "PASS") worst = 1;
      }
      if (n > 1) {
        const c = { PASS: 0, FAIL: 0, ERROR: 0, INCONCLUSIVE: 0, total: recs.length };
        for (const r of recs) c[r.verdict] += 1;
        console.log(`\n${scenario.id}: observed ${formatCounts(c)} (observed outcomes, not a reliability guarantee)\n`);
      }
    }
  } finally {
    await bridge?.stop();
    await evidenceSources?.closeAll();
  }
  return worst;
}

function print(r: RunRecord) {
  if (a.json) return console.log(JSON.stringify(r, null, 2));
  const line = "─".repeat(72);
  console.log(`\n${line}\n${r.verdict}  ${r.scenarioId}  run ${r.runId}`);
  console.log(`agent: ${r.agent.label} @ ${r.agent.version} · adapter: ${r.adapter.name}/${r.adapter.version} · judge: ${r.judge.name} (advisory)`);
  console.log(`execution: ${r.executionStatus}${r.executionReason ? ` (${r.executionReason})` : ""} · outcome: ${r.outcome} · task completion: ${r.taskCompletion}`);
  if (r.faults.length) console.log(`faults configured: ${r.faults.join("; ")} · fired: ${r.faultsFired.join("; ") || "none"}`);
  console.log(`reason: ${r.reason}`);
  console.log(`\nWHAT THE AGENT SAID (claim, not proof):\n  ${r.finalMessage ?? "(no final message)"}`);
  if (r.worldSnapshot) {
    console.log(`\nWHAT ACTUALLY HAPPENED (world state, independently observed):`);
    console.log(`  cart:   ${JSON.stringify(r.worldSnapshot.cart)}`);
    console.log(`  orders: ${JSON.stringify(r.worldSnapshot.orders)}`);
    console.log(`  outbox: ${JSON.stringify(r.worldSnapshot.outbox.map((m) => ({ to: m.to, subject: m.subject })))}`);
    console.log(`  journal: ${r.journal!.filter((e) => e.kind === "tool_invocation").map((e: any) => `${e.tool}${e.ok ? "" : `✗(${e.error})`}`).join(" → ") || "(no tool calls)"}`);
  } else console.log(`\nWorld state: not observable in black-box mode (verifiers: ${r.verifiers.join(", ")})`);
  console.log(`\nCHECKS:`);
  for (const c of r.checks) {
    console.log(`  [${c.status.toUpperCase().padEnd(12)}] ${c.checkId}${c.critical ? " (critical)" : ""}${c.informational ? " (informational)" : ""}: ${c.reason}  {${c.evidenceRefs.join(", ")}} via ${c.verifier}`);
  }
  for (const n of r.notes) console.log(`  note: ${n}`);
  console.log(`\nsaved: ${new RunStore().writeDir}/${r.runId}.json`);
}

/** Lists configured evidence sources and proves read access with a real authenticated call. */
async function sources(): Promise<number> {
  const reg = SourceRegistry.load();
  if (!reg) {
    console.log("No zerobug.sources.json found (or ZB_SOURCES_FILE). See zerobug.sources.example.json.");
    return 1;
  }
  let ok = true;
  for (const name of reg.names()) {
    try {
      const s = reg.get(name);
      const h = await s.health();
      ok &&= h.ok;
      console.log(`  ${h.ok ? "VERIFIED   " : "UNAVAILABLE"} ${name.padEnd(16)} ${s.kind.padEnd(10)} provides ${s.provides.join(", ").padEnd(16)} ${h.detail}`);
    } catch (err) {
      ok = false;
      console.log(`  UNAVAILABLE ${name.padEnd(16)} ${(err as Error).message}`);
    }
  }
  await reg.closeAll();
  return ok ? 0 : 1;
}

async function connect(): Promise<number> {
  if (!a.endpoint) throw new Error("--endpoint is required");
  const policy = policyFromEnv();
  let report;
  if (a.agent === "bridge") {
    const bridge = new BridgeServer({ port: Number(process.env.ZB_BRIDGE_PORT ?? 3000) });
    await bridge.start();
    try {
      report = await connectBridge({ endpoint: a.endpoint, bridge, policy, ...(process.env.ZB_AGENT_TOKEN ? { agentToken: process.env.ZB_AGENT_TOKEN } : {}) });
    } finally {
      await bridge.stop();
    }
  } else {
    report = await connectBlackBox({
      endpoint: a.endpoint,
      policy,
      mapping: { taskField: a["task-field"]!, responseField: a["response-field"]!, ...(a["correlation-field"] ? { correlationField: a["correlation-field"] } : {}) },
      ...(a["verifier-url"] && process.env.ZB_VERIFIER_READ_TOKEN ? { externalOutbox: { url: a["verifier-url"], readToken: process.env.ZB_VERIFIER_READ_TOKEN, fetch: { policy } } } : {}),
    });
  }
  if (a.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.mode} ${report.endpoint}\nhandshake: ${report.handshake.ok ? "ok" : report.handshake.error}\nsmoke: ${report.smoke.ok ? "ok" : "FAILED"} (${report.smoke.status}, run ${report.smoke.runId}, ${report.smoke.toolCallsObserved} tool calls observed)\n`);
    for (const [k, v] of Object.entries(report.capabilities)) console.log(`  ${v.state.padEnd(11)} ${k.padEnd(26)} ${v.basis}`);
    console.log(`\nZeroBug can independently verify: ${report.canVerify.join("; ") || "nothing beyond the reply"}`);
    console.log(`ZeroBug cannot verify: ${report.cannotVerify.join("; ")}`);
  }
  return report.smoke.ok ? 0 : 1;
}

async function gate(): Promise<number> {
  if (!a.baseline || !a.candidate) throw new Error("--baseline and --candidate (agent version labels) are required");
  const runStore = new RunStore();
  const all = await runStore.list(a.dir ?? runStore.writeDir);
  const pick = (v: string) => all.filter((r) => r.agent.version === v || r.agent.id === v);
  const candidate = pick(a.candidate);
  const scenarioIds = a.scenario?.length ? a.scenario : [...new Set(candidate.map((r) => r.scenarioId))];
  const required = Object.fromEntries(scenarioIds.map((s) => [s, Number(a.runs ?? 1)]));
  const g = releaseGate({ baseline: pick(a.baseline), candidate: candidate.filter((r) => scenarioIds.includes(r.scenarioId)), required });
  if (a.json) console.log(JSON.stringify(g, null, 2));
  else {
    console.log(`\n${g.decision}\n${g.reason}\n`);
    for (const r of g.rows) {
      console.log(`  ${r.scenarioId.padEnd(22)} baseline: ${formatCounts(r.baseline).padEnd(24)} candidate: ${formatCounts(r.candidate).padEnd(24)} ${r.status}: ${r.why}`);
      for (const e of r.evidence.filter((x) => x.side === "candidate" && x.verdict !== "PASS")) console.log(`      evidence: run ${e.runId} ${e.verdict} ${e.reason}`);
    }
    for (const d of g.disclosures) console.log(`  disclosure: ${d}`);
  }
  return g.decision === "READY TO RELEASE" ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`zb: ${(err as Error).message}`);
    process.exit(2);
  });
