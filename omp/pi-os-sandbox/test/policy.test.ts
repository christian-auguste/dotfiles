/**
 * @fileoverview Tool-call decision matrix across interactive, headless, and
 * granted modes for bash, eval, and file tools.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, type SandboxConfig } from "../src/config";
import { inspectToolCall, type Decision, type GrantStore } from "../src/policy";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-os-policy-"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-os-policy-cwd-"));
const agentDir = path.join(tmpRoot, "omp", "agent");
const sshDir = path.join(tmpRoot, ".ssh");
const agentsDir = path.join(tmpRoot, ".agents");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(sshDir, { recursive: true });
fs.mkdirSync(agentsDir, { recursive: true });

const safetyFile = path.join(agentDir, "config.yml");
const credentialFile = path.join(sshDir, "config");
const instructionFile = path.join(agentsDir, "AGENTS.md");
fs.writeFileSync(instructionFile, "# test instructions\n");

function config(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    ...defaultConfig(),
    safetyRoots: [agentDir],
    credentialRoots: [sshDir],
    instructionRoots: [agentsDir],
    ...overrides,
  };
}

const grantAll: GrantStore = { has: () => true };
const grantNone: GrantStore = { has: () => false };
const grantExact = (...keys: string[]): GrantStore => ({
  has: (command: string) => keys.includes(command),
});

function reasonOf(decision: Decision): string {
  if (decision.action === "allow") throw new Error("expected a prompt or block decision");
  return decision.reason;
}

const HOME = os.homedir();

describe("inspectToolCall", () => {
  test("allows ordinary bash commands in interactive and headless modes", () => {
    const input = { command: "ls -la" };
    expect(inspectToolCall("bash", input, cwd, { headless: false, config: config() })).toEqual({
      action: "allow",
    });
    expect(inspectToolCall("bash", input, cwd, { headless: true, config: config() })).toEqual({
      action: "allow",
    });
  });

  test("blocks catastrophic bash commands in both modes", () => {
    for (const headless of [false, true]) {
      const decision = inspectToolCall("bash", { command: "rm -rf /" }, cwd, {
        headless,
        config: config(),
      });
      expect(decision.action).toBe("block");
    }
  });

  test("prompts recursive bash interactively, blocks headless without grants, allows with grants", () => {
    const opts = { config: config() };
    const command = "rm -rf node_modules";

    const interactive = inspectToolCall("bash", { command }, cwd, { headless: false, ...opts });
    expect(interactive.action).toBe("prompt");
    expect(typeof reasonOf(interactive)).toBe("string");

    const interactiveGranted = inspectToolCall("bash", { command }, cwd, {
      headless: false,
      grants: grantAll,
      ...opts,
    });
    expect(interactiveGranted.action).toBe("prompt");

    const noGrants = inspectToolCall("bash", { command }, cwd, { headless: true, ...opts });
    expect(noGrants.action).toBe("block");
    expect(reasonOf(noGrants)).toContain("No interactive approval is available.");

    const falseGrants = inspectToolCall("bash", { command }, cwd, {
      headless: true,
      grants: grantNone,
      ...opts,
    });
    expect(falseGrants.action).toBe("block");

    const granted = inspectToolCall("bash", { command }, cwd, {
      headless: true,
      grants: grantExact(command),
      ...opts,
    });
    expect(granted).toEqual({ action: "allow" });

    const wrongKey = inspectToolCall("bash", { command }, cwd, {
      headless: true,
      grants: grantExact("rm -rf dist"),
      ...opts,
    });
    expect(wrongKey.action).toBe("block");
  });

  test("blocks safety-state mentions but allows git metadata commands", () => {
    const homeConfig = config({ safetyRoots: [path.join(HOME, ".omp", "agent")] });
    for (const headless of [false, true]) {
      const decision = inspectToolCall(
        "bash",
        { command: "cat ~/.omp/agent/config.yml" },
        cwd,
        { headless, config: homeConfig },
      );
      expect(decision).toEqual({
        action: "block",
        reason: "Blocked: the agent cannot modify or inspect protected safety state.",
      });
    }

    const gitMetadata = inspectToolCall(
      "bash",
      { command: "git add ~/.omp/agent/extensions/destructive-guard.ts" },
      cwd,
      { headless: false, config: homeConfig },
    );
    expect(gitMetadata).toEqual({ action: "allow" });
  });

  test("blocks empty or missing bash commands", () => {
    expect(inspectToolCall("bash", {}, cwd, { headless: true, config: config() }).action).toBe("block");
    expect(
      inspectToolCall("bash", { command: "" }, cwd, { headless: false, config: config() }).action,
    ).toBe("block");
  });

  test("prompts eval subprocess cells interactively and blocks headless", () => {
    const code = 'import subprocess; subprocess.run(["rm", "-rf", "build"])';
    const opts = { config: config() };

    const interactive = inspectToolCall("eval", { code }, cwd, { headless: false, ...opts });
    expect(interactive.action).toBe("prompt");

    const headless = inspectToolCall("eval", { code }, cwd, { headless: true, ...opts });
    expect(headless.action).toBe("block");
    expect(reasonOf(headless)).toContain("No interactive approval is available.");

    const granted = inspectToolCall("eval", { code }, cwd, {
      headless: true,
      grants: grantExact(code),
      ...opts,
    });
    expect(granted).toEqual({ action: "allow" });
  });

  test("blocks eval cells that mention safety state", () => {
    const homeConfig = config({ safetyRoots: [path.join(HOME, ".omp", "agent")] });
    const decision = inspectToolCall(
      "eval",
      { code: `open(${JSON.stringify(path.join(HOME, ".omp", "agent", "config.yml"))})` },
      cwd,
      { headless: true, config: homeConfig },
    );
    expect(decision).toEqual({
      action: "block",
      reason: "Blocked: the agent cannot modify or inspect protected safety state.",
    });
  });

  test("blocks read/grep/glob of safety roots", () => {
    const opts = { config: config() };
    for (const toolName of ["read", "grep", "glob"]) {
      for (const headless of [false, true]) {
        const decision = inspectToolCall(toolName, { path: safetyFile }, cwd, {
          headless,
          ...opts,
        });
        expect(decision).toEqual({
          action: "block",
          reason: "Blocked: the agent cannot access protected safety state.",
        });
      }
    }
  });

  test("prompts credential reads interactively, blocks headless without grants", () => {
    const opts = { config: config() };

    const interactive = inspectToolCall("read", { path: credentialFile }, cwd, {
      headless: false,
      ...opts,
    });
    expect(interactive.action).toBe("prompt");
    expect(reasonOf(interactive)).toContain("Reading a protected credential path needs approval:");
    expect(reasonOf(interactive)).toContain("ssh");

    const headless = inspectToolCall("read", { path: credentialFile }, cwd, {
      headless: true,
      ...opts,
    });
    expect(headless.action).toBe("block");
    expect(reasonOf(headless)).toContain("No interactive approval is available.");

    const granted = inspectToolCall("read", { path: credentialFile }, cwd, {
      headless: true,
      grants: grantExact(credentialFile),
      ...opts,
    });
    expect(granted).toEqual({ action: "allow" });
  });

  test("blocks writes and edits to safety and credential roots in both modes", () => {
    for (const toolName of ["write", "edit"]) {
      for (const headless of [false, true]) {
        const safety = inspectToolCall(toolName, { path: safetyFile, content: "x" }, cwd, {
          headless,
          config: config(),
        });
        expect(safety).toEqual({
          action: "block",
          reason: "Blocked: the agent cannot access protected safety state.",
        });

        const credential = inspectToolCall(
          toolName,
          { path: credentialFile, content: "x" },
          cwd,
          { headless, config: config() },
        );
        expect(credential).toEqual({
          action: "block",
          reason: "Blocked: writing to a protected credential path.",
        });
      }
    }
  });

  test("allows read/grep/glob of instruction roots, blocks writes in both modes", () => {
    for (const toolName of ["read", "grep", "glob"]) {
      for (const headless of [false, true]) {
        const decision = inspectToolCall(toolName, { path: instructionFile }, cwd, {
          headless,
          config: config(),
        });
        expect(decision).toEqual({ action: "allow" });
      }
    }

    for (const toolName of ["write", "edit"]) {
      for (const headless of [false, true]) {
        const decision = inspectToolCall(toolName, { path: instructionFile, content: "x" }, cwd, {
          headless,
          config: config(),
        });
        expect(decision).toEqual({
          action: "block",
          reason: "Blocked: writing to a protected instruction file.",
        });
      }
    }
  });

  test("blocks bash and eval mentions of instruction roots", () => {
    for (const headless of [false, true]) {
      const bashDecision = inspectToolCall(
        "bash",
        { command: `cat ${instructionFile}` },
        cwd,
        { headless, config: config() },
      );
      expect(bashDecision).toEqual({
        action: "block",
        reason: "Blocked: the agent cannot modify or inspect protected instruction files.",
      });
    }

    const evalDecision = inspectToolCall(
      "eval",
      { code: `open(${JSON.stringify(instructionFile)})` },
      cwd,
      { headless: true, config: config() },
    );
    expect(evalDecision.action).toBe("block");
  });

  test("allows writes to unprotected paths", () => {
    const decision = inspectToolCall(
      "write",
      { path: path.join(tmpRoot, "scratch.txt"), content: "x" },
      cwd,
      { headless: true, config: config() },
    );
    expect(decision).toEqual({ action: "allow" });
  });

  test("blocks metadata-host access in bash", () => {
    for (const headless of [false, true]) {
      const decision = inspectToolCall(
        "bash",
        { command: "curl http://169.254.169.254/latest/meta-data/" },
        cwd,
        { headless, config: config() },
      );
      expect(decision.action).toBe("block");
    }
  });

  test("allows unknown tools", () => {
    for (const headless of [false, true]) {
      expect(
        inspectToolCall("custom_tool", { path: credentialFile }, cwd, {
          headless,
          config: config(),
        }),
      ).toEqual({ action: "allow" });
    }
  });
});
