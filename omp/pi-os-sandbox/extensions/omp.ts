/**
 * @fileoverview OMP adapter: loads the operator config, gates tool calls
 * through the shared policy with interactive approval and headless grants,
 * and exposes a rule customization page plus denial-ring diagnostics.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, KeybindingsManager, Theme } from "@oh-my-pi/pi-coding-agent";
import { DenialRing } from "../src/block-feedback";
import { defaultConfig, loadConfig, type SandboxConfig } from "../src/config";
import {
  loadDisabledRules,
  ruleRegistry,
  saveDisabledRules,
  type RuleInfo,
  type SandboxTab,
} from "../src/customization";
import { inspectToolCall } from "../src/policy";
import { redact } from "../src/redaction";
import { SessionGrants } from "../src/session-grants";

const CONFIG_PATH = join(homedir(), ".omp", "agent", "pi-os-sandbox.json");

/** Tabs of the customization page, in display order. */
const TABS: SandboxTab[] = ["catastrophic-floor", "prompt-classes", "path-policy"];

/** Short display label for each customization tab. */
const TAB_LABELS: Record<SandboxTab, string> = {
  "catastrophic-floor": "catastrophic floor",
  "prompt-classes": "prompt classes",
  "path-policy": "path policy",
};

/**
 * Host renderer surface the page uses. Kept local because the host exposes
 * the full TUI type only through @oh-my-pi/pi-tui, which is not resolvable
 * from this package; the real host type satisfies it structurally.
 */
interface TuiSurface {
  requestRender(force?: boolean): void;
  readonly terminal: { readonly rows: number };
}

/**
 * Render contract the host overlay engine expects from the page. Local mirror
 * of the pi-tui Component interface for the same resolution reason.
 */
interface PageComponent {
  render(width: number): readonly string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}

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

/** Reads a string field from unknown tool input, or null when absent. */
function stringField(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object" || !(key in input)) return null;
  const value = Reflect.get(input, key);
  return typeof value === "string" ? value : null;
}

/** Display preview of a tool call: command, truncated eval code, or tool name. */
function preview(toolName: string, input: unknown): string {
  if (toolName === "bash") return stringField(input, "command") ?? "";
  if (toolName === "eval") {
    const code = stringField(input, "code") ?? "";
    return code.length > 1200 ? `${code.slice(0, 1200)}...` : code;
  }
  return `Tool: ${toolName}`;
}

/** Exact, untruncated command/code used as the grant key for a tool call. */
function previewCommand(toolName: string, input: unknown): string {
  if (toolName === "bash") return stringField(input, "command") ?? "";
  if (toolName === "eval") return stringField(input, "code") ?? "";
  return `Tool: ${toolName}`;
}

/** Clips plain text to a width, appending an ellipsis when shortened. */
function clip(text: string, width: number): string {
  if (width < 3 || text.length <= width) return text;
  return `${text.slice(0, width - 3)}...`;
}

/**
 * Full-screen rule customization page mirroring the /settings navigation: a
 * tab bar, a searchable rule list, and keyboard plus mouse controls. Toggling
 * a rule persists it to the operator config and records a denial-ring entry;
 * the change applies on the next tool call.
 */
class SandboxPage implements PageComponent {
  private readonly disabled: Set<string>;
  private activeTab = 0;
  private query = "";
  private selected = 0;
  private cache: { width: number; lines: readonly string[] } | null = null;
  private readonly rowHits: { row: number; index: number }[] = [];
  private readonly tabHits: { start: number; end: number; index: number }[] = [];

  /**
   * Creates the page with the operator's current disabled rules loaded.
   *
   * @param tui host renderer, repaints after every state change.
   * @param theme host theme, styles rows and tabs.
   * @param keybindings host key bindings, navigation follows user remaps.
   * @param done closes the page.
   * @param configPath operator config file toggles are saved to.
   * @param ring denial ring that receives toggle entries.
   * @param onToggle applies the changed disabled set to the in-memory config.
   */
  constructor(
    private readonly tui: TuiSurface,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
    private readonly configPath: string,
    private readonly ring: DenialRing,
    private readonly onToggle: (disabled: Set<string>) => void,
  ) {
    this.disabled = loadDisabledRules(configPath);
  }

  /** Rules in the active tab, filtered by id, name, and remediation text. */
  private visibleRules(): RuleInfo[] {
    const tab = TABS[this.activeTab]!;
    const query = this.query.trim().toLowerCase();
    return ruleRegistry().filter((rule) => {
      if (rule.tab !== tab) return false;
      if (query === "") return true;
      return (
        rule.id.toLowerCase().includes(query) ||
        rule.name.toLowerCase().includes(query) ||
        rule.remediation.toLowerCase().includes(query)
      );
    });
  }

