import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { blockedReason, policyFromEnv, safeFetch, validateUrl, UnsafeUrlError, type Resolver } from "../src/net/safe-fetch.ts";

const hosted = { allowPrivate: false, allowAddresses: ["127.0.0.1"] }; // only the test server is approved
let server: http.Server;
let base = "";
let hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/redirect") {
      res.writeHead(302, { location: u.searchParams.get("to")! });
      return res.end();
    }
    if (u.pathname === "/big") return res.end("x".repeat(5000));
    if (u.pathname === "/slow") return void setTimeout(() => res.end("late"), 2000);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("SSRF protection (GATE 5)", () => {
  test("hosted mode blocks private, loopback, link-local, metadata and reserved addresses", () => {
    const p = { allowPrivate: false };
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00:ec2::254", "::ffff:127.0.0.1", "::ffff:7f00:1", "224.0.0.1", "198.18.0.1"]) {
      expect(blockedReason(ip, p), ip).not.toBeNull();
    }
    expect(blockedReason("93.184.216.34", p)).toBeNull();
  });

  test("local dev override allows loopback but never cloud metadata", () => {
    expect(blockedReason("127.0.0.1", { allowPrivate: true })).toBeNull();
    expect(blockedReason("169.254.169.254", { allowPrivate: true })).not.toBeNull();
  });

  test("the override is refused in public deployments", () => {
    expect(() => policyFromEnv({ ZB_ALLOW_PRIVATE_AGENT_URLS: "1", ZB_DEPLOYMENT: "public" } as any)).toThrow(UnsafeUrlError);
  });

  test("only http(s), no userinfo", async () => {
    await expect(validateUrl("file:///etc/passwd", hosted)).rejects.toThrow(/Protocol/);
    await expect(validateUrl("gopher://x.test/", hosted)).rejects.toThrow(/Protocol/);
    await expect(validateUrl("http://user:pw@example.test/", hosted)).rejects.toThrow(/Credentials/);
  });

  test("hostnames are resolved and every address checked", async () => {
    const resolve: Resolver = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }];
    await expect(validateUrl("http://mixed.test/", { allowPrivate: false }, resolve)).rejects.toThrow(/10\.0\.0\.1/);
  });

  test("redirect to a private address is rejected at the redirect hop", async () => {
    await expect(safeFetch(`${base}/redirect?to=${encodeURIComponent("http://10.0.0.5/admin")}`, { policy: hosted })).rejects.toThrow(/10\.0\.0\.5/);
    await expect(safeFetch(`${base}/redirect?to=${encodeURIComponent("http://169.254.169.254/latest/meta-data")}`, { policy: hosted })).rejects.toThrow(/metadata/);
  });

  test("redirect to a hostname that resolves privately is rejected", async () => {
    const resolve: Resolver = async (h) => (h === "internal.test" ? [{ address: "192.168.0.10", family: 4 }] : []);
    await expect(safeFetch(`${base}/redirect?to=${encodeURIComponent("http://internal.test/")}`, { policy: hosted, resolve })).rejects.toThrow(/192\.168/);
  });

  test("redirect count is bounded", async () => {
    let url = `${base}/ok`;
    for (let i = 0; i < 5; i++) url = `${base}/redirect?to=${encodeURIComponent(url)}`;
    await expect(safeFetch(url, { policy: hosted, maxRedirects: 3 })).rejects.toThrow(/Too many redirects/);
  });

  test("DNS rebinding: the connection is pinned to the validated address", async () => {
    let calls = 0;
    const port = new URL(base).port;
    const resolve: Resolver = async () => (++calls === 1 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.9.9.9", family: 4 }]);
    const res = await safeFetch(`http://rebind.test:${port}/ok`, { policy: hosted, resolve, timeoutMs: 2000 });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  test("response size and time are bounded", async () => {
    await expect(safeFetch(`${base}/big`, { policy: hosted, maxResponseBytes: 1000 })).rejects.toThrow(/exceeds/);
    await expect(safeFetch(`${base}/slow`, { policy: hosted, timeoutMs: 200 })).rejects.toThrow(/timed out/);
  });

  test("oversized request bodies are refused before sending", async () => {
    hits = [];
    await expect(safeFetch(`${base}/ok`, { policy: hosted, body: "x".repeat(2000), maxRequestBytes: 1000 })).rejects.toThrow(/exceeds/);
    expect(hits).toEqual([]);
  });
});
