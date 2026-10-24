/**
 * Independent demo fixture (not part of ZeroBug): a tiny mail service with a read-only inbox API,
 * plus two chat agents that use it. /chat really "sends" the email; /liar-chat only says it did.
 *   node examples/email-agent/server.cjs      -> http://127.0.0.1:3399
 * Inbox API (read token "inbox-read-token"): GET /inbox?q=<text>, GET /health
 * Chat agents (black-box): POST /chat | /liar-chat  {"message": "..."} -> {"reply": "..."}
 */
const http = require('http');
const emails = [];
const body = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d ? JSON.parse(d) : {})); });
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
    const to = (message.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/) || [])[0];
    const subject = (message.match(/"([^"]+)"/) || [])[1] || 'Hola';
    if (u.pathname === '/chat' && to) emails.push({ id: 'm' + (emails.length + 1), to, from: 'agent@vendor.example', subject, body: 'Mensaje breve.', date: new Date().toISOString() });
    return json(200, { reply: to ? `Listo, envié el correo a ${to}.` : 'No encontré destinatario.' });
  }
  json(404, {});
}).listen(Number(process.env.PORT || 3399), '127.0.0.1', () => console.log('mail fixture on 3399'));
