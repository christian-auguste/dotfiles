/**
 * @fileoverview Session grants: per-grant expiry, revocation, and
 * backward-compatible grant/has/clear behavior.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditJournal } from "../src/audit-journal";
import { SessionGrants } from "../src/session-grants";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SessionGrants expiry", () => {
  test("grant matches immediately and holds until the TTL passes", () => {
    const grants = new SessionGrants();
    grants.grant("rm -rf node_modules", "/repo", 60_000);
    expect(grants.has("rm -rf node_modules", "/repo")).toBe(true);
  });

  test("an expired grant counts as absent", async () => {
    const grants = new SessionGrants();
    grants.grant("rm -rf node_modules", "/repo", 5);
    await sleep(20);
    expect(grants.has("rm -rf node_modules", "/repo")).toBe(false);
  });

  test("expiry is per grant: an old grant expires while a newer one holds", async () => {
    const grants = new SessionGrants();
    grants.grant("rm -rf node_modules", "/repo", 5);
    await sleep(20);
    grants.grant("rm -rf dist", "/repo", 60_000);
    expect(grants.has("rm -rf node_modules", "/repo")).toBe(false);
    expect(grants.has("rm -rf dist", "/repo")).toBe(true);
  });

  test("default TTL grants are alive right after granting", () => {
    const grants = new SessionGrants();
    grants.grant("git clean -fdx", "/repo");
    expect(grants.has("git clean -fdx", "/repo")).toBe(true);
  });

  test("grant/has/clear stay backward compatible", () => {
    const grants = new SessionGrants();
    grants.grant("rm -rf dist", "/repo");
    expect(grants.has("rm -rf dist", "/repo")).toBe(true);
    expect(grants.has("rm -rf dist", "/other")).toBe(false);
    expect(grants.has("rm -rf node_modules", "/repo")).toBe(false);
    grants.clear();
    expect(grants.has("rm -rf dist", "/repo")).toBe(false);
  });
});

describe("SessionGrants revocation", () => {
  test("revoke removes only the exact cwd+command pair", () => {
    const grants = new SessionGrants();
    grants.grant("rm -rf node_modules", "/repo");
    grants.grant("rm -rf dist", "/repo");
    grants.revoke("rm -rf node_modules", "/repo");
    expect(grants.has("rm -rf node_modules", "/repo")).toBe(false);
    expect(grants.has("rm -rf dist", "/repo")).toBe(true);
  });

  test("revoke of a missing grant is a no-op", () => {
    const grants = new SessionGrants();
    grants.revoke("rm -rf node_modules", "/repo");
    expect(grants.has("rm -rf node_modules", "/repo")).toBe(false);
  });

  test("revokeAll clears every grant", () => {
    const grants = new SessionGrants();
    grants.grant("a", "/repo");
    grants.grant("b", "/repo");
    grants.revokeAll();
    expect(grants.has("a", "/repo")).toBe(false);
    expect(grants.has("b", "/repo")).toBe(false);
  });

  test("revokeAll on an empty store is a no-op", () => {
    const grants = new SessionGrants();
    grants.revokeAll();
    expect(grants.has("anything", "/repo")).toBe(false);
  });

  test("revoke journals the revocation with the reason redacted", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-os-grants-"));
    try {
      const journal = new AuditJournal(join(dir, "audit.jsonl"));
      const grants = new SessionGrants(journal);
      grants.grant("curl https://api.example.com?token=sk-12345678901234567890123456789012", "/repo");
      grants.revoke("curl https://api.example.com?token=sk-12345678901234567890123456789012", "/repo");
      const records = journal.entries();
      expect(records).toHaveLength(1);
      expect(records[0]!.kind).toBe("revocation");
      expect(records[0]!.reason).not.toContain("sk-12345678901234567890123456789012");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("revokeAll journals one revocation when grants existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-os-grants-"));
    try {
      const journal = new AuditJournal(join(dir, "audit.jsonl"));
      const grants = new SessionGrants(journal);
      grants.grant("a", "/repo");
      grants.revokeAll();
      expect(journal.entries()).toHaveLength(1);
      expect(journal.entries()[0]!.reason).toBe("revoked all 1 grants");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
