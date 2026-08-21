/**
 * @fileoverview OMP adapter: loads the operator config and gates tool calls
 * through the shared policy with interactive approval and headless grants.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { defaultConfig, loadConfig, type SandboxConfig } from "../src/config";
import { inspectToolCall } from "../src/policy";
import { redact } from "../src/redaction";
import { SessionGrants } from "../src/session-grants";

const CONFIG_PATH = join(homedir(), ".omp", "agent", "pi-os-sandbox.json");

/**
 * Load the sandbox config from disk, falling back to the strict default floor.
 * 
 * @param configPath explicit path for tests, defaults to the operator config.
 * @param log error sink, defaults to stderr.
 */
export function loadSandboxConfig(
  configPath: string = CONFIG_PATH,
  log: (message: string) => void = console.error,
): SandboxConfig {
  try {
    return loadConfig(JSON.parse(readFileSync(configPath, "utf8")));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log(`pi-os-sandbox: config load failed, using defaults: ${redact(detail)}`);
    return defaultConfig();
  }
}

/** Display preview of a tool call: command, truncated eval code, or tool name. */
function preview(toolName: string, input: unknown): string {
  if (toolName === "bash") return String((input as { command?: unknown }).command ?? "");
  if (toolName === "eval") {
    const code = String((input as { code?: unknown }).code ?? "");
    return code.length > 1200 ? `${code.slice(0, 1200)}...` : code;
  }
  return `Tool: ${toolName}`;
}

/** Exact, untruncated command/code used as the grant key for a tool call. */
function previewCommand(toolName: string, input: unknown): string {
  if (toolName === "bash") return String((input as { command?: unknown }).command ?? "");
  if (toolName === "eval") return String((input as { code?: unknown }).code ?? "");
  return `Tool: ${toolName}`;
}

/**
 * Gate tool calls through the policy, prompting for approval and granting
 * exact commands for headless reuse.
 * 
 * @param config explicit config for tests, defaults to the loaded operator
 *               config.
 */
export function createSandboxHandler(
  pi: ExtensionAPI,
  config: SandboxConfig = loadSandboxConfig(CONFIG_PATH, (message) => pi.logger.warn(message)),
): void {
  const grants = new SessionGrants();

  pi.on("tool_call", async (event, ctx) => {
    try {
      const decision = inspectToolCall(event.toolName, event.input, ctx.cwd, {
        headless: !ctx.hasUI,
        grants,
        config,
      });
      if (decision.action === "allow") return undefined;
      if (decision.action === "block") {
        return { block: true, reason: redact(decision.reason) };
      }
      if (!ctx.hasUI) {
        return { block: true, reason: redact(decision.reason) };
      }
      const approved = await ctx.ui.confirm(
        "Approve risky operation?",
        `${decision.reason}\n\n${preview(event.toolName, event.input)}`,
      );
      if (approved) {
        grants.grant(previewCommand(event.toolName, event.input), ctx.cwd);
        return undefined;
      }
      return { block: true, reason: "Blocked: exact approval was not granted." };
    } catch {
      return { block: true, reason: "Blocked: sandbox policy error." };
    }
  });

  pi.registerCommand("sandbox-status", {
    description: "Show pi-os-sandbox policy summary",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `pi-os-sandbox: ${config.safetyRoots.length} safety roots, ${config.credentialRoots.length} credential roots, ${config.metadataHosts.length} metadata hosts, headless: fail-closed`,
      );
    },
  });
}

export default function (pi: ExtensionAPI): void {
  createSandboxHandler(pi);
}