  /** Number of rule rows the terminal fits below the fixed header and footer. */
  private pageSize(): number {
    return Math.max(1, this.tui.terminal.rows - 4);
  }

  /** Moves the selection by delta rows, clamped to the filtered list. */
  private moveSelection(delta: number): void {
    const count = this.visibleRules().length;
    if (count === 0) return;
    this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
    this.repaint();
  }

  /** Switches to the neighboring tab, wrapping around. */
  private switchTab(delta: -1 | 1): void {
    this.activeTab = (this.activeTab + delta + TABS.length) % TABS.length;
    this.selected = 0;
    this.repaint();
  }

  /** Toggles the currently selected rule. */
  private toggleSelected(): void {
    const rule = this.visibleRules()[this.selected];
    if (rule) this.toggle(rule);
  }

  /** Toggles one rule: persists it, applies it to the in-memory config, and records a ring entry. */
  private toggle(rule: RuleInfo): void {
    if (this.disabled.has(rule.id)) {
      this.disabled.delete(rule.id);
    } else {
      this.disabled.add(rule.id);
    }
    saveDisabledRules(this.disabled, this.configPath);
    this.onToggle(this.disabled);
    const state = this.disabled.has(rule.id) ? "disabled" : "enabled";
    this.ring.record({
      kind: "toggle",
      rule: rule.id,
      tool: "sandbox",
      reason: redact(`Operator ${state} rule ${rule.id}`),
    });
    this.repaint();
  }

  /** Drops the cached frame so the next render rebuilds it. */
  private repaint(): void {
    this.cache = null;
    this.tui.requestRender();
  }

  /** Drops the cached frame on theme changes. */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Handles a key press: mouse reports, list navigation, search editing, and
   * toggling, then repaints when the page changed.
   */
  handleInput(data: string): void {
    if (this.handleMouse(data)) return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.toggleSelected();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-this.pageSize());
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(this.pageSize());
      return;
    }
    if (data === "\t" || data === "\x1b[C") {
      this.switchTab(1);
      return;
    }
    if (data === "\x1b[D" || data === "\x1b[Z") {
      this.switchTab(-1);
      return;
    }
    if (data === "\x7f" || data === "\b") {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.selected = 0;
        this.repaint();
      }
      return;
    }
    if (data.length === 1 && data >= " " && data !== "\x1b") {
      this.query += data;
      this.selected = 0;
      this.repaint();
    }
  }

  /**
   * Routes an SGR mouse report: wheel scrolls the selection, clicks toggle a
   * rule or switch tabs.
   */
  private handleMouse(data: string): boolean {
    const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
    if (!match) return false;
    const button = Number(match[1]);
    const col = Number(match[2]) - 1;
    const row = Number(match[3]) - 1;
    const release = match[4] === "m";
    const wheel = button & 64 ? (button & 1 ? 1 : -1) : null;
    const motion = (button & 32) !== 0 && wheel === null;
    const leftClick = !release && wheel === null && !motion && (button & 3) === 0;
    if (wheel !== null) {
      this.moveSelection(wheel);
      return true;
    }
    if (motion || !leftClick) return true;
    const tab = this.tabHits.find((hit) => row === 1 && col >= hit.start && col < hit.end);
    if (tab) {
      this.activeTab = tab.index;
      this.selected = 0;
      this.repaint();
      return true;
    }
    const hit = this.rowHits.find((zone) => zone.row === row);
    if (hit) {
      this.selected = hit.index;
      this.toggleSelected();
    }
    return true;
  }

  /** Builds one rule row: cursor, id, state, then name and description. */
  private renderRow(rule: RuleInfo, isSelected: boolean, idWidth: number, width: number): string {
    const cursor = isSelected ? this.theme.fg("accent", ">") : " ";
    const stateText = this.disabled.has(rule.id) ? "[disabled]" : "[enabled]";
    const state = this.disabled.has(rule.id)
      ? this.theme.fg("warning", stateText)
      : this.theme.fg("success", stateText);
    const prefixWidth = 2 + idWidth + 1 + stateText.length + 1;
    const detail = clip(`${rule.name} — ${rule.description}`, Math.max(0, width - prefixWidth));
    const row = `${cursor} ${rule.id.padEnd(idWidth)} ${state} ${detail}`;
    return isSelected ? this.theme.bg("selectedBg", row) : row;
  }

  /** Renders the page frame, returning a cached copy while unchanged. */
  render(width: number): readonly string[] {
    if (this.cache !== null && this.cache.width === width) return this.cache.lines;

    const list = this.visibleRules();
    if (this.selected >= list.length) this.selected = Math.max(0, list.length - 1);
    const listRows = this.pageSize();
    const windowStart = Math.min(
      Math.max(0, this.selected - listRows + 1),
      Math.max(0, list.length - listRows),
    );
    const idWidth = ruleRegistry().reduce((widest, rule) => Math.max(widest, rule.id.length), 0);

    const lines: string[] = [];
    this.rowHits.length = 0;
    this.tabHits.length = 0;

    lines.push(` ${this.theme.bold(this.theme.fg("accent", "pi-os-sandbox rule customization"))}`);

    let tabLine = " ";
    let col = 1;
    for (let i = 0; i < TABS.length; i++) {
      const chip = ` ${TAB_LABELS[TABS[i]!]} `;
      this.tabHits.push({ start: col, end: col + chip.length, index: i });
      tabLine += i === this.activeTab ? this.theme.bg("selectedBg", chip) : this.theme.fg("muted", chip);
      col += chip.length + 2;
    }
    lines.push(tabLine);

    const search =
      this.query === ""
        ? this.theme.fg("dim", "type to filter by id, name, or remediation")
        : this.theme.bold(this.query);
    lines.push(` search: ${search}`);

    if (list.length === 0) {
      lines.push(` ${this.theme.fg("dim", "(no rules match)")}`);
    } else {
      for (let i = windowStart; i < Math.min(list.length, windowStart + listRows); i++) {
        const rule = list[i]!;
        lines.push(this.renderRow(rule, i === this.selected, idWidth, width));
        this.rowHits.push({ row: lines.length - 1, index: i });
      }
    }

    lines.push(` ${this.theme.fg("dim", "enter/click: toggle | up/down: move | tab/arrows: switch | type: search | esc: close")}`);

    this.cache = { width, lines };
    return lines;
  }
}

