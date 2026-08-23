/**
 * @fileoverview Stable rule ids for every guard decision, plus operator
 * toggles saved to the sandbox config file the agent cannot write.
 */

import { homedir } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type SandboxTab = "catastrophic-floor" | "prompt-classes" | "path-policy";

/**
 * One toggleable guard rule. The registry is the single source of truth for
 * rule ids and remediation hints; the classifier and policy look ids up here.
 */
export interface RuleInfo {
  /** Stable id, e.g. "root-deletion". Survives renames of name or text. */
  id: string;
  /** Tab in the operator customization page. */
  tab: SandboxTab;
  /** Short display name. */
  name: string;
  /** One line: what this rule blocks. */
  description: string;
  /** One line: how to unblock legitimately. */
  remediation: string;
  /** True for the catastrophic-floor tab; disabling one is a deliberate choice recorded in the audit log. */
  hardFloor: boolean;
}

const OPERATOR_CONFIG = resolve(homedir(), ".omp", "agent", "pi-os-sandbox.json");

const RULES: RuleInfo[] = [
  {
    id: "root-deletion",
    tab: "catastrophic-floor",
    name: "Root deletion",
    description: "Recursive deletion of the filesystem root.",
    remediation: "Run the deletion manually.",
    hardFloor: true,
  },
  {
    id: "system-destruction",
    tab: "catastrophic-floor",
    name: "System destruction",
    description: "System shutdown or process destruction.",
    remediation: "Run the shutdown or kill manually.",
    hardFloor: true,
  },
  {
    id: "device-destruction",
    tab: "catastrophic-floor",
    name: "Device destruction",
    description: "Disk formatting or device overwrite.",
    remediation: "Run the disk operation manually.",
    hardFloor: true,
  },
  {
    id: "fetch-to-shell",
    tab: "catastrophic-floor",
    name: "Fetch to shell",
    description: "Downloading code and running it as a shell command.",
    remediation: "Download and review the script, then run it manually.",
    hardFloor: true,
  },
  {
    id: "credential-read",
    tab: "catastrophic-floor",
    name: "Credential read",
    description: "Reading private SSH credential paths.",
    remediation: "Grant the exact command, or read the credential manually.",
    hardFloor: true,
  },
  {
    id: "metadata-deny",
    tab: "catastrophic-floor",
    name: "Metadata deny",
    description: "Fetching cloud metadata endpoints the sandbox always blocks.",
    remediation: "Run the fetch manually; the endpoint stays blocked for the agent.",
    hardFloor: true,
  },
  {
    id: "safety-state-access",
    tab: "catastrophic-floor",
    name: "Safety-state access",
    description: "Reading or modifying protected sandbox state.",
    remediation: "Edit sandbox state manually, outside the agent.",
    hardFloor: true,
  },
  {
    id: "unverifiable-input",
    tab: "catastrophic-floor",
    name: "Unverifiable input",
    description: "Empty or unverifiable commands and eval cells.",
    remediation: "Provide a verifiable command or eval cell.",
    hardFloor: true,
  },
  {
    id: "database-destruction",
    tab: "catastrophic-floor",
    name: "Database destruction",
    description: "Database-wide destructive operations.",
    remediation: "Run the database operation manually.",
    hardFloor: true,
  },
  {
    id: "recursive-cleanup",
    tab: "prompt-classes",
    name: "Recursive cleanup",
    description: "Recursive or destructive developer cleanup.",
    remediation: "Grant the exact command, or run it manually.",
    hardFloor: false,
  },
  {
    id: "force-push",
    tab: "prompt-classes",
    name: "Force push",
    description: "Force push to a Git ref.",
    remediation: "Grant the exact command, or push manually.",
    hardFloor: false,
  },
  {
    id: "opaque-interpreter",
    tab: "prompt-classes",
    name: "Opaque interpreter",
    description: "Destructive work hidden inside an interpreter.",
    remediation: "Run the script manually, or grant the exact command.",
    hardFloor: false,
  },
  {
    id: "credential-write",
    tab: "path-policy",
    name: "Credential write",
    description: "Writing to a protected credential path.",
    remediation: "Write the credential manually.",
    hardFloor: false,
  },
  {
    id: "instruction-write",
    tab: "path-policy",
    name: "Instruction write",
    description: "Writing to a protected instruction file.",
    remediation: "Edit the instruction file manually.",
    hardFloor: false,
  },
  {
    id: "instruction-access",
    tab: "path-policy",
    name: "Instruction access",
    description: "Shell or eval access to protected instruction files.",
    remediation: "Read instructions with the read tool; edit manually.",
    hardFloor: false,
  },
];

/** Returns every toggleable rule, grouped by tab in the customization page. */
export function ruleRegistry(): RuleInfo[] {
  return [...RULES];
}

/** Returns the rule for an id, or undefined when the id is not registered. */
export function ruleInfo(id: string): RuleInfo | undefined {
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
