/**
 * @fileoverview Compose command and path policy into one fail-closed tool-call
 * decision shared by the Pi and OMP adapters.
 */

import { classifyCommand, classifyEval, isGitMetadataCommand } from "./command-classifier";
import type { GuardDecision } from "./command-classifier";
import { mentionsSafetyState, pathArguments, resolveProtectedPath } from "./path-policy";
import type { SandboxConfig } from "./config";

export type Decision =
  | { action: "allow" }
  | { action: "prompt"; reason: string }
  | { action: "block"; reason: string };

/**
 * Positive authorization source: a headless run may proceed with a prompt-class
 * operation only when this store holds an exact command match.
 */
export interface GrantStore {
  has(command: string, cwd: string): boolean;
}

export interface InspectOptions {
  headless: boolean;
  grants?: GrantStore;
  config: SandboxConfig;
}

const SAFETY_BLOCK = "Blocked: the agent cannot modify or inspect protected safety state.";
const ACCESS_BLOCK = "Blocked: the agent cannot access protected safety state.";
const CREDENTIAL_WRITE_BLOCK = "Blocked: writing to a protected credential path.";
const NO_APPROVAL_SUFFIX = " No interactive approval is available.";

function stringField(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object" || !(key in input)) return null;
  const value = Reflect.get(input, key);
  return typeof value === "string" ? value : null;
}

/** One shared fail-closed resolution for every classifier prompt decision. */
function apply(
  decision: GuardDecision,
  commandForGrant: string,
  cwd: string,
  opts: InspectOptions,
): Decision {
  if (decision === null) return { action: "allow" };
  if (decision.action === "block") return decision;
  if (!opts.headless) return { action: "prompt", reason: decision.reason };
  if (opts.grants?.has(commandForGrant, cwd)) return { action: "allow" };
  return { action: "block", reason: `${decision.reason}${NO_APPROVAL_SUFFIX}` };
}

export function inspectToolCall(
  toolName: string,
  input: unknown,
  cwd: string,
  opts: InspectOptions,
): Decision {
  const { safetyRoots, credentialRoots, metadataHosts } = opts.config;

  if (toolName === "bash") {
    const command = stringField(input, "command") ?? "";
    if (mentionsSafetyState(command, cwd, safetyRoots) && !isGitMetadataCommand(command)) {
      return { action: "block", reason: SAFETY_BLOCK };
    }
    return apply(classifyCommand(command, metadataHosts), command, cwd, opts);
  }

  if (toolName === "eval") {
    const code = stringField(input, "code") ?? "";
    if (mentionsSafetyState(code, cwd, safetyRoots)) {
      return { action: "block", reason: SAFETY_BLOCK };
    }
    return apply(classifyEval(code, metadataHosts), code, cwd, opts);
  }

  if (toolName === "read" || toolName === "grep" || toolName === "glob") {
    for (const value of pathArguments(input)) {
      if (resolveProtectedPath(value, cwd, safetyRoots) !== null) {
        return { action: "block", reason: ACCESS_BLOCK };
      }
      const root = resolveProtectedPath(value, cwd, credentialRoots);
      if (root !== null) {
        return apply(
          { action: "prompt", reason: `Reading a protected credential path needs approval: ${root}` },
          value,
          cwd,
          opts,
        );
      }
    }
    return { action: "allow" };
  }

  if (toolName === "write" || toolName === "edit") {
    for (const value of pathArguments(input)) {
      if (resolveProtectedPath(value, cwd, safetyRoots) !== null) {
        return { action: "block", reason: ACCESS_BLOCK };
      }
      if (resolveProtectedPath(value, cwd, credentialRoots) !== null) {
        return { action: "block", reason: CREDENTIAL_WRITE_BLOCK };
      }
    }
    return { action: "allow" };
  }

  return { action: "allow" };
}
