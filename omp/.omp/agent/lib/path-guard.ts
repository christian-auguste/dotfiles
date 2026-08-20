import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export function discoverVaultRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, ".obsidian"))) return canonicalize(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function canonicalize(value: string): string {
  let current = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try {
      let result = realpathSync(current);
      for (let i = suffix.length - 1; i >= 0; i--) result = path.join(result, suffix[i]);
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

export function assertExactBoundPath(bound: string, current: string): boolean {
  return canonicalize(bound) === canonicalize(current);
}
