import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import type { RunInput } from "../src/contracts/index.ts";
import { ChatCompletionsRunner, completionsUrl } from "../src/runner/chat-completions.ts";
import { BlackBoxHttpRunner } from "../src/runner/external.ts";
import { McpAgentRunner, chooseTool } from "../src/runner/mcp-agent.ts";

const policy = { allowPrivate: false, allowAddresses: ["127.0.0.1"] };
const input = (task = "Send the report to qa@example.test"): RunInput => ({
  runId: "run-1", task, tools: [], callTool: async () => ({ success: false, error: "no tools" }), limits: { maxToolCalls: 1, maxSeconds: 10 },
});

// ---------------------------------------------------------------- one local server, several agent styles
const seen: { path: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
let base = "";
const srv = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const body = raw ? JSON.parse(raw) : undefined;
  if (req.url === "/mcp" || req.url === "/mcp-sse") {
    // A real MCP server (official SDK), stateless, answering as JSON or as an event stream.
    const server = new McpServer({ name: "agent", version: "1" });
    server.registerTool("ask_agent", { description: "Talk to the agent", inputSchema: { message: z.string() } }, async ({ message }) => ({ content: [{ type: "text", text: `Done: ${message}` }] }));
    server.registerTool("get_status", { description: "Status", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "ok" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: req.url === "/mcp" });
    res.on("close", () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }
  seen.push({ path: req.url!, headers: req.headers, body });
  if (req.url!.startsWith("/fail")) { res.writeHead(500); return res.end("nope"); }
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url === "/v1/chat/completions") return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `Sent to ${body.messages[0].content.split(" ").at(-1)}` } }] }));
  if (req.url === "/langflow") return res.end(JSON.stringify({ outputs: [{ outputs: [{ results: { message: { text: "Langflow says done" } } }] }] }));
  if (req.url === "/n8n") return res.end(JSON.stringify({ output: `n8n got: ${body.chatInput}` }));
  res.end("{}");
});
beforeAll(async () => {
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

describe("MCP agent (real MCP over HTTP through the SSRF-safe fetch)", () => {
  for (const path of ["/mcp", "/mcp-sse"]) {
    test(`${path}: picks the chat tool and its text argument, sends the task, reads the reply`, async () => {
      const r = new McpAgentRunner({ url: base + path, policy, headers: { authorization: "Bearer mcp-secret-123" } });
      const d = await r.describe();
      expect(d.tools.map((t) => t.name).sort()).toEqual(["ask_agent", "get_status"]);
      expect(d.choice).toEqual({ tool: "ask_agent", argument: "message" });
      const out = await r.run(input(), () => {});
      expect(out.status).toBe("completed");
      expect(out.finalMessage).toBe("Done: Send the report to qa@example.test");
    });
  }

  test("unknown tool -> clear error listing the tools", async () => {
    const out = await new McpAgentRunner({ url: base + "/mcp", policy, tool: "nope" }).run(input(), () => {});
    expect(out.status).toBe("infrastructure_error");
    expect(out.reason).toContain("ask_agent");
  });

  test("private address without approval is rejected before connecting", async () => {
    const out = await new McpAgentRunner({ url: base + "/mcp", policy: { allowPrivate: false } }).run(input(), () => {});
    expect(out.reason).toMatch(/Endpoint rejected/);
  });

  test("tool choice: ambiguous servers ask the user instead of guessing", () => {
    const tools = [{ name: "search", description: "", textArgs: ["q"] }, { name: "translate", description: "", textArgs: ["text"] }];
    expect("error" in chooseTool(tools, {})).toBe(true);
    expect(chooseTool(tools, { tool: "translate" })).toEqual({ tool: "translate", argument: "text" });
  });
});

describe("OpenAI-compatible chat completions", () => {
  test("posts the task as a user message with the key, reads choices[0]", async () => {
    const out = await new ChatCompletionsRunner({ baseUrl: base + "/v1", model: "my-agent", apiKey: "sk-test-abcdefgh", policy }).run(input(), () => {});
    expect(out.finalMessage).toBe("Sent to qa@example.test");
    const req = seen.find((s) => s.path === "/v1/chat/completions")!;
    expect(req.headers.authorization).toBe("Bearer sk-test-abcdefgh");
    expect(req.body).toMatchObject({ model: "my-agent", messages: [{ role: "user", content: "Send the report to qa@example.test" }] });
    expect(completionsUrl("https://x.test/v1/chat/completions/")).toBe("https://x.test/v1/chat/completions");
  });

  test("errors never contain the key", async () => {
    const out = await new ChatCompletionsRunner({ baseUrl: base + "/fail", model: "m", apiKey: "secret-key-zzzzzz", policy }).run(input(), () => {});
    expect(out.status).toBe("infrastructure_error");
    expect(JSON.stringify(out)).not.toContain("secret-key-zzzzzz");
  });
});

describe("HTTP API presets (headers, fixed body fields, nested reply paths)", () => {
  test("n8n-style chat trigger: fixed action, session id, header auth", async () => {
    const r = new BlackBoxHttpRunner({ endpoint: base + "/n8n", policy, mapping: { taskField: "chatInput", correlationField: "sessionId", responseField: "output" }, extraBody: { action: "sendMessage" }, headers: { "x-n8n-key": "n8n-secret-1" } });
    const out = await r.run(input("hola"), () => {});
    expect(out.finalMessage).toBe("n8n got: hola");
    const req = seen.find((s) => s.path === "/n8n")!;
    expect(req.body).toEqual({ action: "sendMessage", chatInput: "hola", sessionId: "run-1" });
    expect(req.headers["x-n8n-key"]).toBe("n8n-secret-1");
  });

  test("Langflow-style reply inside arrays", async () => {
    const r = new BlackBoxHttpRunner({ endpoint: base + "/langflow", policy, mapping: { taskField: "input_value", responseField: "outputs.0.outputs.0.results.message.text" }, extraBody: { input_type: "chat", output_type: "chat" } });
    expect((await r.run(input(), () => {})).finalMessage).toBe("Langflow says done");
  });

  test("request field paths cannot index arrays; reply paths are bounded", () => {
    expect(() => new BlackBoxHttpRunner({ endpoint: base, mapping: { taskField: "a.0", responseField: "x" } })).toThrow();
    expect(() => new BlackBoxHttpRunner({ endpoint: base, mapping: { taskField: "a", responseField: "__proto__..x" } })).toThrow();
  });
});
