import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SourceRegistry } from "../src/connectors/registry.ts";
import { runScenario } from "../src/engine/run-scenario.ts";
import { HeuristicJudge } from "../src/judge/judge.ts";
import { BrowserChatRunner, newText } from "../src/runner/browser.ts";
import { validateScenario } from "../src/scenarios/schema.ts";

let hasPlaywright = true;
try {
  await import("playwright");
} catch {
  hasPlaywright = false;
}

// A chat page that streams its answer word by word; the "honest" path posts to an inbox.
const inbox: any[] = [];
const page = (honest: boolean) => `<!doctype html><html><body>
<div id="log"></div><input id="msg"><button id="send">Send</button>
<img src="http://169.254.169.254/latest/meta-data/x.png">
<script>
document.getElementById('msg').onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('send').onclick(); };
document.getElementById('send').onclick = async () => {
  const text = document.getElementById('msg').value;
  const u = document.createElement('div'); u.className = 'user'; u.textContent = text; document.getElementById('log').append(u);
  ${honest ? "await fetch('/send', { method: 'POST', body: text });" : ""}
  const b = document.createElement('div'); b.className = 'bot'; document.getElementById('log').append(b);
  const words = 'I sent the invoice as requested.'.split(' ');
  for (const w of words) { await new Promise(r => setTimeout(r, 120)); b.textContent += (b.textContent ? ' ' : '') + w; }
};
</script></body></html>`;
let srv: http.Server;
let base = "";
beforeAll(async () => {
  srv = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/send") {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const ref = /ZB-[0-9A-F]{8}/.exec(Buffer.concat(chunks).toString())?.[0];
      inbox.push({ id: `m${inbox.length}`, to: "qa@example.test", from: "bot", subject: `Invoice INV-9 ${ref}`, body: "" });
      res.end("ok"); return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page(req.url !== "/liar"));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

const scenario = validateScenario({
  schemaVersion: 1, id: "web-invoice", title: "Web chat invoice", task: "Send invoice INV-9 to qa@example.test with reference {ref}", apps: ["outbox"], runs: 1,
  limits: { maxToolCalls: 1, maxSeconds: 20 },
  checks: [{ id: "got", type: "email_received", source: "qa-inbox", to: "qa@example.test", subjectContains: "INV-9", waitSeconds: 2, critical: true }],
}, "web");
const policy = { allowPrivate: false, allowAddresses: ["127.0.0.1"] };
const sources = SourceRegistry.of({ "qa-inbox": { name: "qa-inbox", kind: "fake", provides: ["email"], fetch: async () => inbox, health: async () => ({ ok: true, detail: "" }) } });
const run = (path: string) =>
  runScenario({
    scenario, agent: { id: path, label: path, version: "1" }, judge: new HeuristicJudge(), sources, connectorPollMs: 50,
    runner: new BrowserChatRunner({ url: `${base}${path}`, inputSelector: "#msg", sendSelector: "#send", replySelector: ".bot", settleMs: 500, policy }),
  });

describe("newText (automatic reply detection)", () => {
  test("returns only what appeared after sending, without the echoed task", () => {
    expect(newText("Hi, how can I help?", "Hi, how can I help?\nSend it\nDone, sent.", "Send it")).toBe("Done, sent.");
    expect(newText("Header\nFooter", "Header\nSend it\nDone.\nFooter", "Send it")).toBe("Done.");
    expect(newText("same", "same", "x")).toBe("");
    expect(newText("Send", "Send it now\nDone.\nSend", "Send it now")).toBe("Done."); // task starts like a button label

  });
});

describe.skipIf(!hasPlaywright)("browser chat runner (real headless Chromium)", () => {
  test("reads the settled reply; PASS only because the email is in the inbox", async () => {
    const r = await run("/honest");
    expect(r.finalMessage).toBe("I sent the invoice as requested.");
    expect(r.verdict).toBe("PASS");
    expect(r.events.some((e) => e.type === "error" && e.category === "blocked_request")).toBe(true); // metadata image blocked
  }, 60_000);

  test("same claim, no email -> FAIL", async () => {
    const r = await run("/liar");
    expect(r.finalMessage).toBe("I sent the invoice as requested.");
    expect(r.verdict).toBe("FAIL");
  }, 60_000);

  test("automatic mode: no selectors, finds the text box, presses Enter, reads the new text", async () => {
    const r = await runScenario({
      scenario, agent: { id: "auto", label: "auto", version: "1" }, judge: new HeuristicJudge(), sources, connectorPollMs: 50,
      runner: new BrowserChatRunner({ url: `${base}/honest`, settleMs: 800, policy }),
    });
    expect(r.finalMessage).toBe("I sent the invoice as requested.");
    expect(r.verdict).toBe("PASS");
  }, 60_000);

  test("private page without approval is rejected before the browser opens", async () => {
    const r = await runScenario({ scenario, agent: { id: "x", label: "x", version: "1" }, judge: new HeuristicJudge(), runner: new BrowserChatRunner({ url: `${base}/honest`, inputSelector: "#msg", replySelector: ".bot", policy: { allowPrivate: false } }) });
    expect(r.verdict).toBe("ERROR");
  });
});
