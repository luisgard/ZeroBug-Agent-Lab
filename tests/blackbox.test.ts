import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { connectBlackBox } from "../src/engine/connect.ts";
import { runScenario } from "../src/engine/run-scenario.ts";
import { HeuristicJudge } from "../src/judge/judge.ts";
import { BlackBoxHttpRunner } from "../src/runner/external.ts";
import { loadScenario } from "../src/scenarios/schema.ts";

// A chat agent that *says* it sent the invoice; `honest` also writes to its staging outbox.
const policy = { allowPrivate: false, allowAddresses: ["127.0.0.1"] };
const READ = "read-token-0123456789abcdef";
const outbox: any[] = [];
let srv: http.Server;
let base = "";
beforeAll(async () => {
  srv = http.createServer(async (req, res) => {
    const u = new URL(req.url!, "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const json = (s: number, b: unknown) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    if (u.pathname === "/honest/chat" || u.pathname === "/liar/chat") {
      if (u.pathname === "/honest/chat") outbox.push({ to: "ava@customer.example.test", subject: "Invoice INV-1001", body: "x", ref: body.conversation_id });
      return json(200, { reply: "I sent the invoice INV-1001 to ava@customer.example.test." });
    }
    if (u.pathname === "/staging/outbox") {
      if (req.headers.authorization !== `Bearer ${READ}`) return json(401, {});
      return json(200, { emails: outbox.filter((e) => e.ref === u.searchParams.get("ref")) });
    }
    json(404, {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

const mapping = { taskField: "message", correlationField: "conversation_id", responseField: "reply" };
const run = (who: "honest" | "liar", verifier: boolean) =>
  runScenario({
    scenario: loadScenario("blackbox-invoice"),
    agent: { id: who, label: who, version: "1" },
    runner: new BlackBoxHttpRunner({ endpoint: `${base}/${who}/chat`, mapping, policy }),
    judge: new HeuristicJudge(),
    ...(verifier ? { externalOutbox: { url: `${base}/staging/outbox`, readToken: READ, fetch: { policy } } } : {}),
  });

describe("black-box limits (GATE 3)", () => {
  test("'I sent the invoice' with no independent verifier is INCONCLUSIVE, never PASS", async () => {
    for (const who of ["honest", "liar"] as const) {
      const r = await run(who, false);
      expect(r.verdict).toBe("INCONCLUSIVE");
      expect(r.checks.find((c) => c.checkId === "invoice-email-sent")!.status).toBe("unsupported");
      expect(r.journal).toBeNull();
      expect(r.notes.join(" ")).toMatch(/No independent verifier/);
    }
  });

  test("with read-only staging proof the honest agent can PASS", async () => {
    const r = await run("honest", true);
    expect(r.verdict).toBe("PASS");
    expect(r.checks.find((c) => c.checkId === "invoice-email-sent")).toMatchObject({ status: "pass", verifier: "external-staging-outbox" });
    expect(r.evidence.some((e) => e.kind === "external_read")).toBe(true);
  });

  test("with read-only staging proof the lying agent FAILS (false claim)", async () => {
    const r = await run("liar", true);
    expect(r.verdict).toBe("FAIL");
  });

  test("black-box runs never receive tools and never claim fault injection", async () => {
    const report = await connectBlackBox({ endpoint: `${base}/honest/chat`, mapping, policy });
    expect(report.capabilities.canAcceptTask.state).toBe("VERIFIED");
    expect(report.capabilities.canInjectFaults.state).toBe("UNSUPPORTED");
    expect(report.capabilities.canUseInjectedTools.state).toBe("UNSUPPORTED");
    expect(report.capabilities.canInspectExternalEffects.state).toBe("UNSUPPORTED");
    const withV = await connectBlackBox({ endpoint: `${base}/honest/chat`, mapping, policy, externalOutbox: { url: `${base}/staging/outbox`, readToken: READ, fetch: { policy } } });
    expect(withV.capabilities.canInspectExternalEffects.state).toBe("VERIFIED");
  });

  test("declared faults are not silently claimed in black-box mode", async () => {
    const s = { ...loadScenario("store-outage"), agentTransport: "any" as const };
    const r = await runScenario({ scenario: s, agent: { id: "x", label: "x", version: "1" }, runner: new BlackBoxHttpRunner({ endpoint: `${base}/liar/chat`, mapping, policy }), judge: new HeuristicJudge() });
    expect(r.notes.join(" ")).toMatch(/Fault injection is not available in black-box mode/);
    expect(r.verdict).not.toBe("PASS");
  });
});
