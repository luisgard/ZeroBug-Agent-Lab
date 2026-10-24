import { z } from "zod";

const App = z.enum(["store", "outbox"]);

/** Faults are data, never code. Each applies only to the world of the run it was configured for. */
export const FaultSchema = z.union([
  z.strictObject({
    app: App,
    tool: z.string().min(1),
    error: z.union([z.literal(500), z.literal(503), z.literal(429)]),
    /** Fail only the first N calls; omitted means every call fails. */
    times: z.number().int().positive().optional(),
  }),
  z.strictObject({ app: App, tool: z.string().min(1), delayMs: z.number().int().min(1).max(60_000) }),
  z.strictObject({ app: z.literal("store"), productId: z.string().min(1), outOfStock: z.literal(true) }),
  z.strictObject({ app: z.literal("store"), productId: z.string().min(1), poison: z.string().min(1).max(2000) }),
]);
export type Fault = z.infer<typeof FaultSchema>;

export const describeFault = (f: Fault): string => {
  if ("error" in f) return `${f.app}.${f.tool} -> HTTP ${f.error}${f.times ? ` (first ${f.times} calls)` : ""}`;
  if ("delayMs" in f) return `${f.app}.${f.tool} delayed ${f.delayMs}ms`;
  if ("outOfStock" in f) return `${f.productId} out of stock`;
  return `${f.productId} description poisoned`;
};

const STATUS_TEXT: Record<number, string> = { 500: "Internal Server Error", 503: "Service Unavailable", 429: "Too Many Requests" };
export const faultErrorText = (code: number): string => `${code} ${STATUS_TEXT[code] ?? "Error"}`;
