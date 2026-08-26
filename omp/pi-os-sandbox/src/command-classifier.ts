/**
 * @fileoverview Shell and eval command classification against the destructive
 * safety floor, plus cloud metadata targets the sandbox always blocks.
 */

import { ruleInfo } from "./customization";

export type GuardDecision =
  | { action: "block" | "prompt"; reason: string; rule: string; nextStep: string }
  | null;

const EMPTY_QUOTES = /(["'])\1/g;
const GIT_METADATA_COMMANDS: Record<string, true> = {
  add: true,
  commit: true,
  diff: true,
  log: true,
  "ls-files": true,
  show: true,
  status: true,
};
const PROTECTED_REFS: Record<string, true> = { main: true, master: true, trunk: true, mainline: true };
const METADATA_FETCH = /\b(?:curl|wget|fetch|python3?|urllib|requests)\b|\bnode\s+fetch\b/i;

/** Builds a decision carrying the stable rule id and its registry next step. */
function verdict(action: "block" | "prompt", rule: string, reason: string): GuardDecision {
  return { action, reason, rule, nextStep: ruleInfo(rule)?.nextStep ?? "" };
}

function basename(value: string): string {
  const parts = value.split("/");
  return parts[parts.length - 1] ?? "";
}

export function normalize(value: string): string {
  return value.replace(EMPTY_QUOTES, "").replace(/\s+/g, " ").trim();
}

export function shellWords(value: string): string[] {
  return value.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')+/g)?.map((word) => {
    if ((word.startsWith("\"") && word.endsWith("\"")) || (word.startsWith("'") && word.endsWith("'"))) {
      return word.slice(1, -1);
    }
    return word;
  }) ?? [];
}

