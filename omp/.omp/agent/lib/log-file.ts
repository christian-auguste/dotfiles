import { access, appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

export async function appendLogBlock(file: string, block: string): Promise<void> {
  await ensureMarkdownFile(file);
  await appendFile(file, `\n${block}\n`, "utf8");
}

function safe(value: string): string { return (value.replace(/[^A-Za-z0-9._-]/g, "_") || "artifact").slice(0, 120); }

export async function writeArtifact(root: string, sessionId: string, name: string, content: string): Promise<string | null> {
  const file = path.join(root, "5 - AI", "Files", safe(sessionId), safe(name));
  if (!isWithin(file, root)) return null;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return path.relative(root, file);
}
