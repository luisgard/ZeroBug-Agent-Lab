/**
 * Verifies connector checks (email_received, order_exists, payment_exists) against real external
 * systems through evidence sources. Deterministic matching only; no model reads the evidence.
 *
 * Absence is never inferred from a failed read: if the source cannot be read until the deadline,
 * the result is inconclusive, not fail.
 */
import { type VerificationResult, VerificationResultSchema, type VerifierAdapter } from "../contracts/index.ts";
import type { Recorder } from "../checks/hard.ts";
import { CONNECTOR_CHECK_TYPES, type Check } from "../scenarios/schema.ts";
import type { SourceRegistry } from "./registry.ts";
import type { EmailRecord, ExternalRecord, OrderRecord, PaymentRecord, RecordKind } from "./types.ts";

type ConnectorCheck = Extract<Check, { type: "email_received" | "order_exists" | "payment_exists" }>;

const KIND: Record<ConnectorCheck["type"], RecordKind> = { email_received: "email", order_exists: "order", payment_exists: "payment" };

export type ConnectorContext = { ref: string; since: Date; customerEmail: string; pollMs?: number; now?: () => number };

export class ConnectorVerifier implements VerifierAdapter {
  readonly name = "connectors";
  constructor(
    private readonly rec: Recorder,
    private readonly sources: SourceRegistry,
    private readonly ctx: ConnectorContext,
  ) {}

  async verify(check: unknown, _runId: string): Promise<VerificationResult> {
    const c = check as Check;
    const result = (status: VerificationResult["status"], reason: string, evidenceRefs: string[] = []) =>
      VerificationResultSchema.parse({ checkId: c.id, status, reason, evidenceRefs });
    if (!CONNECTOR_CHECK_TYPES.includes(c.type)) return result("unsupported", "not a connector check");
    const cc = c as ConnectorCheck;
    if (!this.sources.names().includes(cc.source)) return result("unsupported", `Evidence source "${cc.source}" is not configured`);

    let source;
    try {
      source = this.sources.get(cc.source);
    } catch (err) {
      return result("inconclusive", `Evidence source "${cc.source}" unavailable: ${(err as Error).message}`);
    }
    const kind = KIND[cc.type];
    if (!source.provides.includes(kind)) return result("unsupported", `Source "${cc.source}" does not provide ${kind} records`);

    const now = this.ctx.now ?? Date.now;
    const deadline = now() + cc.waitSeconds * 1000;
    const sub = (v: string | undefined) => v?.replaceAll("{ref}", this.ctx.ref);
    const c2 = (cc.type === "email_received"
      ? { ...cc, to: sub(cc.to)!, subjectContains: sub(cc.subjectContains), bodyContains: sub(cc.bodyContains), fromContains: sub(cc.fromContains) }
      : cc) as ConnectorCheck;
    const to = c2.type === "email_received" ? (c2.to === "customer" ? this.ctx.customerEmail : c2.to) : undefined;
    const exactly = c2.type === "email_received" ? c2.exactly : undefined;
    let lastError: string | null = null;
    let reads = 0;
    let nearMiss: { record: ExternalRecord; why: string } | null = null;
    let matches: ExternalRecord[] = [];
    for (;;) {
      try {
        const records = await source.fetch(kind, { ref: this.ctx.ref, since: this.ctx.since, matchRef: c2.requireRef, ...(to ? { to } : {}) });
        reads += 1;
        lastError = null;
        matches = [];
        for (const r of records) {
          const date = (r as { date?: string }).date;
          if (date && Date.parse(date) < this.ctx.since.getTime() - 60_000) continue; // outside the run window
          const why = mismatch(c2, r, this.ctx.ref, to);
          if (!why) matches.push(r);
          else nearMiss ??= { record: r, why };
        }
        if (matches.length && exactly === undefined) {
          const ref = this.rec("external_read", `[${source.name}] ${kind} matching ${cc.id} found`, trim(matches[0]!));
          const weak = c2.requireRef ? "" : " (tied to this run by time window only, not by reference)";
          return result("pass", `${describe(c2, to)} found in ${source.name} (${source.kind}), record ${matches[0]!.id}${weak}`, [ref]);
        }
        if (exactly !== undefined && matches.length > exactly) break; // duplicates already proven
      } catch (err) {
        lastError = (err as Error).message;
      }
      if (now() >= deadline) break;
      await new Promise((res) => setTimeout(res, this.ctx.pollMs ?? 3000));
    }
    if (lastError && reads === 0) {
      return result("inconclusive", `Could not read ${source.name}: ${lastError}. Absence is not assumed from a failed read.`);
    }
    if (exactly !== undefined && matches.length > 0) {
      const refs = matches.slice(0, 5).map((m) => this.rec("external_read", `[${source.name}] matching ${kind} ${m.id}`, trim(m)));
      return matches.length === exactly
        ? result("pass", `Exactly ${exactly} ${describe(c2, to)} in ${source.name} after waiting ${c2.waitSeconds}s`, refs)
        : result("fail", `${matches.length} matching emails, expected exactly ${exactly} (duplicates)`, refs);
    }
    const ref = this.rec("external_read", `[${source.name}] searched ${kind} records for ${this.ctx.ref}`, {
      reads,
      waitSeconds: c2.waitSeconds,
      nearMiss: nearMiss ? { record: trim(nearMiss.record), why: nearMiss.why } : null,
      lastError,
    });
    const detail = nearMiss ? `; closest record ${nearMiss.record.id} rejected: ${nearMiss.why}` : "";
    return result("fail", `No ${describe(c2, to)} in ${source.name} after ${c2.waitSeconds}s${detail}`, [ref]);
  }
}

