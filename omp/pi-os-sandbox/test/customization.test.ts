/**
 * @fileoverview Rule registry completeness, group grouping, safety floor, and
 * operator toggle persistence against temp config paths.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadDisabledRules,
  ruleInfo,
  ruleRegistry,
  saveDisabledRules,
} from "../src/customization";

const EXPECTED_IDS = [
  "delete-filesystem-root",
  "destroy-system",
  "destroy-device",
  "download-and-run-code",
  "read-credentials",
  "request-cloud-metadata",
  "access-sandbox-state",
  "reject-unverifiable-input",
  "destroy-database",
  "run-recursive-cleanup",
  "force-push",
  "run-hidden-destructive-code",
  "write-credentials",
  "write-instruction-files",
  "access-instruction-files",
];

const HARD_FLOOR_IDS = EXPECTED_IDS.slice(0, 9);

describe("ruleRegistry", () => {
  test("lists every stable rule id", () => {
    expect(ruleRegistry().map((rule) => rule.id)).toEqual(EXPECTED_IDS);
  });

  test("every rule has display text and a next-step hint", () => {
    for (const rule of ruleRegistry()) {
      expect(rule.name.length).toBeGreaterThan(0);
      expect(rule.description.length).toBeGreaterThan(0);
      expect(rule.nextStep.length).toBeGreaterThan(0);
    }
  });

  test("isSafetyFloor matches the safety-floor group", () => {
    for (const rule of ruleRegistry()) {
      expect(rule.isSafetyFloor).toBe(rule.group === "safety-floor");
    }
    expect(ruleRegistry().filter((rule) => rule.isSafetyFloor).map((rule) => rule.id)).toEqual(
      HARD_FLOOR_IDS,
    );
  });

  test("rules group into the three customization groups", () => {
    const idsByGroup = (group: string) =>
      ruleRegistry().filter((rule) => rule.group === group).map((rule) => rule.id);
    expect(idsByGroup("safety-floor")).toEqual(HARD_FLOOR_IDS);
    expect(idsByGroup("prompt-classes")).toEqual(["run-recursive-cleanup", "force-push", "run-hidden-destructive-code"]);
    expect(idsByGroup("path-policy")).toEqual(["write-credentials", "write-instruction-files", "access-instruction-files"]);
  });
});

describe("ruleInfo", () => {
  test("finds registered ids", () => {
    for (const id of EXPECTED_IDS) {
      expect(ruleInfo(id)?.id).toBe(id);
    }
  });

  test("returns undefined for unknown ids", () => {
    expect(ruleInfo("no-such-rule")).toBeUndefined();
  });
});

describe("operator toggles", () => {
  /** Fresh config path under a temp home, so no test touches the real one. */
  function freshConfigPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-os-custom-"));
    return path.join(dir, ".omp", "agent", "pi-os-sandbox.json");
  }

  test("loadDisabledRules defaults to empty when the config is missing", () => {
    expect(loadDisabledRules(freshConfigPath())).toEqual(new Set());
  });

  test("saveDisabledRules merges into the existing operator config", () => {
    const configPath = freshConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ safetyRoots: ["/keep"] }), "utf8");

    saveDisabledRules(new Set(["force-push"]), configPath);

    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(raw).toEqual({ safetyRoots: ["/keep"], disabledRules: ["force-push"] });
    expect(loadDisabledRules(configPath)).toEqual(new Set(["force-push"]));
  });

  test("disabled rules round-trip through save and load", () => {
    const configPath = freshConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    saveDisabledRules(new Set(["delete-filesystem-root", "write-credentials"]), configPath);
    expect(loadDisabledRules(configPath)).toEqual(new Set(["delete-filesystem-root", "write-credentials"]));
  });

  test("loadDisabledRules tolerates a malformed config", () => {
    const configPath = freshConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "{not json", "utf8");
    expect(loadDisabledRules(configPath)).toEqual(new Set());
  });

  test("loadDisabledRules keeps only string entries", () => {
    const configPath = freshConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ disabledRules: ["force-push", 42, null] }),
      "utf8",
    );
    expect(loadDisabledRules(configPath)).toEqual(new Set(["force-push"]));
  });

  test("saveDisabledRules overwrites the disabled list but keeps other keys", () => {
    const configPath = freshConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    saveDisabledRules(new Set(["force-push"]), configPath);
    saveDisabledRules(new Set(["delete-filesystem-root"]), configPath);
    expect(loadDisabledRules(configPath)).toEqual(new Set(["delete-filesystem-root"]));
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
      disabledRules: ["delete-filesystem-root"],
    });
  });
});
