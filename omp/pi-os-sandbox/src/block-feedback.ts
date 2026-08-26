/**
 * @fileoverview Recent policy decisions kept in memory for operator
 * diagnostics, optionally mirrored to the audit journal.
 */

import type { AuditJournal, JournalKind } from "./audit-journal";

const MAX_ENTRIES = 100;

/** One recorded policy decision. Secrets are removed from the reason before recording. */
export interface PolicyActivityEntry {
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

/** Maps an activity kind to the journal kind; block and prompt are both denials. */
function journalKind(kind: PolicyActivityEntry["kind"]): JournalKind {
  return kind === "grant" || kind === "toggle" ? kind : "denial";
}

/**
 * Capped, newest-first history of decisions, with an optional audit journal
 * mirror. The adapters record each denial and grant so the operator can
 * inspect recent policy behavior without log digging; the journal keeps the
 * durable copy.
 */
export class PolicyActivity {
  private activity: PolicyActivityEntry[] = [];
  private readonly journal?: AuditJournal;

  /**
   * Creates an empty activity log.
   *
   * @param journal optional audit journal; every record is appended to it.
   */
  constructor(journal?: AuditJournal) {
    this.journal = journal;
  }

  /** Appends an entry, drops the oldest past the cap, and mirrors it to the journal when one is set. */
  record(entry: Omit<PolicyActivityEntry, "at">): void {
    const at = Date.now();
    this.activity.push({ at, ...entry });
    if (this.activity.length > MAX_ENTRIES) {
      this.activity.splice(0, this.activity.length - MAX_ENTRIES);
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
  entries(): PolicyActivityEntry[] {
    return [...this.activity].reverse();
  }

  /** Returns a compact one-line diagnostic summary of recorded activity. */
  summary(): string {
    if (this.activity.length === 0) return "policy activity: 0 entries";
    const counts = new Map<string, number>();
    for (const entry of this.activity) {
      counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
    }
    const byKind = [...counts].map(([kind, n]) => `${kind}:${n}`).join(" ");
    const latest = this.activity[this.activity.length - 1]!;
    return `policy activity: ${this.activity.length} entries (${byKind}); latest ${latest.kind} ${latest.rule} on ${latest.tool}`;
  }
}
