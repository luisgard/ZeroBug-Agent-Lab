/**
 * Live demo: a visible browser clicks through the ZeroBug wizard for the ShopZ refund agent v1 and v2,
 * then checks the result the demo depends on: v1 is fully proven and v2 (the broken release) is caught.
 *
 *   npm run demo:live                      (both agents, 1 run per test, English UI)
 *   npm run demo:live -- --runs 3 --lang es
 *   npm run demo:live -- --only v2
 *
 * Starts ShopZ (:3400) and the ZeroBug UI (:3001) if they are not already running, adds the two
 * ShopZ connections if missing, and clears ShopZ's test refunds and emails. Tabs, in order: ShopZ
 * panel, ShopZ store page with each agent's chat, then one ZeroBug tab per agent. The browser stays open
 * at the end; close it (or Ctrl+C) to finish. Exit code 0 only if every expectation held.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Page, chromium } from "playwright";
import { loadLocalEnv } from "../src/util/env.ts";

loadLocalEnv();

const { values: a } = parseArgs({
  options: {
    runs: { type: "string", default: "1" },
    only: { type: "string" },
    lang: { type: "string", default: "en" },
  },
});
const RUNS = Number(a.runs);
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 100) throw new Error("--runs must be a whole number from 1 to 100");
if (a.only && a.only !== "v1" && a.only !== "v2") throw new Error("--only must be v1 or v2");
if (a.lang !== "en" && a.lang !== "es") throw new Error("--lang must be en or es");
const VERSIONS = a.only ? [a.only] : ["v1", "v2"];
const LANG = a.lang;

const UI = "http://127.0.0.1:3001";
const SHOPZ = "http://127.0.0.1:3400";
const LABEL = {
  en: { test: "Test this agent", try: "Connect and test", next: /^Next/, propose: /^Propose tests/, run: /^Run \d+ tests?/ },
  es: { test: "Probar este agente", try: "Conectar y probar", next: /^Siguiente/, propose: /^Proponer pruebas/, run: /^Correr \d+ pruebas?/ },
}[LANG];

// ---------------------------------------------------------------- servers

const started: ChildProcess[] = [];

async function isUp(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function ensureUp(name: string, healthUrl: string, args: string[]) {
  if (await isUp(healthUrl)) return console.log(`${name}: already running`);
  mkdirSync("data/live-demo", { recursive: true });
  const log = createWriteStream(`data/live-demo/${name.toLowerCase()}.log`, { flags: "a" });
  const proc = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  proc.stdout!.pipe(log);
  proc.stderr!.pipe(log);
  started.push(proc);
  const deadline = Date.now() + 30_000;
  while (!(await isUp(healthUrl))) {
    if (proc.exitCode !== null) throw new Error(`${name} exited early; see data/live-demo/${name.toLowerCase()}.log`);
    if (Date.now() > deadline) throw new Error(`${name} did not start; see data/live-demo/${name.toLowerCase()}.log`);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`${name}: started (log in data/live-demo/${name.toLowerCase()}.log)`);
}

function stopStarted() {
  for (const p of started) if (p.exitCode === null) p.kill();
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(UI + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error ?? res.status}`);
  return json as T;
}

type Connection = { slug: string; name: string; provides: string[]; status: { state: string; detail: string }; config: { url?: string } };

/** The ShopZ refunds and inbox connections, created the same way the UI's "Fill in with the ShopZ example" does. */
async function ensureShopzConnections(): Promise<Record<"payment" | "email", string>> {
  const want = {
    payment: { name: "Reembolsos ShopZ", url: `${SHOPZ}/refunds?q={ref}`, itemsPath: "payments", fields: { id: "id", amount: "amount", currency: "currency", status: "status", ref: "ref", date: "date" } },
    email: { name: "Correo ShopZ", url: `${SHOPZ}/inbox?q={ref}`, itemsPath: "emails", fields: { id: "id", to: "to", from: "from", subject: "subject", body: "body", date: "date" } },
  };
  const { connections } = await api<{ connections: Connection[] }>("GET", "/api/connections");
  const slugs = {} as Record<"payment" | "email", string>;
  for (const kind of ["payment", "email"] as const) {
    const w = want[kind];
    let c = connections.find((x) => x.provides.includes(kind) && x.config.url === w.url && x.status.state === "VERIFIED");
    c ??= await api<Connection>("POST", "/api/connections", {
      type: "http_json", name: w.name, kind, url: w.url, itemsPath: w.itemsPath, fields: w.fields,
      headerName: "Authorization", headerValue: "Bearer support-read-token", healthUrl: `${SHOPZ}/health`,
    });
    if (c.status.state !== "VERIFIED") throw new Error(`ShopZ ${kind} connection is not working: ${c.status.detail}`);
    slugs[kind] = c.slug;
  }
  console.log(`Connections: ${slugs.payment} (refunds), ${slugs.email} (inbox)`);
  return slugs;
}

// ---------------------------------------------------------------- wizard

