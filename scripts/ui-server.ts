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
import { SourceRegistry } from "../src/connectors/registry.ts";
import { BrowserChatRunner } from "../src/runner/browser.ts";
import { ChatCompletionsRunner } from "../src/runner/chat-completions.ts";
import { McpAgentRunner } from "../src/runner/mcp-agent.ts";
import { ConnectionError, ConnectionService } from "../src/connections/service.ts";
import { SecretBox } from "../src/connections/secret-box.ts";
import { buildPlan, planAccess, toScenario } from "../src/planning/plan.ts";
import { AgentsApiPlanner } from "../src/planning/agents-planner.ts";
import { type AvailableSource, type NeedKind, type Plan, PlanRequestSchema } from "../src/planning/types.ts";

loadLocalEnv();
// The UI is a local tool: unless this is a public deployment, testing agents on this computer (localhost)
// is allowed by default. Cloud metadata addresses stay blocked either way.
if (process.env.ZB_DEPLOYMENT !== "public" && process.env.ZB_ALLOW_PRIVATE_AGENT_URLS === undefined) process.env.ZB_ALLOW_PRIVATE_AGENT_URLS = "1";

const PORT = Number(process.env.ZB_UI_PORT ?? 3001);
const store = new RunStore();
const bridge = new BridgeServer({ port: Number(process.env.ZB_BRIDGE_PORT ?? 3000) });
const live = new Map<string, { events: RunEvent[]; record: RunRecord | null; error: string | null }>();
const hasKey = Boolean(process.env.OPENAI_API_KEY);
const evidenceSources = SourceRegistry.load();
const connections = new ConnectionService(SecretBox.fromEnvOrFile(), { policy: () => policyFromEnv(), ...(process.env.ZB_CONNECTIONS_FILE ? { file: process.env.ZB_CONNECTIONS_FILE } : {}) });
const PUBLIC_URL = process.env.ZB_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;
const GOOGLE_REDIRECT = `${PUBLIC_URL}/api/oauth/google/callback`;
const plans = new Map<string, Plan>();
/** What the access planner may use: real connections (with their tested state) + operator sources. */
function availableSources(): AvailableSource[] {
  const fromConnections = connections.list().map((c) => ({
    name: c.slug,
    provides: c.provides as NeedKind[],
    verified: c.status.state === "VERIFIED",
    ...(typeof c.config.account === "string" ? { account: c.config.account } : {}),
    origin: "connection" as const,
  }));
  const fromFile = (evidenceSources?.names() ?? []).flatMap((n) => {
    try {
      return [{ name: n, provides: evidenceSources!.get(n).provides as NeedKind[], verified: false, origin: "file" as const }];
    } catch {
      return [];
    }
  });
  return [...fromConnections, ...fromFile];
}
/** Evidence sources for a run: operator file + connections added in the UI. */
const runSources = () => (evidenceSources ?? SourceRegistry.empty()).withExtra(connections.sources());
const judge = process.env.ZB_JUDGE === "decisions" && hasKey ? new DecisionsJudge(new OpenAI()) : new HeuristicJudge();

const Mapping = z.strictObject({ taskField: z.string(), responseField: z.string(), correlationField: z.string().optional() });
// Agent credentials typed in the UI: kept in server memory for the runs only, never written to run files.
const Headers = z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "Invalid header name"), z.string().max(4000)).refine((h) => Object.keys(h).length <= 5, "At most 5 headers");
const ExtraBody = z.record(z.string().max(64), z.unknown()).refine((b) => JSON.stringify(b).length <= 4000, "Extra body is too large");
const AgentSpec = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("sample"), id: z.enum(Object.keys(SAMPLE_AGENTS) as [SampleAgentId, ...SampleAgentId[]]) }),
  z.strictObject({ kind: z.literal("agents_api"), instructions: z.string().trim().min(1, "Instructions are empty"), model: z.string().optional(), label: z.string().max(80).optional() }),
  z.strictObject({ kind: z.literal("http_bridge"), endpoint: z.string().url(), label: z.string().max(80).optional(), version: z.string().max(80).optional() }),
  z.strictObject({ kind: z.literal("browser_chat"), url: z.string().url(), inputSelector: z.string().min(1).max(200).optional(), sendSelector: z.string().max(200).optional(), replySelector: z.string().min(1).max(200).optional(), label: z.string().max(80).optional(), version: z.string().max(80).optional() }),
  z.strictObject({ kind: z.literal("blackbox_http"), endpoint: z.string().url(), mapping: Mapping, headers: Headers.optional(), extraBody: ExtraBody.optional(), verifierUrl: z.string().url().optional(), label: z.string().max(80).optional(), version: z.string().max(80).optional() }),
  z.strictObject({ kind: z.literal("mcp_agent"), url: z.string().url(), headers: Headers.optional(), tool: z.string().max(128).optional(), argument: z.string().max(128).optional(), label: z.string().max(80).optional(), version: z.string().max(80).optional() }),
  z.strictObject({ kind: z.literal("chat_completions"), baseUrl: z.string().url(), model: z.string().trim().min(1, "Model is empty").max(200), apiKey: z.string().max(4000).optional(), label: z.string().max(80).optional(), version: z.string().max(80).optional() }),
]);
const PlanRun = z.strictObject({
  planId: z.string().min(8).max(40),
  agent: AgentSpec,
  items: z
    .array(
      z.strictObject({
        scenarioId: z.string(),
        task: z.string().max(2000).optional(),
        repeats: z.number().int().min(1).max(100).default(1),
        approved: z.boolean().default(false),
        checks: z.record(z.string().max(64), z.record(z.string().max(32), z.union([z.string().max(300), z.number(), z.null()]))).optional(),
      }),
    )
    .min(1, "Select at least one test")
    .max(20),
});

