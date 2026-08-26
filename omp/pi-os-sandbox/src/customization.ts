/**
 * @fileoverview Stable rule ids for every guard decision, plus operator
 * toggles saved to the sandbox config file the agent cannot write.
 */

import { homedir } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type RuleGroup = "safety-floor" | "prompt-classes" | "path-policy";

export type SandboxTab = RuleGroup | "activity";

/**
 * One toggleable guard rule. The registry is the single source of truth for
 * rule ids and next-step hints; the classifier and policy look ids up here.
 */
export interface SandboxRule {
  /** Stable id, e.g. "delete-filesystem-root". Survives renames of name or text. */
  id: string;
  /** Group in the operator customization page. */
  group: RuleGroup;
  /** Short display name. */
  name: string;
  /** One line: what this rule blocks. */
  description: string;
  /** One line: how to unblock legitimately. */
  nextStep: string;
  /** True for the safety-floor group; disabling one is a deliberate choice recorded in the audit log. */
  isSafetyFloor: boolean;
}

const OPERATOR_CONFIG = resolve(homedir(), ".omp", "agent", "pi-os-sandbox.json");

const RULES: SandboxRule[] = [
  {
    id: "delete-filesystem-root",
    group: "safety-floor",
    name: "Root deletion",
    description: "Recursive deletion of the filesystem root.",
    nextStep: "Run the deletion manually.",
    isSafetyFloor: true,
  },
  {
    id: "destroy-system",
    group: "safety-floor",
    name: "System destruction",
    description: "System shutdown or process destruction.",
    nextStep: "Run the shutdown or kill manually.",
    isSafetyFloor: true,
  },
  {
    id: "destroy-device",
    group: "safety-floor",
    name: "Device destruction",
    description: "Disk formatting or device overwrite.",
    nextStep: "Run the disk operation manually.",
    isSafetyFloor: true,
  },
  {
    id: "download-and-run-code",
    group: "safety-floor",
    name: "Fetch to shell",
    description: "Downloading code and running it as a shell command.",
    nextStep: "Download and review the script, then run it manually.",
    isSafetyFloor: true,
  },
  {
    id: "read-credentials",
    group: "safety-floor",
    name: "Credential read",
    description: "Reading private SSH credential paths.",
    nextStep: "Grant the exact command, or read the credential manually.",
    isSafetyFloor: true,
  },
  {
    id: "request-cloud-metadata",
    group: "safety-floor",
    name: "Metadata deny",
    description: "Fetching cloud metadata endpoints the sandbox always blocks.",
    nextStep: "Run the fetch manually; the endpoint stays blocked for the agent.",
    isSafetyFloor: true,
  },
  {
    id: "access-sandbox-state",
    group: "safety-floor",
    name: "Safety-state access",
    description: "Reading or modifying protected sandbox state.",
    nextStep: "Edit sandbox state manually, outside the agent.",
    isSafetyFloor: true,
  },
  {
    id: "reject-unverifiable-input",
    group: "safety-floor",
    name: "Unverifiable input",
    description: "Empty or unverifiable commands and eval cells.",
    nextStep: "Provide a verifiable command or eval cell.",
    isSafetyFloor: true,
  },
  {
    id: "destroy-database",
    group: "safety-floor",
    name: "Database destruction",
    description: "Database-wide destructive operations.",
    nextStep: "Run the database operation manually.",
    isSafetyFloor: true,
  },
  {
    id: "run-recursive-cleanup",
    group: "prompt-classes",
    name: "Recursive cleanup",
    description: "Recursive or destructive developer cleanup.",
    nextStep: "Grant the exact command, or run it manually.",
    isSafetyFloor: false,
  },
  {
    id: "force-push",
    group: "prompt-classes",
    name: "Force push",
    description: "Force push to a Git ref.",
    nextStep: "Grant the exact command, or push manually.",
    isSafetyFloor: false,
  },
  {
    id: "run-hidden-destructive-code",
    group: "prompt-classes",
    name: "Opaque interpreter",
    description: "Destructive work hidden inside an interpreter.",
    nextStep: "Run the script manually, or grant the exact command.",
    isSafetyFloor: false,
  },
  {
    id: "write-credentials",
    group: "path-policy",
    name: "Credential write",
    description: "Writing to a protected credential path.",
    nextStep: "Write the credential manually.",
    isSafetyFloor: false,
  },
  {
    id: "write-instruction-files",
    group: "path-policy",
    name: "Instruction write",
    description: "Writing to a protected instruction file.",
    nextStep: "Edit the instruction file manually.",
    isSafetyFloor: false,
  },
  {
    id: "access-instruction-files",
    group: "path-policy",
    name: "Instruction access",
    description: "Shell or eval access to protected instruction files.",
    nextStep: "Read instructions with the read tool; edit manually.",
    isSafetyFloor: false,
  },
];

/** Returns every toggleable rule, grouped by tab in the customization page. */
export function ruleRegistry(): SandboxRule[] {
  return [...RULES];
}

/** Returns the rule for an id, or undefined when the id is not registered. */
export function ruleInfo(id: string): SandboxRule | undefined {
  return RULES.find((rule) => rule.id === id);
}

/**
 * Returns the operator-disabled rule ids; missing or unreadable config means none.
 *
 * @param configPath explicit path for tests, defaults to the operator config.
 */
export function loadDisabledRules(configPath: string = OPERATOR_CONFIG): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const disabled = raw["disabledRules"];
    if (!Array.isArray(disabled)) return new Set();
    return new Set(disabled.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

/**
 * Saves disabled rule ids into the operator config, preserving other keys.
 *
 * @param configPath explicit path for tests, defaults to the operator config.
 */
export function saveDisabledRules(disabled: Set<string>, configPath: string = OPERATOR_CONFIG): void {
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable config starts fresh; the operator file cannot be
    // written by the agent, so this only happens before the first save.
  }
  existing["disabledRules"] = [...disabled];
  writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}
