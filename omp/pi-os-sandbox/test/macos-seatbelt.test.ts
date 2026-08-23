/**
 * @fileoverview Seatbelt profile generation, backend probing, and the
 * sandbox-exec wrapper, exercised against temp-file fixtures.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backendStatus, buildSeatbeltProfile, execSandboxed, runChild } from "../src/macos-seatbelt";

const fixture = realpathSync(mkdtempSync(join(tmpdir(), "pi-os-sandbox-test-")));
const deniedDir = join(fixture, "denied");
const allowedDir = join(fixture, "allowed");
const fileRoot = join(fixture, "single-file.txt");

mkdirSync(deniedDir, { recursive: true });
mkdirSync(allowedDir, { recursive: true });
writeFileSync(join(deniedDir, "secret.txt"), "top secret");
writeFileSync(join(allowedDir, "note.txt"), "project note");
writeFileSync(fileRoot, "config secret");

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe("buildSeatbeltProfile", () => {
  test("starts from allow-all and adds deny lines per root", () => {
    const profile = buildSeatbeltProfile([deniedDir]);
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(allow default)");
    expect(profile).not.toContain("(deny default)");
    expect(profile).toContain(`(deny file-read* (subpath "${deniedDir}"))`);
    expect(profile).toContain(`(deny file-write* (subpath "${deniedDir}"))`);
    expect(profile).toContain(`(deny file-unlink (subpath "${deniedDir}"))`);
  });

  test("blocks reads of a single file root, not just directories", () => {
    const profile = buildSeatbeltProfile([fileRoot]);
    expect(profile).toContain(`(deny file-read* (subpath "${fileRoot}"))`);
  });

  test("emits one deny set per distinct root, duplicates collapse", () => {
    const profile = buildSeatbeltProfile([deniedDir, deniedDir, allowedDir]);
    const perRoot = profile.split("\n").filter((line) => line.startsWith("(deny"));
    expect(perRoot).toHaveLength(6);
  });
});

describe("backendStatus", () => {
  test("reports a boolean availability and a plain-language reason", async () => {
    const status = await backendStatus();
    expect(typeof status.available).toBe("boolean");
    expect(typeof status.reason).toBe("string");
  });
});

const backend = await backendStatus();

test.skipIf(backend.available)("reports the backend unavailable when sandbox-exec cannot confine", async () => {
  const status = await backendStatus();
  expect(status.available).toBe(false);
  expect(status.reason.length).toBeGreaterThan(0);
});

describe("runChild", () => {
  test("runs a command with the given cwd and env and captures output", async () => {
    const result = await runChild(["/bin/echo", "hello"], allowedDir, { SENTINEL: "present" }, 5_000);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  test("rejects when argv has no executable", async () => {
    expect(runChild([], allowedDir, {}, 5_000)).rejects.toThrow(/executable path/);
  });

  test("kills a hung child after the timeout instead of hanging", async () => {
    const result = await runChild(["/bin/sh", "-c", "sleep 5"], allowedDir, {}, 500);
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGKILL");
  }, 10_000);
});

describe.skipIf(!backend.available)("execSandboxed", () => {
  test("blocks reads inside a denied directory", async () => {
    const result = await execSandboxed(
      buildSeatbeltProfile([deniedDir]),
      ["/bin/cat", join(deniedDir, "secret.txt")],
      fixture,
      {},
      10_000,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Operation not permitted");
  });

  test("allows reads outside the denied roots", async () => {
    const result = await execSandboxed(
      buildSeatbeltProfile([deniedDir]),
      ["/bin/cat", join(allowedDir, "note.txt")],
      fixture,
      {},
      10_000,
    );
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("project note");
  });

  test("blocks reads of a denied single file", async () => {
    const result = await execSandboxed(
      buildSeatbeltProfile([fileRoot]),
      ["/bin/cat", fileRoot],
      fixture,
      {},
      10_000,
    );
    expect(result.code).not.toBe(0);
  });

  test("blocks writes, unlink, and rename inside a denied directory", async () => {
    const profile = buildSeatbeltProfile([deniedDir]);
    const write = await execSandboxed(
      profile,
      ["/bin/sh", "-c", `echo x >> ${join(deniedDir, "secret.txt")}`],
      fixture,
      {},
      10_000,
    );
    expect(write.code).not.toBe(0);
    const unlink = await execSandboxed(profile, ["/bin/rm", join(deniedDir, "secret.txt")], fixture, {}, 10_000);
    expect(unlink.code).not.toBe(0);
    const rename = await execSandboxed(
      profile,
      ["/bin/mv", join(deniedDir, "secret.txt"), join(deniedDir, "moved.txt")],
      fixture,
      {},
      10_000,
    );
    expect(rename.code).not.toBe(0);
    expect(rename.stderr).toContain("Operation not permitted");
  });

  test("keeps nested children inside the boundary", async () => {
    const result = await execSandboxed(
      buildSeatbeltProfile([deniedDir]),
      ["/bin/sh", "-c", `/bin/cat ${join(deniedDir, "secret.txt")}`],
      fixture,
      {},
      10_000,
    );
    expect(result.code).not.toBe(0);
  });
});