const StartRuns = z.strictObject({ agent: AgentSpec, scenarioIds: z.array(z.string()).min(1, "Select at least one scenario"), repeats: z.number().int().min(1).max(10).default(1) });
const Connect = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("http_bridge"), endpoint: z.string().url() }),
  z.strictObject({ kind: z.literal("browser_chat"), url: z.string().url(), inputSelector: z.string().max(200).optional(), sendSelector: z.string().max(200).optional(), replySelector: z.string().max(200).optional() }),
  z.strictObject({ kind: z.literal("blackbox_http"), endpoint: z.string().url(), mapping: Mapping, headers: Headers.optional(), extraBody: ExtraBody.optional(), verifierUrl: z.string().url().optional() }),
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
    case "browser_chat":
      return {
        runner: new BrowserChatRunner({ url: spec.url, ...(spec.inputSelector ? { inputSelector: spec.inputSelector } : {}), ...(spec.replySelector ? { replySelector: spec.replySelector } : {}), ...(spec.sendSelector ? { sendSelector: spec.sendSelector } : {}), policy }),
        agent: { id: "browser-chat", label: spec.label ?? `Browser chat ${spec.url}`, version: spec.version ?? "unversioned", endpoint: spec.url },
      };
    case "blackbox_http": {
      const readToken = process.env.ZB_VERIFIER_READ_TOKEN;
      if (spec.verifierUrl && !readToken) throw new HttpError(400, "Verifier URL given but ZB_VERIFIER_READ_TOKEN is not configured on the server.");
      return {
        runner: new BlackBoxHttpRunner({ endpoint: spec.endpoint, mapping: spec.mapping, policy, ...(spec.headers ? { headers: spec.headers } : {}), ...(spec.extraBody ? { extraBody: spec.extraBody } : {}) }),
        agent: { id: "blackbox", label: spec.label ?? `Black-box ${spec.endpoint}`, version: spec.version ?? "unversioned", endpoint: spec.endpoint },
        ...(spec.verifierUrl ? { externalOutbox: { url: spec.verifierUrl, readToken, fetch: { policy } } } : {}),
      };
    }
    case "mcp_agent":
      return {
        runner: new McpAgentRunner({ url: spec.url, policy, ...(spec.headers ? { headers: spec.headers } : {}), ...(spec.tool ? { tool: spec.tool } : {}), ...(spec.argument ? { argument: spec.argument } : {}) }),
        agent: { id: "mcp-agent", label: spec.label ?? `MCP ${spec.url}`, version: spec.version ?? "unversioned", endpoint: spec.url },
      };
    case "chat_completions":
      return {
        runner: new ChatCompletionsRunner({ baseUrl: spec.baseUrl, model: spec.model, policy, ...(spec.apiKey ? { apiKey: spec.apiKey } : {}) }),
        agent: { id: "chat-completions", label: spec.label ?? `${spec.model} @ ${spec.baseUrl}`, version: spec.version ?? spec.model, endpoint: spec.baseUrl },
      };
  }
}