function unquotedWords(value: string): string[] {
  return shellWords(value.replace(/["']/g, " "));
}

export function segments(value: string): string[] {
  return normalize(value).split(/\r?\n|&&|\|\||[;|]/).map((segment) => segment.trim()).filter(Boolean);
}

export function isGitMetadataCommand(command: string): boolean {
  const commandSegments = segments(command);
  return commandSegments.length > 0 && commandSegments.every((segment) => {
    const words = shellWords(segment);
    return basename(words[0] ?? "") === "git" && GIT_METADATA_COMMANDS[words[1] ?? ""] === true;
  });
}

function isRootDeletion(words: string[]): boolean {
  const rm = words.findIndex((word) => basename(word) === "rm");
  if (rm < 0) return false;

  let recursive = false;
  let targetsStart = words.length;
  for (let i = rm + 1; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) break;
    if (word === "--") {
      targetsStart = i + 1;
      break;
    }
    if (word === "--recursive") {
      recursive = true;
      continue;
    }
    if (word.startsWith("-") && word !== "-") {
      recursive ||= word.slice(1).includes("r");
      continue;
    }
    targetsStart = i;
    break;
  }
  if (!recursive) return false;
  return words.slice(targetsStart).some((target) => target === "/" || target === "//" || target === "/.");
}

function isRecursiveWork(words: string[]): boolean {
  const rm = words.findIndex((word) => basename(word) === "rm");
  if (rm >= 0) {
    const args = words.slice(rm + 1);
    if (args.some((word) => word === "--recursive" || (word.startsWith("-") && word !== "-" && word.slice(1).includes("r")))) return true;
  }
  if (words.some((word) => word === "-delete" || word === "--delete")) return true;
  if (words[0] === "git" && words[1] === "clean" && words.slice(2).some((word) => word.startsWith("-") && word.includes("f") && word.includes("d"))) return true;
  if (words[0] === "git" && words[1] === "reset" && words.includes("--hard")) return true;
  if (words[0] === "git" && words[1] === "branch" && words.some((word) => word === "-D" || word === "--delete --force")) return true;
  return words[0] === "git" && words[1] === "stash" && words[2] === "drop";
}

function isProtectedGitPush(words: string[]): boolean {
  if (words[0] !== "git" || words[1] !== "push") return false;
  const args = words.slice(2);
  if (args.includes("--mirror") || args.includes("--all")) return true;
  if (args.some((word) => /^\+.*refs\/heads\/(?:main|master|trunk|mainline)(?:$|[/:])/i.test(word))) return true;
  const refs = args.filter((word) => !word.startsWith("-") && word !== "origin");
  const protectedRef = refs.some((ref) => ref === "HEAD" || /^refs\/heads\/(?:main|master|trunk|mainline)(?:~0)?$/i.test(ref) || PROTECTED_REFS[ref.replace(/~0$/, "").toLowerCase()] === true);
  const force = args.some((word) => word === "-f" || word === "--force" || word === "--force-with-lease");
  return (protectedRef && force) || (force && refs.length === 0);
}

function isCredentialRead(value: string): boolean {
  return /\b(?:cat|head|tail|less|more|strings|base64|cp|tee|xxd|openssl|python\w*)\b/i.test(value) &&
    /(?:~|\$HOME|\/Users\/[^\s/'"]+)\/\.ssh(?:\/|\b)/i.test(value);
}

function isFetchToShell(value: string): boolean {
  return /\b(?:curl|wget|fetch)\b[\s\S]*(?:\|\s*(?:bash|sh|zsh)|\b(?:bash|sh|zsh)\s+<\(\s*(?:curl|wget|fetch)\b|\beval\s*\$\(\s*(?:curl|wget|fetch)\b|\bsh\s+-c\s+["']?\$\(\s*(?:curl|wget|fetch)\b)/i.test(value);
}

function isDeviceDestruction(value: string): boolean {
  return /\b(?:mkfs(?:\.\w+)?|newfs_\w+|diskutil\s+(?:erase|partitionDisk|apfs\s+deleteVolume)|hdiutil\s+(?:erase|compact)|shred|cryptsetup)\b/i.test(value) || /\bdd\b[\s\S]*\bof\s*=\s*["']?\/dev\//i.test(value);
}

function isSystemDestruction(value: string): boolean {
  return /\b(?:shutdown|reboot|halt|poweroff)\b/i.test(value) || /\binit\s+0\b/i.test(value) || /\bkill\s+-9\s+1\b/i.test(value) || /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\};\s*:/i.test(value);
}

function isDatabaseDestruction(value: string): boolean {
  return /\b(?:drop\s+database|truncate\s+table)\b/i.test(value);
}

function isOpaqueDestructive(value: string): boolean {
  const interpreter = /\b(?:python\w*|node|bun|ruby|perl|bash|sh|zsh)\b\s+(?:-[ce]|<<)/i.test(value) || /<<\s*['"]?[A-Za-z_]+/.test(value);
  return interpreter && /\b(?:rm|rmtree|unlink|fs\.(?:rm|rmSync|rmdir)|child_process|subprocess|os\.system|diskutil|mkfs|shutdown|curl|wget|drop\s+database|truncate\s+table)\b/i.test(value);
}

function isMetadataTarget(value: string, metadataHosts: RegExp[]): boolean {
  if (metadataHosts.length === 0) return false;
  return METADATA_FETCH.test(value) && metadataHosts.some((host) => host.test(value));
}

export function classifyCommand(command: string, metadataHosts: RegExp[]): GuardDecision {
  const normalized = normalize(command);
  if (!normalized) return verdict("block", "reject-unverifiable-input", "Blocked: the shell command was empty or could not be verified.");
  if (isRootDeletion(unquotedWords(normalized))) return verdict("block", "delete-filesystem-root", "Blocked: recursive deletion of the filesystem root.");
  if (isSystemDestruction(normalized)) return verdict("block", "destroy-system", "Blocked: system shutdown or process-destruction command.");
  if (isDeviceDestruction(normalized)) return verdict("block", "destroy-device", "Blocked: disk or device destruction command.");
  if (isFetchToShell(normalized)) return verdict("block", "download-and-run-code", "Blocked: downloading code and executing it as a shell command.");
  if (isMetadataTarget(normalized, metadataHosts)) return verdict("block", "request-cloud-metadata", "Blocked: command targets a cloud metadata service.");
  if (isCredentialRead(normalized)) return verdict("block", "read-credentials", "Blocked: command reads a private SSH credential path.");
  if (isDatabaseDestruction(normalized)) return verdict("block", "destroy-database", "Blocked: database-wide destructive operation.");

  const commandSegments = segments(normalized);
  for (const segment of commandSegments) {
    const words = shellWords(segment);
    if (isRootDeletion(words)) return verdict("block", "delete-filesystem-root", "Blocked: recursive deletion of the filesystem root.");
    if (isProtectedGitPush(words)) return verdict("block", "force-push", "Blocked: destructive push targeting a protected Git ref.");
    if (isOpaqueDestructive(segment)) return verdict("prompt", "run-hidden-destructive-code", "This command hides a potentially destructive operation inside an interpreter.");
  }

  if (commandSegments.some((segment) => isRecursiveWork(shellWords(segment)))) {
    return verdict("prompt", "run-recursive-cleanup", "This recursive or destructive developer operation needs exact approval.");
  }
  if (/\bgit\s+push\b[\s\S]*\s(?:-f|--force|--force-with-lease)\b/i.test(normalized)) {
    return verdict("prompt", "force-push", "This force push needs exact approval.");
  }
  return null;
}

export function classifyEval(code: string, metadataHosts: RegExp[]): GuardDecision {
  if (!code.trim()) return verdict("block", "reject-unverifiable-input", "Blocked: the eval cell was empty or could not be verified.");
  if (isRootDeletion(unquotedWords(code))) return verdict("block", "delete-filesystem-root", "Blocked: eval contains recursive deletion of the filesystem root.");
  const catastrophic = "Blocked: eval contains a catastrophic operation.";
  if (isSystemDestruction(code)) return verdict("block", "destroy-system", catastrophic);
  if (isDeviceDestruction(code)) return verdict("block", "destroy-device", catastrophic);
  if (isFetchToShell(code)) return verdict("block", "download-and-run-code", catastrophic);
  if (isDatabaseDestruction(code)) return verdict("block", "destroy-database", catastrophic);
  if (isMetadataTarget(code, metadataHosts)) return verdict("block", "request-cloud-metadata", "Blocked: eval contains a cloud metadata service target.");
  if (/\b(?:subprocess|child_process|Bun\.\$|shutil\.rmtree|os\.(?:remove|unlink)|fs\.(?:rm|rmSync|rmdir)|exec\(|spawn\(|unlink)\b/i.test(code)) {
    return verdict("prompt", "run-hidden-destructive-code", "This eval cell can execute external commands or delete files.");
  }
  return null;
}
