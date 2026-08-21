/**
 * @fileoverview Config defaults, merge semantics, and validation errors.
 */

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defaultConfig, loadConfig } from "../src/config";

const HOME = resolve(homedir());

describe("defaultConfig", () => {
  test("resolves $HOME and includes all listed safety roots", () => {
    expect(defaultConfig().safetyRoots).toEqual([
      resolve(HOME, ".omp", "agent", "extensions"),
      resolve(HOME, ".omp", "agent", "config.yml"),
      resolve(HOME, ".omp", "agent", "pi-os-sandbox.json"),
      resolve(HOME, ".pi", "agent"),
      resolve(HOME, ".agents", "AGENTS.md"),
    ]);
  });

  test("resolves $HOME and includes all listed credential roots", () => {
    expect(defaultConfig().credentialRoots).toEqual([
      resolve(HOME, ".ssh"),
      resolve(HOME, ".gitconfig"),
      resolve(HOME, ".aws"),
      resolve(HOME, ".gnupg"),
      resolve(HOME, ".docker", "config.json"),
      resolve(HOME, ".kube", "config"),
    ]);
  });

  test("metadataHosts are deny-only targets", () => {
    const { metadataHosts } = defaultConfig();
    for (const target of ["169.254.169.254", "169.254.170.2", "169.254.170.23", "100.100.100.200", "metadata.google.internal"]) {
      expect(metadataHosts.some((r) => r.test(target))).toBe(true);
    }
    expect(metadataHosts.some((r) => r.test("example.com"))).toBe(false);
  });
});

describe("loadConfig", () => {
  test("undefined, null, and empty object fall back to defaults", () => {
    const expected = defaultConfig();
    expect(loadConfig(undefined)).toEqual(expected);
    expect(loadConfig(null)).toEqual(expected);
    expect(loadConfig({})).toEqual(expected);
  });

  test("present root arrays replace defaults wholesale; missing keys keep defaults", () => {
    const cfg = loadConfig({ safetyRoots: ["/custom/safety"], credentialRoots: [] });
    expect(cfg.safetyRoots).toEqual(["/custom/safety"]);
    expect(cfg.credentialRoots).toEqual([]);
    expect(cfg.metadataHosts).toEqual(defaultConfig().metadataHosts);
  });

  test("non-object input throws", () => {
    expect(() => loadConfig("x")).toThrow();
    expect(() => loadConfig([1, 2])).toThrow();
  });

  test("invalid root types throw", () => {
    expect(() => loadConfig({ safetyRoots: "x" })).toThrow();
    expect(() => loadConfig({ safetyRoots: [""] })).toThrow();
    expect(() => loadConfig({ credentialRoots: [42] })).toThrow();
  });

  test("invalid regex source throws", () => {
    expect(() => loadConfig({ metadataHosts: ["["] })).toThrow(/metadataHosts/);
  });

  test("metadataHosts accepts string sources and RegExp instances, compiled fresh", () => {
    const source = new RegExp("169\\.254\\.169\\.254");
    const cfg = loadConfig({ metadataHosts: ["169\\.254\\.170\\.2", source] });
    expect(cfg.metadataHosts).toHaveLength(2);
    expect(cfg.metadataHosts[0]!.test("169.254.170.2")).toBe(true);
    expect(cfg.metadataHosts[1]!.test("169.254.169.254")).toBe(true);
    expect(cfg.metadataHosts[1]).not.toBe(source);
  });

  test("returns a fresh object; mutating it does not affect defaults", () => {
    const baseline = defaultConfig();
    const cfg = loadConfig({});
    cfg.safetyRoots.push("/mutated");
    cfg.credentialRoots[0] = "/mutated";
    cfg.metadataHosts.push(/mutated/);
    expect(baseline.safetyRoots).not.toContain("/mutated");
    expect(baseline.credentialRoots[0]).not.toBe("/mutated");
    expect(baseline.metadataHosts).toHaveLength(5);
    expect(defaultConfig()).toEqual(baseline);
  });
});
