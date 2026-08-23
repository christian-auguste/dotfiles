/**
 * @fileoverview Recent policy decisions kept in memory for operator
 * diagnostics. Persistence is added in the trust phase.
 */

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

/**
 * Capped, newest-first history of decisions, memory-only in this wave. The
 * adapters record each denial and grant so the operator can inspect recent
 * policy behavior without log digging.
 */
export class DenialRing {
  private ring: RingEntry[] = [];

  /** Appends an entry and drops the oldest once the cap is exceeded. */
  record(entry: Omit<RingEntry, "at">): void {
    this.ring.push({ at: Date.now(), ...entry });
    if (this.ring.length > MAX_ENTRIES) {
      this.ring.splice(0, this.ring.length - MAX_ENTRIES);
    }
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
