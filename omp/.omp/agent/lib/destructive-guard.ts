import os from "node:os";
import path from "node:path";
import { canonicalize, isWithin } from "./path-guard";

export type GuardDecision = { action: "block" | "prompt"; reason: string } | null;

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
const SAFETY_ROOTS = [
  path.join(os.homedir(), ".omp", "agent", "extensions"),
  path.join(os.homedir(), ".omp", "agent", "config.yml"),
  path.join(os.homedir(), ".omp", "agent", "lib", "destructive-guard.ts"),
  path.join(os.homedir(), ".agents", "AGENTS.md"),
];

function normalize(value: string): string {
  return value.replace(EMPTY_QUOTES, "").replace(/\s+/g, " ").trim();
}

function shellWords(value: string): string[] {
  return value.match(/(?:[^\s"'`]+|"[^"]*"|'[^']*')+/g)?.map((word) => {
    if ((word.startsWith("\"") && word.endsWith("\"")) || (word.startsWith("'") && word.endsWith("'"))) {
      return word.slice(1, -1);
    }
    return word;
  }) ?? [];
}
function stringField(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object" || !(key in input)) return null;
  const value = Reflect.get(input, key);
  return typeof value === "string" ? value : null;
}

function unquotedWords(value: string): string[] {
  return shellWords(value.replace(/["']/g, " "));
}

function segments(value: string): string[] {
  return normalize(value).split(/\r?\n|&&|\|\||[;|]/).map((segment) => segment.trim()).filter(Boolean);
}
function isGitMetadataCommand(command: string): boolean {
  const commandSegments = segments(command);
  return commandSegments.length > 0 && commandSegments.every((segment) => {
    const words = shellWords(segment);
    return path.basename(words[0] ?? "") === "git" && GIT_METADATA_COMMANDS[words[1] ?? ""] === true;
  });
}

function isRootDeletion(words: string[]): boolean {
  const rm = words.findIndex((word) => path.basename(word) === "rm");
  if (rm < 0) return false;

  let recursive = false;
  let targetsStart = words.length;
  for (let i = rm + 1; i < words.length; i++) {
    const word = words[i];
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
  const rm = words.findIndex((word) => path.basename(word) === "rm");
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
  return /\b(?:cat|head|tail|less|more|strings|base64|cp|tee|xxd|openssl|python\w*)\b/i.test(value) && /(?:~|\$HOME|\/Users\/[^\s/'"]+)\/\.ssh(?:\/|\b)/i.test(value);
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

function protectedPath(value: string, cwd: string): boolean {
  const expanded = value.replace(/^~(?=\/)/, os.homedir()).replace(/^\$HOME(?=\/)/, os.homedir());
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  const real = canonicalize(absolute);
  return SAFETY_ROOTS.some((root) => {
    const canonicalRoot = canonicalize(root);
    return real === canonicalRoot || isWithin(real, canonicalRoot);
  });
}

function mentionsSafetyState(value: string, cwd: string): boolean {
  const lower = value.toLowerCase();
  if ([
    ".agents/agents.md",
    ".omp/agent/config.yml",
    ".omp/agent/extensions",
    ".omp/agent/lib/destructive-guard.ts",
  ].some((marker) => lower.includes(marker))) return true;
  return protectedPath(value, cwd);
}

function pathArguments(input: unknown): string[] {
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

export function classifyCommand(command: string): GuardDecision {
  const normalized = normalize(command);
  if (!normalized) return { action: "block", reason: "Blocked: the shell command was empty or could not be verified." };
  if (isRootDeletion(unquotedWords(normalized))) return { action: "block", reason: "Blocked: recursive deletion of the filesystem root." };
  if (isSystemDestruction(normalized)) return { action: "block", reason: "Blocked: system shutdown or process-destruction command." };
  if (isDeviceDestruction(normalized)) return { action: "block", reason: "Blocked: disk or device destruction command." };
  if (isFetchToShell(normalized)) return { action: "block", reason: "Blocked: downloading code and executing it as a shell command." };
  if (isCredentialRead(normalized)) return { action: "block", reason: "Blocked: command reads a private SSH credential path." };
  if (isDatabaseDestruction(normalized)) return { action: "block", reason: "Blocked: database-wide destructive operation." };

  const commandSegments = segments(normalized);
  for (const segment of commandSegments) {
    const words = shellWords(segment);
    if (isRootDeletion(words)) return { action: "block", reason: "Blocked: recursive deletion of the filesystem root." };
    if (isProtectedGitPush(words)) return { action: "block", reason: "Blocked: destructive push targeting a protected Git ref." };
    if (isOpaqueDestructive(segment)) return { action: "prompt", reason: "This command hides a potentially destructive operation inside an interpreter." };
  }

  if (commandSegments.some((segment) => isRecursiveWork(shellWords(segment)))) {
    return { action: "prompt", reason: "This recursive or destructive developer operation needs exact approval." };
  }
  if (/\bgit\s+push\b[\s\S]*\s(?:-f|--force|--force-with-lease)\b/i.test(normalized)) {
    return { action: "prompt", reason: "This force push needs exact approval." };
  }
  return null;
}

export function classifyEval(code: string): GuardDecision {
  if (!code.trim()) return { action: "block", reason: "Blocked: the eval cell was empty or could not be verified." };
  if (isRootDeletion(unquotedWords(code))) return { action: "block", reason: "Blocked: eval contains recursive deletion of the filesystem root." };
  if (isSystemDestruction(code) || isDeviceDestruction(code) || isFetchToShell(code) || isDatabaseDestruction(code)) {
    return { action: "block", reason: "Blocked: eval contains a catastrophic operation." };
  }
  if (/\b(?:subprocess|child_process|Bun\.\$|shutil\.rmtree|os\.(?:remove|unlink)|fs\.(?:rm|rmSync|rmdir)|exec\(|spawn\(|unlink)\b/i.test(code)) {
    return { action: "prompt", reason: "This eval cell can execute external commands or delete files." };
  }
  return null;
}

export function inspectToolCall(toolName: string, input: unknown, cwd: string): GuardDecision {
  if (toolName === "bash") {
    const command = stringField(input, "command") ?? "";
    if (mentionsSafetyState(command, cwd) && !isGitMetadataCommand(command)) return { action: "block", reason: "Blocked: the agent cannot modify or inspect guard safety state." };
    return classifyCommand(command);
  }
  if (toolName === "eval") {
    const code = stringField(input, "code") ?? "";
    if (mentionsSafetyState(code, cwd)) return { action: "block", reason: "Blocked: the agent cannot modify or inspect guard safety state." };
    return classifyEval(code);
  }
  if (["read", "grep", "glob", "write", "edit"].includes(toolName)) {
    if (pathArguments(input).some((value) => protectedPath(value, cwd) || mentionsSafetyState(value, cwd))) {
      return { action: "block", reason: "Blocked: the agent cannot access guard safety state." };
    }
  }
  return null;
}
