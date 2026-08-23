/**
 * @fileoverview Operator sandbox configuration: default roots, blocked
 * metadata targets, and strict validation of the optional config file.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Operator sandbox policy: which paths are protected and which network targets
 * are denied. Override individual lists to tighten or relax the defaults.
 */
export interface SandboxConfig {
  /** Paths where reads AND writes are blocked (self-protection floor). */
  safetyRoots: string[];
  /** Paths where writes are blocked and reads are prompted. */
  credentialRoots: string[];
  /** Paths the agent must read (instructions); writes are still blocked. */
  instructionRoots: string[];
  /** Network targets that are always blocked (e.g. cloud metadata services). */
  metadataHosts: RegExp[];
  /** Rule ids the operator disabled; those rules allow instead of blocking or prompting. */
  disabledRules: string[];
}

export function defaultConfig(): SandboxConfig {
  const home = resolve(homedir());
  return {
    safetyRoots: [
      resolve(home, ".omp", "agent", "extensions"),
      resolve(home, ".omp", "agent", "config.yml"),
      resolve(home, ".omp", "agent", "pi-os-sandbox.json"),
      resolve(home, ".pi", "agent"),
    ],
    credentialRoots: [
      resolve(home, ".ssh"),
      resolve(home, ".gitconfig"),
      resolve(home, ".aws"),
      resolve(home, ".gnupg"),
      resolve(home, ".docker", "config.json"),
      resolve(home, ".kube", "config"),
    ],
    instructionRoots: [resolve(home, ".agents", "AGENTS.md")],
    metadataHosts: [
      /169\.254\.169\.254/,
      /169\.254\.170\.2/,
      /169\.254\.170\.23/,
      /100\.100\.100\.200/,
      /metadata\.google\.internal/,
    ],
    disabledRules: [],
  };
}

function parseRootList(key: string, value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error(`loadConfig: "${key}" must be an array of non-empty strings`);
  }
  return [...value];
}

function parseMetadataHosts(value: unknown): RegExp[] {
  if (!Array.isArray(value)) {
    throw new Error('loadConfig: "metadataHosts" must be an array of strings or RegExp instances');
  }
  return value.map((entry, index) => {
    if (entry instanceof RegExp) return new RegExp(entry);
    if (typeof entry !== "string") {
      throw new Error(`loadConfig: metadataHosts[${index}] must be a string or RegExp instance`);
    }
    try {
      return new RegExp(entry);
    } catch {
      throw new Error(`loadConfig: metadataHosts[${index}] is not a valid regex source: ${JSON.stringify(entry)}`);
    }
  });
}

export function loadConfig(raw: unknown): SandboxConfig {
  const cfg = defaultConfig();
  if (raw === undefined || raw === null) return cfg;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`loadConfig: expected a config object, got ${Array.isArray(raw) ? "an array" : typeof raw}`);
  }
  const input = raw as Record<string, unknown>;
  if ("safetyRoots" in input) cfg.safetyRoots = parseRootList("safetyRoots", input.safetyRoots);
  if ("credentialRoots" in input) cfg.credentialRoots = parseRootList("credentialRoots", input.credentialRoots);
  if ("instructionRoots" in input) cfg.instructionRoots = parseRootList("instructionRoots", input.instructionRoots);
  if ("metadataHosts" in input) cfg.metadataHosts = parseMetadataHosts(input.metadataHosts);
  if ("disabledRules" in input) cfg.disabledRules = parseRootList("disabledRules", input.disabledRules);
  return cfg;
}
