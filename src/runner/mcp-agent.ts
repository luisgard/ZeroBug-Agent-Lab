/**
 * McpAgentRunner: the agent is exposed as an MCP server (Streamable HTTP). ZeroBug connects as an MCP
 * client, picks the tool that takes a message (or the one the user named) and sends the task as its
 * text argument. Only the reply text is observed (black-box): side effects need evidence connectors.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AdapterInfo, AgentRunner, Emit, RunInput, RunResult } from "../contracts/index.ts";
import { type NetPolicy, UnsafeUrlError, guardedFetch, policyFromEnv, validateUrl } from "../net/safe-fetch.ts";
import { nowIso } from "../util/ids.ts";
import { redactText } from "../util/redact.ts";

export type McpAgentConfig = {
  url: string;
  /** Request headers, e.g. Authorization. Values are secrets: redacted from every error. */
  headers?: Record<string, string>;
  /** Tool to call. Omitted: the only tool, or the one whose name looks like chat/ask/message/run. */
  tool?: string;
  /** Tool argument that receives the task. Omitted: the first required text argument. */
  argument?: string;
  policy?: NetPolicy;
  /** Test hook: provide a ready transport (e.g. in-memory). */
  transportFactory?: () => Transport;
};

export type McpToolInfo = { name: string; description: string; textArgs: string[] };
export type McpChoice = { tool: string; argument: string };

const CHATTY = /chat|ask|message|prompt|query|run|invoke|agent|send|talk/i;

/** Picks the tool and argument to send the task to; null with a reason when it is ambiguous. */
export function chooseTool(tools: McpToolInfo[], want: { tool?: string; argument?: string }): McpChoice | { error: string } {
  const usable = tools.filter((t) => t.textArgs.length > 0);
  let tool: McpToolInfo | undefined;
  if (want.tool) {
    tool = tools.find((t) => t.name === want.tool);
    if (!tool) return { error: `The server has no tool "${want.tool}". Tools: ${tools.map((t) => t.name).join(", ") || "none"}` };
  } else if (usable.length === 1) {
    tool = usable[0];
  } else {
    const chatty = usable.filter((t) => CHATTY.test(t.name));
    if (chatty.length === 1) tool = chatty[0];
  }
  if (!tool) return { error: `Choose which tool receives the message. Tools with a text argument: ${usable.map((t) => t.name).join(", ") || "none"}` };
  const argument = want.argument ?? tool.textArgs[0];
  if (!argument) return { error: `Tool "${tool.name}" has no text argument; name the argument to use.` };
  return { tool: tool.name, argument };
}

export class McpAgentRunner implements AgentRunner {
  readonly info: AdapterInfo = { name: "mcp-agent", version: "1", transport: "blackbox_http" };
  constructor(private readonly cfg: McpAgentConfig) {}

  private async open(): Promise<Client> {
    const policy = this.cfg.policy ?? policyFromEnv();
    if (!this.cfg.transportFactory) await validateUrl(this.cfg.url, policy);
    const transport: Transport = this.cfg.transportFactory
      ? this.cfg.transportFactory()
      : new StreamableHTTPClientTransport(new URL(this.cfg.url), {
          requestInit: { headers: this.cfg.headers ?? {} },
          fetch: guardedFetch(() => policy, { timeoutMs: 120_000 }),
        });
    const client = new Client({ name: "zerobug", version: "1.0.0" });
    await client.connect(transport);
    return client;
  }

  /** Lists the server's tools and the choice ZeroBug would make (used by the connect step). */
  async describe(): Promise<{ tools: McpToolInfo[]; choice: McpChoice | { error: string } }> {
    const client = await this.open();
    try {
      const tools = await listTools(client);
      return { tools, choice: chooseTool(tools, this.cfg) };
    } finally {
      await client.close().catch(() => {});
    }
  }

  async run(input: RunInput, emit: Emit): Promise<RunResult> {
    const secrets = Object.values(this.cfg.headers ?? {});
    const fail = (status: RunResult["status"], reason: string): RunResult => {
      const safe = redactText(reason, secrets);
      emit({ type: "error", timestamp: nowIso(), runId: input.runId, category: status, reason: safe });
      return { status, finalMessage: null, reason: safe, adapter: this.info };
    };
    let client: Client;
    try {
      client = await this.open();
    } catch (err) {
      if (err instanceof UnsafeUrlError) return fail("infrastructure_error", `Endpoint rejected: ${err.message}`);
      return fail("infrastructure_error", `Could not connect to the MCP server: ${(err as Error).message}`);
    }
    try {
      const choice = chooseTool(await listTools(client), this.cfg);
      if ("error" in choice) return fail("infrastructure_error", choice.error);
      // No automatic retry: the agent may have acted before a failure.
      const res = await client.callTool({ name: choice.tool, arguments: { [choice.argument]: input.task } }, undefined, { timeout: input.limits.maxSeconds * 1000 });
      const text = ((res.content as { type: string; text?: string }[]) ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").trim();
      if (res.isError) return fail("infrastructure_error", `Tool ${choice.tool} returned an error: ${text.slice(0, 300)}`);
      const finalMessage = text ? text.slice(0, 20_000) : null;
      if (finalMessage) emit({ type: "message", timestamp: nowIso(), runId: input.runId, text: finalMessage });
      return { status: "completed", finalMessage, adapter: this.info };
    } catch (err) {
      const msg = (err as Error).message;
      return /timed? ?out/i.test(msg) ? fail("agent_limit", "Agent did not answer within the time limit") : fail("infrastructure_error", `MCP call failed: ${msg}`);
    } finally {
      await client.close().catch(() => {});
    }
  }
}

async function listTools(client: Client): Promise<McpToolInfo[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => {
    const props = (t.inputSchema?.properties ?? {}) as Record<string, { type?: string }>;
    const required = new Set((t.inputSchema?.required as string[] | undefined) ?? []);
    const text = Object.entries(props).filter(([, v]) => v?.type === "string").map(([k]) => k);
    text.sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
    return { name: t.name, description: (t.description ?? "").slice(0, 200), textArgs: text };
  });
}
