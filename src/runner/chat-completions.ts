/**
 * ChatCompletionsRunner: any server that speaks the OpenAI Chat Completions format
 * (POST <base>/chat/completions). Many agent servers, gateways and local runtimes expose it.
 * Black-box: only the reply text is observed.
 */
import type { AdapterInfo, AgentRunner, Emit, RunInput, RunResult } from "../contracts/index.ts";
import { type NetPolicy, OutboundError, UnsafeUrlError, safeFetch } from "../net/safe-fetch.ts";
import { nowIso } from "../util/ids.ts";
import { redactText } from "../util/redact.ts";

export type ChatCompletionsConfig = { baseUrl: string; model: string; apiKey?: string; policy?: NetPolicy };

export function completionsUrl(baseUrl: string): string {
  const u = baseUrl.replace(/\/+$/, "");
  return u.endsWith("/chat/completions") ? u : `${u}/chat/completions`;
}

export class ChatCompletionsRunner implements AgentRunner {
  readonly info: AdapterInfo = { name: "chat-completions", version: "1", transport: "blackbox_http" };
  constructor(private readonly cfg: ChatCompletionsConfig) {}

  async run(input: RunInput, emit: Emit): Promise<RunResult> {
    const fail = (status: RunResult["status"], reason: string): RunResult => {
      const safe = redactText(reason, [this.cfg.apiKey ?? ""]);
      emit({ type: "error", timestamp: nowIso(), runId: input.runId, category: status, reason: safe });
      return { status, finalMessage: null, reason: safe, adapter: this.info };
    };
    try {
      const res = await safeFetch(completionsUrl(this.cfg.baseUrl), {
        method: "POST",
        body: JSON.stringify({ model: this.cfg.model, messages: [{ role: "user", content: input.task }], user: input.runId }),
        headers: this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {},
        timeoutMs: input.limits.maxSeconds * 1000,
        maxRedirects: 0,
        maxResponseBytes: 512 * 1024,
        ...(this.cfg.policy ? { policy: this.cfg.policy } : {}),
      });
      if (res.status < 200 || res.status >= 300) return fail("infrastructure_error", `Server answered HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      let json: any;
      try {
        json = JSON.parse(res.text);
      } catch {
        return fail("infrastructure_error", "Response is not JSON");
      }
      const content = json?.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("") : null;
      const finalMessage = text && text.trim() ? text.trim().slice(0, 20_000) : null;
      if (finalMessage) emit({ type: "message", timestamp: nowIso(), runId: input.runId, text: finalMessage });
      return { status: "completed", finalMessage, adapter: this.info };
    } catch (err) {
      if (err instanceof UnsafeUrlError) return fail("infrastructure_error", `Endpoint rejected: ${err.message}`);
      if (err instanceof OutboundError && err.kind === "timeout") return fail("agent_limit", "Agent did not answer within the time limit");
      return fail("infrastructure_error", `Server unreachable: ${(err as Error).message}`);
    }
  }
}