/**
 * Gate tool calls through the policy, prompting for approval and granting
 * exact commands for headless reuse. Every denial and grant is recorded in
 * the denial ring; the /sandbox page lets the operator disable rules.
 *
 * @param config explicit config for tests, defaults to the loaded operator config.
 * @param configPath config file the customization page reads and writes,
 *                   defaults to the operator config.
 * @returns the denial ring, exposed for diagnostics and tests.
 */
export function createSandboxHandler(
  pi: ExtensionAPI,
  config: SandboxConfig = loadSandboxConfig(CONFIG_PATH, (message) => pi.logger.warn(message)),
  configPath: string = CONFIG_PATH,
): { ring: DenialRing } {
  const grants = new SessionGrants();
  const ring = new DenialRing();

  pi.on("tool_call", async (event, ctx) => {
    try {
      const decision = inspectToolCall(event.toolName, event.input, ctx.cwd, {
        headless: !ctx.hasUI,
        grants,
        config,
      });
      if (decision.action === "allow") return undefined;
      if (decision.action === "block" || !ctx.hasUI) {
        ring.record({
          kind: "block",
          rule: decision.rule,
          tool: event.toolName,
          reason: redact(decision.reason),
        });
        return { block: true, reason: redact(decision.reason) };
      }
      ring.record({
        kind: "prompt",
        rule: decision.rule,
        tool: event.toolName,
        reason: redact(decision.reason),
      });
      const approved = await ctx.ui.confirm(
        "Approve risky operation?",
        `${decision.reason}\n\n${preview(event.toolName, event.input)}`,
      );
      if (approved) {
        grants.grant(previewCommand(event.toolName, event.input), ctx.cwd);
        ring.record({
          kind: "grant",
          rule: decision.rule,
          tool: event.toolName,
          reason: "Operator approved the call.",
        });
        return undefined;
      }
      ring.record({
        kind: "block",
        rule: decision.rule,
        tool: event.toolName,
        reason: "Operator declined approval.",
      });
      return { block: true, reason: "Blocked: exact approval was not granted." };
    } catch {
      return { block: true, reason: "Blocked: sandbox policy error." };
    }
  });

  pi.registerCommand("sandbox", {
    description: "Open the pi-os-sandbox rule customization page",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("pi-os-sandbox: /sandbox is terminal-only; run it in interactive mode.", "warning");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) =>
          new SandboxPage(tui, theme, keybindings, done, configPath, ring, (disabled) => {
            config.disabledRules = [...disabled];
          }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-left",
            width: "100%",
            maxHeight: "100%",
            margin: 0,
            fullscreen: true,
          },
        },
      );
    },
  });

  pi.registerCommand("sandbox-status", {
    description: "Show pi-os-sandbox policy summary",
    handler: async (_args, ctx) => {
      const disabledCount = config.disabledRules.length;
      ctx.ui.notify(
        `pi-os-sandbox: ${config.safetyRoots.length} safety roots, ${config.credentialRoots.length} credential roots, ` +
          `${config.metadataHosts.length} metadata hosts, ${disabledCount} disabled rule${disabledCount === 1 ? "" : "s"}, ` +
          `headless: fail-closed; ${ring.summary()}`,
      );
    },
  });

  return { ring };
}

export default function (pi: ExtensionAPI): void {
  createSandboxHandler(pi);
}
