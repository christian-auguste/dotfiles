/**
 * @fileoverview Recent policy decisions kept in memory for operator
 * diagnostics, optionally mirrored to the audit journal.
 */

import type { AuditJournal, JournalKind } from "./audit-journal";

const MAX_ENTRIES = 100;

/** One recorded policy decision. Secrets are removed from the reason before recording. */
export interface RingEntry {
  /** Date.now() at record time. */
  at: number;
  /** What happened: block, prompt, grant, or toggle. */
  kind: "block" | "prompt" | "grant" | "toggle";
  /** Stable rule id from the registry. */
  rule: string;
  /** Tool name the decision applied to. */
  tool: string;
  /** Redacted decision reason. */
  reason: string;
}

/** Maps a ring kind to the journal kind; block and prompt are both denials. */
function journalKind(kind: RingEntry["kind"]): JournalKind {
  return kind === "grant" || kind === "toggle" ? kind : "denial";
}

/**
 * Capped, newest-first history of decisions, with an optional audit journal
 * mirror. The adapters record each denial and grant so the operator can
 * inspect recent policy behavior without log digging; the journal keeps the
 * durable copy.
 */
export class DenialRing {
  private ring: RingEntry[] = [];
  private readonly journal?: AuditJournal;

  /**
   * Creates an empty ring.
   *
   * @param journal optional audit journal; every record is appended to it.
   */
  constructor(journal?: AuditJournal) {
    this.journal = journal;
  }

  /** Appends an entry, drops the oldest past the cap, and mirrors it to the journal when one is set. */
  record(entry: Omit<RingEntry, "at">): void {
    const at = Date.now();
    this.ring.push({ at, ...entry });
    if (this.ring.length > MAX_ENTRIES) {
      this.ring.splice(0, this.ring.length - MAX_ENTRIES);
    }
    this.journal?.append({
      at,
      kind: journalKind(entry.kind),
      rule: entry.rule,
      tool: entry.tool,
      reason: entry.reason,
    });
  }

  /** Returns recorded entries, newest first, capped at 100. */
  entries(): RingEntry[] {
    return [...this.ring].reverse();
  }

  /** Returns a compact one-line diagnostic summary of recorded activity. */
  summary(): string {
    if (this.ring.length === 0) return "denial ring: 0 entries";
    const counts = new Map<string, number>();
    for (const entry of this.ring) {
      counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    }
    const byKind = [...counts].map(([kind, n]) => `${kind}:${n}`).join(" ");
    const latest = this.ring[this.ring.length - 1]!;
    return `denial ring: ${this.ring.length} entries (${byKind}); latest ${latest.kind} ${latest.rule} on ${latest.tool}`;
  }
}
