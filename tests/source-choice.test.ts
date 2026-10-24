import { describe, expect, test } from "vitest";
import { buildPlan, planAccess, toScenario } from "../src/planning/plan.ts";
import { PlanRequestSchema, type AvailableSource } from "../src/planning/types.ts";

const req = PlanRequestSchema.parse({ description: "My agent sends emails for me.", specifics: "", lang: "en" });
const inbox = (name: string): AvailableSource => ({ name, provides: ["email"], verified: true, origin: "connection" });
const shopz = inbox("correo-shopz");
const mailAgent = inbox("correo-agente");

// Found on Oct 24: with two inboxes connected, ZeroBug silently read the first one and reported
// three correctly delivered emails as missing (false FAIL).
describe("choosing which connection a test reads", () => {
  test("two connections that can check the same thing: never guess, ask", async () => {
    const p = await buildPlan(req, [shopz, mailAgent]);
    const s = p.scenarios[0]!;
    expect(s.readiness).toBe("NEEDS_REVIEW");
    expect(s.choices).toEqual({ email: ["correo-shopz", "correo-agente"] });
    expect(s.assignments.email).toBeUndefined();
    expect(s.readinessReason).toContain("correo-shopz");
    expect(s.readinessReason).toContain("correo-agente");
  });

  test("the chosen connection is the one the test reads", async () => {
    const p = await buildPlan(req, [shopz, mailAgent]);
    const s = planAccess(p.scenarios[0]!, [shopz, mailAgent], { email: "correo-agente" });
    expect(s.readiness).toBe("READY");
    expect(s.assignments.email).toBe("correo-agente");
    const email = toScenario(s).checks.find((c) => c.type === "email_received");
    expect(email).toMatchObject({ source: "correo-agente" });
  });

  test("a choice that is not a matching connection is rejected, not used", async () => {
    const p = await buildPlan(req, [shopz, mailAgent]);
    const s = planAccess(p.scenarios[0]!, [shopz, mailAgent], { email: "gmail-nobody" });
    expect(s.readiness).toBe("NEEDS_REVIEW");
    expect(s.assignments.email).toBeUndefined();
  });

  test("one matching connection is still picked automatically", async () => {
    const p = await buildPlan(req, [mailAgent]);
    expect(p.scenarios[0]!.readiness).toBe("READY");
    expect(p.scenarios[0]!.assignments.email).toBe("correo-agente");
    expect(p.scenarios[0]!.choices).toBeUndefined();
  });
});
