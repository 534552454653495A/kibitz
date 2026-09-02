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
 */

export const CHAT_PORT_NAME = "kibitz-chat";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
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

/** One-shot messages (chrome.runtime.sendMessage). */
export type RuntimeRequest =
  | { type: "open-options" }
  | { type: "settings-status" };

export interface SettingsStatus {
  configured: boolean;
  provider?: string;
  model?: string;
}

export type RuntimeResponse = SettingsStatus | { ok: true };
