/**
 * @fileoverview OMP adapter: gates tool calls through the shared policy with
 * interactive approval and headless grants, and exposes a Settings-style
 * rule customization page with session overrides and policy activity.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, KeybindingsManager, Theme } from "@oh-my-pi/pi-coding-agent";
import { AuditJournal, DEFAULT_JOURNAL_PATH } from "../src/audit-journal";
import { PolicyActivity, type PolicyActivityEntry } from "../src/block-feedback";
import { defaultConfig, loadConfig, type SandboxConfig } from "../src/config";
import {
  loadDisabledRules,
  ruleRegistry,
  saveDisabledRules,
  type SandboxRule,
  type SandboxTab,
} from "../src/customization";
import { inspectToolCall } from "../src/policy";
import { redact } from "../src/redaction";
import { SessionGrants } from "../src/session-grants";

import { visibleWidth, truncateToWidth, padding, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { fit, topBorder, divider, bottomBorder, row, splitRow, topBorderSplit, dividerSplit } from "../src/overlay-box";

const CONFIG_PATH = join(homedir(), ".omp", "agent", "pi-os-sandbox.json");

let cachedSandboxSidebarWidth: number | undefined;
function sandboxSidebarWidth(): number {
  if (cachedSandboxSidebarWidth !== undefined) return cachedSandboxSidebarWidth;
  let nameWidth = 0;
  for (const tab of TABS) nameWidth = Math.max(nameWidth, visibleWidth(TAB_LABELS[tab] ?? tab));
  cachedSandboxSidebarWidth = Math.min(22, nameWidth) + 4;
  return cachedSandboxSidebarWidth;
}

function footerHintText(searching: boolean, mode: PageMode, hasOverrides: boolean): string {
  if (searching) return "Type to search · Esc clear search · Enter select · ↑/↓ move";
  if (mode === "session" && hasOverrides) return "Enter/Space change · Tab jump sections · ←/→ switch tabs · Type to search · Esc close · r reset session";
  return "Enter/Space change · Tab jump sections · ←/→ switch tabs · Type to search · Esc close";
}

/** Tabs in display order: three rule groups plus the activity log. */
const TABS: SandboxTab[] = ["safety-floor", "prompt-classes", "path-policy", "activity"];

/** Short display label for each tab. */
const TAB_LABELS: Record<SandboxTab, string> = {
  "safety-floor": "Safety floor",
  "prompt-classes": "Prompt classes",
  "path-policy": "Path policy",
  activity: "Activity",
};

