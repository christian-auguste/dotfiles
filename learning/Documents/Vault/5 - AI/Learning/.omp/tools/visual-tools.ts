import type { CustomTool, CustomToolAPI } from "@oh-my-pi/pi-coding-agent"
import mermaidTools from "../extensions/visual-tools/tools/mermaid_tools.ts"
import svgTools from "../extensions/visual-tools/tools/svg_tools.ts"

/** Native OMP custom-tool entrypoint discovered from `.omp/tools`. */
export default function visualTools(api: CustomToolAPI): CustomTool[] {
  return [...mermaidTools(api), ...svgTools(api)]
}
