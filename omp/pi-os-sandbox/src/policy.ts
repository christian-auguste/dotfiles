/**
 * @fileoverview Combine command and path policy into one tool-call decision
 * that blocks by default, shared by the Pi and OMP adapters.
 */

import { classifyCommand, classifyEval, isGitMetadataCommand } from "./command-classifier";
import type { GuardDecision } from "./command-classifier";
import { mentionsSafetyState, pathArguments, resolveProtectedPath } from "./path-policy";
import type { SandboxConfig } from "./config";
import { ruleInfo } from "./customization";

export type Decision =
  | { action: "allow" }
  | { action: "prompt"; reason: string; rule: string; remediation: string }
  | { action: "block"; reason: string; rule: string; remediation: string };

/**
 * Approval store: a headless run may proceed with a prompt-class operation
 * only when this store holds an exact command match.
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
const INSTRUCTION_WRITE_BLOCK = "Blocked: writing to a protected instruction file.";
const INSTRUCTION_ACCESS_BLOCK = "Blocked: the agent cannot modify or inspect protected instruction files.";
const NO_APPROVAL_SUFFIX = " No interactive approval is available.";
const GRANT_HINT = " An approval for this exact call would have allowed it.";

function stringField(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object" || !(key in input)) return null;
  const value = Reflect.get(input, key);
  return typeof value === "string" ? value : null;
}

/** Builds a direct block decision, appending the rule and remediation lines. */
function decisionFor(rule: string, reason: string): Decision {
  const remediation = ruleInfo(rule)?.remediation ?? "";
  return {
    action: "block",
    reason: `${reason} rule: ${rule} remediation: ${remediation}`,
    rule,
    remediation,
  };
}

/** Resolves classifier decisions the same way in every tool path, allowing only when no check matches. */
function apply(
  decision: GuardDecision,
  commandForGrant: string,
  cwd: string,
  opts: InspectOptions,
  disabled: Set<string>,
): Decision {
  if (decision === null) return { action: "allow" };
  if (disabled.has(decision.rule)) return { action: "allow" };
  const suffix = ` rule: ${decision.rule} remediation: ${decision.remediation}`;
  if (decision.action === "block") {
    return { action: "block", reason: `${decision.reason}${suffix}`, rule: decision.rule, remediation: decision.remediation };
  }
  if (!opts.headless) {
    return { action: "prompt", reason: `${decision.reason}${suffix}`, rule: decision.rule, remediation: decision.remediation };
  }
  if (opts.grants?.has(commandForGrant, cwd)) return { action: "allow" };
  return {
    action: "block",
    reason: `${decision.reason}${NO_APPROVAL_SUFFIX}${GRANT_HINT}${suffix}`,
    rule: decision.rule,
    remediation: decision.remediation,
  };
}

export function inspectToolCall(
  toolName: string,
  input: unknown,
  cwd: string,
  opts: InspectOptions,
): Decision {
  const { safetyRoots, credentialRoots, instructionRoots, metadataHosts } = opts.config;
  const disabled = new Set(opts.config.disabledRules);

  if (toolName === "bash") {
    const command = stringField(input, "command") ?? "";
    if (!disabled.has("safety-state-access") && mentionsSafetyState(command, cwd, safetyRoots) && !isGitMetadataCommand(command)) {
      return decisionFor("safety-state-access", SAFETY_BLOCK);
    }
    if (!disabled.has("instruction-access") && mentionsSafetyState(command, cwd, instructionRoots) && !isGitMetadataCommand(command)) {
      return decisionFor("instruction-access", INSTRUCTION_ACCESS_BLOCK);
    }
    return apply(classifyCommand(command, metadataHosts), command, cwd, opts, disabled);
  }

  if (toolName === "eval") {
    const code = stringField(input, "code") ?? "";
    if (!disabled.has("safety-state-access") && mentionsSafetyState(code, cwd, safetyRoots)) {
      return decisionFor("safety-state-access", SAFETY_BLOCK);
    }
    if (!disabled.has("instruction-access") && mentionsSafetyState(code, cwd, instructionRoots)) {
      return decisionFor("instruction-access", INSTRUCTION_ACCESS_BLOCK);
    }
    return apply(classifyEval(code, metadataHosts), code, cwd, opts, disabled);
  }

  if (toolName === "read" || toolName === "grep" || toolName === "glob") {
    for (const value of pathArguments(input)) {
      if (!disabled.has("safety-state-access") && resolveProtectedPath(value, cwd, safetyRoots) !== null) {
        return decisionFor("safety-state-access", ACCESS_BLOCK);
      }
      if (resolveProtectedPath(value, cwd, instructionRoots) !== null) {
        continue;
      }
      const root = resolveProtectedPath(value, cwd, credentialRoots);
      if (root !== null) {
        const remediation = ruleInfo("credential-read")?.remediation ?? "";
        return apply(
          {
            action: "prompt",
            reason: `Reading a protected credential path needs approval: ${root}`,
            rule: "credential-read",
            remediation,
          },
          value,
          cwd,
          opts,
          disabled,
        );
      }
    }
    return { action: "allow" };
  }

  if (toolName === "write" || toolName === "edit") {
    for (const value of pathArguments(input)) {
      if (!disabled.has("safety-state-access") && resolveProtectedPath(value, cwd, safetyRoots) !== null) {
        return decisionFor("safety-state-access", ACCESS_BLOCK);
      }
      if (!disabled.has("instruction-write") && resolveProtectedPath(value, cwd, instructionRoots) !== null) {
        return decisionFor("instruction-write", INSTRUCTION_WRITE_BLOCK);
      }
      if (!disabled.has("credential-write") && resolveProtectedPath(value, cwd, credentialRoots) !== null) {
        return decisionFor("credential-write", CREDENTIAL_WRITE_BLOCK);
      }
    }
    return { action: "allow" };
  }

  return { action: "allow" };
}
