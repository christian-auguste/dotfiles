/**
 * @fileoverview In-memory policy activity: newest-first ordering, size cap,
 * copied reads, and the compact diagnostic summary.
 */

import { describe, expect, test } from "bun:test";
import { PolicyActivity } from "../src/block-feedback";

describe("PolicyActivity", () => {
  test("records entries and returns them newest first", () => {
    const activity = new PolicyActivity();
    activity.record({ kind: "block", rule: "delete-filesystem-root", tool: "bash", reason: "Blocked: root deletion." });
    activity.record({ kind: "prompt", rule: "run-recursive-cleanup", tool: "bash", reason: "Prompt text." });

    const entries = activity.entries();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.kind).toBe("prompt");
    expect(entries[0]!.rule).toBe("run-recursive-cleanup");
    expect(entries[0]!.tool).toBe("bash");
    expect(entries[1]!.kind).toBe("block");
    expect(entries[1]!.rule).toBe("delete-filesystem-root");
    expect(typeof entries[0]!.at).toBe("number");
    expect(entries[0]!.at).toBeGreaterThan(0);
  });

  test("caps at 100 entries, keeping the newest", () => {
    const activity = new PolicyActivity();
    for (let i = 0; i < 150; i++) {
      activity.record({ kind: "block", rule: "force-push", tool: "bash", reason: `entry ${i}` });
    }
    const entries = activity.entries();
    expect(entries).toHaveLength(100);
    expect(entries[0]!.reason).toBe("entry 149");
    expect(entries[99]!.reason).toBe("entry 50");
  });

  test("summary is a compact one-line diagnostic", () => {
    const activity = new PolicyActivity();
    expect(activity.summary()).toBe("policy activity: 0 entries");

    activity.record({ kind: "block", rule: "delete-filesystem-root", tool: "bash", reason: "x" });
    activity.record({ kind: "block", rule: "force-push", tool: "bash", reason: "y" });
    activity.record({ kind: "grant", rule: "run-recursive-cleanup", tool: "bash", reason: "z" });

    const summary = activity.summary();
    expect(summary).toContain("3 entries");
    expect(summary).toContain("block:2");
    expect(summary).toContain("grant:1");
    expect(summary).toContain("latest grant run-recursive-cleanup on bash");
  });

  test("entries returns a copy, not the internal array", () => {
    const activity = new PolicyActivity();
    activity.record({ kind: "block", rule: "delete-filesystem-root", tool: "bash", reason: "x" });
    const entries = activity.entries();
    entries.push({ at: 0, kind: "grant", rule: "force-push", tool: "bash", reason: "y" });
    expect(activity.entries()).toHaveLength(1);
  });
});
