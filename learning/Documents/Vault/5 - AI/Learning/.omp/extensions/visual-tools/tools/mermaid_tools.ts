import { randomUUID } from "node:crypto"
import type { CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent"
import { fileURLToPath } from "node:url"
import {
  applyEdit,
  dirname,
  existsSync,
  findChrome,
  join,
  mkdirSync,
  publish,
  readFileSync,
  run,
  type Session,
  snippetAround,
  writeBody,
  writeFileSync,
} from "./_common.ts"

const EXTENSION_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const MMDC_BIN = join(EXTENSION_DIR, "node_modules", ".bin", "mmdc")
const GROUP = "mermaid"
const BODY_FILE = "diagram.mmd"
const RENDER_TIMEOUT_MS = 120_000

type RenderDetails = { ok: boolean; path: string; filename?: string }

export default function mermaidTools(api: CustomToolAPI): CustomTool[] {
  const z = api.zod
  let session: Session | null = null
  const instanceId = randomUUID()
  return [
    {
      name: "write_mermaid",
      label: "Write Mermaid",
      description:
        "Write the FULL Mermaid source to this session's managed file (your first draft or a complete rewrite). You do NOT name the file — edit_mermaid and render_mermaid act on the same one.\n\n`source` is a complete Mermaid diagram, e.g. a `graph TD` / `graph LR` flow, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`, `classDiagram`, `mindmap`, or `timeline`. Writing does NOT render — call render_mermaid when ready. For a small fix, prefer edit_mermaid over rewriting.",
      parameters: z.object({
        source: z.string().describe("The complete Mermaid diagram source (starts with the diagram type, e.g. `graph TD`)."),
      }),
      async execute(_id, rawParams) {
        const params = rawParams as { source: string }
        const source = params.source.trim()
        session = writeBody(GROUP, BODY_FILE, source, instanceId)
        const lines = source.split("\n").length
        return {
          content: [{ type: "text", text: `Wrote ${lines}-line Mermaid source.\nCall render_mermaid to render it, or edit_mermaid to tweak it.` }],
          details: { ok: true, path: session.bodyPath, lines },
        }
      },
    },
    {
      name: "edit_mermaid",
      label: "Edit Mermaid",
      description:
        "Make a single exact-match replacement in this session's Mermaid source — the same contract as pi's built-in edit, locked to the one managed file. `old_text` must appear EXACTLY ONCE (include surrounding context for uniqueness); on 0 or >1 matches the call fails and nothing changes. Call write_mermaid first. Editing does NOT render.",
      parameters: z.object({
        old_text: z.string().describe("Exact substring of the current source to replace (must match once)."),
        new_text: z.string().describe("Replacement text for `old_text`."),
      }),
      async execute(_id, rawParams) {
        const params = rawParams as { old_text: string; new_text: string }
        if (!session || !existsSync(session.bodyPath)) throw new Error("edit_mermaid: no source yet — call write_mermaid first.")
        const current = readFileSync(session.bodyPath, "utf8")
        const { updated, index } = applyEdit(current, params.old_text, params.new_text)
        writeFileSync(session.bodyPath, updated, "utf8")
        return {
          content: [{ type: "text", text: `Applied edit. Updated region:\n\`\`\`\n${snippetAround(updated, index)}\n\`\`\`\nCall render_mermaid to see it.` }],
          details: { ok: true, path: session.bodyPath },
        }
      },
    },
    {
      name: "render_mermaid",
      label: "Render Mermaid",
      description:
        "Render the CURRENT session Mermaid source to a PNG and return it inline so you can SEE the diagram and iterate. You do NOT pass the source here — it comes from the managed file; call write_mermaid first.\n\nIterate freely with no `save_as` (preview only). When the diagram is correct and clean, call once more with `save_as` set to a short kebab-case topic slug: that publishes the PNG into <cwd>/viz with a unique filename and returns the filename to embed. On a render error this returns the error text instead of an image — fix with edit_mermaid and re-render.",
      parameters: z.object({
        save_as: z.string().optional().describe("Short kebab-case topic slug (e.g. 'internet-packets'). When set, the rendered PNG is published to <cwd>/viz as viz-<slug>-<timestamp>.png and the filename is returned. Omit for a preview-only render."),
      }),
      async execute(_id, rawParams) {
        const params = rawParams as { save_as?: string }
        if (!session || !existsSync(session.bodyPath)) throw new Error("render_mermaid: no source yet — call write_mermaid first.")
        const { workDir, bodyPath } = session
        mkdirSync(workDir, { recursive: true })
        const chrome = findChrome()
        const cfgPath = join(workDir, "puppeteer.json")
        writeFileSync(cfgPath, JSON.stringify(chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] }), "utf8")
        const outPath = join(workDir, `render-${Date.now()}.png`)
        const result = await run(MMDC_BIN, ["-i", bodyPath, "-o", outPath, "-p", cfgPath, "-s", "2", "-b", "white"], {
          cwd: workDir,
          timeoutMs: RENDER_TIMEOUT_MS,
          env: { PUPPETEER_SKIP_DOWNLOAD: "1" },
        })
        if (result.code !== 0 || !existsSync(outPath)) {
          const detail = (result.stderr || result.stdout || "unknown error").split("\n").slice(-30).join("\n")
          const note = result.timedOut ? "mmdc timed out.\n\n" : ""
          return {
            content: [{ type: "text", text: `${note}Mermaid render FAILED — no image produced. Fix the source with edit_mermaid and call render_mermaid again.\n\nError:\n${detail}` }],
            details: { ok: false, path: "" } satisfies RenderDetails,
          }
        }
        const data = readFileSync(outPath).toString("base64")
        if (params.save_as) {
          const published = publish(outPath, params.save_as, api.cwd)
          return {
            content: [
              { type: "text", text: `Published to viz/.\nfilename: ${published.filename}\npath: ${published.path}\n\nLOOK at the diagram below to confirm it is correct before returning it.` },
              { type: "image", data, mimeType: "image/png" },
            ],
            details: { ok: true, path: published.path, filename: published.filename } satisfies RenderDetails,
          }
        }
        return {
          content: [
            { type: "text", text: "Preview render (not yet saved). LOOK: are arrows/relationships correct, labels right, nothing cramped? Fix with edit_mermaid, or re-render with `save_as` to publish." },
            { type: "image", data, mimeType: "image/png" },
          ],
          details: { ok: true, path: outPath } satisfies RenderDetails,
        }
      },
    },
  ]
}
