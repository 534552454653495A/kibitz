/**
 * LLM settings schema — provider, base URL, key, model — and its validator.
 *
 * Pure on purpose: the same shape is stored in chrome.storage.local by the extension and
 * in a settings.json file by the desktop companion (Node). Both parse through
 * `parseSettings` so "what counts as configured" has exactly one definition.
 */

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

export const PROVIDER_IDS = Object.keys(PROVIDER_PRESETS) as ProviderId[];

/** Null when the value is not a complete, usable configuration (missing key, unknown provider…). */
export function parseSettings(value: unknown): Settings | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.provider !== "openai-compatible" && v.provider !== "anthropic") return null;
  if (typeof v.baseUrl !== "string" || typeof v.model !== "string" || typeof v.apiKey !== "string") return null;
  if (v.apiKey.length === 0 || v.model.length === 0) return null;
  try {
    originPattern(v.baseUrl);
  } catch {
    return null;
  }
  return { provider: v.provider, baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model };
}

/** A draft as the panel sends it, where an empty key means "keep the stored one". */
export interface SettingsDraftInput {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export type SettingsMerge = { ok: true; settings: Settings } | { ok: false; error: string };

/**
 * Turn a panel draft plus whatever is already stored into settings worth persisting.
 *
 * Two call sites, one meaning: `src/background/settings-service.ts` (chrome.storage.local)
 * and `desktop/request-handler.ts` (settings.json). It lives here, next to the schema, so
 * "an empty key keeps the stored one" and the sentence the user reads are the same in both
 * hosts. Pure and Node-safe on purpose — the companion imports it.
 *
 * `parseSettings` stays the authority on accept/reject; the checks below exist only to say
 * *which* field is wrong, which a null return cannot express.
 */
export function mergeSettingsInput(input: SettingsDraftInput, stored: Settings | null): SettingsMerge {
  const baseUrl = input.baseUrl.trim();
  const model = input.model.trim();
  const typed = input.apiKey.trim();
  const apiKey = typed.length > 0 ? typed : (stored?.apiKey ?? "");
  if (apiKey.length === 0) return { ok: false, error: "An API key is required." };
  if (model.length === 0) return { ok: false, error: "A model name is required." };

  const settings = parseSettings({ provider: input.provider, baseUrl, model, apiKey });
  if (settings !== null) return { ok: true, settings };
  if (input.provider !== "openai-compatible" && input.provider !== "anthropic") {
    return { ok: false, error: `Unknown provider "${input.provider}".` };
  }
  return { ok: false, error: "Base URL must be a full http(s) URL, for example https://api.openai.com/v1." };
}

/**
 * Host-permission pattern covering `baseUrl`'s origin, e.g. "https://api.openai.com/*".
 * Throws on unparsable input so callers show an error instead of requesting a garbage pattern.
 */
export function originPattern(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`unsupported protocol ${url.protocol}`);
  return `${url.origin}/*`;
}
