/**
 * Browser chat runner (black-box): for agents that only exist as a chat page. ZeroBug opens the
 * page in a headless browser, types the task, waits until the agent's newest reply stops changing,
 * and reads it. Like every black-box mode it sees only the reply: side effects must be proven by a
 * connector check (Gmail, order API, payment API, MCP).
 */
import type { AdapterInfo, AgentRunner, Emit, RunInput, RunResult } from "../contracts/index.ts";
import { type NetPolicy, UnsafeUrlError, policyFromEnv, validateUrl } from "../net/safe-fetch.ts";
import { nowIso } from "../util/ids.ts";

export type BrowserChatConfig = {
  url: string;
  /** CSS selector of the message input (textarea or input). */
  inputSelector: string;
  /** CSS selector of the send button; when omitted, Enter is pressed. */
  sendSelector?: string;
  /** CSS selector that matches every agent reply bubble; the last one is the answer. */
  replySelector: string;
  /** The reply counts as finished after its text has not changed for this long. */
  settleMs?: number;
  policy?: NetPolicy;
  headless?: boolean;
};

export class BrowserChatRunner implements AgentRunner {
  readonly info: AdapterInfo = { name: "browser-chat", version: "playwright-1.63.0", transport: "blackbox_http" };
  constructor(private readonly cfg: BrowserChatConfig) {}

  async run(input: RunInput, emit: Emit): Promise<RunResult> {
    const fail = (status: RunResult["status"], reason: string): RunResult => {
      emit({ type: "error", timestamp: nowIso(), runId: input.runId, category: status, reason });
      return { status, finalMessage: null, reason, adapter: this.info };
    };
    const policy = this.cfg.policy ?? policyFromEnv();
    try {
      await validateUrl(this.cfg.url, policy);
    } catch (err) {
      return fail("infrastructure_error", `Endpoint rejected: ${(err as Error).message}`);
    }
    let pw: typeof import("playwright");
    try {
      pw = await import("playwright");
    } catch {
      return fail("infrastructure_error", "Playwright is not installed (npm i playwright && npx playwright install chromium)");
    }
    const browser = await pw.chromium.launch({ headless: this.cfg.headless ?? true });
    const deadline = Date.now() + input.limits.maxSeconds * 1000;
    try {
      const page = await browser.newPage();
      // Every navigation and subrequest is re-checked against the same SSRF policy.
      const blocked: string[] = [];
      await page.route("**/*", async (route) => {
        try {
          const u = route.request().url();
          if (u.startsWith("data:") || u.startsWith("blob:")) return route.continue();
          await validateUrl(u, policy);
          return route.continue();
        } catch (err) {
          blocked.push(String((err as Error).message));
          return route.abort("blockedbyclient");
        }
      });
      await page.goto(this.cfg.url, { timeout: 20_000, waitUntil: "domcontentloaded" });
      const replies = page.locator(this.cfg.replySelector);
      const before = await replies.count();
      await page.locator(this.cfg.inputSelector).fill(input.task, { timeout: 10_000 });
      if (this.cfg.sendSelector) await page.locator(this.cfg.sendSelector).click();
      else await page.locator(this.cfg.inputSelector).press("Enter");

      // Wait for a new reply, then for its text to settle.
      while ((await replies.count()) <= before) {
        if (Date.now() > deadline) return fail("agent_limit", "No reply appeared within the time limit");
        await page.waitForTimeout(200);
      }
      const settle = this.cfg.settleMs ?? 1500;
      let last = "";
      let stableSince = Date.now();
      for (;;) {
        const text = (await replies.last().innerText()).trim();
        if (text !== last) {
          last = text;
          stableSince = Date.now();
        } else if (text && Date.now() - stableSince >= settle) break;
        if (Date.now() > deadline) return fail("agent_limit", "Reply kept changing until the time limit");
        await page.waitForTimeout(200);
      }
      if (blocked.length) emit({ type: "error", timestamp: nowIso(), runId: input.runId, category: "blocked_request", reason: blocked.slice(0, 3).join("; ") });
      const finalMessage = last.slice(0, 20_000) || null;
      if (finalMessage) emit({ type: "message", timestamp: nowIso(), runId: input.runId, text: finalMessage });
      return { status: "completed", finalMessage, adapter: this.info };
    } catch (err) {
      if (err instanceof UnsafeUrlError) return fail("infrastructure_error", err.message);
      return fail("infrastructure_error", `Browser automation failed: ${(err as Error).message.split("\n")[0]}`);
    } finally {
      await browser.close();
    }
  }
}
