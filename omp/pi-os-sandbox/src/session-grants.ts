/**
 * @fileoverview Session-scoped exact-match grants: an interactive approval
 * pre-grants one command so a headless subagent may repeat it, until the
 * grant expires or is revoked.
 */

import type { AuditJournal } from "./audit-journal";

const GRANT_KEY_SEP = "\u0000";
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Session-scoped exact-match grants: an approval pre-grants one cwd+command
 * pair for headless reuse; never persisted, expired on a per-grant timer
 * and at session end.
 */
export class SessionGrants {
  private readonly grants = new Map<string, number>();
  private readonly journal?: AuditJournal;

  /**
   * Creates an empty grant store.
   *
   * @param journal optional audit journal; revocation records are appended to it.
   */
  constructor(journal?: AuditJournal) {
    this.journal = journal;
  }

  /**
   * Grants the exact command under the exact cwd for ttlMs milliseconds.
   * Each grant expires on its own clock from grant time, so an old approval
   * cannot authorize a later unrelated task.
   *
   * @param ttlMs lifetime of this grant, defaults to five minutes.
   */
  grant(command: string, cwd: string, ttlMs: number = DEFAULT_TTL_MS): void {
    this.grants.set(`${cwd}${GRANT_KEY_SEP}${command}`, Date.now() + ttlMs);
  }

  /**
   * Returns true only when the identical command was granted under the
   * identical cwd and the grant has not expired. Expired grants count as
   * absent and are dropped lazily here.
   */
  has(command: string, cwd: string): boolean {
    const key = `${cwd}${GRANT_KEY_SEP}${command}`;
    const expiresAt = this.grants.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.grants.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Revokes the exact grant, if present.
   *
   * @param command exact command to drop.
   * @param cwd exact cwd the grant was made under.
   */
  revoke(command: string, cwd: string): void {
    const key = `${cwd}${GRANT_KEY_SEP}${command}`;
    if (!this.grants.delete(key)) return;
    this.journal?.append({
      at: Date.now(),
      kind: "revocation",
      reason: `revoked ${command} in ${cwd}`,
    });
  }

  /**
   * Revokes every grant, journaling a single record when any existed.
   */
  revokeAll(): void {
    if (this.grants.size === 0) return;
    const count = this.grants.size;
    this.grants.clear();
    this.journal?.append({
      at: Date.now(),
      kind: "revocation",
      reason: `revoked all ${count} grants`,
    });
  }

  /** Drops every grant silently; used at session teardown. */
  clear(): void {
    this.grants.clear();
  }
}
