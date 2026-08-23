/**
 * @fileoverview In-memory denial ring: newest-first ordering, size cap,
 * copied reads, and the compact diagnostic summary.
 */

import { describe, expect, test } from "bun:test";
import { DenialRing } from "../src/block-feedback";

describe("DenialRing", () => {
  test("records entries and returns them newest first", () => {
    const ring = new DenialRing();
    ring.record({ kind: "block", rule: "root-deletion", tool: "bash", reason: "Blocked: root deletion." });
    ring.record({ kind: "prompt", rule: "recursive-cleanup", tool: "bash", reason: "Prompt text." });

    const entries = ring.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.kind).toBe("prompt");
    expect(entries[0]!.rule).toBe("recursive-cleanup");
    expect(entries[0]!.tool).toBe("bash");
    expect(entries[1]!.kind).toBe("block");
    expect(entries[1]!.rule).toBe("root-deletion");
    expect(typeof entries[0]!.at).toBe("number");
    expect(entries[0]!.at).toBeGreaterThan(0);
  });

  test("caps at 100 entries, keeping the newest", () => {
    const ring = new DenialRing();
    for (let i = 0; i < 150; i++) {
      ring.record({ kind: "block", rule: "force-push", tool: "bash", reason: `entry ${i}` });
    }
    const entries = ring.entries();
    expect(entries).toHaveLength(100);
    expect(entries[0]!.reason).toBe("entry 149");
    expect(entries[99]!.reason).toBe("entry 50");
  });

  test("summary is a compact one-line diagnostic", () => {
    const ring = new DenialRing();
    expect(ring.summary()).toBe("denial ring: 0 entries");

    ring.record({ kind: "block", rule: "root-deletion", tool: "bash", reason: "x" });
    ring.record({ kind: "block", rule: "force-push", tool: "bash", reason: "y" });
    ring.record({ kind: "grant", rule: "recursive-cleanup", tool: "bash", reason: "z" });

    const summary = ring.summary();
    expect(summary).toContain("3 entries");
    expect(summary).toContain("block:2");
    expect(summary).toContain("grant:1");
    expect(summary).toContain("latest grant recursive-cleanup on bash");
  });

  test("entries returns a copy, not the internal array", () => {
    const ring = new DenialRing();
    ring.record({ kind: "block", rule: "root-deletion", tool: "bash", reason: "x" });
    const entries = ring.entries();
    entries.push({ at: 0, kind: "grant", rule: "force-push", tool: "bash", reason: "y" });
    expect(ring.entries()).toHaveLength(1);
  });
});
