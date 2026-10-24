import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { loadScenarios, parseScenario } from "../src/scenarios/schema.ts";

const base = (checks: string, extra = "") =>
  `schemaVersion: 1\nid: x\ntitle: X\ntask: "Do the thing please"\napps: [store]\n${extra}checks:\n${checks}`;

describe("scenario schema", () => {
  test("every scenario file loads", () => {
    const { scenarios, errors } = loadScenarios();
    expect(errors).toEqual([]);
    expect(scenarios.map((s) => s.id).sort()).toEqual(
      ["blackbox-invoice", "dont-overstep", "external-store-order", "normal-errand", "poisoned-product", "real-email-delivery", "real-purchase", "store-outage"],
    );
  });

  test("defaults and goals", () => {
    const s = parseScenario(readFileSync("scenarios/store-outage.yaml", "utf8"), "store-outage.yaml");
    expect(s.runs).toBe(5);
    expect(s.limits).toEqual({ maxToolCalls: 20, maxSeconds: 90 });
    expect(s.goals).toEqual(["honest-failure-report"]);
    expect(s.version).toMatch(/^[0-9a-f]{16}$/);
  });

  test("unknown check type is rejected with file and path", () => {
    expect(() => parseScenario(base("  - { type: teleport }"), "x.yaml")).toThrow(/x\.yaml.*checks\.0/);
  });

  test("unknown fields are rejected", () => {
    expect(() => parseScenario(base("  - { type: required_cart_item, productId: a, color: red }"), "x.yaml")).toThrow(/x\.yaml/);
    expect(() => parseScenario(base("  - { type: required_cart_item, productId: a }", "mystery: 1\n"), "x.yaml")).toThrow();
  });

  test("expression-like strings are rejected, never evaluated", () => {
    expect(() => parseScenario(base('  - { type: required_cart_item, productId: "${process.exit()}" }'), "x.yaml")).toThrow(/expression/);
    expect(() => parseScenario(base('  - { type: required_cart_item, productId: "{{cart}}" }'), "x.yaml")).toThrow(/expression/);
  });

  test("duplicate check ids are rejected", () => {
    expect(() =>
      parseScenario(base("  - { id: a, type: required_cart_item, productId: p }\n  - { id: a, type: forbid_checkout }"), "x.yaml"),
    ).toThrow(/duplicate/);
  });

  test("only negative constraints is rejected (missing positive goal)", () => {
    expect(() => parseScenario(base("  - { type: forbid_checkout }"), "x.yaml")).toThrow(/positive goal/);
  });

  test("standalone budget check is rejected", () => {
    expect(() => parseScenario(base("  - { type: max_cart_total, max: 50 }\n  - { type: expect_no_action }"), "x.yaml")).toThrow(/max_cart_total/);
  });

  test("claim must reference an existing state check", () => {
    expect(() =>
      parseScenario(base('  - { type: required_cart_item, productId: p }\n  - { type: claim_matches_external_state, claim: "It is done now", stateCheck: nope }'), "x.yaml"),
    ).toThrow(/unknown check id/);
  });

  test("invalid fixture fields in faults are rejected", () => {
    expect(() => parseScenario(base("  - { type: required_cart_item, productId: p }", "faults:\n  - { app: store, tool: add_to_cart, error: 418 }\n"), "x.yaml")).toThrow();
  });

  test("YAML aliases are refused", () => {
    expect(() => parseScenario(base("  - &a { type: required_cart_item, productId: p }\n  - *a"), "x.yaml")).toThrow();
  });
});
