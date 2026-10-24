/**
 * Evidence connectors: read-only access to the real systems where an agent's actions land
 * (a Gmail inbox, a store's order API, a payment provider in test mode, any MCP connector).
 * ZeroBug reads them directly, with no model in between: what a connector returns is evidence,
 * not an interpretation.
 */

export type RecordKind = "email" | "order" | "payment";

/** `raw` is set when a source returns unstructured text: matching then requires every expected value to appear in it. */
export type EmailRecord = { raw?: string; id: string; to: string; from: string; subject: string; body: string; date?: string };
export type OrderRecord = { raw?: string; id: string; product: string; quantity?: number; total?: number; status?: string; ref?: string };
export type PaymentRecord = { raw?: string; id: string; amount?: number; currency?: string; status?: string; ref?: string };
export type ExternalRecord = EmailRecord | OrderRecord | PaymentRecord;

export type RecordQuery = {
  /** Unique reference of this test run (e.g. ZB-1A2B3C4D); the agent was asked to include it. */
  ref: string;
  /** Run start; records older than this are ignored. */
  since: Date;
  /** Optional recipient hint for email searches. */
  to?: string;
};

export interface EvidenceSource {
  readonly name: string;
  readonly kind: string;
  /** Which record kinds this source can return. */
  readonly provides: RecordKind[];
  fetch(kind: RecordKind, q: RecordQuery): Promise<ExternalRecord[]>;
  /** Cheap authenticated read to prove access works (used for VERIFIED capability state). */
  health(): Promise<{ ok: boolean; detail: string }>;
  close?(): Promise<void>;
}

export class SourceError extends Error {}

/** Reads a dotted path ("data.items", "amount") from parsed JSON. */
export function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const p of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z0-9_]{1,64}){0,6}$/;

/** Maps raw JSON items to normalized records using operator-declared field paths. */
export function mapItems(kind: RecordKind, items: unknown, fields: Record<string, string>): ExternalRecord[] {
  if (!Array.isArray(items)) return [];
  const str = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  return items.map((it, i) => {
    const f = (k: string) => (fields[k] ? getPath(it, fields[k]) : undefined);
    const id = str(f("id")) || String(i);
    if (kind === "email") return { id, to: str(f("to")), from: str(f("from")), subject: str(f("subject")), body: str(f("body")), date: str(f("date")) };
    if (kind === "order") {
      return { id, product: str(f("product")), quantity: num(f("quantity")), total: num(f("total")), status: str(f("status")) || undefined, ref: str(f("ref")) || undefined };
    }
    return { id, amount: num(f("amount")), currency: str(f("currency")) || undefined, status: str(f("status")) || undefined, ref: str(f("ref")) || undefined };
  });
}

/** Tool names that could change state. MCP tools used for verification must not look like these. */
export const WRITE_LIKE = /(^|_|-|\b)(send|delete|remove|create|update|modify|write|move|post|reply|forward|draft|trash|archive|mark|flag|label|insert|patch|put|cancel|refund|charge|pay|purchase|checkout)/i;
