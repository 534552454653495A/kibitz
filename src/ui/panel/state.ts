/**
 * Panel state machine: a pure reducer so the host-attribute mirror (what the probe reads)
 * and the rendered UI are two views of one model that can never disagree.
 *
 * `status` and `scan.state` are exactly the PanelState / ScanState vocabularies from
 * shared/dom-markers.ts because mount.ts copies them onto the host verbatim.
 *
 * Three things are deliberately *outside* the per-message lifecycle and therefore survive
 * `open`/`close`: `layout` (the user placed the panel; reopening it somewhere else would be
 * a bug), the settings `draft` (retyping a base URL because the panel closed is hostile) and
 * the view — except that opening a message forces `chat`, because the click that opened the
 * panel asked a question and the answer lives there.
 */
import type { ChatMessage } from "../../core/messaging";
import type { MessageRef, UniversalMessage } from "../../core/types";
import type { PanelState, ScanState } from "../../shared/dom-markers";
import type { SettingsDraft } from "../../shell/types";
import { DEFAULT_LAYOUT_STATE, type LayoutState } from "./layout-model";
import type { PanelView } from "./views";

/**
 * One entry in the transcript, in render order. A message card is a turn like any other
 * because a conversation can cover several messages: clicking a second message by the same
 * author appends its card and its answer under the first instead of replacing the panel
 * (owner's request, 2026-09-03). A fixed card above the turns could only ever show one.
 */
export type Turn =
  | { role: "user" | "assistant" | "note" | "error"; text: string }
  | { role: "message"; message: UniversalMessage };

/** Narrowing helper: the text roles are the ones that carry `text`. */
export function isTextTurn(turn: Turn): turn is { role: "user" | "assistant" | "note" | "error"; text: string } {
  return turn.role !== "message";
}

/** Everything the in-panel settings form needs that is not the form's own field values. */
export interface SettingsModel {
  /** What the host has stored, minus the key; null until the view asked for it. */
  draft: SettingsDraft | null;
  /** One line under the form: save/test outcome. */
  status: string | null;
  /** Origin the host still needs permission for; drives the `grant-access` button. */
  pendingGrant: string | null;
  /** A save or a test is in flight. */
  busy: boolean;
}

export interface PanelModel {
  status: PanelState;
  /** Which registered view is showing; mirrored to VIEW_ATTR. */
  view: PanelView["id"];
  layout: LayoutState;
  /**
   * The **current** anchor: what a follow-up, a retry and a scan act on, and what
   * PANEL_MESSAGE_ATTR reports. Not the transcript — a conversation that has collected
   * several messages keeps each one's card in `turns`, and this points at the last click.
   */
  ref: MessageRef | null;
  message: UniversalMessage | null;
  /** `${err.name}: ${err.message}` of a read failure; mirrored to PANEL_ERROR_ATTR. */
  error: string | null;
  /** null until the background answered `settings-status` for this open. */
  configured: boolean | null;
  turns: Turn[];
  /** Model-facing history; the display turns are derived from the same events but differ. */
  history: ChatMessage[];
  streaming: boolean;
  scan: { state: ScanState; count: number };
  settings: SettingsModel;
}

const NO_SETTINGS: SettingsModel = { draft: null, status: null, pendingGrant: null, busy: false };

export const INITIAL: PanelModel = {
  status: "closed",
  view: "chat",
  layout: DEFAULT_LAYOUT_STATE,
  ref: null,
  message: null,
  error: null,
  configured: null,
  turns: [],
  history: [],
  streaming: false,
  scan: { state: "idle", count: 0 },
  settings: NO_SETTINGS,
};

export type PanelAction =
  | { type: "open"; ref: MessageRef }
  | { type: "close" }
  | { type: "loaded"; message: UniversalMessage }
  /**
   * Another message joins the open conversation: same author, same channel. Keeps `turns`
   * and `history` and moves the anchor, which is what makes the answers stack instead of
   * the panel restarting.
   */
  | { type: "continue"; ref: MessageRef; message: UniversalMessage }
  | { type: "load-failed"; error: string }
  | { type: "settings"; configured: boolean }
  | { type: "stream-start"; history: ChatMessage[] }
  | { type: "delta"; text: string }
  | { type: "stream-end" }
  | { type: "stream-failed"; error: string; unconfigured: boolean }
  /** Clears the trailing error turn so a retried answer does not read as a second reply. */
  | { type: "retry" }
  | { type: "user-turn"; text: string }
  | { type: "note"; text: string }
  | { type: "scan-start" }
  | { type: "scan-progress"; count: number }
  | { type: "scan-done"; count: number }
  | { type: "scan-failed"; error: string }
  | { type: "show-view"; id: PanelView["id"] }
  | { type: "layout"; state: LayoutState }
  | { type: "settings-loaded"; draft: SettingsDraft | null }
  | { type: "settings-busy"; busy: boolean }
  /** Outcome of a save or a connectivity test; `grantOrigin` non-null only for saves. */
  | { type: "settings-result"; status: string; grantOrigin: string | null };

