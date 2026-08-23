/**
 * @fileoverview Child spawn seam: fail-closed sandboxed mode, working
 * explicit opt-out, environment scrubbing, and timeouts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backendStatus } from "../src/macos-seatbelt";
import { ensureBackendAvailable, sandboxedSpawn, scrubCredentialEnv } from "../src/child-spawn";

const fixture = realpathSync(mkdtempSync(join(tmpdir(), "pi-os-sandbox-spawn-")));
const projectDir = join(fixture, "project");
const home = resolve(fixture, "home");

beforeAll(() => {
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "fake key");
  writeFileSync(join(projectDir, "task.txt"), "project file");
});

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

const baseEnv = { SENTINEL: "present", HOME: home, PATH: "/usr/bin:/bin" };

describe("ensureBackendAvailable", () => {
  test("throws a plain-language error when the backend cannot confine", () => {
    expect(() =>
      ensureBackendAvailable({ available: false, reason: "sandbox-exec probe failed" }),
    ).toThrow(/blocked instead of running unprotected/);
  });

  test("passes when the backend is available", () => {
    expect(() => ensureBackendAvailable({ available: true, reason: "" })).not.toThrow();
  });
});

describe("scrubCredentialEnv", () => {
  test("removes variables that point at credential stores or agents", () => {
    const scrubbed = scrubCredentialEnv({
      ...baseEnv,
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      AWS_SHARED_CREDENTIALS_FILE: "/tmp/creds",
      KUBECONFIG: "/tmp/kube",
    });
    expect(scrubbed.SENTINEL).toBe("present");
    expect(scrubbed.HOME).toBe(home);
    expect("SSH_AUTH_SOCK" in scrubbed).toBe(false);
    expect("AWS_SHARED_CREDENTIALS_FILE" in scrubbed).toBe(false);
    expect("KUBECONFIG" in scrubbed).toBe(false);
  });

  test("does not modify the input object", () => {
    const input = { ...baseEnv, SSH_AUTH_SOCK: "/tmp/agent.sock" };
    scrubCredentialEnv(input);
    expect(input.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
  });
});

describe("sandboxedSpawn in explicit-opt-out mode", () => {
  test("runs the command unrestricted with the given cwd and env", async () => {
    const result = await sandboxedSpawn(["/bin/echo", "out"], projectDir, baseEnv, "explicit-opt-out");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("out");
  });

  test("preserves cwd for the child", async () => {
    const result = await sandboxedSpawn(["/bin/pwd"], projectDir, baseEnv, "explicit-opt-out");
    expect(result.stdout.trim()).toBe(projectDir);
  });

  test("can read any file, since opt-out is the operator-chosen escape hatch", async () => {
    const result = await sandboxedSpawn(
      ["/bin/cat", join(home, ".ssh", "id_ed25519")],
      projectDir,
      baseEnv,
      "explicit-opt-out",
    );
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("fake key");
  });

  test("kills a hung command after the timeout", async () => {
    const result = await sandboxedSpawn(["/bin/sh", "-c", "sleep 5"], projectDir, baseEnv, "explicit-opt-out", 500);
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGKILL");
  }, 10_000);

  test("rejects when argv has no executable", async () => {
    expect(sandboxedSpawn([], projectDir, baseEnv, "explicit-opt-out")).rejects.toThrow(/executable path/);
  });
});

const backend = await backendStatus();

test.skipIf(backend.available)("blocks sandboxed runs when no backend is available", async () => {
  // Fail-closed: without a working backend the command must be refused, never
  // run unprotected. Only runs on machines without a working sandbox-exec.
  expect(
    sandboxedSpawn(["/bin/echo", "never"], projectDir, baseEnv, "sandboxed", 5_000),
  ).rejects.toThrow(/blocked instead of running unprotected/);
});

describe.skipIf(!backend.available)("sandboxedSpawn in sandboxed mode", () => {
  test("runs the command and allows project work", async () => {
    const result = await sandboxedSpawn(["/bin/echo", "confined"], projectDir, baseEnv, "sandboxed", 10_000);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("confined");
  });

  test("blocks reads of the real credential roots from the default config", async () => {
    const sshDir = resolve(homedir(), ".ssh");
    const result = await sandboxedSpawn(["/bin/ls", sshDir], projectDir, baseEnv, "sandboxed", 10_000);
    // The sandbox denies the path; where the directory does not exist the
    // listing fails too. A working sandbox never lists the keys.
    expect(result.code).not.toBe(0);
  });

  test("removes credential environment variables from the child", async () => {
    const result = await sandboxedSpawn(
      ["/usr/bin/env"],
      projectDir,
      { ...baseEnv, SSH_AUTH_SOCK: "/tmp/agent.sock" },
      "sandboxed",
      10_000,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("SENTINEL=present");
    expect(result.stdout).not.toContain("SSH_AUTH_SOCK");
  });
});
