/**
 * @fileoverview Append-only audit journal for policy decisions, persisted
 * under an agent-unwritable path with redaction and a hard size bound.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { redact } from "./redaction";

/** What the journaled event was. */
export type JournalKind = "grant" | "denial" | "revocation" | "toggle";

/** One journaled policy event. The reason is redacted before it reaches disk. */
export interface JournalRecord {
  /** Date.now() at record time. */
  at: number;
  /** What happened: grant, denial, revocation, or toggle. */
  kind: JournalKind;
  /** Rule id when a rule is involved, absent otherwise. */
  rule?: string;
  /** Tool name when a tool is involved, absent otherwise. */
  tool?: string;
  /** Redacted human-readable detail. */
  reason: string;
}

/** The journal keeps only the newest records and rewrites the file past this cap. */
const MAX_ENTRIES = 2000;

/**
 * Default journal path. Lives under ~/.pi/agent, which the default config
 * lists as a safety root, so the agent's own file tools cannot write it.
 */
export const DEFAULT_JOURNAL_PATH = resolve(homedir(), ".pi", "agent", "pi-os-sandbox-audit.jsonl");

/**
 * Append-only JSONL journal of policy decisions. Writes are best-effort: a
 * failed write is logged and the caller's policy path continues. Reads skip
 * torn lines left by a crash mid-write.
 */
export class AuditJournal {
  private readonly path: string;
  private readonly log: (message: string) => void;
  private count = -1;

  /**
   * Opens the journal at path.
   *
   * @param path journal file, defaults to the operator journal path.
   * @param log error sink, defaults to stderr.
   */
  constructor(path: string = DEFAULT_JOURNAL_PATH, log: (message: string) => void = console.error) {
    this.path = path;
    this.log = log;
  }

  /**
   * Appends one redacted record, bounding the file to the newest entries.
   * Never throws: on any write failure it logs and continues.
   */
  append(record: JournalRecord): void {
    try {
      const line = `${JSON.stringify({ ...record, reason: redact(record.reason) })}\n`;
      mkdirSync(dirname(this.path), { recursive: true });
      if (this.count < 0) this.count = this.entries().length;
      if (this.count >= MAX_ENTRIES) {
        this.trimToNewest(MAX_ENTRIES - 1);
        this.count = MAX_ENTRIES - 1;
      }
      appendFileSync(this.path, line, "utf8");
      this.count += 1;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log(`pi-os-sandbox: audit journal write failed, continuing: ${redact(detail)}`);
    }
  }

  /**
   * Returns every record in chronological order. An unreadable journal reads
   * as empty and torn lines are skipped. Never throws.
   */
  entries(): JournalRecord[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const records: JournalRecord[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      try {
        records.push(JSON.parse(line) as JournalRecord);
      } catch {
        // Torn line from a crash mid-write: skip it.
      }
    }
    return records;
  }

  /** Rewrites the file keeping only the newest records. */
  private trimToNewest(keep: number): void {
    const records = this.entries();
    if (records.length <= keep) return;
    const kept = records.slice(records.length - keep);
    writeFileSync(this.path, `${kept.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  }
}
