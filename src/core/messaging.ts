/**
 * Protocol between the in-page panel (content script) and the service worker.
 *
 * Streaming goes over a long-lived Port (`chrome.runtime.connect`) because a single
 * `sendMessage` cannot deliver incremental tokens and a service worker may be killed
 * between one-shot messages; a Port keeps it alive for the duration of one answer.
 * One-shot control messages use `chrome.runtime.sendMessage`.
 *
 * The background is a dumb relay: it receives fully built chat messages and streams the
 * provider's answer back. Prompt construction stays in core/prompt.ts (pure, testable).
 *
 * Images ride *alongside* `content` rather than turning `content` into a text-or-parts
 * union: every consumer — the panel's transcript, the stored history, the prompt builders,
 * the follow-up appender — already reads `content` as "the text of this turn", and a union
 * would force all of them to narrow for a case only the two provider clients care about.
 * The providers are the single place that knows how to put a picture on the wire.
 */

export const CHAT_PORT_NAME = "kibitz-chat";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatImage {
  /** Absolute http(s) URL, or a `data:` URL when bytes are inlined. */
  url: string;
  /** Original filename, for the text part and for logs. Never sent as a wire field. */
  name?: string;
  mimeType?: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Only meaningful on a user turn; providers ignore images on any other role. */
  images?: ChatImage[];
}

export interface ChatRequest {
  type: "chat";
  requestId: string;
  messages: ChatMessage[];
}

export interface ChatCancel {
  type: "cancel";
  requestId: string;
}

export type PortRequest = ChatRequest | ChatCancel;

export type ChatErrorCode =
  /** No provider configured yet — UI should offer the options page. */
  | "no-settings"
  /** Host permission for the API origin was not granted. */
  | "no-permission"
  /** Provider answered with a non-2xx status. `message` carries status + body excerpt. */
  | "http"
  /** fetch() itself failed (offline, DNS, CORS). */
  | "network"
  | "aborted"
  /** Provider stream was malformed or ended without completion. */
  | "provider";

export type PortResponse =
  | { type: "delta"; requestId: string; text: string }
  | { type: "done"; requestId: string }
  | { type: "error"; requestId: string; code: ChatErrorCode; message: string };

/**
 * One-shot messages (extension: chrome.runtime.sendMessage; desktop: the CDP call binding).
 * The panel edits settings in place, so these carry a draft in and a redacted view out —
 * a stored API key is never sent back to the UI.
 */
export type RuntimeRequest =
  | { type: "open-options" }
  | { type: "settings-status" }
  | { type: "load-settings" }
  | { type: "save-settings"; input: SettingsInputMessage }
  | { type: "request-access"; origin: string }
  | { type: "load-ui-state" }
  | { type: "save-ui-state"; state: Record<string, unknown> };

export interface SettingsInputMessage {
  provider: string;
  baseUrl: string;
  model: string;
  /** Empty = keep the stored key. */
  apiKey: string;
  /** Absent in drafts written before the field existed; absence means "on". */
  sendImages?: boolean;
  /** Absent in drafts written before the language picker; absence means "auto". */
  language?: string;
}

export interface SettingsStatus {
  configured: boolean;
  provider?: string;
  model?: string;
}

/** Settings as the UI may see them: no key, only whether one is stored. */
export interface SettingsDraftMessage {
  provider: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  /** Always present outbound: the host resolved the stored value (or its default) already. */
  sendImages: boolean;
  /** Always present outbound, `"auto"` included, so the picker never has to guess. */
  language: string;
}

export type SaveSettingsMessage = { ok: true } | { ok: false; error: string; grantOrigin?: string };

export type RuntimeResponse =
  | SettingsStatus
  | { draft: SettingsDraftMessage | null }
  | SaveSettingsMessage
  | { granted: boolean }
  | { state: Record<string, unknown> }
  | { ok: true };
