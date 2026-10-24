/**
 * OpenAI Agents API runner (openai@7.43.0, `client.beta.agents.sessions`).
 * Shapes are taken from the installed SDK type definitions; see docs/API-PROOF.md for what has and
 * has not been exercised against the live API.
 */
import type OpenAI from "openai";
import type { AdapterInfo, AgentRunner, Emit, RunInput, RunResult } from "../contracts/index.ts";
import { nowIso } from "../util/ids.ts";

export const AGENTS_MODEL_DEFAULT = "gpt-6-astra";

type SessionsApi = Pick<OpenAI["beta"]["agents"]["sessions"], "create" | "delete"> & {
  events: Pick<OpenAI["beta"]["agents"]["sessions"]["events"], "create">;
};
export type AgentsClient = { beta: { agents: { sessions: SessionsApi } } };

export type AgentsApiAgent = { model: string; instructions: string };

export class AgentsApiRunner implements AgentRunner {
  readonly info: AdapterInfo = { name: "agents-api", version: "openai@7.43.0", transport: "agents_api" };
  private readonly stallMs: number;

  constructor(
    private readonly client: AgentsClient,
    private readonly agent: AgentsApiAgent,
    opts: { stallMs?: number } = {},
  ) {
    this.stallMs = opts.stallMs ?? 30_000;
  }

  async run(input: RunInput, emit: Emit): Promise<RunResult> {
    const sessions = this.client.beta.agents.sessions;
    const fail = (status: RunResult["status"], reason: string, sessionId?: string): RunResult => {
      emit({ type: "error", timestamp: nowIso(), runId: input.runId, category: status, reason });
      return { status, finalMessage: null, reason, adapter: this.info, ...(sessionId ? { externalRef: sessionId } : {}) };
    };
    let sessionId: string | undefined;
    let stream: AsyncIterable<any> & { controller?: AbortController };
    try {
      stream = (await sessions.create({
        stream: true,
        environment: { type: "none" },
        agent: {
          model: this.agent.model,
          instructions: this.agent.instructions,
          tools: input.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.parameters })),
        },
        input: input.task,
        metadata: { zerobug_run_id: input.runId },
      } as any)) as any;
    } catch (err) {
      return fail("infrastructure_error", `Agents API session create failed: ${(err as Error).message}`);
    }

    const started = Date.now();
    let calls = 0;
    let lastText: string | null = null;
    const it = stream[Symbol.asyncIterator]();
    try {
      for (;;) {
        const remaining = input.limits.maxSeconds * 1000 - (Date.now() - started);
        if (remaining <= 0) {
          await this.cancel(sessionId);
          return fail("agent_limit", `Agent exceeded maxSeconds (${input.limits.maxSeconds})`, sessionId);
        }
        const next = await nextWithTimeout(it, Math.min(this.stallMs, remaining));
        if (next === "timeout") {
          await this.cancel(sessionId);
          return Date.now() - started >= input.limits.maxSeconds * 1000
            ? fail("agent_limit", `Agent exceeded maxSeconds (${input.limits.maxSeconds})`, sessionId)
            : fail("infrastructure_error", `No session events for ${this.stallMs}ms`, sessionId);
        }
        if (next.done) return fail("infrastructure_error", "Session stream ended before the turn completed", sessionId);
        const ev = next.value;
        sessionId ??= ev.session?.id ?? ev.session_id;
        switch (ev.type) {
          case "agent.session.requires_action": {
            sessionId = ev.session.id;
            for (const action of ev.session.required_actions ?? []) {
              if (action.type !== "function_call") {
                await this.cancel(sessionId);
                return fail("infrastructure_error", `Unsupported required action: ${action.type}`, sessionId);
              }
              calls += 1;
              const args = typeof action.arguments === "string" ? safeJson(action.arguments) : action.arguments;
              emit({ type: "tool_call", timestamp: nowIso(), runId: input.runId, callId: action.call_id, tool: action.name, args });
              if (calls > input.limits.maxToolCalls) {
                await this.cancel(sessionId);
                return fail("agent_limit", `Agent exceeded maxToolCalls (${input.limits.maxToolCalls})`, sessionId);
              }
              const out = await input.callTool(action.name, args, { callId: action.call_id });
              emit({
                type: "tool_result",
                timestamp: nowIso(),
                runId: input.runId,
                callId: action.call_id,
                ok: out.success,
                ...(out.success ? { result: out.output } : { error: out.error }),
              });
              await sessions.events.create(sessionId!, {
                events: [
                  out.success
                    ? { type: "agent.session.input.tool_result", turn_id: action.turn_id, call_id: action.call_id, success: true, output: JSON.stringify(out.output) }
                    : { type: "agent.session.input.tool_result", turn_id: action.turn_id, call_id: action.call_id, success: false, error: out.error },
                ],
              });
            }
            break;
          }
          case "agent.session.turn.output_text.done":
            lastText = ev.text ?? lastText;
            break;
          case "agent.session.turn.completed": {
            const finalMessage = lastText && lastText.trim() ? lastText : null;
            if (finalMessage) emit({ type: "message", timestamp: nowIso(), runId: input.runId, text: finalMessage });
            return { status: "completed", finalMessage, adapter: this.info, ...(sessionId ? { externalRef: sessionId } : {}) };
          }
          case "agent.session.turn.failed":
          case "agent.session.turn.cancelled":
          case "agent.session.failed":
          case "error":
            return fail("infrastructure_error", `Agents API reported ${ev.type}${ev.error ? `: ${JSON.stringify(ev.error)}` : ""}`, sessionId);
        }
      }
    } catch (err) {
      return fail("infrastructure_error", `Agents API stream error: ${(err as Error).message}`, sessionId);
    } finally {
      stream.controller?.abort();
      if (sessionId) await sessions.delete(sessionId).catch(() => undefined);
    }
  }

  private async cancel(sessionId: string | undefined) {
    if (!sessionId) return;
    await this.client.beta.agents.sessions.events
      .create(sessionId, { events: [{ type: "agent.session.input.cancel" } as any] })
      .catch(() => undefined);
  }
}

async function nextWithTimeout<T>(it: AsyncIterator<T>, ms: number): Promise<IteratorResult<T> | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([it.next(), new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
