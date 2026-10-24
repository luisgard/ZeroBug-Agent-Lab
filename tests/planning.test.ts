import { describe, expect, test } from "vitest";
import { buildPlan, toScenario } from "../src/planning/plan.ts";
import { PlanRequestSchema, type AvailableSource } from "../src/planning/types.ts";

const req = (description: string, specifics = "", lang: "es" | "en" = "es") => PlanRequestSchema.parse({ description, specifics, lang });
const gmail: AvailableSource = { name: "gmail-qa", provides: ["email"], verified: true, account: "qa@example.com", origin: "connection" };

describe("offline planner + access planner", () => {
  test("email agent without an inbox -> tests proposed, NEEDS_ACCESS", async () => {
    const p = await buildPlan(req("Mi agente envía correos formales a clientes."), []);
    expect(p.planner.kind).toBe("offline_rules");
    expect(p.capabilitiesDetected).toEqual(["email"]);
    expect(p.scenarios.map((s) => s.id)).toEqual(["email-happy-path", "email-no-duplicates"]);
    expect(p.scenarios.every((s) => s.readiness === "NEEDS_ACCESS")).toBe(true);
  });

  test("with a verified Gmail connection -> READY, unique recipient per run, compiles into the engine", async () => {
    const p = await buildPlan(req("My agent sends emails for me.", "", "en"), [gmail]);
    const s = p.scenarios[0]!;
    expect(s.readiness).toBe("READY");
    expect(s.task).toContain("qa+{ref}@example.com");
    const sc = toScenario(s);
    expect(sc.checks.find((c) => c.type === "email_received")).toMatchObject({ source: "gmail-qa", to: "qa+{ref}@example.com" });
  });

  test("user specifics become traceable criteria; unsupported asks are listed, not dropped", async () => {
    const p = await buildPlan(req("Envía correos de cumpleaños.", 'Que llegue solo una vez.\nAsunto "Feliz cumpleaños".\nVerifica que el PDF sea el correcto.\nQue suene amable.'), [gmail]);
    const s = p.scenarios[0]!;
    expect(s.source).toBe("HYBRID");
    expect(s.checks.find((c) => c.id === "email-delivered")).toMatchObject({ exactly: 1 });
    expect(s.checks.find((c) => c.id === "subject-matches")).toMatchObject({ subjectContains: "Feliz cumpleaños" });
    expect(p.scenarios.some((x) => x.id === "email-no-duplicates")).toBe(false);
    expect(p.unsupported.map((u) => u.text)).toEqual(["Verifica que el PDF sea el correcto.", "Que suene amable."]);
  });

  test("job agent: real-world effect needs approval and is tied by time window", async () => {
    const p = await buildPlan(req("Agente que se postula a vacantes en LinkedIn por mí."), [gmail]);
    const s = p.scenarios.find((x) => x.id === "job-application-confirmed")!;
    expect(s).toMatchObject({ risk: "HIGH", approvalRequired: true, readiness: "READY" });
    expect(s.checks[0]).toMatchObject({ requireRef: false });
  });

  test("shopping with placeholders needs review; 'never buy' is reported as not provable", async () => {
    const p = await buildPlan(req("Agente de compras en tienda online."), [{ name: "shop", provides: ["order"], verified: true, origin: "connection" }]);
    expect(p.scenarios.find((x) => x.id === "order-created")!.readiness).toBe("NEEDS_REVIEW");
    const q = await buildPlan(req("Agente de compras.", "Nunca hagas checkout."), []);
    expect(q.unsupported[0]!.why).toMatch(/NEEDS_REVIEW, nunca PASS/);
  });

  test("nothing verifiable detected -> said plainly", async () => {
    const p = await buildPlan(req("Es un chatbot que cuenta chistes."), []);
    expect(p.scenarios).toEqual([]);
    expect(p.unsupported[0]!.why).toMatch(/No detecté acciones/);
  });

  test("model output is never trusted: invalid scenarios rejected, invented sources need access, failures fall back", async () => {
    const model = {
      info: { name: "agents-api-planner", kind: "agents_api" as const, note: "" },
      plan: async () => ({
        capabilities: ["email"],
        unsupported: [],
        scenarios: [
          { id: "bad", title: "Bad", task: "x", source: "AUTO", capability: "email", checks: [{ type: "eval", code: "1" }], needs: [], risk: "LOW", approvalRequired: false },
          { id: "invented", title: "Uses an invented connector", task: "Send mail {ref}", source: "AUTO", capability: "email", checks: [{ type: "email_received", source: "gmail-ceo", to: "a@b.com" }], needs: [], risk: "LOW", approvalRequired: false },
        ],
      }),
    };
    const p = await buildPlan(req("Sends emails."), [gmail], model);
    expect(p.planner.kind).toBe("agents_api");
    expect(p.unsupported.some((u) => /schema/.test(u.why))).toBe(true);
    expect(p.scenarios[0]).toMatchObject({ id: "invented", readiness: "NEEDS_ACCESS" });
    const failing = { ...model, plan: async () => { throw new Error("401 Unauthorized"); } };
    const f = await buildPlan(req("Sends emails."), [gmail], failing);
    expect(f.planner.kind).toBe("offline_rules");
    expect(f.planner.note).toMatch(/401/);
  });
});

