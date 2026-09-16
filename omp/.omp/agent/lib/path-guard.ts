import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export type VaultDiscovery =
  | { ok: true; root: string }
  | { ok: false; error: "denied"; at: string }
  | { ok: false; error: "not-found" };

export function discoverVaultRoot(cwd: string): VaultDiscovery {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      if (statSync(path.join(dir, ".obsidian")).isDirectory()) return { ok: true, root: canonicalize(dir) };
    } catch (error) {
      // statSync throws on EPERM/EACCES where existsSync would swallow it, so a
      // TCC denial is distinguishable from "no .obsidian anywhere above" (ENOENT).
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return { ok: false, error: "denied", at: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { ok: false, error: "not-found" };
    dir = parent;
  }
}

export function canonicalize(value: string): string {
  let current = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try {
      let result = realpathSync(current);
      for (const part of suffix) result = path.join(result, part);
      return result;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveBoundPath(vaultRoot: string, requested: string): { path: string; error?: string } {
  const root = canonicalize(vaultRoot);
  const target = canonicalize(requested);
  if (!isWithin(target, root) || !isWithin(path.dirname(target), root)) {
    return { path: target, error: `path escapes the vault: ${requested}` };
  }
  return { path: target };
}