/** Drives one agent from "My agents" to "Run"; returns the run ids the UI started. */
async function startAgent(page: Page, version: string, slugs: Record<string, string>): Promise<string[]> {
  const say = (m: string) => console.log(`[${version}] ${m}`);
  await page.goto(`${UI}/agents`);
  await page.locator(`#lang-${LANG}`).click();
  const card = page.locator("article")
    .filter({ has: page.locator("b", { hasText: /^ShopZ refund agent$/ }) })
    .filter({ has: page.locator(".pill", { hasText: new RegExp(`^${version}$`) }) });
  await card.getByRole("button", { name: LABEL.test }).click();

  say("step 1: connect and test");
  await page.getByRole("button", { name: LABEL.try }).click();
  const smoke = page.locator("#main .notice.ok, #main .notice.bad").first();
  await smoke.waitFor({ timeout: 90_000 });
  if (await smoke.evaluate((el) => el.classList.contains("bad"))) throw new Error(`[${version}] agent did not answer: ${await smoke.innerText()}`);
  await page.getByRole("button", { name: LABEL.next }).click();

  say("step 2: propose tests (the planner can take a minute)");
  await page.getByRole("button", { name: LABEL.propose }).click();
  const step3 = page.locator("ol.steps li.cur .n", { hasText: "3" });
  const planError = page.locator("#main .notice.bad");
  await Promise.race([step3.waitFor({ timeout: 240_000 }), planError.waitFor({ timeout: 240_000 })]);
  if (!(await step3.isVisible())) throw new Error(`[${version}] could not propose tests: ${await planError.innerText()}`);
  say(`step 3: ${(await page.locator("#main section.card .notice").first().innerText()).split("\n")[0]}`);

  // More than one connection can check the same thing; point each choice at ShopZ.
  for (const kind of ["payment", "email"]) {
    const sel = page.locator(`#src-${kind}`);
    if (!(await sel.count())) continue;
    await Promise.all([page.waitForResponse((r) => r.url().endsWith("/access")), sel.selectOption(slugs[kind]!)]);
  }
  for (const box of await page.locator('input[id^="ap-"]').all()) await box.check();
  const chip = page.locator(`button.chip[data-n="${RUNS}"]`);
  if (await chip.count()) await chip.click();
  else await page.locator('input[type="number"]').last().fill(String(RUNS));

  const runBtn = page.getByRole("button", { name: LABEL.run });
  say(`step 4: ${await runBtn.innerText()}`);
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/plan/run")), runBtn.click()]);
  const body = await res.json();
  if (!res.ok()) throw new Error(`[${version}] run refused: ${body.error}`);
  return body.runIds as string[];
}

type RunView = { status: string; error: string | null; record: { scenarioId: string; verdict: string; reason: string } | null };

async function waitForRuns(ids: string[]): Promise<RunView[]> {
  for (;;) {
    const runs = await Promise.all(ids.map((id) => api<RunView>("GET", `/api/runs/${id}`)));
    if (runs.every((r) => r.status === "done")) return runs;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  await ensureUp("ShopZ", `${SHOPZ}/health`, ["examples/support-agent/server.cjs"]);
  await ensureUp("ZeroBug", `${UI}/api/meta`, ["--import", "tsx", "scripts/ui-server.ts"]);
  const meta = await api<{ agentsApi: string; judge: { name: string } }>("GET", "/api/meta");
  console.log(`ZeroBug: Agents API ${meta.agentsApi} · judge ${meta.judge.name}`);
  if (meta.judge.name !== "decisions-api") console.warn("Note: the judge is not the Decisions API (check OPENAI_API_KEY and ZB_JUDGE).");
  const slugs = await ensureShopzConnections();
  await fetch(`${SHOPZ}/admin/reset`, { method: "POST" });
  console.log("ShopZ: test refunds and emails cleared");

  const browser = await chromium.launch({ headless: false, slowMo: 250, args: ["--start-maximized"] });
  const context = await browser.newContext({ viewport: null });
  // ShopZ as the audience sees it: the internal panel (what really happened) and the store page with each agent's chat.
  await (await context.newPage()).goto(`${SHOPZ}/admin`);
  for (const v of VERSIONS) await (await context.newPage()).goto(`${SHOPZ}/agent/${v}/page`);
  const runIds: Record<string, string[]> = {};
  for (const v of VERSIONS) runIds[v] = await startAgent(await context.newPage(), v, slugs);

  let ok = true;
  for (const v of VERSIONS) {
    const runs = await waitForRuns(runIds[v]!);
    const verdict = (r: RunView) => r.record?.verdict ?? "ERROR";
    const pass = runs.filter((r) => verdict(r) === "PASS").length;
    const fail = runs.filter((r) => verdict(r) === "FAIL").length;
    console.log(`\n${v}: ${pass}/${runs.length} proven, ${fail} failed`);
    for (const r of runs) console.log(`  ${verdict(r).padEnd(12)} ${r.record?.scenarioId ?? "?"}  ${verdict(r) === "PASS" ? "" : (r.record?.reason ?? r.error ?? "").slice(0, 160)}`);
    // The demo's claim: v1 holds up, v2 (the broken release) gets caught.
    const met = v === "v1" ? runs.length > 0 && pass === runs.length : fail > 0;
    console.log(`  expected ${v === "v1" ? "every test proven" : "at least one FAIL"}: ${met ? "YES" : "NO"}`);
    ok &&= met;
  }
  console.log(`\n${ok ? "DEMO OK" : "DEMO EXPECTATION NOT MET"}. The browser stays open; close it or press Ctrl+C to finish.`);
  await new Promise<void>((r) => {
    browser.on("disconnected", () => r());
    process.once("SIGINT", () => r());
  });
  await browser.close().catch(() => undefined);
  return ok ? 0 : 1;
}

main().then(
  (code) => (stopStarted(), process.exit(code)),
  (err) => (console.error(err instanceof Error ? err.message : err), stopStarted(), process.exit(1)),
);