const SMOKE_TASK = "Hola, esto es una prueba de conexión de ZeroBug. Responde con un saludo corto y no hagas ninguna acción. / Hi, this is a ZeroBug connection test. Reply with a short greeting and take no action.";
/** Connection check for the simple UI: one harmless message through the same runner the tests use. */
async function smokeAgent(spec: z.infer<typeof AgentSpec>) {
  const { runner } = build(spec);
  const runId = newRunId();
  const extra = runner instanceof McpAgentRunner ? await runner.describe().catch((err) => ({ error: (err as Error).message })) : undefined;
  const r = await runner.run({ runId, task: SMOKE_TASK, tools: [], callTool: async () => ({ success: false, error: "no tools" }), limits: { maxToolCalls: 1, maxSeconds: 60 } }, () => {});
  return {
    mode: spec.kind,
    smoke: { ok: r.status === "completed" && !!r.finalMessage, runId, finalMessage: r.finalMessage, status: r.status, toolCallsObserved: 0, ...(r.reason ? { reason: r.reason } : {}) },
    ...(extra ? { mcp: extra } : {}),
  };
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
      evidenceSources: runSources().names(),
    };
  }
  if (method === "GET" && path === "/api/scenarios") return loadScenarios().scenarios;
  if (method === "GET" && path === "/api/connections/catalog") return { ...connections.catalog(), redirectUri: GOOGLE_REDIRECT };
  if (method === "GET" && path === "/api/connections") {
    const fileSources = evidenceSources?.names() ?? [];
    return { connections: connections.list(), fileSources };
  }
  if (method === "POST" && path === "/api/connections") return connections.create(body);
  const connMatch = /^\/api\/connections\/([A-Za-z0-9_-]{6,40})(\/test)?$/.exec(path);
  if (connMatch && method === "POST" && connMatch[2]) return connections.test(connMatch[1]!);
  if (connMatch && method === "DELETE" && !connMatch[2]) return connections.remove(connMatch[1]!);
  if (method === "POST" && path === "/api/agent/check") return smokeAgent(parse(AgentSpec, body));
  if (method === "POST" && path === "/api/connect") {
    const c = parse(Connect, body);
    const policy = policyFromEnv();
    if (c.kind === "http_bridge") return connectBridge({ endpoint: c.endpoint, bridge, policy });
    if (c.kind === "browser_chat") {
      const runner = new BrowserChatRunner({ url: c.url, policy, ...(c.inputSelector ? { inputSelector: c.inputSelector } : {}), ...(c.sendSelector ? { sendSelector: c.sendSelector } : {}), ...(c.replySelector ? { replySelector: c.replySelector } : {}) });
      const runId = newRunId();
      const r = await runner.run(
        { runId, task: "Hola, esto es una prueba de conexión de ZeroBug. Responde con un saludo corto. / Hi, this is a ZeroBug connection test. Reply with a short greeting.", tools: [], callTool: async () => ({ success: false, error: "no tools" }), limits: { maxToolCalls: 1, maxSeconds: 45 } },
        () => {},
      );
      return { mode: "browser_chat", endpoint: c.url, smoke: { ok: r.status === "completed" && !!r.finalMessage, runId, finalMessage: r.finalMessage, status: r.status, toolCallsObserved: 0, ...(r.reason ? { reason: r.reason } : {}) } };
    }
    const readToken = process.env.ZB_VERIFIER_READ_TOKEN;
    return connectBlackBox({ endpoint: c.endpoint, mapping: c.mapping, policy, ...(c.headers ? { headers: c.headers } : {}), ...(c.extraBody ? { extraBody: c.extraBody } : {}), ...(c.verifierUrl && readToken ? { externalOutbox: { url: c.verifierUrl, readToken, fetch: { policy } } } : {}) });
  }
  if (method === "POST" && path === "/api/plan") {
    const req = parse(PlanRequestSchema, body);
    const model = hasKey && process.env.ZB_PLANNER !== "rules" ? new AgentsApiPlanner(new OpenAI() as any, process.env.ZB_AGENTS_MODEL ?? AGENTS_MODEL_DEFAULT) : undefined;
    const plan = await buildPlan(req, availableSources(), model);
    plans.set(plan.planId, plan);
    if (plans.size > 200) plans.delete(plans.keys().next().value!);
    return plan;
  }
  if (method === "POST" && path === "/api/plan/run") {
    const reqRun = parse(PlanRun, body);
    const plan = plans.get(reqRun.planId);
    if (!plan) throw new HttpError(404, "Plan not found or expired; propose the tests again.");
    const total = reqRun.items.reduce((n, i) => n + i.repeats, 0);
    if (total > 500) throw new HttpError(400, `Too many runs at once (${total}); the limit is 500.`);
    const sourcesNow = availableSources();
    const compiled = reqRun.items.map((item) => {
      const p = plan.scenarios.find((x) => x.id === item.scenarioId);
      if (!p) throw new HttpError(400, `Unknown test: ${item.scenarioId}`);
      const fresh = planAccess(p, sourcesNow); // re-check access at run time, never trust the earlier answer
      if (fresh.readiness !== "READY") throw new HttpError(400, `"${p.title}" is not ready: ${fresh.readinessReason}`);
      if (p.approvalRequired && !item.approved) throw new HttpError(400, `"${p.title}" has real-world effects and needs your explicit approval.`);
      try {
        return { scenario: toScenario(fresh, { ...(item.task ? { task: item.task } : {}), ...(item.checks ? { checks: item.checks } : {}) }), repeats: item.repeats };
      } catch (err) {
        throw new HttpError(400, `"${p.title}": ${(err as Error).message}`);
      }
    });
    const { runner, agent, externalOutbox } = build(reqRun.agent);
    const sources = runSources();
    const runIds: string[] = [];
    const jobs: (() => Promise<void>)[] = [];
    for (const { scenario, repeats } of compiled) {
      for (let i = 0; i < repeats; i++) {
        const runId = newRunId();
        runIds.push(runId);
        const entry = { events: [] as RunEvent[], record: null as RunRecord | null, error: null as string | null };
        live.set(runId, entry);
        jobs.push(async () => {
          try {
            entry.record = await runScenario({ scenario, agent, runner, judge, store, runId, sources, ...(externalOutbox ? { externalOutbox } : {}), onEvent: (e) => entry.events.push(e) });
          } catch (err) {
            entry.error = (err as Error).message;
          }
        });
      }
    }
    // Runs are independent (each has its own reference), so a few go at once; waiting checks
    // (e.g. "no duplicate arrives in 90 s") would otherwise add up run after run.
    const parallel = Math.max(1, Math.min(10, Number(process.env.ZB_PARALLEL_RUNS ?? 5) || 5));
    void (async () => {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
        while (next < jobs.length) await jobs[next++]!();
      }));
      await sources.closeAll();
    })();
    return { runIds, planner: plan.planner };
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
    const sources = runSources();
    for (const scenario of scenarios) {
      for (let i = 0; i < req.repeats; i++) {
        const runId = newRunId();
        runIds.push(runId);
        const entry = { events: [] as RunEvent[], record: null as RunRecord | null, error: null as string | null };
        live.set(runId, entry);
        jobs.push(async () => {
          try {
            entry.record = await runScenario({ scenario, agent, runner, judge, store, runId, ...(externalOutbox ? { externalOutbox } : {}), sources, onEvent: (e) => entry.events.push(e) });
          } catch (err) {
            entry.error = (err as Error).message;
          }
        });
      }
    }
    void (async () => {
      for (const j of jobs) await j(); // sequential: predictable load on external agents
      await sources.closeAll();
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
const advancedUrl = new URL("../ui/advanced.html", import.meta.url);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://ui.local");
  const json = (status: number, b: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(b));
  };
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/connections" || url.pathname === "/design" || url.pathname.startsWith("/run/"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'" });
      return res.end(readFileSync(pageUrl, "utf8"));
    }
    if (req.method === "GET" && url.pathname === "/advanced") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'" });
      return res.end(readFileSync(advancedUrl, "utf8"));
    }
    if (req.method === "GET" && url.pathname === "/api/oauth/google/start") {
      try {
        res.writeHead(302, { location: connections.googleAuthUrl(GOOGLE_REDIRECT), "cache-control": "no-store" });
      } catch (err) {
        res.writeHead(302, { location: `/connections?error=${encodeURIComponent((err as Error).message)}` });
      }
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/api/oauth/google/callback") {
      try {
        const c = await connections.googleCallback(
          { code: url.searchParams.get("code"), state: url.searchParams.get("state"), error: url.searchParams.get("error") },
          GOOGLE_REDIRECT,
        );
        res.writeHead(302, { location: `/connections?connected=${encodeURIComponent(c.slug)}` });
      } catch (err) {
        res.writeHead(302, { location: `/connections?error=${encodeURIComponent((err as Error).message)}` });
      }
      return res.end();
    }
    if (!url.pathname.startsWith("/api/")) return json(404, { error: "Not found" });
    let body: unknown = undefined;
    if (req.method === "POST" || req.method === "DELETE") {
      // CSRF guard for a localhost app: JSON only, and same-origin when the browser says where it came from.
      const origin = req.headers.origin;
      const allowed = [PUBLIC_URL, `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json") || (origin && !allowed.includes(origin))) {
        return json(403, { error: "Cross-site or non-JSON request refused" });
      }
    }
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
    if (err instanceof ConnectionError) return json(400, { error: err.message });
    console.error(err);
    json(500, { error: "Internal error. The run state is preserved; check the server log." });
  }
});

await bridge.start();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`ZeroBug UI: http://127.0.0.1:${PORT}  (bridge tool host: ${bridge.url})`);
  console.log(`Agents API: ${hasKey ? "available" : "BLOCKED (no OPENAI_API_KEY)"} · judge: ${judge.info.name}`);
});
