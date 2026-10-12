import { randomUUID } from "node:crypto"
import { rasterizeSvg } from "@oh-my-pi/pi-natives"
import type { CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent"
import {
  applyEdit,
  existsSync,
  join,
  publish,
  readFileSync,
  type Session,
  snippetAround,
  writeBody,
  writeFileSync,
} from "./_common.ts"

const GROUP = "svg"
const BODY_FILE = "diagram.svg"
const MAX_RENDER_EDGE_PX = 4096

type RenderDetails = { ok: boolean; path: string; filename?: string }

export default function svgTools(api: CustomToolAPI): CustomTool[] {
  const z = api.zod
  let session: Session | null = null
  const instanceId = randomUUID()
  return [
    {
      name: "write_svg",
      label: "Write SVG",
      description:
        "Write the FULL SVG source to this session's managed file (your first draft or a complete rewrite). You do NOT name the file — edit_svg and render_svg act on the same one.\n\n`source` is a complete `<svg ...>…</svg>` document with an explicit width/height (or viewBox), readable font sizes, and a light or transparent background. Writing does NOT render — call render_svg when ready. For a small fix, prefer edit_svg over rewriting.",
      parameters: z.object({
        source: z.string().describe("The complete SVG document, from `<svg` to `</svg>`.")
      }),
      async execute(_id, rawParams) {
        const params = rawParams as { source: string }
        const source = params.source.trim()
        if (!source) throw new Error("`write_svg` requires a non-empty `source`.")
        if (!source.includes("<svg")) throw new Error("`write_svg`: source must be a complete <svg>…</svg> document.")
        session = writeBody(GROUP, BODY_FILE, source, instanceId)
        const lines = source.split("\n").length
        return {
          content: [{ type: "text", text: `Wrote ${lines}-line SVG source.\nCall render_svg to render it, or edit_svg to tweak it.` }],
          details: { ok: true, path: session.bodyPath, lines },
        }
      },
    },
    {
      name: "edit_svg",
      label: "Edit SVG",
      description:
        "Make a single exact-match replacement in this session's SVG source — the same contract as pi's built-in edit, locked to the one managed file. `old_text` must appear EXACTLY ONCE (include surrounding context for uniqueness); on 0 or >1 matches the call fails and nothing changes. Call write_svg first. Editing does NOT render.",
      parameters: z.object({
        old_text: z.string().describe("Exact substring of the current source to replace (must match once)."),
        new_text: z.string().describe("Replacement text for `old_text`.")
      }),
      async execute(_id, rawParams) {
        const params = rawParams as { old_text: string; new_text: string }
        if (!session || !existsSync(session.bodyPath)) throw new Error("edit_svg: no source yet — call write_svg first.")
        const current = readFileSync(session.bodyPath, "utf8")
        const { updated, index } = applyEdit(current, params.old_text, params.new_text)
        writeFileSync(session.bodyPath, updated, "utf8")
        return {
          content: [{ type: "text", text: `Applied edit. Updated region:\n\`\`\`\n${snippetAround(updated, index)}\n\`\`\`\nCall render_svg to see it.` }],
          details: { ok: true, path: session.bodyPath },
        }
      },
    },
    {
      name: "render_svg",
      label: "Render SVG",
      description:
        "Render the CURRENT session SVG source to a PNG and return it inline so you can SEE the picture and iterate. You do NOT pass the source here — it comes from the managed file; call write_svg first.\n\nIterate freely with no `save_as` (preview only). When the picture is correct and clean, call once more with `save_as` set to a short kebab-case topic slug: that publishes the PNG into <cwd>/viz with a unique filename and returns the filename to embed. On a render error this returns the error text instead of an image — fix with edit_svg and re-render.",
      parameters: z.object({
        save_as: z.string().optional().describe("Short kebab-case topic slug (e.g. 'number-line'). When set, the rendered PNG is published to <cwd>/viz as viz-<slug>-<timestamp>.png and the filename is returned. Omit for a preview-only render.")
      }),
      async execute(_id, rawParams) {
        const params = rawParams as { save_as?: string }
        if (!session || !existsSync(session.bodyPath)) throw new Error("render_svg: no source yet — call write_svg first.")
        const { workDir, bodyPath } = session
        const outPath = join(workDir, `render-${Date.now()}.png`)
        let png: Uint8Array
        try {
          png = await rasterizeSvg(readFileSync(bodyPath), MAX_RENDER_EDGE_PX, MAX_RENDER_EDGE_PX, 2)
          writeFileSync(outPath, png)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          return {
            content: [{ type: "text", text: `SVG render FAILED — no image produced. Fix the source with edit_svg and call render_svg again.\n\nError:\n${detail}` }],
            details: { ok: false, path: "" } satisfies RenderDetails,
          }
        }
        const data = Buffer.from(png).toString("base64")
        if (params.save_as) {
          const published = publish(outPath, params.save_as, api.cwd)
          return {
            content: [
              { type: "text", text: `Published to viz/.\nfilename: ${published.filename}\npath: ${published.path}\n\nLOOK at the picture below to confirm the geometry is correct before returning it.` },
              { type: "image", data, mimeType: "image/png" },
            ],
            details: { ok: true, path: published.path, filename: published.filename } satisfies RenderDetails,
          }
        }
        return {
          content: [
            { type: "text", text: "Preview render (not yet saved). LOOK: are coordinates, angles, directions, and proportions correct? Labels clear and unclipped? Fix with edit_svg, or re-render with `save_as` to publish." },
            { type: "image", data, mimeType: "image/png" },
          ],
          details: { ok: true, path: outPath } satisfies RenderDetails,
        }
      },
    },
  ]
}