function describe(c: ConnectorCheck, to?: string): string {
  if (c.type === "email_received") return `email to ${to}${c.subjectContains ? ` with subject containing "${c.subjectContains}"` : ""}`;
  if (c.type === "order_exists") return `order${c.productContains ? ` for "${c.productContains}"` : ""}`;
  return `payment${c.amount !== undefined ? ` of ${c.amount}${c.currency ? ` ${c.currency.toUpperCase()}` : ""}` : ""}`;
}

const has = (hay: string | undefined, needle: string) => (hay ?? "").toLowerCase().includes(needle.toLowerCase());

/** Returns why a record does not satisfy the check, or null when it matches. */
export function mismatch(c: ConnectorCheck, r: ExternalRecord, ref: string, to?: string): string | null {
  if (c.type === "email_received") {
    const e = r as EmailRecord;
    if (c.requireRef && !has(e.raw ?? `${e.subject}\n${e.body}`, ref)) return `missing reference ${ref}`;
    if (to && !has(e.raw ?? e.to, to)) return `recipient is "${e.to}", expected ${to}`;
    if (c.subjectContains && !has(e.raw ?? e.subject, c.subjectContains)) return `subject "${e.subject}" lacks "${c.subjectContains}"`;
    if (c.bodyContains && !has(e.raw ?? e.body, c.bodyContains)) return `body lacks "${c.bodyContains}"`;
    if (c.fromContains && !has(e.raw ?? e.from, c.fromContains)) return `sender "${e.from}" lacks "${c.fromContains}"`;
    return null;
  }
  if (c.type === "order_exists") {
    const o = r as OrderRecord;
    if (c.requireRef && !has(o.raw ?? `${o.ref ?? ""} ${o.product} ${o.id}`, ref)) return `missing reference ${ref}`;
    if (c.productContains && !has(o.raw ?? o.product, c.productContains)) return `product "${o.product}" lacks "${c.productContains}"`;
    if (c.status && !has(o.raw ?? o.status, c.status)) return `status is "${o.status ?? "unknown"}", expected ${c.status}`;
    if (o.raw === undefined) {
      if (c.quantity !== undefined && o.quantity !== c.quantity) return `quantity is ${o.quantity ?? "unknown"}, expected ${c.quantity}`;
      if (c.maxTotal !== undefined && (o.total === undefined || o.total > c.maxTotal)) return `total is ${o.total ?? "unknown"}, max ${c.maxTotal}`;
    } else if (c.quantity !== undefined || c.maxTotal !== undefined) {
      return "quantity/total cannot be checked on unstructured text; use parse mode json";
    }
    return null;
  }
  const p = r as PaymentRecord;
  if (c.requireRef && !has(p.raw ?? `${p.ref ?? ""} ${p.id}`, ref)) return `missing reference ${ref}`;
  if (p.raw !== undefined) {
    if (c.amount !== undefined && !p.raw.includes(String(c.amount))) return `amount ${c.amount} not present`;
    if (c.currency && !has(p.raw, c.currency)) return `currency ${c.currency} not present`;
    if (c.status && !has(p.raw, c.status)) return `status ${c.status} not present`;
    return null;
  }
  if (c.amount !== undefined && (p.amount === undefined || Math.abs(p.amount - c.amount) > 0.005)) return `amount is ${p.amount ?? "unknown"}, expected ${c.amount}`;
  if (c.currency && (p.currency ?? "").toLowerCase() !== c.currency.toLowerCase()) return `currency is ${p.currency ?? "unknown"}, expected ${c.currency}`;
  if (c.status && (p.status ?? "").toLowerCase() !== c.status.toLowerCase()) return `status is ${p.status ?? "unknown"}, expected ${c.status}`;
  return null;
}

function trim(r: ExternalRecord): ExternalRecord {
  const out: Record<string, unknown> = { ...r };
  for (const k of ["body", "raw"]) if (typeof out[k] === "string" && (out[k] as string).length > 800) out[k] = `${(out[k] as string).slice(0, 800)}…`;
  return out as ExternalRecord;
}
