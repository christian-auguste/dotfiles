/**
 * pi-startup — custom start screen
 *
 * Replaces the default/compact header with:
 *   - a large elegant block π rendered with a warm gruvbox gradient
 *   - keybindings in a side column
 *   - loaded model, skills, and a de-duplicated (shortened) extension list
 *
 * Gradient uses raw truecolor ANSI when the active theme is in truecolor
 * mode, and falls back to the theme accent color otherwise.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// Big "PI" wordmark (ANSI Shadow style) — 6 rows. Gradient maps left→right.
const PI_ART = [
  "██████╗ ██╗",
  "██╔══██╗██║",
  "██████╔╝██║",
  "██╔═══╝ ██║",
  "██║     ██║",
  "╚═╝     ╚═╝",
];

// Warm gruvbox gradient stops (orange → red → yellow), blended left→right.
const GRADIENT: Array<[number, number, number]> = [
  [0xd6, 0x5d, 0x0e], // orange  #d65d0e
  [0xcc, 0x24, 0x1d], // red     #cc241d
  [0xd7, 0x99, 0x21], // yellow  #d79921
];

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Sample the multi-stop gradient at position t in [0,1]. */
function gradientAt(t: number): [number, number, number] {
  const segs = GRADIENT.length - 1;
  const scaled = Math.min(t, 0.999999) * segs;
  const i = Math.floor(scaled);
  const local = scaled - i;
  const [r1, g1, b1] = GRADIENT[i];
  const [r2, g2, b2] = GRADIENT[i + 1];
  return [lerp(r1, r2, local), lerp(g1, g2, local), lerp(b1, b2, local)];
}

function truecolor(r: number, g: number, b: number, text: string): string {
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/** Paint a string with a left→right gradient. `span` fixes the color scale
 *  across all rows (use the widest art row) so the gradient is column-aligned. */
function gradientLine(line: string, span: number): string {
  const chars = [...line];
  const denom = Math.max(1, span - 1);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === " ") {
      out += ch;
      continue;
    }
    const [r, g, b] = gradientAt(i / denom);
    out += truecolor(r, g, b, ch);
  }
  return out;
}

/** Normalize one raw id (package/path/file) to a short unique package name. */
function shortenId(raw: string): string {
  // strip a "npm:" / "git:" scheme prefix
  let name = raw.replace(/^(npm|git):/, "");
  // strip trailing ":path" segment (e.g. "@samfp/pi-essentials:src/foo.ts")
  if (name.includes(":")) name = name.slice(0, name.indexOf(":"));
  // strip a version suffix (e.g. "pkg@1.0.0", but not a leading @scope)
  const at = name.lastIndexOf("@");
  if (at > 0) name = name.slice(0, at);
  // for git-style "host/owner/repo" keep the last segment; keep npm @scope/pkg intact
  if (!name.startsWith("@") && name.includes("/")) {
    name = name.slice(name.lastIndexOf("/") + 1);
  }
  // drop a trailing ".ts" for bare-file extensions (e.g. "kiro-steering.ts")
  return name.replace(/\.ts$/, "");
}

