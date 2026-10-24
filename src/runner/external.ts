/**
 * Runners for agents ZeroBug does not host.
 *
 * HttpBridgeRunner (developer-instrumented): sends the task to `POST <endpoint>`; the agent calls
 *   ZeroBug's run-scoped tool URLs, so every tool effect is recorded by the world journal.
 * BlackBoxHttpRunner (minimal access): sends the task to a plain chat endpoint and records only the
 *   reply. It never claims tool visibility or fault injection.
 */
import { BRIDGE_PROTOCOL_VERSION, BridgeRunRequestSchema, BridgeRunResponseSchema, type BridgeRunRequest } from "../contracts/bridge.ts";
import type { AdapterInfo, AgentRunner, Emit, RunInput, RunResult } from "../contracts/index.ts";
import type { BridgeServer } from "../bridge/server.ts";
import { type NetPolicy, OutboundError, type Resolver, UnsafeUrlError, safeFetch } from "../net/safe-fetch.ts";
import { nowIso } from "../util/ids.ts";
import { redactText } from "../util/redact.ts";

export type ExternalOptions = {
  endpoint: string;
  /** Developer-configured credential for the agent endpoint (from a server-side secret, never the browser). */
  agentToken?: string;
  policy?: NetPolicy;
  resolve?: Resolver;
  maxResponseBytes?: number;
};

class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active += 1;
    return () => {
      this.active -= 1;
      this.queue.shift()?.();
    };
  }
}
/** Global cap on concurrent outbound agent runs. */
const outbound = new Semaphore(Number(process.env.ZB_MAX_CONCURRENT_RUNS ?? 4));

export class HttpBridgeRunner implements AgentRunner {
  readonly info: AdapterInfo = { name: "http-bridge", version: `bridge-v${BRIDGE_PROTOCOL_VERSION}`, transport: "http_bridge" };
  constructor(
    private readonly bridge: BridgeServer,
    private readonly opts: ExternalOptions,
  ) {}

  async run(input: RunInput, emit: Emit): Promise<RunResult> {
    const release = await outbound.acquire();
    const reg = this.bridge.registerRun({
      runId: input.runId,
      allowedTools: input.tools.map((t) => t.name),
      maxToolCalls: input.limits.maxToolCalls,
      callTool: input.callTool,
      emit,
      ttlMs: (input.limits.maxSeconds + 30) * 1000,
    });
    const secrets = [reg.toolsToken, this.opts.agentToken ?? ""];
    const fail = (status: RunResult["status"], reason: string): RunResult => {
      const safe = redactText(reason, secrets);
      emit({ type: "error", timestamp: nowIso(), runId: input.runId, category: status, reason: safe });
      return { status, finalMessage: null, reason: safe, adapter: this.info };
    };
    try {
      const request: BridgeRunRequest = BridgeRunRequestSchema.parse({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        runId: input.runId,
        task: input.task,
        toolsUrl: reg.toolsUrl,
        toolsToken: reg.toolsToken,
        tools: input.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
        limits: input.limits,
      });
      const body = JSON.stringify(request);
      let res;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await safeFetch(this.opts.endpoint, {
            method: "POST",
            body,
            headers: this.opts.agentToken ? { authorization: `Bearer ${this.opts.agentToken}` } : {},
            timeoutMs: input.limits.maxSeconds * 1000,
            maxRedirects: 0,
            maxResponseBytes: this.opts.maxResponseBytes ?? 256 * 1024,
            ...(this.opts.policy ? { policy: this.opts.policy } : {}),
            ...(this.opts.resolve ? { resolve: this.opts.resolve } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          });
          break;
        } catch (err) {
          // Reconcile before retrying: retry only if the request provably never reached the agent
          // (connection refused) AND the world saw no tool call for this run. Never blind-retry a
          // request that may have caused side effects.
          const neverSent = err instanceof OutboundError && err.kind === "connect" && /ECONNREFUSED/.test(err.message);
          if (attempt === 0 && neverSent && this.bridge.runStats(input.runId).calls === 0) {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          throw err;
        }
      }
      const stats = this.bridge.runStats(input.runId);
      if (stats.limitExceeded) return fail("agent_limit", `Agent exceeded maxToolCalls (${input.limits.maxToolCalls})`);
      if (res.status < 200 || res.status >= 300) return fail("infrastructure_error", `Agent endpoint answered HTTP ${res.status}`);
      let parsed;
      try {
        parsed = BridgeRunResponseSchema.parse(JSON.parse(res.text));
      } catch (err) {
        return fail("infrastructure_error", `Bridge protocol violation in agent response: ${(err as Error).message.slice(0, 300)}`);
      }
      if (parsed.runId !== input.runId) return fail("infrastructure_error", "Bridge protocol violation: runId mismatch");
      if (parsed.finalMessage) emit({ type: "message", timestamp: nowIso(), runId: input.runId, text: parsed.finalMessage });
      return { status: "completed", finalMessage: parsed.finalMessage?.trim() ? parsed.finalMessage : null, adapter: this.info };
    } catch (err) {
      if (err instanceof UnsafeUrlError) return fail("infrastructure_error", `Endpoint rejected: ${err.message}`);
      if (err instanceof OutboundError && err.kind === "timeout") {
        return fail("agent_limit", `Agent exceeded maxSeconds (${input.limits.maxSeconds}); not retried (possible side effects reconciled from the world journal)`);
      }
      return fail("infrastructure_error", `Agent endpoint unreachable: ${(err as Error).message}`);
    } finally {
      this.bridge.endRun(input.runId); // revoke the tools token: replay after termination is denied
      release();
    }
  }
}

