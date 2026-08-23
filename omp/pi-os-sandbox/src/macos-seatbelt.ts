/**
 * @fileoverview macOS Seatbelt backend for confined child processes: profile
 * generation, backend availability probing, and the sandbox-exec wrapper.
 */

import { spawn } from "node:child_process";
import { defaultConfig } from "./config";
import { canonicalize } from "./path-policy";

/** How a child process ended: exit code, or the signal that killed it. */
export interface SpawnResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** Whether the Seatbelt backend is usable, and why not when it is not. */
export interface BackendStatus {
  available: boolean;
  reason: string;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const PROBE_TIMEOUT_MS = 5_000;

/** Escape a path so it is safe inside a quoted Seatbelt literal. */
function escapeLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Build a Seatbelt profile that blocks reads, writes, and removals of every
 * listed root while leaving everything else allowed.
 *
 * @param roots paths to block; files and directories both work.
 */
export function buildSeatbeltProfile(roots: string[]): string {
  const seen = new Set<string>();
  const lines = ["(version 1)", "(allow default)"];
  for (const root of roots) {
    const canonical = canonicalize(root);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const literal = escapeLiteral(canonical);
    lines.push(
      `(deny file-read* (subpath "${literal}"))`,
      `(deny file-write* (subpath "${literal}"))`,
      `(deny file-unlink (subpath "${literal}"))`,
    );
  }
  return lines.join("\n");
}

/**
 * The credential and policy roots from the default operator config, which is
 * what the seatbelt profile denies by default.
 */
export function defaultDenyRoots(): string[] {
  const config = defaultConfig();
  return [...config.safetyRoots, ...config.credentialRoots, ...config.instructionRoots];
}

let cachedStatus: Promise<BackendStatus> | null = null;

/**
 * Check whether sandbox-exec exists and actually enforces profiles. Cached for
 * the process lifetime.
 */
export function backendStatus(): Promise<BackendStatus> {
  cachedStatus ??= probeBackend();
  return cachedStatus;
}

async function probeBackend(): Promise<BackendStatus> {
  try {
    const { promise, resolve, reject } = Promise.withResolvers<number | null>();
    const probe = spawn(SANDBOX_EXEC, ["-p", "(version 1)(deny default)", "/usr/bin/true"], {
      stdio: "ignore",
    });
    probe.on("error", reject);
    probe.on("exit", (exitCode) => resolve(exitCode));
    const timer = setTimeout(() => {
      probe.kill("SIGKILL");
      reject(new Error("probe timed out"));
    }, PROBE_TIMEOUT_MS);
    const code = await promise;
    clearTimeout(timer);
    // A working sandbox blocks /usr/bin/true (nonzero exit). Exit 0 means the
    // profile was ignored, so the backend cannot confine anything.
    if (code === 0) {
      return { available: false, reason: "sandbox-exec ran the probe but did not enforce the profile" };
    }
    return { available: true, reason: "" };
  } catch (error) {
    return { available: false, reason: `sandbox-exec probe failed: ${String(error)}` };
  }
}

/**
 * Run a command with a full environment and a hard timeout that kills the
 * whole process group.
 *
 * @param argv command to run, starting with the executable path.
 * @param cwd working directory for the command.
 * @param env full environment for the command; nothing is inherited.
 * @param timeoutMs kill the process group after this long.
 */
export function runChild(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<SpawnResult> {
  const command = argv[0];
  if (command === undefined) {
    return Promise.reject(new Error("runChild: argv must include the executable path"));
  }
  // Bun refuses to spawn even absolute executables when PATH is missing, so a
  // child always gets a PATH; callers can override it via env.
  const childEnv = { ...env, PATH: env.PATH ?? "/usr/bin:/bin" };
  const child = spawn(command, argv.slice(1), {
    cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const timer = setTimeout(() => {
    // Kill the whole process group so grandchildren do not outlive the child.
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  }, timeoutMs);
  const { promise, resolve, reject } = Promise.withResolvers<SpawnResult>();
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal, stdout, stderr });
  });
  return promise;
}

/**
 * Run a command inside a sandbox with the given profile.
 *
 * @param profile profile text from buildSeatbeltProfile.
 * @param argv command to run, starting with the executable path.
 * @param cwd working directory for the command.
 * @param env full environment for the command; nothing is inherited.
 * @param timeoutMs kill the process group after this long.
 */
export function execSandboxed(
  profile: string,
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<SpawnResult> {
  return runChild([SANDBOX_EXEC, "-p", profile, ...argv], cwd, env, timeoutMs);
}
