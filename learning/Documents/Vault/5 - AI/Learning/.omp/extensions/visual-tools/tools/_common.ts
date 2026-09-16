import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

// Keep system renderers discoverable when a task agent inherits a minimal PATH.
export const EXTRA_PATH = ["/opt/local/bin", "/usr/local/bin", "/opt/homebrew/bin"]
export const STAGING_ROOT = join(tmpdir(), "pi-visual-tools")
export const FILES_DIRNAME = "viz"
export const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
]

export function findChrome(): string | undefined {
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate
  return undefined
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<RunResult> {
  const { promise, resolve } = Promise.withResolvers<RunResult>()
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...(opts.env ?? {}),
      PATH: [...EXTRA_PATH, process.env.PATH ?? ""].join(":"),
    },
  })
  let stdout = ""
  let stderr = ""
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, opts.timeoutMs)
  child.stdout.on("data", (data) => (stdout += data.toString()))
  child.stderr.on("data", (data) => (stderr += data.toString()))
  child.on("error", (error) => {
    clearTimeout(timer)
    resolve({ code: null, stdout, stderr: stderr + String(error), timedOut })
  })
  child.on("close", (code) => {
    clearTimeout(timer)
    resolve({ code, stdout, stderr, timedOut })
  })
  return promise
}

export interface Session {
  workDir: string
  bodyPath: string
}

export function sessionDir(group: string): string {
  return join(STAGING_ROOT, `${group}-${process.pid}`)
}

export function writeBody(group: string, bodyFileName: string, source: string): Session {
  const workDir = sessionDir(group)
  mkdirSync(workDir, { recursive: true })
  const bodyPath = join(workDir, bodyFileName)
  writeFileSync(bodyPath, source, "utf8")
  return { workDir, bodyPath }
}

export function applyEdit(current: string, oldText: string, newText: string): { updated: string; index: number } {
  if (oldText === "") throw new Error("`old_text` must be non-empty.")
  if (oldText === newText) throw new Error("`old_text` and `new_text` are identical.")
  const first = current.indexOf(oldText)
  if (first === -1) throw new Error("`old_text` not found in the current source — match it exactly.")
  const second = current.indexOf(oldText, first + 1)
  if (second !== -1) {
    let count = 0
    for (let index = current.indexOf(oldText); index !== -1; index = current.indexOf(oldText, index + oldText.length)) count++
    throw new Error(`\`old_text\` appears ${count} times — add surrounding context to make it unique.`)
  }
  return {
    updated: current.slice(0, first) + newText + current.slice(first + oldText.length),
    index: first,
  }
}

export function snippetAround(content: string, index: number, contextLines = 3): string {
  const hitLine = content.slice(0, index).split("\n").length - 1
  const lines = content.split("\n")
  const start = Math.max(0, hitLine - contextLines)
  const end = Math.min(lines.length - 1, hitLine + contextLines)
  const width = String(end + 1).length
  return lines.slice(start, end + 1).map((line, offset) => `${String(start + offset + 1).padStart(width)}  ${line}`).join("\n")
}

export function publish(pngPath: string, slug: string, cwd: string): { filename: string; path: string } {
  const filesDir = join(cwd, FILES_DIRNAME)
  mkdirSync(filesDir, { recursive: true })
  const clean = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "viz"
  const filename = `viz-${clean}-${Date.now()}.png`
  const path = join(filesDir, filename)
  copyFileSync(pngPath, path)
  return { filename, path }
}

export { basename, dirname, join, existsSync, mkdirSync, readFileSync, writeFileSync }
