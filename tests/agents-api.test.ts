import { describe, expect, test } from "vitest";
import { AgentsApiRunner } from "../src/runner/agents-api.ts";
import { DecisionsJudge, JudgeUnavailableError } from "../src/judge/judge.ts";
import { createWorld, toolsFor } from "../src/world/world.ts";

// Fake client exposing only the SDK calls the runner uses (shapes from openai@7.43.0 .d.ts files).
function fakeClient(events: any[], opts: { createThrows?: Error } = {}) {
  const sent: any[] = [];
  const deleted: string[] = [];
  async function* gen() {
    for (const e of events) {
      if (e === "HANG") await new Promise((r) => setTimeout(r, 10_000));
      yield e;
    }
  }
  return {
    sent,
    deleted,
    client: {
      beta: {
        agents: {
          sessions: {
            create: async () => {
              if (opts.createThrows) throw opts.createThrows;
              return gen();
            },
            delete: async (id: string) => void deleted.push(id),
            events: { create: async (_id: string, body: any) => void sent.push(...body.events) },
          },
        },
      },
    } as any,
  };
}
const session = (actions: any[]) => ({ id: "sess_1", required_actions: actions });
const requiresAction = (call_id: string, name: string, args: unknown) => ({
  type: "agent.session.requires_action",
  session: session([{ type: "function_call", turn_id: "turn_1", call_id, name, arguments: JSON.stringify(args) }]),
});
const textDone = (text: string) => ({ type: "agent.session.turn.output_text.done", session_id: "sess_1", text });
const completed = { type: "agent.session.turn.completed", session_id: "sess_1", turn_id: "turn_1" };

const input = (world = createWorld({ runId: "r" }), limits = { maxToolCalls: 5, maxSeconds: 5 }) => ({
  runId: "r", task: "t", tools: toolsFor(["store"]), callTool: world.tools.call, limits,
});

describe("AgentsApiRunner (offline contract test; live run is opt-in)", () => {
  test("answers each function call with the same turn_id and call_id; final text read from output_text.done", async () => {
    const world = createWorld({ runId: "r" });
    const { client, sent, deleted } = fakeClient([requiresAction("call_1", "add_to_cart", { product_id: "trailmate-wp-42" }), textDone("Added."), completed]);
    const r = await new AgentsApiRunner(client, { model: "m", instructions: "i" }).run(input(world), () => {});
    expect(sent[0]).toMatchObject({ type: "agent.session.input.tool_result", turn_id: "turn_1", call_id: "call_1", success: true });
    expect(r).toMatchObject({ status: "completed", finalMessage: "Added.", externalRef: "sess_1" });
    expect(world.inspector.snapshot().cart).toHaveLength(1);
    expect(deleted).toEqual(["sess_1"]);
  });

  test("tool failure is sent back as success:false with the error", async () => {
    const { client, sent } = fakeClient([requiresAction("c", "nope", {}), completed]);
    await new AgentsApiRunner(client, { model: "m", instructions: "i" }).run(input(), () => {});
    expect(sent[0]).toMatchObject({ success: false, error: "Unknown tool: nope" });
  });

  test("limits, failures and stalls", async () => {
    const many = Array.from({ length: 3 }, (_, i) => requiresAction(`c${i}`, "search_products", { query: "bag" }));
    const lim = await new AgentsApiRunner(fakeClient([...many, completed]).client, { model: "m", instructions: "i" }).run(input(undefined, { maxToolCalls: 2, maxSeconds: 5 }), () => {});
    expect(lim.status).toBe("agent_limit");
    const failed = await new AgentsApiRunner(fakeClient([{ type: "agent.session.failed", session: session([]) }]).client, { model: "m", instructions: "i" }).run(input(), () => {});
    expect(failed.status).toBe("infrastructure_error");
    const thrown = await new AgentsApiRunner(fakeClient([], { createThrows: new Error("401") }).client, { model: "m", instructions: "i" }).run(input(), () => {});
    expect(thrown.status).toBe("infrastructure_error");
    const stall = await new AgentsApiRunner(fakeClient(["HANG"]).client, { model: "m", instructions: "i" }, { stallMs: 50 }).run(input(), () => {});
    expect(stall.status).toBe("infrastructure_error");
    const empty = await new AgentsApiRunner(fakeClient([completed]).client, { model: "m", instructions: "i" }).run(input(), () => {});
    expect(empty.finalMessage).toBeNull();
  });
});

describe("DecisionsJudge (offline contract test)", () => {
  test("maps predicate/choice/score/refusal answers", async () => {
    const client = {
      decisions: {
        create: async () => ({
          model: "gpt-6-luna",
          answers: [
            { type: "predicate", name: "claim:x", probability: 0.9 },
            { type: "choice", name: "failure_type", choice: "other", confidence: 0.7, probabilities: [] },
            { type: "score", name: "honesty", score: 2, confidence: 0.8, probabilities: [] },
            { type: "refusal", name: null },
          ],
        }),
      },
    } as any;
    const qs: any[] = [
      { type: "predicate", name: "claim:x", instructions: "i" },
      { type: "choice", name: "failure_type", instructions: "i", choices: [] },
      { type: "score", name: "honesty", instructions: "i", levels: [{ label: "a" }, { label: "b" }, { label: "c" }] },
      { type: "predicate", name: "claim:y", instructions: "i" },
    ];
    const a = await new DecisionsJudge(client).ask("e", qs);
    expect(a).toEqual([
      { name: "claim:x", type: "predicate", probability: 0.9 },
      { name: "failure_type", type: "choice", choice: "other", confidence: 0.7 },
      { name: "honesty", type: "score", score: 2, label: "c" },
      { name: "claim:y", type: "refusal" },
    ]);
  });
  test("API errors become JudgeUnavailableError", async () => {
    const client = { decisions: { create: async () => { throw new Error("ECONNRESET"); } } } as any;
    await expect(new DecisionsJudge(client).ask("e", [])).rejects.toBeInstanceOf(JudgeUnavailableError);
  });
});
