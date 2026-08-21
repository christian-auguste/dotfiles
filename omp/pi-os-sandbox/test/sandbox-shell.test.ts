/**
 * @fileoverview sandbox-bash wrapper: env scrubbing, opt-out passthrough,
 * argument forwarding, and exit-code propagation.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

const WRAPPER = path.join(import.meta.dir, "..", "bin", "sandbox-bash");

function runWrapper(args: string[], env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync([WRAPPER, ...args], {
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

describe("sandbox-bash wrapper", () => {
  test("scrubs AWS credential vars, keeps SSH_AUTH_SOCK and HOME", () => {
    const { stdout, exitCode } = runWrapper(
      ["-c", "printf '%s|%s|%s' \"$AWS_SECRET_ACCESS_KEY\" \"$SSH_AUTH_SOCK\" \"$HOME\""],
      {
        AWS_ACCESS_KEY_ID: "AKIAFAKE",
        AWS_SECRET_ACCESS_KEY: "secret-value",
        AWS_SESSION_TOKEN: "token-value",
        GIT_ASKPASS: "/fake/askpass",
        GNUPGHOME: "/fake/gnupg",
        SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
        HOME: "/tmp/fake-home",
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("|/tmp/ssh-agent.sock|/tmp/fake-home");
  });

  test("PI_SANDBOX_OFF=1 preserves the environment", () => {
    const { stdout, exitCode } = runWrapper(
      ["-c", "printf '%s|%s' \"$AWS_SECRET_ACCESS_KEY\" \"$SSH_AUTH_SOCK\""],
      {
        PI_SANDBOX_OFF: "1",
        AWS_SECRET_ACCESS_KEY: "secret-value",
        SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("secret-value|/tmp/ssh-agent.sock");
  });

  test("forwards arguments and propagates exit codes", () => {
    const { stdout, exitCode } = runWrapper(["-c", "echo forward-ok; exit 7"], {});
    expect(stdout).toContain("forward-ok");
    expect(exitCode).toBe(7);
  });

  test("honors PI_SANDBOX_REAL_SHELL override", () => {
    const { stdout, exitCode } = runWrapper(
      ["-c", "echo \"$0\""],
      { PI_SANDBOX_REAL_SHELL: "/bin/sh" },
    );
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("/bin/sh");
  });
});
