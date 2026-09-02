/**
 * LLM settings schema — provider, base URL, key, model, image policy — and its validator.
 *
 * Pure on purpose: the same shape is stored in chrome.storage.local by the extension and
 * in a settings.json file by the desktop companion (Node). Both parse through
 * `parseSettings` so "what counts as configured" has exactly one definition.
 */
import type { ChatMessage } from "./messaging";

export type ProviderId = "openai-compatible" | "anthropic";

export interface Settings {
  provider: ProviderId;
  /** Origin + path prefix the provider client appends to, e.g. "https://api.openai.com/v1". */
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Whether image attachments may be sent to the provider. Off is for a model without
   * vision (which answers a request carrying an image part with an error) and for users
   * who do not want Discord CDN links leaving for a third party.
   */
  sendImages: boolean;
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
  // Absence means "on". Configurations written before this field existed are on disk and in
  // chrome.storage right now; reading them as "off" would make the feature look unshipped to
  // every existing user. A present non-boolean is corruption, not absence, so it fails.
  const sendImages: unknown = v.sendImages;
  if (sendImages !== undefined && typeof sendImages !== "boolean") return null;
  try {
    originPattern(v.baseUrl);
  } catch {
    return null;
  }
  return { provider: v.provider, baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, sendImages: sendImages ?? true };
}

/** A draft as the panel sends it, where an empty key means "keep the stored one". */
export interface SettingsDraftInput {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Absent when the sender predates the image toggle; `parseSettings` reads that as "on". */
  sendImages?: boolean;
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
  // Same reasoning as the empty key above: a sender that says nothing about the image policy
  // (a renderer or panel from before the toggle) must not overwrite a choice the user made.
  // Only when nothing is stored either does `parseSettings`'s "absent means on" decide.
  const sendImages = input.sendImages ?? stored?.sendImages;

  const settings = parseSettings({ provider: input.provider, baseUrl, model, apiKey, sendImages });
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

/**
 * The only sanctioned way to put a `Settings` value into a log line, an error message, a
 * probe report or a diagnostic script.
 *
 * History (2026-09-02): a throwaway diagnostic printed `settings.json` with a hand-written
 * redaction regex that did not match the pretty-printed `"apiKey": "…"` spacing, and the
 * owner's live OpenAI key ended up in a session transcript and had to be revoked. Hand-rolled
 * redaction is now forbidden: format through this function, which cannot be defeated by
 * whitespace because it never sees text — it rebuilds the object.
 */
export interface RedactedSettings {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  /** Not a secret: a diagnostic that cannot see the image policy cannot explain a vision failure. */
  sendImages: boolean;
  /** Length only: enough to tell "empty" from "pasted something" without revealing it. */
  apiKeyLength: number;
}

export function redactSettings(settings: Settings): RedactedSettings {
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    sendImages: settings.sendImages,
    apiKeyLength: settings.apiKey.length,
  };
}

/**
 * The image policy applied to an outgoing conversation: with `sendImages` off, no message
 * keeps its `images`, so no provider request can carry an image part.
 *
 * Enforced here — one function, called by `src/background/chat-session.ts` and
 * `desktop/request-handler.ts` right before they construct a provider — rather than where
 * the messages are built. The panel builds them and never sees `Settings`: it only receives
 * the redacted draft, so honouring the toggle up there would mean a new `Shell` surface
 * whose only job is to carry one boolean into the page. Both hosts already re-read settings
 * on every request, which makes the last point before the bytes leave the cheapest and the
 * only unbypassable one.
 *
 * Returns `messages` itself when nothing has to change: the overwhelming majority of
 * requests carry no image at all, and a stripped copy of them would be pure garbage.
 */
export function applyImagePolicy(messages: ChatMessage[], settings: Settings): ChatMessage[] {
  if (settings.sendImages) return messages;
  if (!messages.some((message) => message.images !== undefined)) return messages;
  return messages.map((message) => {
    if (message.images === undefined) return message;
    const { images: _dropped, ...rest } = message;
    return rest;
  });
}
