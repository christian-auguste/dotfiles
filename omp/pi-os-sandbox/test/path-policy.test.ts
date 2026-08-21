/**
 * @fileoverview Path canonicalization, root matching, and safety-state
 * mention detection.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalize,
  isWithin,
  mentionsSafetyState,
  pathArguments,
  protectedPath,
  resolveProtectedPath,
} from "../src/path-policy";

const tmp = mkdtempSync(path.join(os.tmpdir(), "path-policy-"));
const realRoot = path.join(tmp, "protected");
mkdirSync(realRoot);
const linkRoot = path.join(tmp, "protected-link");
symlinkSync(realRoot, linkRoot);
const savedHome = process.env.HOME;
process.env.HOME = tmp;

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("canonicalize", () => {
  test("collapses .. segments", () => {
    expect(canonicalize(path.join(tmp, "a", "..", "b"))).toBe(path.join(realpathSync(tmp), "b"));
  });

  test("preserves a single non-existent suffix segment", () => {
    const existing = path.join(tmp, "exists");
    mkdirSync(existing);
    expect(canonicalize(path.join(existing, "nope"))).toBe(path.join(realpathSync(existing), "nope"));
  });

  test("preserves a multi-segment non-existent suffix in order", () => {
    expect(canonicalize(path.join(tmp, "deep", "a", "b", "c"))).toBe(
      path.join(realpathSync(tmp), "deep", "a", "b", "c"),
    );
  });

  test("resolves an existing symlink into its real path", () => {
    const file = path.join(realRoot, "file.txt");
    writeFileSync(file, "x");
    expect(canonicalize(path.join(linkRoot, "file.txt"))).toBe(realpathSync(file));
  });

  test("preserves a dangling symlink as a non-existent suffix", () => {
    const dangling = path.join(tmp, "dangling");
    symlinkSync(path.join(tmp, "missing-target"), dangling);
    expect(canonicalize(dangling)).toBe(path.join(realpathSync(tmp), "dangling"));
  });
});

describe("isWithin", () => {
  const parent = path.join(tmp, "a");
  const child = path.join(tmp, "a", "b");
  test("child equals parent", () => {
    expect(isWithin(parent, parent)).toBe(true);
  });
  test("child is under parent", () => {
    expect(isWithin(child, parent)).toBe(true);
    expect(isWithin(path.join(child, "c", "d"), parent)).toBe(true);
  });
  test("sibling is not within", () => {
    expect(isWithin(path.join(tmp, "a-b"), parent)).toBe(false);
  });
  test("parent is not within child", () => {
    expect(isWithin(parent, child)).toBe(false);
  });
  test("unrelated path is not within", () => {
    expect(isWithin(path.join(tmp, "x"), parent)).toBe(false);
  });
});

describe("pathArguments", () => {
  test("collects matching keys at any nesting depth", () => {
    const input = {
      path: "/p",
      paths: ["/p1", "/p2"],
      dst: "/dst",
      dest: "/dest",
      destination: "/destination",
      source: "/src",
      from: "/from",
      to: "/to",
      nested: {
        deeper: { path: "/nested" },
        list: [{ to: "/in-array" }],
      },
    };
    expect(pathArguments(input)).toEqual([
      "/p",
      "/p1",
      "/p2",
      "/dst",
      "/dest",
      "/destination",
      "/src",
      "/from",
      "/to",
      "/nested",
      "/in-array",
    ]);
  });

  test("matches keys case-insensitively and as suffixes", () => {
    expect(pathArguments({ PATH: "/upper", destination: "/d", filepath: "/fp" })).toEqual([
      "/upper",
      "/d",
      "/fp",
    ]);
  });

  test("ignores non-matching keys and non-string values", () => {
    expect(pathArguments({ name: "/n", data: "/d", path: 42, mode: "/m", to: null })).toEqual([]);
  });

  test("top-level string is not collected", () => {
    expect(pathArguments("/bare")).toEqual([]);
  });
});

describe("protectedPath", () => {
  const roots = [realRoot];
  test("path inside a root", () => {
    expect(protectedPath(path.join(realRoot, "deep", "file"), tmp, roots)).toBe(true);
  });
  test("path equal to a root", () => {
    expect(protectedPath(realRoot, tmp, roots)).toBe(true);
  });
  test("path outside all roots", () => {
    expect(protectedPath(path.join(tmp, "other", "file"), tmp, roots)).toBe(false);
  });
  test("sibling of a root is not protected", () => {
    expect(protectedPath(path.join(tmp, "protected-other"), tmp, roots)).toBe(false);
  });
  test("expands ~/ using HOME", () => {
    expect(protectedPath("~/protected/file", tmp, roots)).toBe(true);
  });
  test("expands $HOME/ using HOME", () => {
    expect(protectedPath("$HOME/protected/file", tmp, roots)).toBe(true);
  });
  test("does not expand ~foo or $HOMEfoo", () => {
    expect(protectedPath("~foo/protected", tmp, roots)).toBe(false);
    expect(protectedPath("$HOMEfoo/protected", tmp, roots)).toBe(false);
  });
  test("resolves relative paths against cwd", () => {
    expect(protectedPath("protected/file", tmp, roots)).toBe(true);
    expect(protectedPath("protected/file", path.join(tmp, "elsewhere"), roots)).toBe(false);
  });
  test("resolves a symlink into a root", () => {
    expect(protectedPath(path.join(linkRoot, "file"), tmp, roots)).toBe(true);
  });
});

describe("mentionsSafetyState", () => {
  const configRoot = path.join(tmp, ".omp", "agent", "config.yml");
  const customRoot = path.join(tmp, "custom", "place");
  const markerOf = (root: string): string => root.split("/").filter(Boolean).join("/").toLowerCase();
  const roots = [realRoot, configRoot];
  test("hits a root-derived marker substring", () => {
    expect(mentionsSafetyState(`update ${markerOf(configRoot)}`, tmp, roots)).toBe(true);
  });
  test("marker match is case-insensitive", () => {
    expect(mentionsSafetyState(`UPDATE ${markerOf(configRoot).toUpperCase()}`, tmp, roots)).toBe(true);
  });
  test("derives markers from root segments, not hardcoded strings", () => {
    expect(mentionsSafetyState(`touch ${markerOf(customRoot)}`, tmp, [customRoot])).toBe(true);
    expect(mentionsSafetyState(`touch ${markerOf(customRoot)}`, tmp, roots)).toBe(false);
  });
  test("misses when neither marker nor path matches", () => {
    expect(mentionsSafetyState("unrelated text", tmp, roots)).toBe(false);
  });
  test("falls back to protectedPath for direct paths", () => {
    expect(mentionsSafetyState(path.join(realRoot, "file"), tmp, roots)).toBe(true);
  });
  test("expands HOME for the path check", () => {
    expect(mentionsSafetyState("$HOME/protected/file", tmp, roots)).toBe(true);
  });
});

const credRoot = path.join(tmp, "credentials");
const safetyRoot = path.join(tmp, "safety");
mkdirSync(credRoot);
mkdirSync(safetyRoot);

describe("resolveProtectedPath", () => {
  const roots = [credRoot, safetyRoot];
  test("returns the matching canonicalized root", () => {
    expect(resolveProtectedPath(path.join(credRoot, "key"), tmp, roots)).toBe(canonicalize(credRoot));
    expect(resolveProtectedPath(path.join(safetyRoot, "policy"), tmp, roots)).toBe(canonicalize(safetyRoot));
  });
  test("matches the root itself", () => {
    expect(resolveProtectedPath(credRoot, tmp, roots)).toBe(canonicalize(credRoot));
  });
  test("returns null outside all roots", () => {
    expect(resolveProtectedPath(path.join(tmp, "unrelated"), tmp, roots)).toBeNull();
  });
  test("resolves symlinks before matching", () => {
    expect(resolveProtectedPath(path.join(linkRoot, "file"), tmp, [realRoot])).toBe(canonicalize(realRoot));
  });
});