import { AgentsApiPlanner } from "../src/planning/agents-planner.ts";

describe("Agents API planner (offline contract test; live run BLOCKED without a key)", () => {
  const goodScenario = {
    id: "email-ok", title: "Email arrives", task: "Send an email to qa+{ref}@example.com", source: "AUTO", capability: "email",
    checks: [{ id: "got", type: "email_received", source: "need-email", to: "qa+{ref}@example.com", subjectContains: "{ref}" }],
    needs: [{ kind: "email", why: "inbox" }], risk: "LOW", approvalRequired: false,
  };
  function fakeClient(submissions: unknown[]) {
    const sent: any[] = [];
    let i = 0;
    const action = (name: string, args: unknown, id: string) => ({ type: "agent.session.requires_action", session: { id: "s1", required_actions: [{ type: "function_call", name, arguments: JSON.stringify(args), call_id: id, turn_id: "t1" }] } });
    async function* gen() {
      yield action("list_evidence_providers", {}, "c0");
      for (const s of submissions) yield action("submit_plan", s, `c${++i}`);
      yield { type: "agent.session.turn.completed" };
    }
    return { sent, client: { beta: { agents: { sessions: { create: async () => gen(), delete: async () => undefined, events: { create: async (_: string, b: any) => void sent.push(...b.events) } } } } } as any };
  }

  test("lists only real providers, rejects an invalid plan once, accepts the corrected one", async () => {
    const { client, sent } = fakeClient([{ capabilities: ["email"], scenarios: [{ id: "x" }], unsupported: [] }, { capabilities: ["email"], scenarios: [goodScenario], unsupported: [{ text: "PDF", why: "not supported" }] }]);
    const out = await new AgentsApiPlanner(client, "gpt-6-astra").plan(PlanRequestSchema.parse({ description: "Sends emails for me", lang: "en" }), [gmail]);
    expect(JSON.parse(sent[0].output)).toEqual([{ kind: ["email"], verified: true, name: "gmail-qa" }]);
    expect(sent[1]).toMatchObject({ success: false });
    expect(sent[2]).toMatchObject({ success: true });
    expect(out.scenarios).toHaveLength(1);
    const plan = await buildPlan(PlanRequestSchema.parse({ description: "Sends emails for me", lang: "en" }), [gmail], { info: new AgentsApiPlanner(client, "m").info, plan: async () => out });
    expect(plan.scenarios[0]).toMatchObject({ readiness: "READY", assignments: { email: "gmail-qa" } });
  });

  test("no plan submitted is an error (and buildPlan falls back to offline rules)", async () => {
    const { client } = fakeClient([]);
    await expect(new AgentsApiPlanner(client, "m").plan(PlanRequestSchema.parse({ description: "Sends emails for me" }), [])).rejects.toThrow(/without submitting/);
  });
});
