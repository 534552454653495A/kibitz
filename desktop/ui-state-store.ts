/**
 * ui-state.json — the desktop counterpart of the extension's `uiState` storage key.
 *
 * Separate file from settings.json, not another field in it, for the same reason the
 * extension uses a separate storage key: this blob is written every time the user drags the
 * panel, and a write path that touches the file holding the API key is a file that can lose
 * the API key. It carries panel geometry and the last open view — nothing secret — so no
 * 0o600, and it lives beside settings.json so both follow one per-user config directory.
 *
 * Every failure degrades to `{}`. A corrupt preferences file must cost the user their panel
 * position, never their chat: the panel falls back to its default layout and rewrites the
 * file on the next drag.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "../src/core/validate";
import { log } from "../src/shared/log";
import { settingsPath } from "./settings-store";

const FILE_NAME = "ui-state.json";

/** Beside the settings file, so an overridden settings path keeps both halves together. */
export function uiStatePath(settingsFile: string = settingsPath()): string {
  return path.join(path.dirname(settingsFile), FILE_NAME);
}

export async function loadUiState(file: string = uiStatePath()): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return {};
    throw err;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    log.warn(`${file} is not valid JSON; the panel starts from its default layout`);
    return {};
  }
  return isRecord(value) ? value : {};
}

export async function saveUiState(state: Record<string, unknown>, file: string = uiStatePath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}
