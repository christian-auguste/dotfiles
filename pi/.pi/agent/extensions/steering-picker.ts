/**
 * steering-picker — choose which Kiro steering files load into context
 *
 * `/steering` opens a checkbox multi-select of every steering file discovered
 * for the current directory (global ~/.kiro/steering + project .kiro/steering).
 * Toggle with space, save with enter, cancel with esc. The selection is saved
 * per project directory to ~/.pi/agent/steering-selection.json.
 *
 * The kiro-steering extension reads that file and only injects the selected
 * steering docs. If a directory has no saved selection, all files load
 * (matching the original always-on behavior).
 *
 * Shared helpers (discovery + selection store) are exported so kiro-steering
 * imports them instead of duplicating the logic.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, type Component, matchesKey, Key, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface SteeringFile {
  /** stable id used in the selection store — relative to its steering root, prefixed by scope */
  id: string;
  /** absolute path on disk */
  path: string;
  /** "global" (~/.kiro) or "project" (cwd/.kiro) */
  scope: "global" | "project";
  /** inclusion frontmatter value: always | fileMatch | manual */
  inclusion: string;
}

const SELECTION_FILE = join(homedir(), ".pi", "agent", "steering-selection.json");

/** Read the whole selection store: { "<dir>": ["id1","id2",...] }. */
export function readSelectionStore(): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(SELECTION_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeSelectionStore(store: Record<string, string[]>): void {
  mkdirSync(dirname(SELECTION_FILE), { recursive: true });
  writeFileSync(SELECTION_FILE, JSON.stringify(store, null, 2));
}

/** Saved selection for a directory, or undefined if none saved. */
export function getSavedSelection(cwd: string): string[] | undefined {
  return readSelectionStore()[cwd];
}

export function saveSelection(cwd: string, ids: string[]): void {
  const store = readSelectionStore();
  store[cwd] = ids;
  writeSelectionStore(store);
}

function extractInclusion(content: string): string {
  if (!content.startsWith("---\n")) return "always";
  const lines = content.split("\n");
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return "always";
  const yaml = lines.slice(1, end).join("\n");
  const m = yaml.match(/^inclusion:\s*(.+)$/m);
  return m ? m[1].trim() : "always";
}

function scanDir(dir: string, scope: "global" | "project"): SteeringFile[] {
  if (!existsSync(dir)) return [];
  let entries: Array<{ name: string; parentPath?: string; path?: string; isFile: () => boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true, recursive: true }) as never;
  } catch {
    return [];
  }
  const out: SteeringFile[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const base = e.parentPath ?? e.path ?? dir;
    const abs = join(base, e.name);
    const rel = abs.startsWith(dir) ? abs.slice(dir.length + 1) : e.name;
    let inclusion = "always";
    try {
      inclusion = extractInclusion(readFileSync(abs, "utf-8"));
    } catch {
      /* unreadable — treat as always */
    }
    out.push({ id: `${scope}:${rel}`, path: abs, scope, inclusion });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** All steering files visible from a directory (global + project). */
export function discoverSteeringFiles(cwd: string): SteeringFile[] {
  return [
    ...scanDir(join(homedir(), ".kiro", "steering"), "global"),
    ...scanDir(join(cwd, ".kiro", "steering"), "project"),
  ];
}

/**
 * Resolve which files should actually load for a directory.
 * - If a selection is saved for cwd, use it (intersected with existing files).
 * - Otherwise default: every file whose inclusion is not manual/fileMatch.
 */
export function resolveActiveSteering(cwd: string): SteeringFile[] {
  const files = discoverSteeringFiles(cwd);
  const saved = getSavedSelection(cwd);
  if (saved) {
    const set = new Set(saved);
    return files.filter((f) => set.has(f.id));
  }
  return files.filter((f) => f.inclusion !== "manual" && f.inclusion !== "fileMatch");
}

// ── Checkbox multi-select overlay ─────────────────────────────────────────
class SteeringPicker extends Container implements Component {
  private files: SteeringFile[];
  private checked: Set<string>;
  private cursor = 0;
  private done: (result: string[] | null) => void;
  private scrollTop = 0;
  /** max file rows shown at once; kept small so it fits split viewports */
  private maxRows: number;
  private theme: {
    fg(color: string, text: string): string;
    bg(color: string, text: string): string;
    bold(text: string): string;
  };

  constructor(
    files: SteeringFile[],
    initial: Set<string>,
    done: (r: string[] | null) => void,
    theme: SteeringPicker["theme"],
    maxRows = 12,
  ) {
    super();
    this.files = files;
    this.checked = new Set(initial);
    this.done = done;
    this.theme = theme;
    this.maxRows = Math.max(3, maxRows);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.cursor = (this.cursor - 1 + this.files.length) % this.files.length;
    } else if (matchesKey(data, Key.down)) {
      this.cursor = (this.cursor + 1) % this.files.length;
    } else if (matchesKey(data, Key.space)) {
      const id = this.files[this.cursor].id;
      if (this.checked.has(id)) this.checked.delete(id);
      else this.checked.add(id);
    } else if (matchesKey(data, "a")) {
      // toggle all
      if (this.checked.size === this.files.length) this.checked.clear();
      else this.files.forEach((f) => this.checked.add(f.id));
    } else if (matchesKey(data, Key.enter)) {
      this.done([...this.checked]);
      return;
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done(null);
      return;
    }
    this.invalidate();
  }

  private ensureVisible(): void {
    if (this.cursor < this.scrollTop) this.scrollTop = this.cursor;
    else if (this.cursor >= this.scrollTop + this.maxRows) {
      this.scrollTop = this.cursor - this.maxRows + 1;
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    // Pad to full width, then paint the whole row with the panel background so
    // the overlay is opaque and clearly separated from content behind it.
    const pad = (s: string) => {
      const t = truncateToWidth(s, width);
      return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
    };
    const panel = (s: string) => th.bg("selectedBg", pad(s));
    this.ensureVisible();
    const lines: string[] = [];
    lines.push(th.bg("selectedBg", pad("  " + th.bold(th.fg("accent", "Select steering files to load")))));
    lines.push(th.bg("selectedBg", pad("  " + th.fg("dim", "space toggle · a all · enter save · esc cancel"))));
    lines.push(panel(""));

    const end = Math.min(this.files.length, this.scrollTop + this.maxRows);
    if (this.scrollTop > 0) lines.push(th.bg("selectedBg", pad(th.fg("dim", "    ↑ more"))));
    let lastScope = "";
    for (let i = this.scrollTop; i < end; i++) {
      const f = this.files[i];
      if (f.scope !== lastScope) {
        const hdr = `  [${f.scope === "global" ? "~/.kiro/steering" : "project .kiro/steering"}]`;
        lines.push(th.bg("selectedBg", pad(th.fg("muted", hdr))));
        lastScope = f.scope;
      }
      const isCursor = i === this.cursor;
      const box = this.checked.has(f.id) ? "[x]" : "[ ]";
      const pointer = isCursor ? "›" : " ";
      const label = f.id.replace(/^(global|project):/, "");
      const flag = f.inclusion !== "always" ? `  (${f.inclusion})` : "";
      const row = ` ${pointer} ${box} ${label}${flag}`;
      if (isCursor) {
        // highlight the selected row: accent fg on the panel bg
        lines.push(th.bg("selectedBg", pad(th.bold(th.fg("accent", row)))));
      } else {
        const marked = this.checked.has(f.id) ? th.fg("success", ` ${pointer} ${box}`) + ` ${label}${flag}` : row;
        lines.push(th.bg("selectedBg", pad(marked)));
      }
    }
    if (end < this.files.length) lines.push(th.bg("selectedBg", pad(th.fg("dim", "    ↓ more"))));

    lines.push(panel(""));
    lines.push(th.bg("selectedBg", pad(th.fg("dim", `  ${this.checked.size}/${this.files.length} selected`))));
    return lines;
  }

  invalidate(): void {
    super.invalidate?.();
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("steering", {
    description: "Choose which Kiro steering files load into context",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/steering requires interactive mode", "warning");
        return;
      }
      const files = discoverSteeringFiles(ctx.cwd);
      if (files.length === 0) {
        ctx.ui.notify("No steering files found for this directory", "info");
        return;
      }
      // seed checkboxes from current effective selection
      const active = new Set(resolveActiveSteering(ctx.cwd).map((f) => f.id));

      const result = await ctx.ui.custom<string[] | null>(
        (tui, theme, _kb, done) => {
          // leave headroom for header (3), scroll hints (2), footer (2) plus
          // overlay chrome; cap file rows to what the terminal can show.
          const rows = tui.terminal?.rows ?? 24;
          const maxRows = Math.max(3, Math.min(files.length, rows - 10));
          return new SteeringPicker(files, active, done, theme, maxRows);
        },
        {
          overlay: true,
          overlayOptions: { width: "80%", minWidth: 40, maxHeight: "90%" },
        },
      );

      if (result === null) {
        ctx.ui.notify("Steering selection unchanged", "info");
        return;
      }
      saveSelection(ctx.cwd, result);
      ctx.ui.notify(
        `Saved ${result.length} steering file${result.length === 1 ? "" : "s"} for this directory. Reloading…`,
        "info",
      );
      await ctx.reload();
    },
  });
}
