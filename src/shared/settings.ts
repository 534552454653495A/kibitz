/**
 * Extension-side settings persistence.
 *
 * chrome.storage.local — NOT storage.sync — so the API key is never uploaded to the
 * user's Google account (architecture decision 4). The schema and validator live in
 * core/settings.ts because the desktop companion stores the same shape in a file.
 */
import { parseSettings, type Settings } from "../core/settings";
import { ext } from "./ext";

const STORAGE_KEY = "settings";

export async function loadSettings(): Promise<Settings | null> {
  const stored = await ext.storage.local.get(STORAGE_KEY);
  return parseSettings(stored[STORAGE_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await ext.storage.local.set({ [STORAGE_KEY]: settings });
}
