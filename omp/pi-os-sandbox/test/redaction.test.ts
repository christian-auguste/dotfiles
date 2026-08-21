/**
 * @fileoverview Env scrubbing and secret masking behavior.
 */

import { describe, expect, test } from "bun:test";
import { redact, scrubEnv } from "../src/redaction";

describe("scrubEnv", () => {
  const env = {
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE1234",
    AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    AWS_SESSION_TOKEN: "session-token",
    GIT_ASKPASS: "/usr/bin/git-askpass",
    GNUPGHOME: "/home/user/.gnupg",
    SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.sock",
    HOME: "/home/user",
    PATH: "/usr/bin:/bin",
  };

  test("removes credential variables", () => {
    const out = scrubEnv(env);
    expect(out.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(out.AWS_SESSION_TOKEN).toBeUndefined();
    expect(out.GIT_ASKPASS).toBeUndefined();
    expect(out.GNUPGHOME).toBeUndefined();
  });

  test("matches variable names case-insensitively", () => {
    const out = scrubEnv({
      aws_access_key_id: "x",
      "AWS_FOO_SECRET_BAR": "y",
    });
    expect(out).toEqual({});
  });

  test("keeps SSH_AUTH_SOCK and ordinary variables", () => {
    const out = scrubEnv(env);
    expect(out.SSH_AUTH_SOCK).toBe("/run/user/1000/ssh-agent.sock");
    expect(out.HOME).toBe("/home/user");
    expect(out.PATH).toBe("/usr/bin:/bin");
  });

  test("does not mutate the input", () => {
    const before = { ...env };
    scrubEnv(env);
    expect(env).toEqual(before);
  });
});

describe("redact", () => {
  test("masks AWS access key IDs", () => {
    const out = redact("key AKIAIOSFODNN7EXAMPLE seen");
    expect(out).toBe("key [redacted] seen");
  });

  test("masks AWS secret access keys", () => {
    const out = redact("secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY now");
    expect(out).toBe("secret [redacted] now");
  });

  test("masks GitHub tokens", () => {
    const out = redact("token ghp_0123456789abcdefghijklmnopqrstuvwxyzABCD leaked");
    expect(out).toBe("token [redacted] leaked");
  });

  test("masks sk- style secrets", () => {
    const out = redact("api key sk-0123456789abcdefghijklmnopqrstuvwxyz invalid");
    expect(out).toBe("api key [redacted] invalid");
  });

  test("masks password-style assignments", () => {
    const out = redact("password=hunter2");
    expect(out).toBe("[redacted]");
    expect(out).not.toContain("hunter2");
  });

  test("masks PRIVATE KEY blocks", () => {
    const key =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n-----END PRIVATE KEY-----";
    const out = redact(`before\n${key}\nafter`);
    expect(out).toBe("before\n[redacted]\nafter");
    expect(out).not.toContain("MIIEvQIB");
  });

  test("leaves ordinary text untouched", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    expect(redact(text)).toBe(text);
  });
});
