/**
 * Panel state machine: a pure reducer so the host-attribute mirror (what the probe reads)
 * and the rendered UI are two views of one model that can never disagree.
 *
 * `status` and `scan.state` are exactly the PanelState / ScanState vocabularies from
 * shared/dom-markers.ts because mount.ts copies them onto the host verbatim.
 *
 * Four things are deliberately *outside* the per-message lifecycle and therefore survive
 * `open`/`close`: `layout` (the user placed the panel; reopening it somewhere else would be
 * a bug), the settings `draft` (retyping a base URL because the panel closed is hostile),
 * the list of saved conversations with its search box (re-fetching and re-typing both on
 * every click would be work the user can see) and the view — except that opening a message
 * forces `chat`, because the click that opened the panel asked a question and the answer
 * lives there.
 *
 * `Turn` lives in core/history.ts rather than here: a saved conversation stores the display
 * turns verbatim, so the panel and the record must be the same type, not two that drift.
 */
import { parseMatches, type ConversationRecord, type ConversationSummary, type Turn } from "../../core/history";
import type { ChatMessage } from "../../core/messaging";
import type { MessageRef, UniversalMessage } from "../../core/types";
import type { PanelState, ScanState } from "../../shared/dom-markers";
import type { SettingsDraft } from "../../shell/types";
import { DEFAULT_LAYOUT_STATE, type LayoutState } from "./layout-model";
import type { PanelView } from "./views";

/** The message cards in the transcript, in the order they were asked about. */
export function conversationMessages(turns: Turn[]): UniversalMessage[] {
  return turns.flatMap((turn) => (turn.role === "message" ? [turn.message] : []));
}

/**
 * Does this message belong to the conversation already on screen?
 *
 * Owner's rule, in their words: two messages by one person are one conversation, and a message
 * that **replies** to one of them is the same subject too — "yunusun mesajını yanıtlayıp cevap
 * vermiş". A message from someone new that replies to nothing we are discussing is a different
 * subject and starts fresh, which is the same sentence read the other way.
 *
 * Three ways in, all cheap and all decidable from what is on screen:
 *   - the author already speaks in this conversation (the original same-author rule; a person
 *     who joined by replying counts, because from then on they are part of the subject);
 *   - the message replies **into** the conversation;
 *   - the conversation already replies **to** it — the mirror case, which happens when the
 *     user reads an answer about a reply and then clicks the message it answered.
 *
 * Deliberately not included: a reply to some message by a participant that is not itself in
 * the conversation. That is a different exchange by a familiar face, and the user still has a
 * way to start over — closing the panel.
 */
