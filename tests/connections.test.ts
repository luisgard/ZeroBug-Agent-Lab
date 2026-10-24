import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SecretBox } from "../src/connections/secret-box.ts";
import { ConnectionService } from "../src/connections/service.ts";

const dir = mkdtempSync(join(tmpdir(), "zb-conn-"));
const box = new SecretBox(Buffer.alloc(32, 7));
const local = () => ({ allowPrivate: false, allowAddresses: ["127.0.0.1"] });
const svc = (extra: Partial<ConstructorParameters<typeof ConnectionService>[1]> = {}, file = join(dir, `c-${Math.random()}.json`)) =>
  new ConnectionService(box, { file, policy: local, env: {}, ...extra });

// A staging "orders API" that needs a bearer token.
let api: http.Server;
let base = "";
beforeAll(async () => {
  api = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer shop-secret-123") { res.writeHead(401); return res.end("{}"); }
    const u = new URL(req.url!, "http://x");
    res.writeHead(200, { "content-type": "application/json" });
    if (u.pathname === "/health") return res.end("{}");
    const note = u.searchParams.get("note");
    res.end(JSON.stringify({ orders: note === "ZB-ABCDEF12" ? [{ id: 7, product_name: "TrailMate Waterproof Backpack", qty: 1, total: 42, status: "paid", note }] : [] }));
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => api.close(() => r())));

describe("secret box", () => {
  test("round trip and tamper detection", () => {
    const sealed = box.seal({ a: "secret" });
    expect(sealed).not.toContain("secret");
    expect(box.open(sealed)).toEqual({ a: "secret" });
    const bad = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => box.open(bad)).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 1)).open(sealed)).toThrow();
  });
  test("local key file is created owner-only", () => {
    const file = join(dir, "k.key");
    SecretBox.fromEnvOrFile({}, file);
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
  });
});

const httpJson = () => ({
  type: "http_json", name: "Shop orders", kind: "order", url: `${base}/orders?note={ref}`, itemsPath: "orders",
  fields: { id: "id", product: "product_name", quantity: "qty", total: "total", status: "status", ref: "note" },
  headerName: "Authorization", headerValue: "Bearer shop-secret-123", healthUrl: `${base}/health`,
});

describe("connection service", () => {
  test("custom API connection: tested with a real read, secret never exposed, usable as a source", async () => {
    const file = join(dir, "conns.json");
    const s = svc({}, file);
    const c = await s.create(httpJson());
    expect(c).toMatchObject({ slug: "shop-orders", status: { state: "VERIFIED" }, provides: ["order"] });
    expect(JSON.stringify(c)).not.toContain("shop-secret-123");
    expect(JSON.stringify(s.list())).not.toContain("shop-secret-123");
    expect(readFileSync(file, "utf8")).not.toContain("shop-secret-123");
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
    const recs = await s.sources()["shop-orders"]!.fetch("order", { ref: "ZB-ABCDEF12", since: new Date() });
    expect(recs[0]).toMatchObject({ product: "TrailMate Waterproof Backpack", total: 42 });
    const again = await s.create(httpJson());
    expect(again.slug).toBe("shop-orders-2");
    expect(s.remove(c.id)).toEqual({ removed: true });
    expect(s.list().map((x) => x.slug)).toEqual(["shop-orders-2"]);
  });

  test("wrong credential is saved as UNAVAILABLE with the reason", async () => {
    const c = await svc().create({ ...httpJson(), headerValue: "Bearer wrong" });
    expect(c.status).toMatchObject({ state: "UNAVAILABLE" });
    expect(c.status.detail).toMatch(/401/);
  });

  test("input rules: {ref} required, private URLs blocked in hosted mode, live Stripe keys refused, write tools refused", async () => {
    await expect(svc().create({ ...httpJson(), url: `${base}/orders` })).rejects.toThrow(/\{ref\}/);
    await expect(new ConnectionService(box, { file: join(dir, "x.json"), policy: () => ({ allowPrivate: false }), env: {} }).create(httpJson())).rejects.toThrow(/not allowed/);
    await expect(svc().create({ type: "stripe_test", apiKey: "sk_live_abcdefghijklmnop" })).rejects.toThrow(/TEST keys/);
    await expect(svc().create({ type: "mcp_http", name: "Mail", url: `${base}/mcp`, kind: "email", tool: "send_email", parse: { mode: "text" } })).rejects.toThrow(/state-changing/);
  });
});

// ---------------------------------------------------------------- Google OAuth (fake Google endpoints)
function fakeGoogle(opts: { refresh?: boolean } = {}) {
  return (async (url: string, init?: RequestInit) => {
    const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
    if (url === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(String(init?.body));
      if (p.get("grant_type") === "authorization_code") {
        return p.get("code") === "good-code" ? json(200, { access_token: "ya29.a", ...(opts.refresh === false ? {} : { refresh_token: "1//refresh" }), scope: "https://www.googleapis.com/auth/gmail.readonly" }) : json(400, { error: "invalid_grant" });
      }
      return json(200, { access_token: "ya29.b", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly" });
    }
    if (url.endsWith("/profile")) return json(200, { emailAddress: "zerobug-qa@example.com" });
    return json(404, {});
  }) as typeof fetch;
}
const env = { ZB_GOOGLE_CLIENT_ID: "client-123.apps.googleusercontent.com", ZB_GOOGLE_CLIENT_SECRET: "secret-xyz" };

describe("Gmail via Google sign-in", () => {
  test("not configured -> clear message", () => {
    expect(() => svc().googleAuthUrl("http://127.0.0.1:3001/cb")).toThrow(/not configured/);
  });

  test("auth URL asks only for gmail.readonly with offline access and a state", () => {
    const u = new URL(svc({ env }).googleAuthUrl("http://127.0.0.1:3001/api/oauth/google/callback"));
    expect(u.origin).toBe("https://accounts.google.com");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("state")!.length).toBeGreaterThan(20);
  });

  test("callback exchanges the code, stores the token encrypted and names the connection by the inbox", async () => {
    const file = join(dir, "g.json");
    const s = svc({ env, googleFetch: fakeGoogle() }, file);
    const state = new URL(s.googleAuthUrl("http://cb")).searchParams.get("state");
    const c = await s.googleCallback({ code: "good-code", state }, "http://cb");
    expect(c).toMatchObject({ type: "gmail", slug: "gmail-zerobug-qa", name: "Gmail (zerobug-qa@example.com)", status: { state: "VERIFIED" } });
    expect(readFileSync(file, "utf8")).not.toContain("1//refresh");
    await expect(s.googleCallback({ code: "good-code", state }, "http://cb")).rejects.toThrow(/expired or invalid/); // state is single use
  });

  test("forged state, denied consent and missing refresh token are refused", async () => {
    const s = svc({ env, googleFetch: fakeGoogle({ refresh: false }) });
    await expect(s.googleCallback({ code: "good-code", state: "forged" }, "http://cb")).rejects.toThrow(/expired or invalid/);
    await expect(s.googleCallback({ error: "access_denied" }, "http://cb")).rejects.toThrow(/cancelled/);
    const state = new URL(s.googleAuthUrl("http://cb")).searchParams.get("state");
    await expect(s.googleCallback({ code: "good-code", state }, "http://cb")).rejects.toThrow(/refresh token/);
  });
});