/** Host-style icon for each tab, matching Settings spacing. */
const TAB_ICONS: Record<SandboxTab, string> = {
  "safety-floor": "⬢",
  "prompt-classes": "⬣",
  "path-policy": "⬔",
  activity: "◈",
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

/** Mode of the page: persistent saves to disk, session keeps overrides in memory. */
type PageMode = "saved" | "session";

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

/** Shortens an absolute path with ~/ when under the home directory. */
function shortPath(path: string): string {
  const home = resolve(homedir());
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return `~/${path.slice(home.length + 1)}`;
  return path;
}

/** Relative time label for an activity entry. */
function relativeTime(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Paths displayed for a path-policy rule, drawn from the default config. */
function protectedPathsForRule(rule: SandboxRule, config: SandboxConfig): string[] {
  if (rule.group !== "path-policy") return [];
  if (rule.id === "write-credentials") return config.credentialRoots;
  if (rule.id === "write-instruction-files" || rule.id === "access-instruction-files")
    return config.instructionRoots;
  return [];
}

/** Grouped search hit: either a rule or an activity entry. */
type GroupedHit =
  | { kind: "rule"; group: SandboxTab; rule: SandboxRule }
  | { kind: "activity"; entry: PolicyActivityEntry; isCurrent: boolean };

/**
 * Full-screen rule customization page mirroring Settings: bordered overlay,
 * four tabs with icons, left list / right details, global grouped search,
 * activity merging, session overrides, and mouse plus keyboard controls.
 */
class SandboxPage implements PageComponent {
  private activeTab = 0;
  private query = "";
  private selected = 0;
  private detailsScroll = 0;
  private cache: { width: number; lines: readonly string[] } | null = null;
  private readonly rowHits: { row: number; index: number; stateStart: number; stateEnd: number }[] = [];
  private readonly tabHits: { start: number; end: number; index: number }[] = [];
  private readonly sidebarHitRows: (number | undefined)[] = [];
  private readonly hitRowsByLine: (number | undefined)[] = [];
  private readonly stateStartsByLine: (number | undefined)[] = [];
  private sidebarHitCol = 0;
  private tabRowStart = 0;
  private tabRowCount = 0;
  private contentRowStart = 0;
  private contentRowCount = 0;
  private expanded = false;

  /**
   * Creates the page.
   *
   * @param tui host renderer, repaints after every state change.
   * @param theme host theme, styles rows and tabs.
   * @param keybindings host key bindings, navigation follows user remaps.
   * @param done closes the page.
   * @param configPath operator config file toggles are saved to.
   * @param activity policy activity that receives toggle entries.
   * @param journal persisted audit journal for activity merging.
   * @param config in-memory config whose disabledRules reflects the effective set.
   * @param savedDisabled persistent disabled ids loaded from disk.
   * @param sessionOverrides in-memory session overrides shared across pages.
   * @param mode saved writes to disk, session keeps overrides in memory.
   * @param confirm host confirm dialog for safety-floor toggles.
   * @param notify host notify for status lines.
   */
  constructor(
    private readonly tui: TuiSurface,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
    private readonly configPath: string,
    private readonly activity: PolicyActivity,
    private readonly journal: AuditJournal | undefined,
    private readonly config: SandboxConfig,
    private readonly savedDisabled: Set<string>,
    private readonly sessionOverrides: Map<string, boolean>,
    private readonly mode: PageMode,
    private readonly confirm: (title: string, message: string) => Promise<boolean>,
    private readonly notify: (message: string) => void,
  ) {}

  /** Effective disabled set: session overrides overlay the saved set. */
  private effectiveSet(): Set<string> {
    const out = new Set<string>();
    for (const rule of ruleRegistry()) {
      const overridden = this.sessionOverrides.get(rule.id);
      const disabled = overridden !== undefined ? overridden : this.savedDisabled.has(rule.id);
      if (disabled) out.add(rule.id);
    }
    return out;
  }

  /** Whether a rule id is effectively disabled. */
  private isEffectiveDisabled(id: string): boolean {
    const overridden = this.sessionOverrides.get(id);
    if (overridden !== undefined) return overridden;
    return this.savedDisabled.has(id);
  }

  /** Apply the effective set to the in-memory config. */
  private syncConfig(): void {
    this.config.disabledRules = [...this.effectiveSet()];
  }

  /** Rules in the active tab filtered by the current query when not in global search. */
  private visibleRules(): SandboxRule[] {
    const tab = TABS[this.activeTab]!;
    if (tab === "activity") return [];
    return ruleRegistry().filter((rule) => rule.group === tab);
  }

  /** Merged activity entries: current plus persisted journal, deduped newest first. */
  private mergedActivity(): { entry: PolicyActivityEntry; isCurrent: boolean }[] {
    const current = this.activity.entries();
    const currentKeys = new Set(current.map((entry) => `${entry.at}|${entry.rule}|${entry.tool}`));
    const merged: { entry: PolicyActivityEntry; isCurrent: boolean }[] = current.map((entry) => ({
      entry,
      isCurrent: true,
    }));
    if (this.journal) {
      for (const record of this.journal.entries()) {
        const key = `${record.at}|${record.rule ?? ""}|${record.tool ?? ""}`;
        if (currentKeys.has(key)) continue;
        const kind =
          record.kind === "denial"
            ? "block"
            : record.kind === "grant"
              ? "grant"
              : record.kind === "toggle"
                ? "toggle"
                : "block";
        merged.push({
          entry: {
            at: record.at,
            kind: kind as PolicyActivityEntry["kind"],
            rule: record.rule ?? "",
            tool: record.tool ?? "",
            reason: record.reason,
          },
          isCurrent: false,
        });
      }
    }
    merged.sort((a, b) => b.entry.at - a.entry.at);
    return merged;
  }

  /** All grouped hits for the current query, across rule tabs and activity. */
  private groupedHits(): GroupedHit[] {
    const q = this.query.trim().toLowerCase();
    if (q === "") return [];
    const hits: GroupedHit[] = [];
    for (const rule of ruleRegistry()) {
      const hay = `${rule.name} ${rule.id} ${rule.description} ${rule.nextStep}`.toLowerCase();
      if (hay.includes(q)) hits.push({ kind: "rule", group: rule.group as SandboxTab, rule });
    }
    for (const { entry, isCurrent } of this.mergedActivity()) {
      const hay = `${entry.kind} ${entry.rule} ${entry.tool} ${entry.reason}`.toLowerCase();
      if (hay.includes(q)) hits.push({ kind: "activity", entry, isCurrent });
    }
    // Keep tab order for rules: safety-floor, prompt-classes, path-policy, then activity hits at end.
    const order: Record<string, number> = {
      "safety-floor": 0,
      "prompt-classes": 1,
      "path-policy": 2,
      activity: 3,
    };
    hits.sort((a, b) => {
      const ga = a.kind === "rule" ? order[a.group]! : 3;
      const gb = b.kind === "rule" ? order[b.group]! : 3;
      if (ga !== gb) return ga - gb;
      if (a.kind === "rule" && b.kind === "rule") return a.rule.name.localeCompare(b.rule.name);
      return 0;
    });
    return hits;
  }

  /** Whether the page is currently in global search mode. */
  private isSearching(): boolean {
    return this.query.trim() !== "";
  }

  /** Number of selectable rows in the current view. */
  private selectableCount(): number {
    if (this.isSearching()) return this.groupedHits().length;
    const tab = TABS[this.activeTab]!;
    if (tab === "activity") return this.mergedActivity().length;
    return this.visibleRules().length;
  }

  /** Rule or activity at the current selection, if any. */
  private selectedHit(): GroupedHit | { kind: "rule"; rule: SandboxRule } | { kind: "activity"; entry: PolicyActivityEntry; isCurrent: boolean } | null {
    if (this.isSearching()) return this.groupedHits()[this.selected] ?? null;
    const tab = TABS[this.activeTab]!;
    if (tab === "activity") {
      const merged = this.mergedActivity();
      const hit = merged[this.selected];
      return hit ? { kind: "activity", entry: hit.entry, isCurrent: hit.isCurrent } : null;
    }
    const rule = this.visibleRules()[this.selected];
    return rule ? { kind: "rule", rule } : null;
  }

  /** Number of rows the terminal fits below the fixed header/footer. */
  private pageSize(): number {
    return Math.max(1, this.tui.terminal.rows - 10);
  }

  /** Moves the selection by delta rows, clamped. */
  private moveSelection(delta: number): void {
    const count = this.selectableCount();
    if (count === 0) return;
    this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
    this.detailsScroll = 0;
    this.repaint();
  }

  /** Switches to the neighboring tab, wrapping around. */
  private switchTab(delta: -1 | 1): void {
    if (this.isSearching()) return;
    this.activeTab = (this.activeTab + delta + TABS.length) % TABS.length;
    this.selected = 0;
    this.detailsScroll = 0;
    this.repaint();
  }

  /** Toggles the currently selected rule, confirming for safety-floor. */
  private async toggleSelected(): Promise<void> {
    const hit = this.selectedHit();
    if (!hit || hit.kind !== "rule") return;
    await this.toggle(hit.rule);
  }

  /** Toggles one rule, handling saved vs session and safety-floor confirm. */
  private async toggle(rule: SandboxRule): Promise<void> {
    if (rule.isSafetyFloor) {
      const ok = await this.confirm(
        "Disable safety floor?",
        `Disabling ${rule.name} (${rule.id}) weakens the safety floor. Continue?`,
      );
      if (!ok) return;
    }
    const effectiveBefore = this.isEffectiveDisabled(rule.id);
    const nextDisabled = !effectiveBefore;
    if (this.mode === "session") {
      this.sessionOverrides.set(rule.id, nextDisabled);
      this.syncConfig();
      // Record session-only toggle as current activity without persisting to journal file beyond memory.
      this.activity.record({
        kind: "toggle",
        rule: rule.id,
        tool: "sandbox",
        reason: redact(
          `Operator ${nextDisabled ? "disabled" : "enabled"} rule ${rule.id} (session-only; saved: ${this.savedDisabled.has(rule.id) ? "disabled" : "enabled"} → session: ${nextDisabled ? "disabled" : "enabled"})`,
        ),
      });
      this.notify(`Session: ${rule.name} ${nextDisabled ? "disabled" : "enabled"} (saved: ${this.savedDisabled.has(rule.id) ? "disabled" : "enabled"} → session: ${nextDisabled ? "disabled" : "enabled"})`);
    } else {
      if (nextDisabled) this.savedDisabled.add(rule.id);
      else this.savedDisabled.delete(rule.id);
      // If a session override existed for this id, clear it so saved wins.
      if (this.sessionOverrides.has(rule.id)) {
        const savedVal = this.savedDisabled.has(rule.id);
        if (this.sessionOverrides.get(rule.id) === savedVal) this.sessionOverrides.delete(rule.id);
        else if (!nextDisabled && !this.savedDisabled.has(rule.id)) {
          // keep override only if it still differs; if now equals saved, drop
          if (!this.sessionOverrides.get(rule.id)) this.sessionOverrides.delete(rule.id);
        }
      }
      saveDisabledRules(this.savedDisabled, this.configPath);
      this.syncConfig();
      const state = nextDisabled ? "disabled" : "enabled";
      this.activity.record({
        kind: "toggle",
        rule: rule.id,
        tool: "sandbox",
        reason: redact(`Operator ${state} rule ${rule.id}`),
      });
      this.notify(`Saved: ${rule.name} ${state}`);
    }
    this.repaint();
  }

  /** Clears session overrides, restoring saved state. */
  private resetSession(): void {
    if (this.sessionOverrides.size === 0) return;
    this.sessionOverrides.clear();
    this.syncConfig();
    this.notify("Session overrides cleared");
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
    // Session drawer is keyboard-only like ModelPicker (model-picker.ts:65-67);
    // mouse tracking is reserved for fullscreen overlays (tui.ts:353-371).
    if (this.mode === "saved" && this.handleMouse(data)) return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.isSearching()) {
        this.query = "";
        this.selected = 0;
        this.repaint();
        return;
      }
      this.done();
      return;
    }
    if (data === "\x1b") {
      if (this.isSearching()) {
        this.query = "";
        this.selected = 0;
        this.repaint();
        return;
      }
      this.done();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      void this.toggleSelected();
      return;
    }
    if (data === " " && !this.isSearching()) {
      void this.toggleSelected();
      return;
    }
    if (data === " " && this.isSearching()) {
      // Space toggles in search too without leaving search.
      void this.toggleSelected();
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
    if (data === "\t") {
      if (this.isSearching()) return;
      this.switchTab(1);
      return;
    }
    if (data === "\x1b[C") {
      this.switchTab(1);
      return;
    }
    if (data === "\x1b[D" || data === "\x1b[Z") {
      this.switchTab(-1);
      return;
    }
    // Reset shortcut in session mode: 'r' when overrides exist and not searching? Use explicit key 'r' guarded.
    if (this.mode === "session" && this.sessionOverrides.size > 0 && data === "r" && !this.isSearching()) {
      this.resetSession();
      return;
    }
    if (data === "\x0f" || data === "\x0F") {
      this.expanded = !this.expanded;
      this.repaint();
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

  private hitTest(line: number, col: number): number | undefined {
    if (this.sidebarHitCol > 0 && col < this.sidebarHitCol) return this.sidebarHitRows[line];
    return this.hitRowsByLine[line];
  }
  private hoverTest(line: number, col: number): number | undefined {
    if (this.sidebarHitCol > 0 && col < this.sidebarHitCol) return undefined;
    return this.hitRowsByLine[line];
  }

  /**
   * Routes an SGR mouse report: wheel scrolls the selection, clicks toggle a
   * rule or switch tabs. Uses host geometry (tabRowStart/contentRowStart) and
   * innerCol inset like SettingsSelector. Guarded to fullscreen only —
   * session drawer is keyboard-only (model-picker.ts:65-67, tui.ts:353-371).
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
    const innerCol = col - 2;
    const contentLine = row - this.contentRowStart;
    const tabLine = row - this.tabRowStart;
    const overTabs = tabLine >= 0 && tabLine < this.tabRowCount;
    const overContent = contentLine >= 0 && contentLine < this.contentRowCount;
    if (wheel !== null) {
      if (overContent) {
        if (this.sidebarHitCol > 0 && innerCol < this.sidebarHitCol) return true;
        this.moveSelection(wheel);
      } else if (overTabs) this.moveSelection(wheel);
      else this.moveSelection(wheel);
      return true;
    }
    if (motion) return true;
    if (!leftClick) return true;
    if (overTabs && !this.isSearching()) {
      const hit = this.tabHits.find((h) => innerCol >= h.start && innerCol < h.end);
      if (hit) {
        this.activeTab = hit.index;
        this.selected = 0;
        this.detailsScroll = 0;
        this.repaint();
        return true;
      }
      const fallback = this.tabHits.find((h) => col >= h.start && col < h.end && row === this.tabRowStart);
      if (fallback && !this.isSearching()) {
        this.activeTab = fallback.index;
        this.selected = 0;
        this.detailsScroll = 0;
        this.repaint();
        return true;
      }
    }
    if (overContent) {
      const hoverId = this.hoverTest(contentLine, innerCol);
      const hitId = hoverId ?? this.hitTest(contentLine, innerCol);
      if (hitId !== undefined) {
        const wasSelected = this.selected === hitId;
        this.selected = hitId;
        this.detailsScroll = 0;
        if (wasSelected && hoverId !== undefined && !this.isSearching()) {
          const tab = TABS[this.activeTab]!;
          if (tab !== "activity") {
            const st = this.stateStartsByLine[contentLine];
            const isStateClick = st !== undefined && (innerCol >= st || col >= st) && innerCol >= 0;
            // Only state-area clicks toggle; row-body clicks just select (like original stateStart check)
            if (isStateClick) void this.toggleSelected();
            else this.repaint();
          } else this.repaint();
        } else {
          this.repaint();
        }
        return true;
      }
      // legacy absolute fallback for tests that use rowHits directly
      const legacy = this.rowHits.find((zone) => zone.row === row);
      if (legacy) {
        const isStateClick = col >= legacy.stateStart && col < legacy.stateEnd;
        const wasSelected = this.selected === legacy.index;
        this.selected = legacy.index;
        this.detailsScroll = 0;
        if (wasSelected && isStateClick) void this.toggleSelected();
        else if (wasSelected && legacy.stateStart === legacy.stateEnd) {
          // no state col (activity) — second click shouldn't toggle
          this.repaint();
        } else if (isStateClick) void this.toggleSelected();
        else this.repaint();
        return true;
      }
    }
    const legacy = this.rowHits.find((zone) => zone.row === row);
    if (legacy) {
      const wasSelected = this.selected === legacy.index;
      this.selected = legacy.index;
      this.detailsScroll = 0;
      if (wasSelected) void this.toggleSelected();
      else this.repaint();
    }
    return true;
  }

  /** Renders a rule row: friendly name left, state right with warning for safety-floor. */
  private renderRuleRow(rule: SandboxRule, isSelected: boolean, width: number): { line: string; stateStart: number; stateEnd: number } {
    const effective = this.isEffectiveDisabled(rule.id);
    const saved = this.savedDisabled.has(rule.id);
    const overridden = this.sessionOverrides.has(rule.id);
    let stateText: string;
    if (!overridden) stateText = effective ? "disabled" : "enabled";
    else stateText = `saved: ${saved ? "disabled" : "enabled"} → session: ${effective ? "disabled" : "enabled"}`;
    const isWarning = rule.isSafetyFloor && effective;
    if (isWarning) stateText = `${stateText} · warning`;
    const coloredState = effective
      ? this.theme.fg(isWarning ? "warning" : "warning", stateText)
      : this.theme.fg("success", stateText);
    const cursor = isSelected ? this.theme.fg("accent", ">") : " ";
    const left = `${cursor} ${rule.name}`;
    const plainStateLen = visibleWidth(stateText);
    const availableForLeft = Math.max(0, width - plainStateLen - 4);
    const leftClipped = truncateToWidth(left, availableForLeft);
    const pad = Math.max(1, width - visibleWidth(leftClipped) - plainStateLen - 1);
    const line = isSelected
      ? this.theme.bg("selectedBg", `${this.theme.bold(leftClipped)}${padding(pad)}${coloredState}`)
      : `${leftClipped}${padding(pad)}${coloredState}`;
    const stateStart = width - plainStateLen - 1;
    const stateEnd = width;
    return { line, stateStart, stateEnd };
  }

  /** Renders an activity row: action · rule · tool · time */
  private renderActivityRow(entry: PolicyActivityEntry, isSelected: boolean, width: number): string {
    const label = `${entry.kind} · ${entry.rule} · ${entry.tool} · ${relativeTime(entry.at)}`;
    const clipped = truncateToWidth(label, Math.max(0, width - 2));
    const cursor = isSelected ? this.theme.fg("accent", ">") : " ";
    const rowStr = `${cursor} ${clipped}`;
    return isSelected ? this.theme.bg("selectedBg", this.theme.bold(rowStr)) : rowStr;
  }

  /** Builds the details panel for a rule, in the spec order. */
  private ruleDetails(rule: SandboxRule, width: number): string[] {
    const out: string[] = [];
    const effective = this.isEffectiveDisabled(rule.id);
    const stateText = effective ? "disabled" : "enabled";
    const stateColor = effective ? "warning" : "success";
    const isWarning = rule.isSafetyFloor && effective;
    const stateLine = isWarning
      ? `${this.theme.fg("warning", "disabled · warning")}`
      : this.theme.fg(stateColor, stateText);
    out.push(truncateToWidth(` State: ${stateLine}`, width));
    // Full path to what's being edited — show config file and protected paths with absolute paths, not ~/.
    out.push(truncateToWidth(` ${this.theme.fg("dim", `Config: ${this.configPath}`)}`, width));
    // Description: 3 rows collapsed, full when expanded (ctrl+o)
    const descLines = wrapTextWithAnsi(rule.description, Math.max(1, width - 4));
    const useDesc = this.expanded ? descLines : descLines.slice(0, 3);
    const paddedDesc = this.expanded ? useDesc : (() => { const a = useDesc.slice(0, 3); while (a.length < 3) a.push(""); return a; })();
    for (let i = 0; i < paddedDesc.length; i++) {
      const line = paddedDesc[i]!;
      const styled = this.theme.fg("dim", line);
      out.push(truncateToWidth(` ${styled}`, width));
    }
    if (!this.expanded && descLines.length > 3) {
      out.push(truncateToWidth(` ${this.theme.fg("dim", `… ${descLines.length - 3} more lines (ctrl+o to expand)`)}`, width));
    }
    const paths = protectedPathsForRule(rule, this.config);
    if (paths.length > 0) {
      out.push(truncateToWidth(` ${this.theme.fg("muted", "Protected paths:")}`, width));
      // Show both short (~/) and full absolute for clarity; expandable shows all
      const showPaths = this.expanded ? paths : paths.slice(0, 5);
      for (const p of showPaths) out.push(truncateToWidth(`  ${shortPath(p)}  ${this.theme.fg("dim", `(${p})`)}`, width));
      if (!this.expanded && paths.length > 5) {
        out.push(truncateToWidth(`  ${this.theme.fg("dim", `… ${paths.length - 5} more (ctrl+o to expand)`)}`, width));
      }
    }
    out.push(truncateToWidth(` ${this.theme.fg("muted", "How to continue:")} ${rule.nextStep}`, width));
    out.push(truncateToWidth(` ${this.theme.fg("dim", `Rule id: ${rule.id}`)}`, width));
    return out.map((line) => truncateToWidth(line, width));
  }
  /** Builds the details panel for an activity entry. */
  private activityDetails(entry: PolicyActivityEntry, isCurrent: boolean, width: number): string[] {
    const out: string[] = [];
    out.push(truncateToWidth(` Action: ${entry.kind}`, width));
    out.push(truncateToWidth(` Rule: ${entry.rule || "—"}`, width));
    out.push(truncateToWidth(` Tool: ${entry.tool || "—"}`, width));
    out.push(truncateToWidth(` Time: ${relativeTime(entry.at)} (${new Date(entry.at).toLocaleString()})`, width));
    out.push(truncateToWidth(` Session: ${isCurrent ? "Current session" : "Previous sessions"}`, width));
    out.push(truncateToWidth(` Config: ${this.configPath}`, width));
    // Reason: collapsed 3 rows, expanded full with ctrl+o
    const reasonLines = wrapTextWithAnsi(entry.reason, Math.max(1, width - 4));
    const useReason = this.expanded ? reasonLines : reasonLines.slice(0, 3);
    const paddedReason = this.expanded ? useReason : (() => { const a = useReason.slice(0, 3); while (a.length < 3) a.push(""); return a; })();
    for (let i = 0; i < paddedReason.length; i++) {
      const prefix = i === 0 ? " Reason: " : "         ";
      out.push(truncateToWidth(`${prefix}${paddedReason[i]}`, width));
    }
    if (!this.expanded && reasonLines.length > 3) {
      out.push(truncateToWidth(` ${this.theme.fg("dim", `… ${reasonLines.length - 3} more lines (ctrl+o to expand)`)}`, width));
    }
    const previewText = entry.reason.length > 80 && !this.expanded ? `${entry.reason.slice(0, 80)}…` : entry.reason;
    const previewLabel = this.expanded ? "Full reason:" : "Preview:";
    // When expanded, show full reason wrapped, not just 80 chars
    if (this.expanded) {
      const fullLines = wrapTextWithAnsi(entry.reason, Math.max(1, width - 4));
      for (const l of fullLines) out.push(truncateToWidth(` ${l}`, width));
    } else {
      out.push(truncateToWidth(` ${previewLabel} ${previewText}`, width));
    }
    return out.map((line) => truncateToWidth(line, width));
  }

  /** Renders the page frame, returning a cached copy while unchanged. */
  render(width: number): readonly string[] {
    if (this.cache !== null && this.cache.width === width) return this.cache.lines;

    const height = Math.max(14, (this.tui.terminal?.rows ?? 40) as number);
    const innerWidth = Math.max(1, width - 4);

    this.rowHits.length = 0;
    this.tabHits.length = 0;
    this.sidebarHitRows.length = 0;
    this.hitRowsByLine.length = 0;
    this.sidebarHitCol = 0;

    const searching = this.isSearching();
    const title = this.mode === "session" ? "Session Sandbox" : "Sandbox";

    // Preview keeps summary + config full-path row so header stays host-verbatim.
    const totalRules = ruleRegistry().length;
    const savedEnabled = totalRules - this.savedDisabled.size;
    const effectiveDisabled = this.effectiveSet().size;
    const activeEnabled = totalRules - effectiveDisabled;
    const previewLines: string[] = [];
    if (this.mode === "session") {
      previewLines.push(this.theme.fg("dim", "Session-only changes: saved rules stay unchanged"));
    }
    previewLines.push(this.theme.fg("dim", `Saved rules: ${savedEnabled} enabled`));
    previewLines.push(this.theme.fg("dim", `Active rules: ${activeEnabled} enabled`));
    if (this.sessionOverrides.size > 0) {
      previewLines.push(this.theme.fg("warning", "Session overrides active"));
    }
    const configLabel = `Config: ${this.configPath}`;
    if (this.expanded) {
      const wrapped = wrapTextWithAnsi(configLabel, innerWidth);
      for (const line of wrapped) previewLines.push(this.theme.fg("dim", line));
    } else {
      previewLines.push(this.theme.fg("dim", truncateToWidth(configLabel, innerWidth)));
    }

    // Tab bar — single row, chips styled like Settings
    let tabContent = " ";
    let hitCol = 1;
    for (let i = 0; i < TABS.length; i++) {
      const tab = TABS[i]!;
      const chip = ` ${TAB_ICONS[tab]} ${TAB_LABELS[tab]} `;
      const chipWidth = visibleWidth(chip);
      this.tabHits.push({ start: hitCol, end: hitCol + chipWidth, index: i });
      let styled: string;
      try {
        styled = i === this.activeTab ? this.theme.bg("selectedBg", this.theme.bold(chip)) : this.theme.fg("muted", chip);
      } catch {
        styled = chip;
      }
      tabContent += styled + " ";
      hitCol += chipWidth + 2;
    }
    const tabClipped = truncateToWidth(tabContent, innerWidth);
    const tabLines = [tabClipped];

    const fixedRows = 1 + tabLines.length + 1 + (searching ? 1 : 0) + 1 + 1 + 1;
    const contentRows = Math.max(7, height - fixedRows - previewLines.length);

    const out: string[] = [];
    out.push(topBorder(width, title));
    this.tabRowStart = out.length;
    this.tabRowCount = tabLines.length;
    for (const line of tabLines) out.push(row(line, width));
    out.push(divider(width));
    if (searching) {
      const placeholder = this.theme.fg("dim", "Type to search rules and activity");
      const content = this.query === "" ? placeholder : this.theme.bold(this.query);
      const grouped = this.groupedHits();
      const matchInfo = `${grouped.length} matches`;
      const searchLine = this.query === ""
        ? ` Search: ${placeholder}`
        : ` Search: ${content}  ${this.theme.fg("dim", matchInfo)}`;
      out.push(row(truncateToWidth(searchLine, innerWidth), width));
    }
    this.contentRowStart = out.length;
    this.contentRowCount = contentRows;

    const contentLines: string[] = [];
    const hitRowsByLine: (number | undefined)[] = new Array(contentRows).fill(undefined);
    const sidebarHitRowsByLine: (number | undefined)[] = new Array(contentRows).fill(undefined);
    const stateStartsByLine: (number | undefined)[] = new Array(contentRows).fill(undefined);
    if (searching) {
      const grouped = this.groupedHits();
      if (grouped.length === 0) {
        contentLines.push(truncateToWidth(` ${this.theme.fg("dim", "No matching rules or activity")}`, innerWidth));
      } else {
        const groups: Record<string, GroupedHit[]> = {};
        for (const hit of grouped) {
          const key = hit.kind === "rule" ? (hit.group as string) : "activity";
          (groups[key] ??= []).push(hit);
        }
        const groupOrder: string[] = ["safety-floor", "prompt-classes", "path-policy", "activity"];
        let globalIndex = 0;
        const windowStart = Math.min(
          Math.max(0, this.selected - contentRows + 2),
          Math.max(0, grouped.length - contentRows + 1),
        );
        for (const g of groupOrder) {
          const hits = groups[g] ?? [];
          if (hits.length === 0) continue;
          const headingLabel =
            g === "safety-floor" ? "Safety floor" : g === "prompt-classes" ? "Prompt classes" : g === "path-policy" ? "Path policy" : "Activity";
          const groupStart = grouped.indexOf(hits[0]!);
          const groupEnd = grouped.indexOf(hits[hits.length - 1]!);
          if (groupEnd < windowStart || groupStart >= windowStart + contentRows) {
            globalIndex += hits.length;
            continue;
          }
          const heading = this.theme.bold(this.theme.fg("accent", headingLabel));
          if (contentLines.length < contentRows) {
            contentLines.push(truncateToWidth(` ${heading}`, innerWidth));
          }
          for (const hit of hits) {
            if (globalIndex < windowStart || globalIndex >= windowStart + contentRows) {
              globalIndex++;
              continue;
            }
            const isSelected = globalIndex === this.selected;
            if (contentLines.length >= contentRows) { globalIndex++; continue; }
            const lineIdx = contentLines.length;
            if (hit.kind === "rule") {
              const { line, stateStart } = this.renderRuleRow(hit.rule, isSelected, innerWidth);
              contentLines.push(truncateToWidth(line, innerWidth));
              hitRowsByLine[lineIdx] = globalIndex;
              stateStartsByLine[lineIdx] = stateStart;
            } else {
              const rowStr = this.renderActivityRow(hit.entry, isSelected, innerWidth);
              contentLines.push(truncateToWidth(rowStr, innerWidth));
              hitRowsByLine[lineIdx] = globalIndex;
            }
            globalIndex++;
          }
        }
        const selected = grouped[this.selected];
        if (selected && contentLines.length < contentRows) {
          const explanation = selected.kind === "rule" ? selected.rule.description : selected.entry.reason;
          const wrapped = wrapTextWithAnsi(explanation, Math.max(1, innerWidth - 4));
          const preview = wrapped.slice(0, 3).join(" ");
          contentLines.push(truncateToWidth(` ${this.theme.fg("dim", truncateToWidth(preview, innerWidth - 2))}`, innerWidth));
        }
      }
    } else {
      const tab = TABS[this.activeTab]!;
      if (tab === "activity") {
        const merged = this.mergedActivity();
        const count = merged.length;
        if (this.selected >= count) this.selected = Math.max(0, count - 1);
        const windowStart = Math.min(
          Math.max(0, this.selected - contentRows + 1),
          Math.max(0, count - contentRows),
        );
        if (count === 0) {
          contentLines.push(truncateToWidth(` ${this.theme.fg("dim", "No recent activity — blocks and changes will appear here.")}`, innerWidth));
        } else {
          const sidebarWidth = sandboxSidebarWidth();
          const paneWidth = innerWidth - sidebarWidth - 2;
          const isFlat = paneWidth < 60;
          let leftWidth: number;
          let rightWidth: number;
          if (isFlat) {
            leftWidth = innerWidth;
            rightWidth = 0;
            this.sidebarHitCol = 0;
          } else {
            leftWidth = Math.floor((innerWidth - 3) / 2);
            rightWidth = innerWidth - leftWidth - 3;
            this.sidebarHitCol = 0;
          }
          const visible = merged.slice(windowStart, windowStart + contentRows);
          const selectedEntry = merged[this.selected];
          const details = selectedEntry ? this.activityDetails(selectedEntry.entry, selectedEntry.isCurrent, Math.max(1, rightWidth)) : [];
          const maxRows = isFlat ? visible.length : Math.max(visible.length, details.length);
          if (isFlat) {
            for (let i = 0; i < visible.length && contentLines.length < contentRows; i++) {
              const idx = windowStart + i;
              const isSel = idx === this.selected;
              const { entry } = visible[i]!;
              const raw = this.renderActivityRow(entry, isSel, leftWidth);
              contentLines.push(truncateToWidth(raw, innerWidth));
              hitRowsByLine[contentLines.length - 1] = idx;
            }
          } else {
            for (let i = 0; i < maxRows && contentLines.length < contentRows; i++) {
              const idx = windowStart + i;
              const isSel = idx === this.selected;
              let left = "";
              if (i < visible.length) {
                const { entry } = visible[i]!;
                const raw = this.renderActivityRow(entry, isSel, leftWidth);
                left = fit(raw, leftWidth);
                hitRowsByLine[contentLines.length] = idx;
              } else {
                left = padding(leftWidth);
              }
              const right = fit(details[i] ?? "", rightWidth);
              const sep = this.theme.fg("dim", "│ ");
              const combined = truncateToWidth(left + sep + right, innerWidth);
              const finalLine = isSel && i < visible.length ? this.theme.bg("selectedBg", combined) : combined;
              contentLines.push(finalLine);
            }
          }
        }
      } else {
        const list = this.visibleRules();
        const count = list.length;
        if (this.selected >= count) this.selected = Math.max(0, count - 1);
        const windowStart = Math.min(
          Math.max(0, this.selected - contentRows + 1),
          Math.max(0, count - contentRows),
        );
        const selectedRule = list[this.selected];
        const sidebarWidth = sandboxSidebarWidth();
        const paneWidth = innerWidth - sidebarWidth - 2;
        const isFlat = paneWidth < 60;
        let leftWidth: number;
        let rightWidth: number;
        if (isFlat) {
          leftWidth = innerWidth;
          rightWidth = 0;
          this.sidebarHitCol = 0;
        } else {
          leftWidth = Math.floor((innerWidth - 3) / 2);
          rightWidth = innerWidth - leftWidth - 3;
          this.sidebarHitCol = 0;
        }
        const visible = list.slice(windowStart, windowStart + contentRows);
        const details = selectedRule ? this.ruleDetails(selectedRule, Math.max(1, isFlat ? innerWidth : rightWidth)) : [];
        if (count === 0) {
          contentLines.push(truncateToWidth(` ${this.theme.fg("dim", "(no rules)")}`, innerWidth));
        } else if (isFlat) {
          for (let i = 0; i < visible.length && contentLines.length < contentRows; i++) {
            const idx = windowStart + i;
            const rule = visible[i]!;
            const isSel = idx === this.selected;
            const rendered = this.renderRuleRow(rule, isSel, leftWidth);
            contentLines.push(truncateToWidth(rendered.line, innerWidth));
            hitRowsByLine[contentLines.length - 1] = idx;
            stateStartsByLine[contentLines.length - 1] = rendered.stateStart;
          }
        } else {
          const maxRows = Math.max(visible.length, details.length, 1);
          for (let i = 0; i < maxRows && contentLines.length < contentRows; i++) {
            const idx = windowStart + i;
            const rule = visible[i];
            const isSel = idx === this.selected;
            let left = "";
            if (rule) {
              const rendered = this.renderRuleRow(rule, isSel, leftWidth);
              left = fit(truncateToWidth(rendered.line, leftWidth), leftWidth);
              hitRowsByLine[contentLines.length] = idx;
              stateStartsByLine[contentLines.length] = rendered.stateStart;
            } else {
              left = padding(leftWidth);
            }
            const right = fit(details[i] ?? "", rightWidth);
            const sep = this.theme.fg("dim", "│ ");
            const combined = truncateToWidth(left + sep + right, innerWidth);
            contentLines.push(combined);
          }
        }
      }
    }

    while (contentLines.length < contentRows) contentLines.push("");
    const sliced = contentLines.slice(0, contentRows);
    this.hitRowsByLine.length = 0;
    this.sidebarHitRows.length = 0;
    this.stateStartsByLine.length = 0;
    for (let i = 0; i < contentRows; i++) {
      this.hitRowsByLine[i] = hitRowsByLine[i];
      this.sidebarHitRows[i] = sidebarHitRowsByLine[i];
      this.stateStartsByLine[i] = stateStartsByLine[i];
    }
    this.rowHits.length = 0;
    for (let i = 0; i < contentRows; i++) {
      const idx = hitRowsByLine[i];
      if (idx !== undefined) {
        const s = stateStartsByLine[i] ?? innerWidth;
        this.rowHits.push({ row: this.contentRowStart + i, index: idx, stateStart: s, stateEnd: s + 20 });
      }
    }
    for (let i = 0; i < contentRows; i++) {
      out.push(row(sliced[i] ?? "", width));
    }
    for (const line of previewLines) out.push(row(line, width));
    out.push(divider(width));
    let footer = footerHintText(searching, this.mode, this.sessionOverrides.size > 0);
    footer += " · ctrl+o";
    out.push(row(this.theme.fg("dim", truncateToWidth(footer, innerWidth)), width));
    out.push(bottomBorder(width));

    this.cache = { width, lines: out };
    return out;
  }
}

/**
 * Gate tool calls through the policy, prompting for approval and granting
 * exact commands for headless reuse. Every denial and grant is recorded in
 * the policy activity; the /sandbox pages let the operator disable rules.
 *
 * @param pi host extension API.
 * @param config explicit config for tests, defaults to the loaded operator config.
 * @param configPath config file the customization pages read and write,
 *                   defaults to the operator config.
 * @returns the policy activity, exposed for diagnostics and tests.
 */
export function createSandboxHandler(
  pi: ExtensionAPI,
  config: SandboxConfig = loadSandboxConfig(CONFIG_PATH, (message) => pi.logger.warn(message)),
  configPath: string = CONFIG_PATH,
): { activity: PolicyActivity; journal: AuditJournal; savedDisabled: Set<string>; sessionOverrides: Map<string, boolean> } {
  const grants = new SessionGrants();
  const journalPath = configPath === CONFIG_PATH ? DEFAULT_JOURNAL_PATH : join(resolve(configPath, ".."), "audit.jsonl");
  const journal = new AuditJournal(journalPath, (message) => pi.logger.warn(message));
  const activity = new PolicyActivity(journal);
  const savedDisabled = loadDisabledRules(configPath);
  const sessionOverrides = new Map<string, boolean>();
  // Sync config to effective set at startup.
  {
    const effective = new Set<string>();
    for (const rule of ruleRegistry()) {
      const over = sessionOverrides.get(rule.id);
      const disabled = over !== undefined ? over : savedDisabled.has(rule.id);
      if (disabled) effective.add(rule.id);
    }
    config.disabledRules = [...effective];
  }

  pi.on("tool_call", async (event, ctx) => {
    try {
      const decision = inspectToolCall(event.toolName, event.input, ctx.cwd, {
        headless: !ctx.hasUI,
        grants,
        config,
      });
      if (decision.action === "allow") return undefined;
      if (decision.action === "block" || !ctx.hasUI) {
        activity.record({
          kind: "block",
          rule: decision.rule,
          tool: event.toolName,
          reason: redact(decision.reason),
        });
        return { block: true, reason: redact(decision.reason) };
      }
      activity.record({
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
        activity.record({
          kind: "grant",
          rule: decision.rule,
          tool: event.toolName,
          reason: "Operator approved the call.",
        });
        return undefined;
      }
      activity.record({
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

  const openPage = (ctx: unknown, mode: PageMode) => {
    const c = ctx as
      | {
          mode?: string;
          ui?: {
            custom?: <T>(
              factory: (tui: TuiSurface, theme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => PageComponent,
              options?: unknown,
            ) => Promise<T>;
            confirm?: (t: string, m: string) => Promise<boolean>;
            notify?: (m: string, t?: string) => void;
          };
        }
      | undefined;
    if (!c || c.mode !== "tui" || !c.ui?.custom) {
      c?.ui?.notify?.("pi-os-sandbox: /sandbox is terminal-only; run it in interactive mode.", "warning");
      return Promise.resolve();
    }
    const isSession = mode === "session";
    const overlayOptions = isSession
      ? {
          anchor: "bottom-center" as const,
          width: "100%" as const,
          maxHeight: "100%" as const,
          margin: 0,
        }
      : {
          anchor: "bottom-center" as const,
          width: "100%" as const,
          maxHeight: "100%" as const,
          margin: 0,
          fullscreen: true as const,
        };
    return c.ui.custom<void>(
      (tui: TuiSurface, theme: Theme, keybindings: KeybindingsManager, done: (result: void) => void) =>
        new SandboxPage(
          tui as unknown as TuiSurface,
          theme as unknown as Theme,
          keybindings as unknown as KeybindingsManager,
          done,
          configPath,
          activity,
          journal,
          config,
          savedDisabled,
          sessionOverrides,
          mode,
          (title, message) => c.ui!.confirm!(title, message),
          (message) => c.ui!.notify!(message),
        ),
      {
        overlay: true,
        overlayOptions,
      },
    );
  };

  pi.registerCommand("sandbox", {
    description: "Open the pi-os-sandbox rule customization page",
    handler: async (_args, ctx) => {
      await openPage(ctx, "saved");
    },
  });

  pi.registerCommand("sandbox-session", {
    description: "Open the session sandbox (session-only rule overrides)",
    handler: async (_args, ctx) => {
      await openPage(ctx, "session");
    },
  });

  pi.registerCommand("sandbox-status", {
    description: "Show pi-os-sandbox policy summary",
    handler: async (_args, ctx) => {
      const disabledCount = config.disabledRules.length;
      (ctx as unknown as { ui: { notify: (m: string) => void } }).ui.notify(
        `pi-os-sandbox: ${config.safetyRoots.length} safety roots, ${config.credentialRoots.length} credential roots, ` +
          `${config.metadataHosts.length} metadata hosts, ${disabledCount} disabled rule${disabledCount === 1 ? "" : "s"}, ` +
          `headless: fail-closed; ${activity.summary()}`,
      );
    },
  });

  // Option+S shortcut for session sandbox, guarded for hosts without the API.
  try {
    const maybe = pi as unknown as { registerShortcut?: (id: string, opts: unknown) => void };
    if (typeof maybe.registerShortcut === "function") {
      maybe.registerShortcut("alt+s", {
        description: "Open session sandbox",
        handler: async (ctx: unknown) => {
          await openPage(ctx, "session");
        },
      });
    }
  } catch {}

  return { activity, journal, savedDisabled, sessionOverrides };
}

export default function (pi: ExtensionAPI): void {
  createSandboxHandler(pi);
}
