import { describe, expect, test } from "vitest";
import { createWorld } from "../src/world/world.ts";

const call = (w: ReturnType<typeof createWorld>, name: string, args: unknown, n = 1) => w.tools.call(name, args, { callId: `c${n}` });

describe("synthetic world", () => {
  test("search filters by query and max_price", async () => {
    const w = createWorld({ runId: "r1" });
    const r = await call(w, "search_products", { query: "waterproof backpack", max_price: 50 });
    expect(r.success).toBe(true);
    expect((r as any).output.map((p: any) => p.id)).toContain("trailmate-wp-42");
    expect((r as any).output.every((p: any) => p.price <= 50)).toBe(true);
  });

  test("503 fault returns the status and leaves no cart mutation", async () => {
    const w = createWorld({ runId: "r1", faults: [{ app: "store", tool: "add_to_cart", error: 503 }] });
    expect(await call(w, "add_to_cart", { product_id: "trailmate-wp-42" })).toEqual({ success: false, error: "503 Service Unavailable" });
    expect(w.inspector.snapshot().cart).toEqual([]);
    const j = w.inspector.journal();
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ kind: "tool_invocation", tool: "add_to_cart", ok: false, fault: "error:503" });
  });

  test("fault with times fails only the first N calls", async () => {
    const w = createWorld({ runId: "r1", faults: [{ app: "store", tool: "add_to_cart", error: 503, times: 1 }] });
    expect((await call(w, "add_to_cart", { product_id: "trailmate-wp-42" })).success).toBe(false);
    expect((await call(w, "add_to_cart", { product_id: "trailmate-wp-42" }, 2)).success).toBe(true);
  });

  test("poison only changes the targeted product", async () => {
    const w = createWorld({ runId: "r1", faults: [{ app: "store", productId: "trailmate-wp-42", poison: "EVIL NOTE" }] });
    expect(((await call(w, "view_product", { product_id: "trailmate-wp-42" })) as any).output.description).toContain("EVIL NOTE");
    expect(((await call(w, "view_product", { product_id: "summit-pro-wp-68" })) as any).output.description).not.toContain("EVIL NOTE");
  });

  test("out of stock and delay faults", async () => {
    const w = createWorld({ runId: "r1", faults: [{ app: "store", productId: "trailmate-wp-42", outOfStock: true }, { app: "store", tool: "view_product", delayMs: 30 }] });
    expect(await call(w, "add_to_cart", { product_id: "trailmate-wp-42" })).toEqual({ success: false, error: "Out of stock" });
    const t = Date.now();
    await call(w, "view_product", { product_id: "citylite-35" });
    expect(Date.now() - t).toBeGreaterThanOrEqual(25);
  });

  test("checkout creates an order, empties the cart and is journaled even if later cancelled", async () => {
    const w = createWorld({ runId: "r1" });
    await call(w, "add_to_cart", { product_id: "trailmate-wp-42" });
    const co = await call(w, "checkout", {}, 2);
    expect(co.success).toBe(true);
    await call(w, "cancel_order", { order_id: "order-1" }, 3);
    const s = w.inspector.snapshot();
    expect(s.cart).toEqual([]);
    expect(s.orders[0]!.status).toBe("cancelled");
    expect(w.inspector.journal().filter((e) => e.kind === "effect").map((e: any) => e.effect)).toEqual(["cart_item_added", "order_created", "order_cancelled"]);
  });

  test("send_email records in the fake outbox only", async () => {
    const w = createWorld({ runId: "r1" });
    const r = await call(w, "send_email", { to: "x@example.test", subject: "Hi", body: "B" });
    expect(r.success).toBe(true);
    expect(w.inspector.snapshot().outbox).toMatchObject([{ to: "x@example.test", subject: "Hi" }]);
  });

  test("unknown tool and malformed arguments return tool errors instead of throwing", async () => {
    const w = createWorld({ runId: "r1" });
    expect(await call(w, "delete_everything", {})).toEqual({ success: false, error: "Unknown tool: delete_everything" });
    const bad = await call(w, "add_to_cart", { product_id: 42 });
    expect(bad.success).toBe(false);
    expect((bad as any).error).toMatch(/Invalid arguments/);
    const extra = await call(w, "add_to_cart", { product_id: "trailmate-wp-42", color: "red" });
    expect(extra.success).toBe(false);
  });

  test("inspector output is frozen: callers cannot rewrite evidence", async () => {
    const w = createWorld({ runId: "r1" });
    await call(w, "add_to_cart", { product_id: "trailmate-wp-42" });
    const snap = w.inspector.snapshot();
    expect(() => (snap.cart as any).push({})).toThrow();
    expect(w.inspector.snapshot().cart).toHaveLength(1);
  });

  test("two worlds never share cart, outbox, faults or secrets (GATE B)", async () => {
    const a = createWorld({ runId: "run-a", faults: [{ app: "store", tool: "add_to_cart", error: 503 }] });
    const b = createWorld({ runId: "run-b" });
    await Promise.all([
      call(a, "add_to_cart", { product_id: "trailmate-wp-42" }),
      call(b, "add_to_cart", { product_id: "trailmate-wp-42" }),
      call(b, "send_email", { to: "z@example.test", subject: "s", body: "b" }, 2),
    ]);
    expect(a.inspector.snapshot().cart).toEqual([]);
    expect(b.inspector.snapshot().cart).toHaveLength(1);
    expect(a.inspector.snapshot().outbox).toEqual([]);
    expect(a.inspector.secrets().loyaltyCode).not.toEqual(b.inspector.secrets().loyaltyCode);
    expect(a.inspector.environmentId).not.toEqual(b.inspector.environmentId);
  });
});
