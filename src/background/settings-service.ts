/**
 * The service worker's settings/UI-state operations, split out of index.ts so the message
 * handler there stays a router and this stays testable against a fake chrome.storage.
 *
 * Two rules shape it. First, the key never travels outward: `loadDraft` reports *whether*
 * one is stored, never its value, because the panel that asks lives in a tab shared with
 * Discord (AGENTS.md 3.4). Second, saving and being *allowed to call* the provider are
 * separate outcomes: Chrome only grants a host permission from a user gesture in an
 * extension page, which a service worker is not, so a save whose origin is not yet granted
 * still persists and reports `grantOrigin` — losing the user's typing because a prompt
 * cannot be shown from here would be the worse failure.
 */
import type { SaveSettingsMessage, SettingsDraftMessage, SettingsInputMessage } from "../core/messaging";
import { mergeSettingsInput, originPattern } from "../core/settings";
import { isRecord } from "../core/validate";
import { ext } from "../shared/ext";
import { loadSettings, saveSettings } from "../shared/settings";

/** Separate from the `settings` key so a panel preference can never overwrite a key. */
const UI_STATE_KEY = "uiState";

export async function loadDraft(): Promise<SettingsDraftMessage | null> {
  const settings = await loadSettings();
  if (settings === null) return null;
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasKey: settings.apiKey.length > 0,
    sendImages: settings.sendImages,
  };
}

export async function saveDraft(input: SettingsInputMessage): Promise<SaveSettingsMessage> {
  const merged = mergeSettingsInput(input, await loadSettings());
  if (!merged.ok) return { ok: false, error: merged.error };

  await saveSettings(merged.settings);
  const pattern = originPattern(merged.settings.baseUrl);
  if (await ext.permissions.contains({ origins: [pattern] })) return { ok: true };
  return {
    ok: false,
    error: `Settings saved. Chrome must approve access to ${pattern} before Kibitz can use it.`,
    grantOrigin: pattern,
  };
}

export async function loadUiState(): Promise<Record<string, unknown>> {
  const stored = await ext.storage.local.get(UI_STATE_KEY);
  const value = stored[UI_STATE_KEY];
  return isRecord(value) ? value : {};
}

export async function saveUiState(state: Record<string, unknown>): Promise<void> {
  await ext.storage.local.set({ [UI_STATE_KEY]: state });
}
