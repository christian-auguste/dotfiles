/**
 * @fileoverview Child process seam: run a command either confined by the
 * macOS Seatbelt backend or in an operator-chosen unrestricted mode. Sandboxed
 * mode never falls back to an unrestricted run.
 */

import {
  backendStatus,
  buildSeatbeltProfile,
  defaultDenyRoots,
  execSandboxed,
  runChild,
  type BackendStatus,
  type SpawnResult,
} from "./macos-seatbelt";

/** How a child runs: confined by Seatbelt, or unrestricted by explicit choice. */
export type SpawnMode = "sandboxed" | "explicit-opt-out";

/** Environment variables that point at credential stores or agent sockets, removed from sandboxed children. */
const CREDENTIAL_ENV_VARS = [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "KUBECONFIG",
  "DOCKER_CONFIG",
  "GNUPGHOME",
];

/**
 * Run a command through the child seam: sandboxed runs are Seatbelt-confined
 * or blocked, and only "explicit-opt-out" runs unrestricted.
 *
 * @param argv command to run, starting with the executable path.
 * @param cwd working directory for the command.
 * @param env full environment for the command; nothing is inherited.
 * @param mode "sandboxed" confines the child; "explicit-opt-out" runs it unrestricted.
 * @param timeoutMs kill the process group after this long.
 */
export async function sandboxedSpawn(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  mode: SpawnMode,
  timeoutMs?: number,
): Promise<SpawnResult> {
  const deadline = timeoutMs ?? 30_000;
  if (mode === "explicit-opt-out") {
    return runChild(argv, cwd, env, deadline);
  }
  ensureBackendAvailable(await backendStatus());
  const profile = buildSeatbeltProfile(defaultDenyRoots());
  return execSandboxed(profile, argv, cwd, scrubCredentialEnv(env), deadline);
}

/**
 * Remove environment variables that point at credential stores or agent
 * sockets, so a confined child cannot reach them through the environment.
 *
 * @param env environment to filter; the input object is not modified.
 */
export function scrubCredentialEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!CREDENTIAL_ENV_VARS.includes(key)) result[key] = value;
  }
  return result;
}

/**
 * Block the run when the Seatbelt backend cannot confine a child. Called
 * before any sandboxed spawn; throwing here is the fail-closed guarantee.
 *
 * @param status backend probe result from macos-seatbelt.
 */
export function ensureBackendAvailable(status: BackendStatus): void {
  if (!status.available) {
    throw new Error(
      `cannot run the command in a sandbox: ${status.reason}; ` +
        "the command is blocked instead of running unprotected",
    );
  }
}
