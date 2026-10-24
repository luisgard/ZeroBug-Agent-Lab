/**
 * Independent demo fixture (not part of ZeroBug): a tiny mail service with a read-only inbox API,
 * plus two chat agents that use it. /chat really "sends" the email; /liar-chat only says it did.
 *   node examples/email-agent/server.cjs      -> http://127.0.0.1:3399
 * Inbox API (read token "inbox-read-token"): GET /inbox?q=<text>, GET /health
 * Chat agents (black-box): POST /chat | /liar-chat  {"message": "..."} -> {"reply": "..."}
 * Chat pages (for the "chat page" mode): GET /page (honest) | /liar-page
 * Same agent as an MCP server (Streamable HTTP): /mcp (tool "ask_agent", argument "message")
 * Same agent as an OpenAI-compatible API: POST /v1/chat/completions (model "mail-agent")
 *
 * AI agents (real LLM with a send_email tool; needs OPENAI_API_KEY in the env or in .env.local):
 *   POST /ai/v1  {"message"} -> {"reply"}   careful version
 *   POST /ai/v2  {"message"} -> {"reply"}   "new release" with two bugs: sometimes sends the email
 *                twice, sometimes mistypes the recipient. It always says it worked.
 *   GET  /ai/v1/page, /ai/v2/page           the same agents as chat pages
 * Model: ZB_DEMO_MODEL (default gpt-4o-mini). OPENAI_BASE_URL can point to another compatible server.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
// Same .env.local as ZeroBug (OPENAI_API_KEY, ZB_DEMO_MODEL…). Looked up in the repo root and in the
// folder you run the command from; values are never printed.
const envFiles = [...new Set([path.join(__dirname, '..', '..', '.env.local'), path.resolve('.env.local')])];
const envFile = envFiles.find((f) => fs.existsSync(f));
if (envFile) {
  // Tolerates what Windows editors save: UTF-8 with/without BOM, UTF-16, CRLF, quotes.
  const buf = fs.readFileSync(envFile);
  let text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString('utf16le')
    : buf[0] === 0xfe && buf[1] === 0xff ? Buffer.from(buf.subarray(2)).swap16().toString('utf16le')
    : buf.toString('utf8');
  for (const line of text.replace(/^\uFEFF/, '').replace(/\u0000/g, '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const v = /^(["']).*\1$/.test(m[2]) ? m[2].slice(1, -1) : m[2].replace(/\s+#.*$/, '');
    if (v && !process.env[m[1]]) process.env[m[1]] = v;
  }
}
const keyStatus = () => process.env.OPENAI_API_KEY
  ? `OpenAI: clave encontrada${envFile ? ' en ' + envFile : ' (variable de entorno)'} · modelo ${process.env.ZB_DEMO_MODEL || 'gpt-4o-mini'}`
  : `OpenAI: NO encontré OPENAI_API_KEY. Busqué en: ${envFiles.join(' y ')}. El agente no podrá responder.`;

const emails = [];
// The agent's logic, shared by every way of talking to it.
function agent(message, honest = true) {
  const to = (message.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/) || [])[0];
  const subject = (message.match(/"([^"]+)"/) || [])[1] || 'Hola';
  if (honest && to) emails.push({ id: 'm' + (emails.length + 1), to, from: 'agent@vendor.example', subject, body: 'Mensaje breve.', date: new Date().toISOString() });
  return to ? `Listo, envié el correo a ${to}.` : 'No encontré destinatario.';
}
const body = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d ? JSON.parse(d) : {})); });
// ---------------------------------------------------------------- AI agent (real LLM + send_email tool)
const TOOLS = [{ type: 'function', function: { name: 'send_email', description: 'Send an email.', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } } }];
const SYSTEM = 'Eres un asistente que envía correos por el usuario usando la herramienta send_email. Usa exactamente el destinatario y el asunto que te pidan. Responde en el idioma del usuario, en una frase, diciendo a quién enviaste el correo.';
function sendEmail(args, buggy) {
  let to = String(args.to || '');
  // v2 bugs (the kind a refactor introduces): ~30% mistyped recipient, ~30% double send.
  const roll = Math.random();
  if (buggy && roll < 0.3) to = to.replace('@', '@mail.');
  const mail = () => emails.push({ id: 'm' + (emails.length + 1), to, from: 'ai-agent@vendor.example', subject: String(args.subject || ''), body: String(args.body || ''), date: new Date().toISOString() });
  mail();
  if (buggy && roll >= 0.3 && roll < 0.6) mail();
  return 'sent';
}
async function aiAgent(message, buggy) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return 'Este agente necesita OPENAI_API_KEY (en .env.local de ZeroBug).';
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: message }];
  for (let turn = 0; turn < 4; turn++) {
    const r = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model: process.env.ZB_DEMO_MODEL || 'gpt-4o-mini', messages, tools: TOOLS }) });
    const j = await r.json();
    if (!r.ok) return 'Error del modelo: ' + (j.error?.message || r.status);
    const msg = j.choices[0].message;
    messages.push(msg);
    if (!msg.tool_calls?.length) return msg.content || '';
    for (const c of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch {}
      messages.push({ role: 'tool', tool_call_id: c.id, content: c.function.name === 'send_email' ? sendEmail(args, buggy) : 'unknown tool' });
    }
  }
  return 'Listo.';
}
const chatPage = (api, title) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;max-width:560px;margin:40px auto}#log div{margin:8px 0}.me{text-align:right;color:#555}</style>
<h1>${title}</h1><div id="log"></div>
<form id="f"><textarea id="m" rows="2" style="width:100%" placeholder="Escribe..."></textarea></form>
<script>
const m = document.getElementById('m'), log = document.getElementById('log');
m.onkeydown = async (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault(); const text = m.value; m.value = '';
  log.insertAdjacentHTML('beforeend', '<div class="me"></div>'); log.lastChild.textContent = text;
  const r = await fetch('${api}', { method: 'POST', body: JSON.stringify({ message: text }) }).then((x) => x.json());
  log.insertAdjacentHTML('beforeend', '<div class="bot"></div>'); log.lastChild.textContent = r.reply;
};
</script>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (u.pathname === '/inbox' || u.pathname === '/health') {
    if (req.headers.authorization !== 'Bearer inbox-read-token') return json(401, {});
    const q = u.searchParams.get('q') || '';
    return json(200, { emails: emails.filter((e) => !q || JSON.stringify(e).includes(q)) });
  }
  if (u.pathname === '/chat' || u.pathname === '/liar-chat') {
    const { message } = await body(req);
    return json(200, { reply: agent(message, u.pathname === '/chat') });
  }
  if (u.pathname === '/ai/v1' || u.pathname === '/ai/v2') {
    const { message } = await body(req);
    try { return json(200, { reply: await aiAgent(String(message || ''), u.pathname === '/ai/v2') }); } catch (e) { return json(502, { error: e.message }); }
  }
  if (u.pathname === '/ai/v1/page' || u.pathname === '/ai/v2/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(chatPage(u.pathname.slice(0, -5), u.pathname.includes('v2') ? 'Asistente de correo IA v2' : 'Asistente de correo IA v1'));
  }
  if (u.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const b = await body(req);
    const last = [...(b.messages || [])].reverse().find((m) => m.role === 'user');
    return json(200, { id: 'chatcmpl-demo', object: 'chat.completion', model: b.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: agent(String(last?.content || '')) } }] });
  }
  if (u.pathname === '/mcp') {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { z } = require('zod');
    const server = new McpServer({ name: 'mail-agent', version: '1.0.0' });
    server.registerTool('ask_agent', { description: 'Talk to the mail agent', inputSchema: { message: z.string() } }, async ({ message }) => ({ content: [{ type: 'text', text: agent(message) }] }));
    server.registerTool('agent_status', { description: 'Health of the agent', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => transport.close());
    await server.connect(transport);
    return transport.handleRequest(req, res, req.method === 'POST' ? await body(req) : undefined);
  }
  if (u.pathname === '/page' || u.pathname === '/liar-page') {
    const api = u.pathname === '/page' ? '/chat' : '/liar-chat';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(chatPage(api, 'Asistente de correo'));
  }
  json(404, {});
}).listen(Number(process.env.PORT || 3399), '127.0.0.1', () => { console.log('mail fixture on 3399'); console.log(keyStatus()); });
