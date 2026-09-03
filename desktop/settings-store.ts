/**
 * settings.json on disk — the desktop counterpart of the extension's chrome.storage.local.
 *
 * Same shape, same validator (`parseSettings`), so a file the wizard wrote and a value
 * the options page saved are "configured" under exactly one definition. The file holds
 * the API key, hence mode 0o600 and a per-user config directory; it is never placed in
 * the repo or the working directory.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSettings, type Settings } from "../src/core/settings";
import { log } from "../src/shared/log";

const FILE_NAME = "settings.json";
const APP_DIR = "kibitz";

/** Where each OS expects per-user app config. Anything else follows the XDG rule. */
const CONFIG_DIR_BY_PLATFORM: Record<"win32" | "darwin" | "linux", () => string> = {
  win32: () => process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
  darwin: () => path.join(os.homedir(), "Library", "Application Support"),
  linux: () => process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
};

export function settingsPath(platform: NodeJS.Platform = process.platform): string {
  const configDir = (CONFIG_DIR_BY_PLATFORM[platform as keyof typeof CONFIG_DIR_BY_PLATFORM] ?? CONFIG_DIR_BY_PLATFORM.linux)();
  return path.join(configDir, APP_DIR, FILE_NAME);
}

/** Null when there is no file, the file is not JSON, or the JSON is not a complete configuration. */
export async function loadFileSettings(file: string = settingsPath()): Promise<Settings | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    log.warn(`${file} is not valid JSON; run \`npm run desktop -- setup\` to rewrite it`);
    return null;
  }
  return parseSettings(value);
}

export async function saveFileSettings(settings: Settings, file: string = settingsPath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; tighten a pre-existing, wider file too.
  await fs.chmod(file, 0o600);
}
