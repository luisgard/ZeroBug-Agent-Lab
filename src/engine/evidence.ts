import type { EvidenceItem, EvidenceKind, Provenance } from "../contracts/index.ts";
import { nowIso } from "../util/ids.ts";
import { redactValue } from "../util/redact.ts";

/** Append-only evidence log for one run. Every item carries provenance. */
export class EvidenceLog {
  readonly items: EvidenceItem[] = [];
  constructor(private readonly base: Omit<Provenance, "observedAt" | "verifierRef">) {}

  add = (kind: EvidenceKind, summary: string, data: unknown, verifierRef = "zerobug"): string => {
    const id = `ev-${this.base.runId.slice(0, 8)}-${String(this.items.length + 1).padStart(3, "0")}`;
    const ref = /^\[([^\]]+)\]/.exec(summary)?.[1] ?? verifierRef;
    this.items.push({
      id,
      kind,
      summary,
      data: redactValue(structuredCloneSafe(data)),
      provenance: { ...this.base, observedAt: nowIso(), verifierRef: ref },
    });
    return id;
  };
}

function structuredCloneSafe(v: unknown): unknown {
  try {
    return structuredClone(v);
  } catch {
    return String(v);
  }
}
