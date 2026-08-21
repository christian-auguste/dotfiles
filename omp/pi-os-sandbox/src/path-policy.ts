/**
 * @fileoverview Path canonicalization and protected-root matching for host
 * file tools, distinguishing safety roots from credential roots.
 */

import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Resolve symlinks on the deepest existing ancestor, preserving the rest.
 * 
 * @param value path to canonicalize; never throws for non-existent paths.
 */
export function canonicalize(value: string): string {
  let current = path.resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try {
      let result = realpathSync(current);
      for (const segment of suffix) result = path.join(result, segment);
      return result;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** True when `child` equals `parent` or is located beneath it. */
export function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Recursively collect string values whose key ends in a path-like name. */
export function pathArguments(input: unknown): string[] {
  const result: string[] = [];
  const visit = (value: unknown, key = ""): void => {
    if (typeof value === "string") {
      if (/(?:path|paths|dst|dest|destination|source|from|to)$/i.test(key)) result.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
    }
  };
  visit(input);
  return result;
}

/** Canonicalized root that `value` resolves to, or null when outside all roots. */
export function resolveProtectedPath(value: string, cwd: string, roots: string[]): string | null {
  const home = process.env.HOME ?? "";
  const expanded = value.replace(/^~(?=\/)/, home).replace(/^\$HOME(?=\/)/, home);
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  const real = canonicalize(absolute);
  for (const root of roots) {
    const canonicalRoot = canonicalize(root);
    if (real === canonicalRoot || isWithin(real, canonicalRoot)) return canonicalRoot;
  }
  return null;
}

/** True when `value` resolves to a root itself or to a path inside one. */
export function protectedPath(value: string, cwd: string, roots: string[]): boolean {
  return resolveProtectedPath(value, cwd, roots) !== null;
}

function homeRelativeMarker(root: string, home: string): string {
  return root.slice(home.length).replace(/^\/+/, "").toLowerCase();
}

/** True when `value` mentions a root-derived marker substring or resolves into a root. */
export function mentionsSafetyState(value: string, cwd: string, roots: string[]): boolean {
  const lower = value.toLowerCase();
  const home = (process.env.HOME ?? "").replace(/\/+$/, "");
  for (const root of roots) {
    const full = root.split("/").filter(Boolean).join("/").toLowerCase();
    if (lower.includes(full)) return true;
    if (home && root.startsWith(`${home}/`)) {
      const relative = homeRelativeMarker(root, home);
      if (lower.includes(relative)) return true;
    }
  }
  return protectedPath(value, cwd, roots);
}
