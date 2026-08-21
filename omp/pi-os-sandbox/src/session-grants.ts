/**
 * @fileoverview Session-scoped exact-match grants: an interactive approval
 * pre-grants one command so a headless subagent may repeat it.
 */

/**
 * Session-scoped exact-match grants: an approval pre-grants one cwd+command
 * pair for headless reuse; never persisted, expired at session end.
 */
const GRANT_KEY_SEP = "\u0000";

export class SessionGrants {
  private readonly grants = new Set<string>();

  /** Grants the exact command under the exact cwd. */
  grant(command: string, cwd: string): void {
    this.grants.add(`${cwd}${GRANT_KEY_SEP}${command}`);
  }

  /** Returns true only when the identical command was granted under the identical cwd. */
  has(command: string, cwd: string): boolean {
    return this.grants.has(`${cwd}${GRANT_KEY_SEP}${command}`);
  }

  /** Drops every grant. */
  clear(): void {
    this.grants.clear();
  }
}