// ---------------------------------------------------------------- black box

const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,4}$/;

export type BlackBoxMapping = {
  /** Request body field that receives the task text, e.g. "message". */
  taskField: string;
  /** Optional request field that receives the run id, so an external verifier can correlate effects. */
  correlationField?: string;
  /** Dotted path of the reply text in the response JSON, e.g. "reply" or "data.text". */
  responseField: string;
};

export class BlackBoxHttpRunner implements AgentRunner {
  readonly info: AdapterInfo = { name: "blackbox-http", version: "1", transport: "blackbox_http" };

  constructor(private readonly opts: ExternalOptions & { mapping: BlackBoxMapping; timeoutSeconds?: number }) {
    for (const p of [opts.mapping.taskField, opts.mapping.responseField, opts.mapping.correlationField].filter(Boolean)) {
      if (!FIELD_PATH.test(p!)) throw new Error(`Invalid mapping path: ${p}`);
    }
  }

  async run(input: RunInput, emit: Emit): Promise<RunResult> {
    const release = await outbound.acquire();
    const fail = (status: RunResult["status"], reason: string): RunResult => {
      const safe = redactText(reason, [this.opts.agentToken ?? ""]);
      emit({ type: "error", timestamp: nowIso(), runId: input.runId, category: status, reason: safe });
      return { status, finalMessage: null, reason: safe, adapter: this.info };
    };
    try {
      const body: Record<string, unknown> = {};
      setPath(body, this.opts.mapping.taskField, input.task);
      if (this.opts.mapping.correlationField) setPath(body, this.opts.mapping.correlationField, input.runId);
      // No automatic retry: a black-box agent may have acted before the failure and ZeroBug cannot see it.
      const res = await safeFetch(this.opts.endpoint, {
        method: "POST",
        body: JSON.stringify(body),
        headers: this.opts.agentToken ? { authorization: `Bearer ${this.opts.agentToken}` } : {},
        timeoutMs: (this.opts.timeoutSeconds ?? input.limits.maxSeconds) * 1000,
        maxRedirects: 2,
        maxResponseBytes: this.opts.maxResponseBytes ?? 256 * 1024,
        ...(this.opts.policy ? { policy: this.opts.policy } : {}),
        ...(this.opts.resolve ? { resolve: this.opts.resolve } : {}),
      });
      if (res.status < 200 || res.status >= 300) return fail("infrastructure_error", `Agent endpoint answered HTTP ${res.status}`);
      let json: unknown;
      try {
        json = JSON.parse(res.text);
      } catch {
        return fail("infrastructure_error", "Agent response is not JSON");
      }
      const reply = getPath(json, this.opts.mapping.responseField);
      if (reply !== null && typeof reply !== "string") return fail("infrastructure_error", `Response field ${this.opts.mapping.responseField} is not text`);
      const finalMessage = reply && reply.trim() ? reply.slice(0, 20_000) : null;
      if (finalMessage) emit({ type: "message", timestamp: nowIso(), runId: input.runId, text: finalMessage });
      return { status: "completed", finalMessage, adapter: this.info };
    } catch (err) {
      if (err instanceof UnsafeUrlError) return fail("infrastructure_error", `Endpoint rejected: ${err.message}`);
      if (err instanceof OutboundError && err.kind === "timeout") return fail("agent_limit", `Agent did not answer within the time limit`);
      return fail("infrastructure_error", `Agent endpoint unreachable: ${(err as Error).message}`);
    } finally {
      release();
    }
  }
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
  cur[parts.at(-1)!] = value;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const p of path.split(".")) {
    if (!cur || typeof cur !== "object" || !Object.hasOwn(cur, p)) return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur ?? null;
}
