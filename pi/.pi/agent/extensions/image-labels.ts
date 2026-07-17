/**
 * image-labels — cleaner clipboard-image paste
 *
 * pi's built-in Ctrl+V paste inserts the raw temp file path
 * (…/pi-clipboard-<uuid>.png) into the prompt. This extension replaces each
 * such path with a tidy "Image 1", "Image 2", … label and attaches the file
 * as a real image so the model still sees it.
 *
 * Counter is per submitted message: the first pasted image in a message is
 * "Image 1", the second "Image 2", and so on.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

// Matches the temp path pi writes on Ctrl+V (pi-clipboard-<uuid>.<ext>).
const CLIPBOARD_PATH =
  /(\S*pi-clipboard-[0-9a-fA-F-]+\.(png|jpe?g|gif|webp))/g;

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return EXT_MIME[ext] ?? "image/png";
}

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    if (!event.text) return { action: "continue" as const };

    const matches = [...event.text.matchAll(CLIPBOARD_PATH)];
    if (matches.length === 0) return { action: "continue" as const };

    const images = [...(event.images ?? [])];
    let text = event.text;
    let n = 0;
    let attached = 0;

    for (const [path] of matches) {
      // avoid double-counting if the same path appears twice
      if (!text.includes(path)) continue;
      n += 1;
      const label = `Image ${n}`;

      if (existsSync(path)) {
        try {
          const data = readFileSync(path).toString("base64");
          images.push({ type: "image" as const, data, mimeType: mimeFor(path) });
          attached += 1;
        } catch {
          // unreadable — still relabel so the path doesn't leak into the prompt
        }
      }
      // replace the (first remaining) occurrence of the path with the label
      text = text.replace(path, label);
    }

    if (attached > 0) {
      ctx.ui.notify(
        `📎 attached ${attached} image${attached > 1 ? "s" : ""}`,
        "info",
      );
    }

    // if the message is only image labels, give the model a default prompt
    const stripped = text.replace(/Image \d+/g, "").trim();
    const finalText = stripped.length > 0 ? text : "Describe this image. What do you see?";

    return { action: "transform" as const, text: finalText, images };
  });
}
