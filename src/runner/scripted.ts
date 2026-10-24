/**
 * Deterministic in-process runner for offline tests and the CLI. A policy is plain code that decides
 * the next tool call from real tool results; it goes through the same world tools as any agent.
 */
import type { AdapterInfo, AgentRunner, Emit, RunInput, RunResult, ToolOutcome } from "../contracts/index.ts";
import { nowIso } from "../util/ids.ts";

export type PolicyApi = { task: string; call(name: string, args: unknown): Promise<ToolOutcome> };
export type Policy = (api: PolicyApi) => Promise<string | null>;
export type ScriptStep = { call: string; args: unknown } | { say: string } | { infraError: string } | { waitMs: number };

class InfraError extends Error {}
class LimitError extends Error {}

export function scriptToPolicy(steps: ScriptStep[]): Policy {
  return async (api) => {
    let said: string | null = null;
    for (const s of steps) {
      if ("call" in s) await api.call(s.call, s.args);
      else if ("say" in s) said = s.say;
      else if ("waitMs" in s) await new Promise((r) => setTimeout(r, s.waitMs));
      else throw new InfraError(s.infraError);
    }
    return said;
  };
}

export class ScriptedRunner implements AgentRunner {
  readonly info: AdapterInfo;
  private readonly policy: Policy;

  constructor(policy: Policy | ScriptStep[], name = "scripted") {
    this.policy = Array.isArray(policy) ? scriptToPolicy(policy) : policy;
    this.info = { name, version: "1", transport: "scripted" };
  }

  async run(input: RunInput, emit: Emit): Promise<RunResult> {
    let calls = 0;
    const api: PolicyApi = {
      task: input.task,
      call: async (tool, args) => {
        calls += 1;
        const callId = `call-${calls}`;
        emit({ type: "tool_call", timestamp: nowIso(), runId: input.runId, callId, tool, args });
        if (calls > input.limits.maxToolCalls) throw new LimitError(`Agent exceeded maxToolCalls (${input.limits.maxToolCalls})`);
        const out = await input.callTool(tool, args, { callId });
        emit({
          type: "tool_result",
          timestamp: nowIso(),
          runId: input.runId,
          callId,
          ok: out.success,
          ...(out.success ? { result: out.output } : { error: out.error }),
        });
        return out;
      },
    };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LimitError(`Agent exceeded maxSeconds (${input.limits.maxSeconds})`)), input.limits.maxSeconds * 1000);
    });
    try {
      const finalMessage = await Promise.race([this.policy(api), timeout]);
      if (finalMessage) emit({ type: "message", timestamp: nowIso(), runId: input.runId, text: finalMessage });
      return { status: "completed", finalMessage: finalMessage || null, adapter: this.info };
    } catch (err) {
      const reason = (err as Error).message;
      const status = err instanceof LimitError ? "agent_limit" : "infrastructure_error";
      emit({ type: "error", timestamp: nowIso(), runId: input.runId, category: status, reason });
      return { status, finalMessage: null, reason, adapter: this.info };
    } finally {
      clearTimeout(timer);
    }
  }
}
