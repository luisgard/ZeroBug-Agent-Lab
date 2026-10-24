/**
 * Verifier adapters: each one decides which observations it can independently provide, then calls
 * the shared hard oracle. Verifiers read state; they never execute tools and the agent never sees them.
 */
import {
  type EvidenceKind,
  type VerificationResult,
  VerificationResultSchema,
  type VerifierAdapter,
} from "../contracts/index.ts";
import { type Observation, type ObservedEmail, type Recorder, evaluateHardCheck } from "../checks/hard.ts";
import { type SafeFetchOptions, safeFetchJson } from "../net/safe-fetch.ts";
import type { Check } from "../scenarios/schema.ts";
import type { WorldInspector } from "../world/world.ts";

export type RunFacts = { finalMessage: string | null; durationMs: number; customerEmail: string };

abstract class BaseVerifier implements VerifierAdapter {
  abstract readonly name: string;
  constructor(protected readonly rec: Recorder) {}
  protected abstract observe(runId: string): Promise<Observation>;

  async verify(check: unknown, runId: string): Promise<VerificationResult> {
    const c = check as Check;
    const obs = await this.observe(runId);
    const tagged: Recorder = (kind, summary, data) => this.rec(kind, `[${this.name}] ${summary}`, data);
    const r = evaluateHardCheck(c, obs, tagged);
    return VerificationResultSchema.parse({ checkId: c.id, ...r });
  }
}

/** Instrumented mode: ZeroBug owns the world, so store, outbox and journal are fully observable. */
export class WorldVerifier extends BaseVerifier {
  readonly name = "zerobug-world";
  constructor(
    rec: Recorder,
    private readonly inspector: WorldInspector,
    private readonly facts: () => RunFacts,
  ) {
    super(rec);
  }
  protected async observe(): Promise<Observation> {
    const snap = this.inspector.snapshot();
    const journal = this.inspector.journal();
    const facts = this.facts();
    return {
      store: { cart: [...snap.cart], orders: [...snap.orders], journal },
      outbox: { emails: snap.outbox.map((e) => ({ ...e })), coverage: "complete", source: "zerobug-world" },
      toolCallCount: journal.filter((e) => e.kind === "tool_invocation").length,
      secrets: this.inspector.secrets(),
      customerEmail: facts.customerEmail,
      finalMessage: facts.finalMessage,
      durationMs: facts.durationMs,
    };
  }
}

/** Black-box mode with no external verifier: only the agent's message and timing are observable. */
export class MessageOnlyVerifier extends BaseVerifier {
  readonly name = "message-only";
  constructor(
    rec: Recorder,
    private readonly facts: () => RunFacts,
  ) {
    super(rec);
  }
  protected async observe(): Promise<Observation> {
    const f = this.facts();
    return { toolCallCount: null, customerEmail: f.customerEmail, finalMessage: f.finalMessage, durationMs: f.durationMs };
  }
}

export type ExternalOutboxConfig = {
  /** Read-only endpoint of a staging/test outbox, e.g. http://127.0.0.1:8010/staging/outbox */
  url: string;
  /** Read-only credential, kept server side. Never forwarded to the agent. */
  readToken: string;
  fetch?: SafeFetchOptions;
};

/**
 * Black-box mode with a separately granted, read-only verification interface (a staging outbox).
 * Coverage is `partial`: ZeroBug can only see this one system, so absence claims stay inconclusive.
 */
export class ExternalOutboxVerifier extends BaseVerifier {
  readonly name = "external-staging-outbox";
  private cache?: { emails: ObservedEmail[] };
  constructor(
    rec: Recorder,
    private readonly cfg: ExternalOutboxConfig,
    private readonly facts: () => RunFacts,
  ) {
    super(rec);
  }
  protected async observe(runId: string): Promise<Observation> {
    if (!this.cache) {
      const url = new URL(this.cfg.url);
      url.searchParams.set("ref", runId);
      const body = await safeFetchJson(url.toString(), {
        ...this.cfg.fetch,
        method: "GET",
        headers: { authorization: `Bearer ${this.cfg.readToken}` },
      });
      const emails = Array.isArray((body as any)?.emails) ? ((body as any).emails as any[]) : [];
      this.cache = {
        emails: emails
          .filter((e) => e && typeof e.to === "string" && typeof e.subject === "string" && typeof e.body === "string")
          .filter((e) => e.ref === runId)
          .map((e) => ({ to: e.to, subject: e.subject, body: e.body, ref: e.ref })),
      };
      this.rec("external_read", `[${this.name}] read ${this.cache.emails.length} email(s) for ref ${runId}`, {
        url: this.cfg.url,
        count: this.cache.emails.length,
      });
    }
    const f = this.facts();
    return {
      outbox: { emails: this.cache.emails, coverage: "partial", source: this.name },
      toolCallCount: null,
      customerEmail: f.customerEmail,
      finalMessage: f.finalMessage,
      durationMs: f.durationMs,
    };
  }
}

/** Try verifiers in order; the first that does not answer `unsupported` decides. */
export async function verifyWith(
  verifiers: VerifierAdapter[],
  check: Check,
  runId: string,
): Promise<VerificationResult & { verifier: string }> {
  let last: (VerificationResult & { verifier: string }) | undefined;
  for (const v of verifiers) {
    let r: VerificationResult;
    try {
      r = await v.verify(check, runId);
    } catch (err) {
      r = { checkId: check.id, status: "inconclusive", evidenceRefs: [], reason: `${v.name} failed to read: ${(err as Error).message}` };
    }
    last = { ...r, verifier: v.name };
    if (r.status !== "unsupported") return last;
  }
  return last ?? { checkId: check.id, status: "unsupported", evidenceRefs: [], reason: "No verifier connected", verifier: "none" };
}

export type { EvidenceKind };
