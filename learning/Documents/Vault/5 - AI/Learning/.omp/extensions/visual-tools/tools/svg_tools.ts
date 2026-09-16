import type { CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent"
import {
  applyEdit,
  existsSync,
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

const GROUP = "svg"
const BODY_FILE = "diagram.svg"
const RENDER_TIMEOUT_MS = 60_000

type RenderDetails = { ok: boolean; path: string; filename?: string }

let session: Session | null = null

async function renderSvg(svgPath: string, outPath: string, workDir: string) {
  const rsvg = await run("rsvg-convert", ["-z", "2", svgPath, "-o", outPath], { cwd: workDir, timeoutMs: RENDER_TIMEOUT_MS })
  if (rsvg.code === 0 && existsSync(outPath)) return { ok: true as const, res: rsvg }
  const magick = await run("magick", ["-density", "192", "-background", "white", svgPath, outPath], { cwd: workDir, timeoutMs: RENDER_TIMEOUT_MS })
  if (magick.code === 0 && existsSync(outPath)) return { ok: true as const, res: magick }
  return { ok: false as const, res: rsvg.code !== null ? rsvg : magick }
}

export default function svgTools(api: CustomToolAPI): CustomTool[] {
  const z = api.zod
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
        session = writeBody(GROUP, BODY_FILE, source)
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
        mkdirSync(workDir, { recursive: true })
        const outPath = join(workDir, `render-${Date.now()}.png`)
        const { ok, res } = await renderSvg(bodyPath, outPath, workDir)
        if (!ok) {
          const detail = (res.stderr || res.stdout || "unknown error").split("\n").slice(-30).join("\n")
          const note = res.timedOut ? "SVG render timed out.\n\n" : ""
          return {
            content: [{ type: "text", text: `${note}SVG render FAILED — no image produced (tried rsvg-convert then magick). Fix the source with edit_svg and call render_svg again.\n\nError:\n${detail}` }],
            details: { ok: false, path: "" } satisfies RenderDetails,
          }
        }
        const data = readFileSync(outPath).toString("base64")
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
