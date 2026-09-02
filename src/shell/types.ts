/**
 * Shell — everything the in-page UI needs from its host runtime, and nothing else.
 *
 * Two hosts exist: the Chrome extension (settings in chrome.storage, LLM calls in the
 * service worker over a Port) and the desktop companion (settings in a file, LLM calls in
 * a Node process reached over a CDP binding). The panel, injector and adapters must not
 * know which one they run under (AGENTS.md 3.7/3.8), so the host-specific code is confined
 * to src/shell/<host>.ts behind this interface.
 *
 * Settings are edited *inside the panel* (the user asked for no separate page), which means
 * the API key crosses this seam. `capabilities.keyIsPageVisible` says whether that is
 * risky in the current host — false in the extension (the panel runs in the isolated world;
 * the page cannot read it), true on the desktop (the renderer shares Discord's realm). The
 * settings view shows a warning when it is true and keeps `kibitz-desktop setup` as the
 * safer route. Only the DRAFT (never a stored key) is ever sent back to the UI.
 */
import type { ChatErrorCode, ChatMessage, SettingsStatus } from "../core/messaging";
import type { ProviderId } from "../core/settings";

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

/** What the settings view shows: everything except the key, plus whether a key is stored. */
export interface SettingsDraft {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  /** Whether image attachments may go to the provider; not a secret, so it round-trips. */
  sendImages: boolean;
  /** Answer language, `"auto"` or a label the model reads; not a secret either. */
  language: string;
}

export interface SettingsInput {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  /** Empty string means "keep the stored key" so the user can edit a URL without retyping it. */
  apiKey: string;
  sendImages: boolean;
  language: string;
}

export type SaveSettingsResult =
  | { ok: true }
  /** The host needs a permission the UI cannot request itself; `grantOrigin` is what for. */
  | { ok: false; error: string; grantOrigin?: string };

export interface ShellCapabilities {
  /** True when a key typed into the panel is readable by the host page (desktop). */
  keyIsPageVisible: boolean;
  /** True when the host can open a native settings surface as a fallback (extension). */
  canOpenOptionsPage: boolean;
}

export interface Shell {
  /** Streams one answer; resolves on completion, rejects with ChatError (see `code`). */
  streamChat(messages: ChatMessage[], options: StreamChatOptions): Promise<void>;
  /** Redacted: never carries the key. */
  settingsStatus(): Promise<SettingsStatus>;
  /** For the settings view; `hasKey` stands in for the key itself. */
  loadSettings(): Promise<SettingsDraft | null>;
  saveSettings(input: SettingsInput): Promise<SaveSettingsResult>;
  /** Opens the host's permission prompt for `origin`; only called when saving asked for it. */
  requestAccess(origin: string): Promise<boolean>;
  /** Native settings surface, when the host has one (extension options page). */
  openOptions(): Promise<void>;
  /** Small JSON blob for UI preferences (panel layout, last view). Never secrets. */
  loadUiState(): Promise<Record<string, unknown>>;
  saveUiState(state: Record<string, unknown>): Promise<void>;
  readonly capabilities: ShellCapabilities;
  /** One sentence the settings view shows about where the key is stored. */
  readonly keyStorageHint: string;
}