/** Discover loaded extensions from settings packages + the global extensions dir. */
function discoverExtensions(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const name = shortenId(raw);
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  };

  const base = join(homedir(), ".pi", "agent");
  try {
    const settings = JSON.parse(readFileSync(join(base, "settings.json"), "utf-8"));
    for (const p of settings.packages ?? []) add(p);
    for (const e of settings.extensions ?? []) add(e);
  } catch {
    // no settings / unreadable — skip
  }
  const extDir = join(base, "extensions");
  try {
    if (existsSync(extDir)) {
      for (const f of readdirSync(extDir)) {
        if (f.endsWith(".ts")) add(f);
      }
    }
  } catch {
    // skip
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  // Register on resources_discover (fires after all session_start handlers)
  // so this header wins over any other extension that also calls setHeader
  // (e.g. pi-essentials' compact-header).
  pi.on("resources_discover", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        const d = (s: string) => theme.fg("dim", s);
        const a = (s: string) => theme.fg("accent", s);
        const m = (s: string) => theme.fg("muted", s);
        const b = (s: string) => theme.bold(theme.fg("muted", s));
        const truecolorMode = theme.getColorMode() === "truecolor";
        const pad = (s: string, w: number) =>
          s + " ".repeat(Math.max(0, w - visibleWidth(s)));

        // Wrap a list of items into lines that fit `avail` columns, joined by
        // two spaces, with each continuation line indented to `indent`.
        const wrapList = (items: string[], indent: number, avail: number): string[] => {
          const rows: string[] = [];
          let cur = "";
          for (const it of items) {
            const candidate = cur ? `${cur}  ${it}` : it;
            if (visibleWidth(candidate) > avail && cur) {
              rows.push(cur);
              cur = it;
            } else {
              cur = candidate;
            }
          }
          if (cur) rows.push(cur);
          return rows.map((r, i) => (i === 0 ? r : " ".repeat(indent) + r));
        };

        const lines: string[] = [""];

        // --- Gradient-painted PI wordmark, centered ---
        const artWidth = Math.max(...PI_ART.map((l) => visibleWidth(l)));
        for (const raw of PI_ART) {
          const painted = truecolorMode ? gradientLine(raw, artWidth) : a(raw);
          // center on the raw glyph width so ANSI codes don't skew centering
          const leftPad = Math.max(0, Math.floor((width - artWidth) / 2));
          lines.push(" ".repeat(leftPad) + painted);
        }
        lines.push("");

        // --- Centered model · project dir ---
        const model = ctx.model ? ctx.model.id : "no model";
        const dir = basename(ctx.cwd) || ctx.cwd;
        const modelLine = `${a(model)}${m("  ·  ")}${d(dir)}`;
        const modelPlain = `${model}  ·  ${dir}`;
        const modelPad = Math.max(0, Math.floor((width - visibleWidth(modelPlain)) / 2));
        lines.push(" ".repeat(modelPad) + modelLine);
        lines.push("");

        // --- Keybindings, two centered rows of four ---
        const keys: Array<[string, string]> = [
          ["^P", "model"],
          ["S-tab", "thinking"],
          ["^V", "paste image"],
          ["^O", "expand"],
          ["/", "commands"],
          ["!", "bash"],
          ["esc", "interrupt"],
          ["^C", "clear / exit"],
        ];
        const sep = m("   ·   ");
        const sepPlain = "   ·   ";
        for (let i = 0; i < keys.length; i += 4) {
          const row = keys.slice(i, i + 4);
          const str = row.map(([k, v]) => `${m(k)} ${d(v)}`).join(sep);
          const plain = row.map(([k, v]) => `${k} ${v}`).join(sepPlain);
          const p = Math.max(0, Math.floor((width - visibleWidth(plain)) / 2));
          lines.push(" ".repeat(p) + str);
        }
        lines.push("");

        // --- Info rows: think / skills / extensions ---
        const thinking = pi.getThinkingLevel();
        const cmds = pi.getCommands();
        const skills = cmds
          .filter((c) => c.source === "skill")
          // skill command names are "skill:<name>" — show just the name
          .map((c) => c.name.replace(/^skill:/, ""));
        const exts = discoverExtensions();
        const gap = "   ";
        const labelW = 8;
        const indent = gap.length + labelW;
        const avail = Math.max(20, width - indent);
        const lbl = (s: string) => b(pad(s, labelW));
        lines.push(`${gap}${lbl("think")}${a(thinking)}${d(`  ·  pi v${VERSION}`)}`);
        if (skills.length) {
          const wrapped = wrapList(skills, indent, avail);
          wrapped.forEach((row, i) =>
            lines.push(i === 0 ? `${gap}${lbl("skills")}${d(row)}` : d(row)),
          );
        }
        if (exts.length) {
          const wrapped = wrapList(exts, indent, avail);
          wrapped.forEach((row, i) =>
            lines.push(i === 0 ? `${gap}${lbl("ext")}${d(row)}` : d(row)),
          );
        }
        lines.push(d("─".repeat(width)));

        return lines;
      },
      invalidate() {},
    }));
  });

  // Restore the built-in header on session switch/shutdown so a stale closure
  // doesn't linger. resources_discover re-installs ours on the next session.
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setHeader(undefined);
  });
}