function appendToLastAssistant(turns: Turn[], text: string): Turn[] {
  const last = turns[turns.length - 1];
  if (last?.role === "assistant") {
    return [...turns.slice(0, -1), { role: "assistant", text: last.text + text }];
  }
  return [...turns, { role: "assistant", text }];
}

/** Kept per-message state only; see the file header for what survives and why. */
function resetFor(model: PanelModel, status: PanelState, ref: MessageRef | null): PanelModel {
  return {
    ...INITIAL,
    status,
    ref,
    view: ref === null ? model.view : "chat",
    layout: model.layout,
    settings: { ...model.settings, status: null, pendingGrant: null, busy: false },
  };
}

export function reduce(model: PanelModel, action: PanelAction): PanelModel {
  switch (action.type) {
    case "open":
      // Re-opening resets everything except what the reducer cannot know (settings),
      // which the controller re-asks anyway.
      return resetFor(model, "loading", action.ref);
    case "close":
      return resetFor(model, "closed", null);
    case "loaded":
      // The card enters the transcript here, so the first message and every later one are
      // rendered by the same code path in the same order they were asked about.
      return { ...model, status: "ready", message: action.message, error: null, turns: [{ role: "message", message: action.message }] };
    case "continue":
      return {
        ...model,
        status: "ready",
        ref: action.ref,
        message: action.message,
        error: null,
        scan: { state: "idle", count: 0 },
        turns: [...model.turns, { role: "message", message: action.message }],
      };
    case "load-failed":
      return { ...model, status: "error", error: action.error };
    case "settings":
      return { ...model, configured: action.configured };
    case "stream-start":
      return { ...model, streaming: true, history: action.history, turns: [...model.turns, { role: "assistant", text: "" }] };
    case "delta":
      return { ...model, turns: appendToLastAssistant(model.turns, action.text) };
    case "stream-end": {
      const last = model.turns[model.turns.length - 1];
      const reply = last?.role === "assistant" ? last.text : "";
      return { ...model, streaming: false, history: [...model.history, { role: "assistant", content: reply }] };
    }
    case "stream-failed":
      return {
        ...model,
        streaming: false,
        configured: action.unconfigured ? false : model.configured,
        turns: [...model.turns.filter((t) => t.role !== "assistant" || t.text.length > 0), { role: "error", text: action.error }],
      };
    case "retry": {
      const last = model.turns[model.turns.length - 1];
      return last?.role === "error" ? { ...model, turns: model.turns.slice(0, -1) } : model;
    }
    case "user-turn":
      return { ...model, turns: [...model.turns, { role: "user", text: action.text }] };
    case "note":
      return { ...model, turns: [...model.turns, { role: "note", text: action.text }] };
    case "scan-start":
      return { ...model, error: null, scan: { state: "running", count: 0 } };
    case "scan-progress":
      return { ...model, scan: { state: "running", count: action.count } };
    case "scan-done":
      return { ...model, scan: { state: "done", count: action.count } };
    case "scan-failed":
      // `error` is mirrored to PANEL_ERROR_ATTR so the probe can name the collection failure;
      // status stays "ready" because the message card is still valid.
      return {
        ...model,
        scan: { state: "error", count: model.scan.count },
        error: action.error,
        turns: [...model.turns, { role: "error", text: action.error }],
      };
    case "show-view":
      return { ...model, view: action.id };
    case "layout":
      return { ...model, layout: action.state };
    case "settings-loaded":
      return { ...model, settings: { ...model.settings, draft: action.draft } };
    case "settings-busy":
      return { ...model, settings: { ...model.settings, busy: action.busy } };
    case "settings-result":
      return {
        ...model,
        settings: { ...model.settings, busy: false, status: action.status, pendingGrant: action.grantOrigin },
      };
  }
}
