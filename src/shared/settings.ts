/**
 * User settings: provider, base URL, API key, model.
 *
 * Stored in chrome.storage.local — NOT storage.sync — so the API key is never uploaded
 * to the user's Google account (architecture decision 4). Read by the service worker and
 * the options page only; the content script asks the background for a redacted status.
 */
import { ext } from "./ext";

export type ProviderId = "openai-compatible" | "anthropic";

export interface Settings {
  provider: ProviderId;
  /** Origin + path prefix the provider client appends to, e.g. "https://api.openai.com/v1". */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ProviderPreset {
  label: string;
  baseUrl: string;
  model: string;
  /** Shown under the field; tells users which servers this covers. */
  hint: string;
}

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  "openai-compatible": {
    label: "OpenAI-compatible (OpenAI, OpenRouter, Groq, Ollama, LM Studio…)",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    hint: "Any server that implements POST {baseUrl}/chat/completions with streaming.",
  },
  anthropic: {
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    hint: "Direct Anthropic Messages API. Uses the browser-access header; your key stays local.",
  },
};

const STORAGE_KEY = "settings";

export async function loadSettings(): Promise<Settings | null> {
  const stored = await ext.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY] as Partial<Settings> | undefined;
  if (!value || typeof value.apiKey !== "string" || value.apiKey.length === 0) return null;
  if (typeof value.baseUrl !== "string" || typeof value.model !== "string") return null;
  if (value.provider !== "openai-compatible" && value.provider !== "anthropic") return null;
  return { provider: value.provider, baseUrl: value.baseUrl, apiKey: value.apiKey, model: value.model };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await ext.storage.local.set({ [STORAGE_KEY]: settings });
}

/**
 * Host-permission pattern covering `baseUrl`'s origin, e.g. "https://api.openai.com/*".
 * Throws on unparsable input so the options page shows an error instead of requesting
 * a garbage pattern.
 */
export function originPattern(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`unsupported protocol ${url.protocol}`);
  return `${url.origin}/*`;
}
