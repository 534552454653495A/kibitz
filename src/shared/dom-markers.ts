/**
 * Attributes Kibitz puts on ITS OWN elements so that tests and the canary probe can find
 * and drive the UI without relying on class names or visible text — the same discipline
 * we demand from Discord's DOM (AGENTS.md "Selector contract"), applied to ourselves.
 *
 * The probe (probe/checks.ts) imports these; changing a value here without updating the
 * UI that sets it breaks the probe, which is the intended coupling.
 */

/** On the button's shadow host inside a message item. Value: messageId. */
export const BUTTON_HOST_ATTR = "data-kibitz-button";

/** On the panel's shadow host (document.body child). Value: "1". */
export const PANEL_HOST_ATTR = "data-kibitz-panel";

/** On the panel host. */
export const PANEL_STATE_ATTR = "data-kibitz-state";
export type PanelState = "closed" | "loading" | "ready" | "error";

/** On the panel host: the message currently shown. */
export const PANEL_MESSAGE_ATTR = "data-kibitz-message-id";

/** On the panel host while state is "error": short machine-readable reason (e.g. "RpcTimeoutError: …"). */
export const PANEL_ERROR_ATTR = "data-kibitz-error";

/** On the panel host: progress of a "scan related messages" collection. */
export const SCAN_STATE_ATTR = "data-kibitz-scan";
export type ScanState = "idle" | "running" | "done" | "error";
export const SCAN_COUNT_ATTR = "data-kibitz-scan-count";

/**
 * Inside shadow roots, on interactive elements. Values are stable action names so a
 * driver can do `host.shadowRoot.querySelector('[data-kibitz-action="scan"]')`.
 * Adding a feature adds a name here first; the panel's action map is typed against it.
 */
export const ACTION_ATTR = "data-kibitz-action";
export type ActionName =
  | "explain"
  | "scan"
  | "close"
  | "send"
  | "stop"
  | "open-options"
  /** Header tabs (one per registered view) and the back arrow. */
  | "view-chat"
  | "view-settings"
  /** Settings view. */
  | "save-settings"
  | "test-settings"
  | "grant-access"
  | "reveal-key"
  /** Layout. */
  | "dock-left"
  | "dock-right"
  | "float"
  | "expand"
  | "reset-layout"
  /** Per-turn affordances. */
  | "copy-turn"
  | "retry";

/** On the panel host: which registered view is showing (`PanelView.id`). */
export const VIEW_ATTR = "data-kibitz-view";

/** On the panel host: current layout mode, so tests/probe can assert docking. */
export const LAYOUT_ATTR = "data-kibitz-layout";
export type LayoutMode = "left" | "right" | "float";
