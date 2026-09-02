/**
 * Shell — everything the in-page UI needs from its host runtime, and nothing else.
 *
 * Two hosts exist: the Chrome extension (settings in chrome.storage, LLM calls in the
 * service worker over a Port) and the desktop companion (settings in a file, LLM calls
 * in a Node process reached over a CDP binding). The panel, injector and adapters must
 * not know which one they run under (AGENTS.md 3.7 extended to the runtime), so the
 * host-specific code is confined to src/shell/<host>.ts behind this interface.
 */
import type { ChatErrorCode, ChatMessage, SettingsStatus } from "../core/messaging";

export class ChatError extends Error {
  override readonly name = "ChatError";
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface StreamChatOptions {
  onDelta: (text: string) => void;
  signal: AbortSignal;
}

export interface Shell {
  /** Streams one answer; resolves on completion, rejects with ChatError (see `code`). */
  streamChat(messages: ChatMessage[], options: StreamChatOptions): Promise<void>;
  /** Redacted: never carries the key. */
  settingsStatus(): Promise<SettingsStatus>;
  /** Opens the host's settings UI, or does the closest thing the host can (see optionsHint). */
  openOptions(): Promise<void>;
  /** One sentence the panel shows next to the "configure" call-to-action. */
  readonly optionsHint: string;
}
