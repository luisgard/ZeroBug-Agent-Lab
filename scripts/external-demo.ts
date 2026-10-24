/**
 * Spec 02 mandatory real E2E: an independently built LangGraph agent in a second process,
 * driven by ZeroBug over the HTTP bridge, verified by the unchanged Spec 01 oracle.
 *
 *   npm run demo:external            (writes data/e2e/<timestamp>/report.{json,md})
 *
 * Local development only: private/loopback addresses are approved explicitly for 127.0.0.1.
 * This is NOT a demonstration of public-endpoint network security (see docs/THREAT-MODEL.md).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BridgeServer } from "../src/bridge/server.ts";
import { type GateResult, formatCounts, releaseGate } from "../src/comparison/gate.ts";
import { type ConnectReport, connectBlackBox, connectBridge } from "../src/engine/connect.ts";
import { type RunRecord, runScenario } from "../src/engine/run-scenario.ts";
import { RunStore } from "../src/engine/store.ts";
import { HeuristicJudge } from "../src/judge/judge.ts";
import { BlackBoxHttpRunner, HttpBridgeRunner } from "../src/runner/external.ts";
import { loadScenario } from "../src/scenarios/schema.ts";
import { newToken } from "../src/util/ids.ts";
import { type Managed, startPython } from "./lib/processes.ts";

export const BRIDGE_SCENARIOS = ["external-store-order", "normal-errand", "store-outage", "poisoned-product", "dont-overstep"];

export type DemoReport = {
  startedAt: string;
  finishedAt: string;
  commandLine: string;
  ports: { zerobug: number; agent: number; staging: number };
  connect: Record<string, ConnectReport>;
  runs: { baseline: RunRecord[]; candidate: RunRecord[]; wrongItem: RunRecord[]; blackbox: RunRecord[] };
  gate: GateResult;
  exitCodes: Record<string, number | null>;
  outDir: string;
};

export async function runExternalDemo(o: { runsPerScenario?: number; outDir?: string; agentPort?: number; zerobugPort?: number; stagingPort?: number } = {}): Promise<DemoReport> {
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-");
  const outDir = o.outDir ?? join("data", "e2e", stamp);
  mkdirSync(outDir, { recursive: true });
  const ports = { zerobug: o.zerobugPort ?? 3000, agent: o.agentPort ?? 8000, staging: o.stagingPort ?? 8010 };
  const runs = o.runsPerScenario ?? 2;
  // Local dev only: explicitly approve loopback, nothing else private.
  const policy = { allowPrivate: false, allowAddresses: ["127.0.0.1"] };
  const write = newToken();
  const read = newToken();
  const store = new RunStore(join(outDir, "runs"), [join(outDir, "runs")]);
  const judge = new HeuristicJudge();
  const exitCodes: Record<string, number | null> = {};
  const connect: Record<string, ConnectReport> = {};
  const bridge = new BridgeServer({ port: ports.zerobug });
  await bridge.start();

  const startAgent = (variant: string) =>
    startPython({
      name: `agent-${variant}`,
      module: "shop_agent.server",
      args: ["--variant", variant, "--port", String(ports.agent)],
      port: ports.agent,
      healthPath: "/health",
      env: { AGENT_PLANNER: "scripted", STAGING_OUTBOX_URL: `http://127.0.0.1:${ports.staging}/staging/outbox`, STAGING_WRITE_TOKEN: write },
      logFile: join(outDir, "logs", `agent-${variant}.jsonl`),
      secrets: [write, read],
    });

  const suite = async (variant: string, scenarios: string[]): Promise<RunRecord[]> => {
    const out: RunRecord[] = [];
    for (const id of scenarios) {
      const scenario = { ...loadScenario(id), agentTransport: "http_bridge" as const };
      for (let i = 0; i < (id === "external-store-order" ? 1 : runs); i++) {
        out.push(
          await runScenario({
            scenario,
            agent: { id: `langgraph-${variant}`, label: `LangGraph shop agent (${variant})`, version: `shop-agent-1.0.0+${variant}`, endpoint: `http://127.0.0.1:${ports.agent}/agent/run` },
            runner: new HttpBridgeRunner(bridge, { endpoint: `http://127.0.0.1:${ports.agent}/agent/run`, policy }),
            judge,
            store,
            capabilities: connect[variant]!.capabilities,
          }),
        );
      }
    }
    return out;
  };

  let staging: Managed | undefined;
  let agent: Managed | undefined;
  const result = { baseline: [] as RunRecord[], candidate: [] as RunRecord[], wrongItem: [] as RunRecord[], blackbox: [] as RunRecord[] };
  try {
    staging = await startPython({
      name: "staging-outbox",
      module: "shop_agent.staging_outbox",
      args: ["--port", String(ports.staging)],
      port: ports.staging,
      healthPath: "/health",
      env: { STAGING_WRITE_TOKEN: write, STAGING_READ_TOKEN: read },
      logFile: join(outDir, "logs", "staging-outbox.jsonl"),
      secrets: [write, read],
    });
    const externalOutbox = { url: `${staging.url}/staging/outbox`, readToken: read, fetch: { policy } };
    const mapping = { taskField: "message", correlationField: "conversation_id", responseField: "reply" };

    for (const variant of ["baseline", "candidate", "wrong-item"] as const) {
      agent = await startAgent(variant);
      connect[variant] = await connectBridge({ endpoint: `${agent.url}/agent/run`, bridge, policy });
      const scenarios = variant === "wrong-item" ? ["normal-errand"] : BRIDGE_SCENARIOS;
      const recs = await suite(variant, scenarios);
      if (variant === "baseline") result.baseline = recs;
      else if (variant === "candidate") result.candidate = recs;
      else result.wrongItem = recs;
      if (variant !== "wrong-item") {
        connect[`${variant}-blackbox`] = await connectBlackBox({ endpoint: `${agent.url}/chat`, mapping, policy, externalOutbox });
        for (const withVerifier of [false, true]) {
          result.blackbox.push(
            await runScenario({
              scenario: loadScenario("blackbox-invoice"),
              agent: { id: `langgraph-${variant}-chat`, label: `LangGraph invoice chat (${variant})${withVerifier ? " + staging verifier" : " (no verifier)"}`, version: `shop-agent-1.0.0+${variant}` },
              runner: new BlackBoxHttpRunner({ endpoint: `${agent.url}/chat`, mapping, policy }),
              judge,
              store,
              capabilities: connect[`${variant}-blackbox`]!.capabilities,
              ...(withVerifier ? { externalOutbox } : {}),
            }),
          );
        }
      }
      exitCodes[`agent-${variant}`] = await agent.stop();
      agent = undefined;
    }
  } finally {
    if (agent) exitCodes[agent.name] = await agent.stop();
    if (staging) exitCodes["staging-outbox"] = await staging.stop();
    await bridge.stop();
  }

  const required = Object.fromEntries(BRIDGE_SCENARIOS.map((s) => [s, s === "external-store-order" ? 1 : runs]));
  const gate = releaseGate({ baseline: result.baseline, candidate: result.candidate, required });
  const report: DemoReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    commandLine: process.argv.join(" "),
    ports,
    connect,
    runs: result,
    gate,
    exitCodes,
    outDir,
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "report.md"), toMarkdown(report));
  return report;
}

function row(r: RunRecord): string {
  const calls = r.journal?.filter((e) => e.kind === "tool_invocation").map((e: any) => `${e.tool}${e.ok ? "" : "✗"}`).join(" → ") ?? "(not observable)";
  return `| ${r.scenarioId} | \`${r.runId.slice(0, 8)}\` | ${r.verdict} | ${r.outcome} | ${calls} | ${r.reason.replace(/\|/g, "/")} |`;
}

export function toMarkdown(rep: DemoReport): string {
  const table = (rs: RunRecord[]) => ["| Scenario | Run | Verdict | Outcome | World journal (tool calls) | Reason |", "|---|---|---|---|---|---|", ...rs.map(row)].join("\n");
  const caps = (c: ConnectReport) =>
    Object.entries(c.capabilities).map(([k, v]) => `| ${k} | ${v.state} | ${v.basis} |`).join("\n");
  return `# External agent E2E report

- Started: ${rep.startedAt} · Finished: ${rep.finishedAt}
- Command: \`${rep.commandLine}\`
- ZeroBug bridge: 127.0.0.1:${rep.ports.zerobug} · Agent: 127.0.0.1:${rep.ports.agent} · Staging outbox: 127.0.0.1:${rep.ports.staging}
- Agent: LangGraph 1.2.17, deterministic scripted planner (no model calls). Judge: heuristic-offline (advisory).
- Process exit codes: ${Object.entries(rep.exitCodes).map(([k, v]) => `${k}=${v}`).join(", ")}
- Local loopback only. Not a test of public-endpoint security.

## Capability matrix (baseline, HTTP bridge)

| Capability | State | Basis |
|---|---|---|
${caps(rep.connect.baseline!)}

## Capability matrix (baseline, black-box chat + staging verifier)

| Capability | State | Basis |
|---|---|---|
${caps(rep.connect["baseline-blackbox"]!)}

## Baseline runs
${table(rep.runs.baseline)}

## Candidate runs
${table(rep.runs.candidate)}

## Wrong-item fixture
${table(rep.runs.wrongItem)}

## Black-box runs
${["| Agent | Run | Verdict | Reason |", "|---|---|---|---|", ...rep.runs.blackbox.map((r) => `| ${r.agent.label} | \`${r.runId.slice(0, 8)}\` | ${r.verdict} | ${r.reason.replace(/\|/g, "/")} |`)].join("\n")}

## Release gate: ${rep.gate.decision}

${rep.gate.reason}

| Scenario | Baseline (observed) | Candidate (observed) | Status | Why |
|---|---|---|---|---|
${rep.gate.rows.map((r) => `| ${r.scenarioId} | ${formatCounts(r.baseline)} | ${formatCounts(r.candidate)} | ${r.status} | ${r.why.replace(/\|/g, "/")} |`).join("\n")}

Disclosures:
${rep.gate.disclosures.map((d) => `- ${d}`).join("\n")}
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runExternalDemo()
    .then((r) => {
      console.log(toMarkdown(r));
      console.log(`\nSaved: ${r.outDir}/report.json, report.md, runs/, logs/`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
