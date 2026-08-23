// md-log user settings: ~/.omp/agent/md-log.json (PI_CODING_AGENT_DIR override).
// Machine-specific by design: the dotfiles repo ignores runtime agent state, so
// the configured vault path stays local. Writes are atomic (temp file + rename).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface MdLogConfig {
  version: 1;
  vaultRoot?: string;
}

const configPath = () =>
  path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent"), "md-log.json");

export async function readConfig(): Promise<MdLogConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1) return { version: 1 };
    return {
      version: 1,
      vaultRoot: "vaultRoot" in value && typeof value.vaultRoot === "string" ? value.vaultRoot : undefined,
    };
  } catch {
    return { version: 1 };
  }
}

export async function writeConfig(config: MdLogConfig): Promise<void> {
  const file = configPath();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}