export function admitsMessage(cards: readonly UniversalMessage[], candidate: UniversalMessage): boolean {
  if (cards.length === 0) return false;
  if (cards.some((card) => card.author.id === candidate.author.id)) return true;
  const replyTarget = candidate.replyTo?.messageId;
  if (replyTarget !== undefined && cards.some((card) => card.id === replyTarget)) return true;
  return cards.some((card) => card.replyTo?.messageId === candidate.id);
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

/**
 * The saved-conversation record this panel is writing into. Minted on the FIRST save, not
 * when the panel opens: a click whose answer never arrived is not a conversation, and an id
 * handed out earlier would leave an empty record behind for every abandoned click.
 */
export interface RecordedConversation {
  id: string;
  /** ISO 8601, fixed at the first save; only `updatedAt` moves afterwards. */
  createdAt: string;
  /** The model's 3-5 word title once it arrived; null means `fallbackTitle` is in use. */
  title: string | null;
  /**
   * Set when the one-shot title request STARTS, so it runs once per conversation whether it
   * succeeds or fails — a title is not worth a second billed request, let alone a retry loop.
   */
  titleAsked: boolean;
}

/** Everything the history view shows that is not derived from the summaries themselves. */
export interface HistoryModel {
  /** Newest first, as the host returns them; null until the host has answered once. */
  list: ConversationSummary[] | null;
  /** The one search box: it filters the list locally AND is the question `Ask` sends. */
  query: string;
  /** A list, an open or a delete is in flight. */
  busy: boolean;
  /** The AI search is streaming; kept apart from `busy` so the list stays clickable. */
  asking: boolean;
  /** The AI search's answer so far, and the ids it named once the stream ended. */
  answer: string;
  matches: string[];
  /** A list/search failure, shown inside the view: it is not part of any transcript. */
  error: string | null;
  /** "Delete all" is armed by a first click; this is that armed step. */
  confirmingClear: boolean;
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
  /** Where this conversation is being saved; null until the first answer was stored. */
  conversation: RecordedConversation | null;
  /**
   * Browsing the saved conversations. Named `saved` and not `history` because `history`
   * above is already the model-facing chat history — two different things one word apart.
   */
  saved: HistoryModel;
}

const NO_SETTINGS: SettingsModel = { draft: null, status: null, pendingGrant: null, busy: false };
const NO_HISTORY: HistoryModel = {
  list: null,
  query: "",
  busy: false,
  asking: false,
  answer: "",
  matches: [],
  error: null,
  confirmingClear: false,
};

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
  conversation: null,
  saved: NO_HISTORY,
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
  | { type: "settings-result"; status: string; grantOrigin: string | null }
  /** The first save happened: this is the id and creation time everything later reuses. */
  | { type: "conversation-recorded"; id: string; createdAt: string }
  | { type: "conversation-title-requested" }
  | { type: "conversation-titled"; title: string }
  /** A stored conversation is put back on screen: cards, transcript, model history, anchor. */
  | { type: "history-restore"; record: ConversationRecord }
  | { type: "history-listed"; list: ConversationSummary[] }
  | { type: "history-list-failed"; error: string }
  /** Typing in the search box: filters locally, and invalidates the previous AI answer. */
  | { type: "history-query"; query: string }
  | { type: "history-busy"; busy: boolean }
  | { type: "history-find-start" }
  | { type: "history-find-delta"; text: string }
  | { type: "history-find-end" }
  | { type: "history-find-failed"; error: string }
  | { type: "history-deleted"; id: string }
  | { type: "history-cleared" }
  | { type: "history-confirm-clear"; pending: boolean };

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
    // The saved list and what the user typed into its box survive; a streaming AI answer
    // and its buttons do not, because they answered a question about a previous moment.
    saved: { ...NO_HISTORY, list: model.saved.list, query: model.saved.query },
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
    case "conversation-recorded":
      return { ...model, conversation: { id: action.id, createdAt: action.createdAt, title: null, titleAsked: false } };
    case "conversation-title-requested":
      return model.conversation === null ? model : { ...model, conversation: { ...model.conversation, titleAsked: true } };
    case "conversation-titled":
      return model.conversation === null ? model : { ...model, conversation: { ...model.conversation, title: action.title } };
    case "history-restore": {
      const { record } = action;
      // The LAST stored message is the anchor: it is where the stored conversation was left,
      // so a follow-up, a retry and a scan act on the same message they would have then.
      // A record with no messages cannot exist (core/history.ts drops those), so no anchor
      // means a value that never came from `parseConversation` — leave the panel alone.
      const anchor = record.messages[record.messages.length - 1];
      if (anchor === undefined) return model;
      return {
        ...model,
        status: "ready",
        view: "chat",
        ref: { platform: anchor.platform, channelId: anchor.channel.id, messageId: anchor.id },
        message: anchor,
        error: null,
        turns: record.turns,
        history: record.history,
        streaming: false,
        scan: { state: "idle", count: 0 },
        // `titleAsked` is true even when the stored title is only the fallback: the request
        // already had its one chance, and a reopened conversation must not pay for another.
        conversation: { id: record.id, createdAt: record.createdAt, title: record.title, titleAsked: true },
        saved: { ...model.saved, busy: false, confirmingClear: false },
      };
    }
    case "history-listed":
      return { ...model, saved: { ...model.saved, list: action.list, busy: false, error: null } };
    case "history-list-failed":
      return { ...model, saved: { ...model.saved, busy: false, error: action.error } };
    case "history-query":
      // The previous AI answer belonged to the previous question; leaving its match buttons
      // under a different query would offer conversations nobody asked about.
      return { ...model, saved: { ...model.saved, query: action.query, answer: "", matches: [], error: null } };
    case "history-busy":
      return { ...model, saved: { ...model.saved, busy: action.busy } };
    case "history-find-start":
      return { ...model, saved: { ...model.saved, asking: true, answer: "", matches: [], error: null } };
    case "history-find-delta":
      return { ...model, saved: { ...model.saved, answer: model.saved.answer + action.text } };
    case "history-find-end":
      // The ids come from the finished answer via the shared parser, so the buttons and the
      // text the user is reading can never name different conversations.
      return { ...model, saved: { ...model.saved, asking: false, matches: parseMatches(model.saved.answer) } };
    case "history-find-failed":
      return { ...model, saved: { ...model.saved, asking: false, error: action.error } };
    case "history-deleted":
      return {
        ...model,
        // Deleting the conversation that is on screen forgets where it was being saved, so
        // the next answer starts a new record instead of re-creating the id the user removed
        // (which would look like the delete had failed).
        conversation: model.conversation?.id === action.id ? null : model.conversation,
        saved: {
          ...model.saved,
          list: (model.saved.list ?? []).filter((summary) => summary.id !== action.id),
          matches: model.saved.matches.filter((id) => id !== action.id),
          busy: false,
        },
      };
    case "history-cleared":
      return {
        ...model,
        conversation: null,
        saved: { ...model.saved, list: [], matches: [], busy: false, confirmingClear: false },
      };
    case "history-confirm-clear":
      return { ...model, saved: { ...model.saved, confirmingClear: action.pending } };
  }
}
