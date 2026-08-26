/**
 * @fileoverview Audit journal: redacted append-only persistence, replay,
 * bounding, torn-line tolerance, write-failure safety, and the policy-activity
 * mirror.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditJournal, DEFAULT_JOURNAL_PATH } from "../src/audit-journal";
import { PolicyActivity } from "../src/block-feedback";
import { defaultConfig } from "../src/config";
import { protectedPath } from "../src/path-policy";

const fixture = mkdtempSync(join(tmpdir(), "pi-os-audit-"));

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe("AuditJournal", () => {
  test("appends and replays records in chronological order", () => {
    const path = join(fixture, "roundtrip.jsonl");
    const journal = new AuditJournal(path);
    journal.append({ at: 1, kind: "denial", rule: "delete-filesystem-root", tool: "bash", reason: "blocked rm -rf /" });
    journal.append({ at: 2, kind: "grant", rule: "run-recursive-cleanup", tool: "bash", reason: "approved rm -rf node_modules" });

    const replayed = new AuditJournal(path).entries();
    expect(replayed).toHaveLength(2);
    expect(replayed[0]).toEqual({
      at: 1,
      kind: "denial",
      rule: "delete-filesystem-root",
      tool: "bash",
      reason: "blocked rm -rf /",
    });
    expect(replayed[1]!.kind).toBe("grant");
  });

  test("redacts secret-shaped text before writing", () => {
    const path = join(fixture, "redacted.jsonl");
    const journal = new AuditJournal(path);
    journal.append({
      at: 1,
      kind: "denial",
      rule: "download-and-run-code",
      tool: "bash",
      reason: "token=sk-12345678901234567890123456789012 in url",
    });

    const records = new AuditJournal(path).entries();
    expect(records[0]!.reason).toContain("[redacted]");
    expect(records[0]!.reason).not.toContain("sk-12345678901234567890123456789012");
  });

  test("bounds the file to the newest 2000 entries", () => {
    const path = join(fixture, "bounded.jsonl");
    const journal = new AuditJournal(path);
    for (let i = 0; i < 2100; i++) {
      journal.append({ at: i, kind: "denial", rule: "force-push", tool: "bash", reason: `entry ${i}` });
    }

    const records = new AuditJournal(path).entries();
    expect(records).toHaveLength(2000);
    expect(records[1999]!.reason).toBe("entry 2099");
    expect(records[0]!.reason).toBe("entry 100");
  });

  test("a missing journal reads as empty", () => {
    const journal = new AuditJournal(join(fixture, "never-created.jsonl"));
    expect(journal.entries()).toEqual([]);
  });

  test("skips torn lines from a crash mid-write", () => {
    const path = join(fixture, "torn.jsonl");
    writeFileSync(path, '{"at":1,"kind":"grant","reason":"ok"}\n{"at":2,"kind":"den","reason":"cut off\n', "utf8");
    const journal = new AuditJournal(path);
    journal.append({ at: 3, kind: "toggle", rule: "force-push", reason: "disabled by operator" });

    const records = journal.entries();
    expect(records).toHaveLength(2);
    expect(records[0]!.reason).toBe("ok");
    expect(records[1]!.kind).toBe("toggle");
  });

  test("a write failure is logged, never thrown, and policy data is lost but reads stay safe", () => {
    const blocker = join(fixture, "blocker.jsonl");
    writeFileSync(blocker, "file", "utf8");
    const journal = new AuditJournal(join(blocker, "audit.jsonl"));
    expect(() => journal.append({ at: 1, kind: "grant", reason: "x" })).not.toThrow();
    expect(journal.entries()).toEqual([]);
  });

  test("default journal path lives inside a safety root", () => {
    expect(protectedPath(DEFAULT_JOURNAL_PATH, "/", defaultConfig().safetyRoots)).toBe(true);
  });
});

describe("PolicyActivity with journal", () => {
  test("records mirror to the journal with mapped kinds", () => {
    const path = join(fixture, "ring.jsonl");
    const activity = new PolicyActivity(new AuditJournal(path));
    activity.record({ kind: "block", rule: "delete-filesystem-root", tool: "bash", reason: "rm -rf /" });
    activity.record({ kind: "prompt", rule: "run-recursive-cleanup", tool: "bash", reason: "cleanup" });
    activity.record({ kind: "grant", rule: "run-recursive-cleanup", tool: "bash", reason: "approved" });
    activity.record({ kind: "toggle", rule: "force-push", tool: "bash", reason: "disabled by operator" });

    const records = new AuditJournal(path).entries();
    expect(records.map((record) => record.kind)).toEqual(["denial", "denial", "grant", "toggle"]);
  });

  test("journal reasons are redacted even when the activity entry is not", () => {
    const path = join(fixture, "ring-redacted.jsonl");
    const activity = new PolicyActivity(new AuditJournal(path));
    activity.record({ kind: "block", rule: "download-and-run-code", tool: "bash", reason: "api_key=AKIA0123456789ABCDEF call" });

    const records = new AuditJournal(path).entries();
    expect(records[0]!.reason).toContain("[redacted]");
  });

  test("public API is unchanged: entries() and summary() work with a journal", () => {
    const activity = new PolicyActivity(new AuditJournal(join(fixture, "ring-api.jsonl")));
    activity.record({ kind: "block", rule: "delete-filesystem-root", tool: "bash", reason: "x" });
    expect(activity.entries()).toHaveLength(1);
    expect(activity.entries()[0]!.kind).toBe("block");
    expect(activity.summary()).toContain("1 entries");
  });

  test("records persist across instances via the journal file", () => {
    const path = join(fixture, "ring-persist.jsonl");
    new PolicyActivity(new AuditJournal(path)).record({
      kind: "grant",
      rule: "run-recursive-cleanup",
      tool: "bash",
      reason: "approved",
    });

    const records = new AuditJournal(path).entries();
    expect(records).toHaveLength(1);
    expect(records[0]!.kind).toBe("grant");
  });
});
