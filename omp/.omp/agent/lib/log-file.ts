import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isWithin } from "./path-guard";

export const MARKER_KEY = "omp-md-log";
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export async function readText(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); } catch { return null; }
}

export async function fileExists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

export async function ensureMarkdownFile(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  if (!(await fileExists(file))) await writeFile(file, "", "utf8");
}

export async function upsertFrontMatter(file: string, values: Record<string, string>): Promise<void> {
  const original = (await readText(file)) ?? "";
  const match = FRONT_MATTER.exec(original);
  const lines = match ? match[1].split(/\r?\n/) : [];
  const body = match ? original.slice(match[0].length) : original;
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.trimStart().startsWith(`${key}:`));
    if (index >= 0) lines[index] = `${key}: ${value}`;
    else lines.push(`${key}: ${value}`);
  }
  const next = `---\n${lines.join("\n")}\n---\n${body}`;
  if (next !== original) await writeFile(file, next, "utf8");
}

export async function readMarker(file: string): Promise<string | null> {
  const text = await readText(file);
  const match = text ? FRONT_MATTER.exec(text) : null;
  if (!match) return null;
  const line = match[1].split(/\r?\n/).find((item) => item.trimStart().startsWith(`${MARKER_KEY}:`));
  return line?.slice(line.indexOf(":") + 1).trim().replace(/^['"]|['"]$/g, "") ?? null;
}

export async function findFrontMatterTarget(root: string, marker: string, limit = 2): Promise<string[]> {
  const matches: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (matches.length >= limit) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith(".md") && (await readMarker(target)) === marker) matches.push(target);
      if (matches.length >= limit) return;
    }
  }
  await walk(root);
  return matches;
}

export interface LogBlock {
  id: string;
  content: string;
}

interface MarkedBlock extends LogBlock {
  start: number;
  end: number;
}

export interface ReconcileLogResult {
  addedIds: string[];
  presentIds: string[];
}

function stripLogMarkers(text: string): string {
  return text.replace(/^<!-- md-log:event:[a-f0-9]{8}:(?:start|end) -->(?:\r?\n|$)/gm, "");
}

function ambiguousBlockIds(text: string, history: readonly LogBlock[]): Set<string> {
  const groups = new Map<string, LogBlock[]>();
  for (const block of history) {
    const group = groups.get(block.content) ?? [];
    group.push(block);
    groups.set(block.content, group);
  }
  const ambiguous = new Set<string>();
  for (const [content, group] of groups) {
    let count = 0;
    let from = 0;
    while (true) {
      const start = text.indexOf(content, from);
      if (start < 0) break;
      count++;
      from = start + content.length;
    }
    if (count > 0 && count !== group.length) {
      for (const block of group) ambiguous.add(block.id);
    }
  }
  return ambiguous;
}

function findBlocks(text: string, history: readonly LogBlock[]): MarkedBlock[] {
  const groups = new Map<string, LogBlock[]>();
  for (const block of history) {
    const group = groups.get(block.content) ?? [];
    group.push(block);
    groups.set(block.content, group);
  }

  const found: MarkedBlock[] = [];
  for (const [content, group] of groups) {
    const positions: number[] = [];
    let from = 0;
    while (true) {
      const start = text.indexOf(content, from);
      if (start < 0) break;
      positions.push(start);
      from = start + content.length;
    }
    if (positions.length !== group.length) continue;
    positions.forEach((start, index) => {
      found.push({ ...group[index]!, start, end: start + content.length });
    });
  }
  return found.sort((a, b) => a.start - b.start);
}

export async function reconcileLogBlocks(
  file: string,
  history: readonly LogBlock[],
  eligibleIds: ReadonlySet<string>,
): Promise<ReconcileLogResult> {
  await ensureMarkdownFile(file);
  let text = (await readText(file)) ?? "";
  const original = text;
  text = stripLogMarkers(text);
  const ambiguousIds = ambiguousBlockIds(text, history);
  let existing = findBlocks(text, history);
  const presentIds = new Set(existing.map((block) => block.id));
  const addedIds: string[] = [];
  const contiguous = existing.length > 0 && existing.every((block, index) =>
    index === 0 || /^\s*$/.test(text.slice(existing[index - 1]!.end, block.start)),
  );

  if (contiguous) {
    const first = existing[0]!;
    const last = existing[existing.length - 1]!;
    const target = history.filter((block) =>
      (presentIds.has(block.id) || eligibleIds.has(block.id)) && !ambiguousIds.has(block.id),
    );
    const replacement = target.map((block) => {
      if (!presentIds.has(block.id)) addedIds.push(block.id);
      presentIds.add(block.id);
      return block.content;
    }).join("\n\n");
    text = text.slice(0, first.start) + replacement + text.slice(last.end);
    existing = findBlocks(text, history);
  } else {
    const orderedPresent = history.filter((block) => presentIds.has(block.id));
    if (orderedPresent.length > 1 && orderedPresent.length === existing.length) {
      for (let index = existing.length - 1; index >= 0; index--) {
        const slot = existing[index]!;
        const block = orderedPresent[index]!;
        text = text.slice(0, slot.start) + block.content + text.slice(slot.end);
      }
      existing = findBlocks(text, history);
    }
  }

  for (let index = 0; index < history.length; index++) {
    const block = history[index]!;
    if (!eligibleIds.has(block.id) || presentIds.has(block.id) || ambiguousIds.has(block.id)) continue;
    const next = history.slice(index + 1).find((candidate) => presentIds.has(candidate.id));
    const nextSpan = next && existing.find((candidate) => candidate.id === next.id);
    const at = nextSpan?.start ?? text.length;
    const prefix = at > 0 && !text.slice(0, at).endsWith("\n\n") ? "\n\n" : "";
    const suffix = at < text.length && !text.slice(at).startsWith("\n\n") ? "\n\n" : "";
    const insertion = `${prefix}${block.content}${suffix}`;
    text = text.slice(0, at) + insertion + text.slice(at);
    const delta = insertion.length;
    existing = existing.map((candidate) => candidate.start >= at
      ? { ...candidate, start: candidate.start + delta, end: candidate.end + delta }
      : candidate);
    existing.push({ ...block, start: at + prefix.length, end: at + prefix.length + block.content.length });
    existing.sort((a, b) => a.start - b.start);
    presentIds.add(block.id);
    addedIds.push(block.id);
  }

  if (text !== original) await writeFile(file, text, "utf8");
  return { addedIds, presentIds: [...presentIds] };
}

function safe(value: string): string { return (value.replace(/[^A-Za-z0-9._-]/g, "_") || "artifact").slice(0, 120); }

export async function writeArtifact(root: string, sessionId: string, name: string, content: string): Promise<string | null> {
  const file = path.join(root, "5 - AI", "Files", safe(sessionId), safe(name));
  if (!isWithin(file, root)) return null;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return path.relative(root, file);
}
