/**
 * Minimal local UI + JSON API over the same engine (no second engine, no fake controls).
 *   npm run ui      -> http://127.0.0.1:3001  (bridge tool host on :3000)
 *
 * Long-lived Node process: live run state stays in memory; finished runs are saved by RunStore and
 * can be reopened after a restart. Binds to 127.0.0.1 only.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import OpenAI from "openai";
import { z } from "zod";
import { SAMPLE_AGENTS, type SampleAgentId } from "../src/agents/samples.ts";
import { BridgeServer } from "../src/bridge/server.ts";
import { releaseGate } from "../src/comparison/gate.ts";
import type { AgentRunner, RunEvent } from "../src/contracts/index.ts";
import { connectBlackBox, connectBridge } from "../src/engine/connect.ts";
import { type AgentDescriptor, type RunRecord, runScenario } from "../src/engine/run-scenario.ts";
import { RunStore } from "../src/engine/store.ts";
import { DecisionsJudge, HeuristicJudge } from "../src/judge/judge.ts";
import { policyFromEnv } from "../src/net/safe-fetch.ts";
import { AGENTS_MODEL_DEFAULT, AgentsApiRunner } from "../src/runner/agents-api.ts";
import { BlackBoxHttpRunner, HttpBridgeRunner } from "../src/runner/external.ts";
import { ScriptedRunner } from "../src/runner/scripted.ts";
import { loadScenario, loadScenarios } from "../src/scenarios/schema.ts";
import { fingerprint, newRunId } from "../src/util/ids.ts";
import { loadLocalEnv } from "../src/util/env.ts";

loadLocalEnv();

const PORT = Number(process.env.ZB_UI_PORT ?? 3001);
const store = new RunStore();
const bridge = new BridgeServer({ port: Number(process.env.ZB_BRIDGE_PORT ?? 3000) });
const live = new Map<string, { events: RunEvent[]; record: RunRecord | null; error: string | null }>();
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const judge = process.env.ZB_JUDGE === "decisions" && hasKey ? new DecisionsJudge(new OpenAI()) : new HeuristicJudge();

const Mapping = z.strictObject({ taskField: z.string(), responseField: z.string(), correlationField: z.string().optional() });
const AgentSpec = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("sample"), id: z.enum(Object.keys(SAMPLE_AGENTS) as [SampleAgentId, ...SampleAgentId[]]) }),
  z.strictObject({ kind: z.literal("agents_api"), instructions: z.string().trim().min(1, "Instructions are empty"), model: z.string().optional(), label: z.string().max(80).optional() }),
  z.strictObject({ kind: z.literal("http_bridge"), endpoint: z.string().url(), label: z.string().max(80).optional(), version: z.string().max(80).optional() }),
  z.strictObject({ kind: z.literal("blackbox_http"), endpoint: z.string().url(), mapping: Mapping, verifierUrl: z.string().url().optional(), label: z.string().max(80).optional(), version: z.string().max(80).optional() }),
]);
const StartRuns = z.strictObject({ agent: AgentSpec, scenarioIds: z.array(z.string()).min(1, "Select at least one scenario"), repeats: z.number().int().min(1).max(10).default(1) });
const Connect = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("http_bridge"), endpoint: z.string().url() }),
  z.strictObject({ kind: z.literal("blackbox_http"), endpoint: z.string().url(), mapping: Mapping, verifierUrl: z.string().url().optional() }),
]);

function build(spec: z.infer<typeof AgentSpec>): { runner: AgentRunner; agent: AgentDescriptor; externalOutbox?: any } {
  const policy = policyFromEnv();
  switch (spec.kind) {
    case "sample": {
      const s = SAMPLE_AGENTS[spec.id];
      return { runner: new ScriptedRunner(s.policy, spec.id), agent: { id: spec.id, label: s.label, version: s.version } };
    }
    case "agents_api": {
      if (!hasKey) throw new HttpError(400, "Agents API is BLOCKED: OPENAI_API_KEY is not configured on the server.");
      const model = spec.model ?? AGENTS_MODEL_DEFAULT;
      return {
        runner: new AgentsApiRunner(new OpenAI(), { model, instructions: spec.instructions }),
        agent: { id: "agents-api", label: spec.label ?? `Agents API (${model})`, version: `prompt-${fingerprint({ model, i: spec.instructions })}` },
      };
    }
    case "http_bridge":
      return {
        runner: new HttpBridgeRunner(bridge, { endpoint: spec.endpoint, policy, ...(process.env.ZB_AGENT_TOKEN ? { agentToken: process.env.ZB_AGENT_TOKEN } : {}) }),
        agent: { id: "http-bridge", label: spec.label ?? `Bridge ${spec.endpoint}`, version: spec.version ?? "unversioned", endpoint: spec.endpoint },
      };
    case "blackbox_http": {
      const readToken = process.env.ZB_VERIFIER_READ_TOKEN;
      if (spec.verifierUrl && !readToken) throw new HttpError(400, "Verifier URL given but ZB_VERIFIER_READ_TOKEN is not configured on the server.");
      return {
        runner: new BlackBoxHttpRunner({ endpoint: spec.endpoint, mapping: spec.mapping, policy }),
        agent: { id: "blackbox", label: spec.label ?? `Black-box ${spec.endpoint}`, version: spec.version ?? "unversioned", endpoint: spec.endpoint },
        ...(spec.verifierUrl ? { externalOutbox: { url: spec.verifierUrl, readToken, fetch: { policy } } } : {}),
      };
    }
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function api(method: string, path: string, body: unknown): Promise<unknown> {
  if (method === "GET" && path === "/api/meta") {
    return {
      agentsApi: hasKey ? "available" : "BLOCKED (no OPENAI_API_KEY on server)",
      judge: judge.info,
      samples: Object.entries(SAMPLE_AGENTS).map(([id, s]) => ({ id, label: s.label })),
      privateUrlsAllowed: policyFromEnv().allowPrivate,
    };
  }
  if (method === "GET" && path === "/api/scenarios") return loadScenarios().scenarios;
  if (method === "POST" && path === "/api/connect") {
    const c = parse(Connect, body);
    const policy = policyFromEnv();
    if (c.kind === "http_bridge") return connectBridge({ endpoint: c.endpoint, bridge, policy });
    const readToken = process.env.ZB_VERIFIER_READ_TOKEN;
    return connectBlackBox({ endpoint: c.endpoint, mapping: c.mapping, policy, ...(c.verifierUrl && readToken ? { externalOutbox: { url: c.verifierUrl, readToken, fetch: { policy } } } : {}) });
  }
  if (method === "POST" && path === "/api/runs") {
    const req = parse(StartRuns, body);
    const { runner, agent, externalOutbox } = build(req.agent);
    const scenarios = req.scenarioIds.map((id) => {
      try {
        return loadScenario(id);
      } catch {
        throw new HttpError(400, `Unknown scenario: ${id}`);
      }
    });
    const runIds: string[] = [];
    const jobs: (() => Promise<void>)[] = [];
    for (const scenario of scenarios) {
      for (let i = 0; i < req.repeats; i++) {
        const runId = newRunId();
        runIds.push(runId);
        const entry = { events: [] as RunEvent[], record: null as RunRecord | null, error: null as string | null };
        live.set(runId, entry);
        jobs.push(async () => {
          try {
            entry.record = await runScenario({ scenario, agent, runner, judge, store, runId, ...(externalOutbox ? { externalOutbox } : {}), onEvent: (e) => entry.events.push(e) });
          } catch (err) {
            entry.error = (err as Error).message;
          }
        });
      }
    }
    void (async () => {
      for (const j of jobs) await j(); // sequential: predictable load on external agents
    })();
    return { runIds };
  }
  const runMatch = /^\/api\/runs\/([0-9a-f-]{36})$/.exec(path);
  if (method === "GET" && runMatch) {
    const entry = live.get(runMatch[1]!);
    if (entry) return { status: entry.record || entry.error ? "done" : "running", events: entry.events, record: entry.record, error: entry.error };
    const rec = await store.get(runMatch[1]!);
    if (!rec) throw new HttpError(404, "Run not found");
    return { status: "done", events: rec.events, record: rec, error: null, replayed: true };
  }
  if (method === "GET" && path === "/api/runs") {
    const recs = await store.list();
    return recs
      .sort((x, y) => (x.startedAt < y.startedAt ? 1 : -1))
      .slice(0, 200)
      .map((r) => ({ runId: r.runId, scenarioId: r.scenarioId, verdict: r.verdict, reason: r.reason, agent: r.agent, startedAt: r.startedAt, adapter: r.adapter.name }));
  }
  if (method === "POST" && path === "/api/gate") {
    const g = parse(z.strictObject({ baseline: z.string().min(1), candidate: z.string().min(1), runsPerScenario: z.number().int().min(1).default(1) }), body);
    const all = await store.list();
    const pick = (v: string) => all.filter((r) => r.agent.version === v);
    const cand = pick(g.candidate);
    const required = Object.fromEntries([...new Set(cand.map((r) => r.scenarioId))].map((s) => [s, g.runsPerScenario]));
    return releaseGate({ baseline: pick(g.baseline), candidate: cand, required });
  }
  throw new HttpError(404, "Not found");
}

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "));
  return r.data;
}

const pageUrl = new URL("../ui/index.html", import.meta.url);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://ui.local");
  const json = (status: number, b: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(b));
  };
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/run/"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'" });
      return res.end(readFileSync(pageUrl, "utf8"));
    }
    if (!url.pathname.startsWith("/api/")) return json(404, { error: "Not found" });
    let body: unknown = undefined;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 64 * 1024) return json(413, { error: "Request too large" });
        chunks.push(c as Buffer);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {
        return json(400, { error: "Body must be JSON" });
      }
    }
    json(200, await api(req.method ?? "GET", url.pathname, body));
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.error(err);
    json(500, { error: "Internal error. The run state is preserved; check the server log." });
  }
});

await bridge.start();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`ZeroBug UI: http://127.0.0.1:${PORT}  (bridge tool host: ${bridge.url})`);
  console.log(`Agents API: ${hasKey ? "available" : "BLOCKED (no OPENAI_API_KEY)"} · judge: ${judge.info.name}`);
});
