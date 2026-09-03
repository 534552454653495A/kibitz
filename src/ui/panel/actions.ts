/**
 * Everything a view can ask the panel to do. Split out of the view/controller files so a
 * new view compiles against a named contract instead of an inferred object literal, and so
 * the controller's implementation and the tests share one shape.
 *
 * Every entry here corresponds to an `ActionName` in shared/dom-markers.ts: the DOM carries
 * the name, this interface carries the behaviour, and the probe drives the pair.
 */
import type { LayoutMode } from "../../shared/dom-markers";
import type { SettingsInput } from "../../shell/types";
import type { PanelView } from "./views";

export interface PanelActions {
  /** Chat. */
  send(text: string): void;
  scan(): void;
  stop(): void;
  retry(): void;
  close(): void;
  /** Navigation between registered views. */
  showView(id: PanelView["id"]): void;
  /** Settings (in-page). Resolves with a message for the view to display. */
  saveSettings(input: SettingsInput): Promise<void>;
  testSettings(): void;
  requestAccess(origin: string): void;
  /** Native settings surface, where the host has one. */
  openOptions(): void;
  /** Layout. */
  setLayout(mode: LayoutMode): void;
  toggleExpanded(): void;
  resetLayout(): void;
  /** Clipboard for one conversation turn. */
  copyTurn(index: number): void;
  /**
   * Saved conversations. `searchConversations` is the instant local filter (it only writes
   * the query into the model); `askConversations` is the one billed request that sends a
   * catalogue of titles and excerpts to the provider — two entries, not one debounced call,
   * because the second spends the user's money and the first must not.
   */
  searchConversations(query: string): void;
  askConversations(question: string): void;
  openConversation(id: string): void;
  deleteConversation(id: string): void;
  /** Arms or disarms "delete all"; the deletion itself is `clearConversations`. */
  confirmClearConversations(pending: boolean): void;
  clearConversations(): void;
}
