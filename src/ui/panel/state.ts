/**
 * Panel state machine: a pure reducer so the host-attribute mirror (what the probe reads)
 * and the rendered UI are two views of one model that can never disagree.
 *
 * `status` and `scan.state` are exactly the PanelState / ScanState vocabularies from
 * shared/dom-markers.ts because mount.ts copies them onto the host verbatim.
 */
import type { ChatMessage } from "../../core/messaging";
import type { MessageRef, UniversalMessage } from "../../core/types";
import type { PanelState, ScanState } from "../../shared/dom-markers";

export interface Turn {
  role: "user" | "assistant" | "note" | "error";
  text: string;
}

export interface PanelModel {
  status: PanelState;
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
}

export const INITIAL: PanelModel = {
  status: "closed",
  ref: null,
  message: null,
  error: null,
  configured: null,
  turns: [],
  history: [],
  streaming: false,
  scan: { state: "idle", count: 0 },
};

export type PanelAction =
  | { type: "open"; ref: MessageRef }
  | { type: "close" }
  | { type: "loaded"; message: UniversalMessage }
  | { type: "load-failed"; error: string }
  | { type: "settings"; configured: boolean }
  | { type: "stream-start"; history: ChatMessage[] }
  | { type: "delta"; text: string }
  | { type: "stream-end" }
  | { type: "stream-failed"; error: string; unconfigured: boolean }
  | { type: "user-turn"; text: string }
  | { type: "note"; text: string }
  | { type: "scan-start" }
  | { type: "scan-progress"; count: number }
  | { type: "scan-done"; count: number }
  | { type: "scan-failed"; error: string };

function appendToLastAssistant(turns: Turn[], text: string): Turn[] {
  const last = turns[turns.length - 1];
  if (last?.role === "assistant") {
    return [...turns.slice(0, -1), { role: "assistant", text: last.text + text }];
  }
  return [...turns, { role: "assistant", text }];
}

export function reduce(model: PanelModel, action: PanelAction): PanelModel {
  switch (action.type) {
    case "open":
      // Re-opening resets everything except what the reducer cannot know (settings),
      // which the controller re-asks anyway.
      return { ...INITIAL, status: "loading", ref: action.ref };
    case "close":
      return { ...INITIAL };
    case "loaded":
      return { ...model, status: "ready", message: action.message, error: null };
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
        turns: [...model.turns.filter((t) => t.role !== "assistant" || t.text !== ""), { role: "error", text: action.error }],
      };
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
  }
}
