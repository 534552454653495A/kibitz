/**
 * Panel controller: owns the shadow host, the reducer store, every async flow (read,
 * explain, follow-up, scan, synthesis, settings save/test) and the host-attribute mirror
 * the probe reads.
 *
 * The mirror is written from the reduced model on every dispatch, so the attributes are a
 * projection of state rather than a second bookkeeping path. Async work is guarded by a
 * session counter: re-opening the panel on another message must not let a late RPC or a
 * late stream chunk from the previous message leak into the new one.
 *
 * The host itself comes from `createShadowHost`, never `attachShadow` directly: the event
 * isolation that helper installs is the fix for Discord stealing our keystrokes, and a
 * hand-rolled host would silently reintroduce the bug (see ui/shadow-host.ts).
 *
 * Geometry is delegated to layout.ts and only *persisted* here, because saving is a shell
 * concern (`loadUiState`/`saveUiState`) and the layout engine must stay DOM-pure.
 *
 * Conversation history is written here for the same reason: the shell stores records, but
 * only the controller knows when a conversation is worth storing. Two rules decide that:
 *   - a save happens when an ANSWER completes and when a message joins a conversation that
 *     already has one. A click whose answer never arrived is not history, and minting a
 *     record for it would leave an empty entry in the list for every mis-click;
 *   - the id and `createdAt` are minted once, on the first save, and kept in the model, so
 *     every later save REPLACES that record instead of growing the list as the user asks.
 */
import { h, render } from "preact";
import type { PlatformAdapter } from "../../core/adapter";
import {
  catalogueLine,
  clip,
  fallbackTitle,
  isTextTurn,
  matchesQuery,
  newConversationId,
  participantsOf,
  summarySearchText,
  type ConversationRecord,
  type SaveHistoryResult,
} from "../../core/history";
import type { ChatMessage } from "../../core/messaging";
import {
  appendExplain,
  appendFollowUp,
  buildExplainMessages,
  buildFindMessages,
  buildSynthesisMessages,
  buildTitleMessages,
} from "../../core/prompt";
import { originPattern } from "../../core/settings";
import type { MessageRef, UniversalMessage } from "../../core/types";
import {
  PANEL_ERROR_ATTR,
  PANEL_HOST_ATTR,
  PANEL_MESSAGE_ATTR,
  PANEL_STATE_ATTR,
  SCAN_COUNT_ATTR,
  SCAN_STATE_ATTR,
  VIEW_ATTR,
  type LayoutMode,
} from "../../shared/dom-markers";
import { log } from "../../shared/log";
import { ChatError, type SaveSettingsResult, type Shell } from "../../shell/types";
import { createShadowHost } from "../shadow-host";
import { Panel } from "./Panel";
import type { PanelActions } from "./actions";
import { clampLayout, installLayoutController, parseLayoutState, UI_STATE_LAYOUT_KEY } from "./layout";
import { DEFAULT_LAYOUT_STATE, type LayoutState, type Viewport } from "./layout-model";
import panelCss from "./panel.css";
import { admitsMessage, conversationMessages, INITIAL, reduce, type PanelAction, type PanelModel } from "./state";

export interface PanelHandle {
  open(ref: MessageRef): void;
}

/** Bounds for "scan related": enough for a busy hour of chat, short enough to feel alive. */
const SCAN_MAX_MESSAGES = 200;
const SCAN_MAX_DURATION_MS = 45_000;

/** Attribute values are read by the probe's report; keep them short and one-line. */
const ERROR_ATTR_MAX = 200;

/** A drag fires onChange per pointermove; the host's storage is not a stream. */
const PERSIST_DEBOUNCE_MS = 300;

/** Distance from the top-left corner a panel gets when it starts floating. */
const FLOAT_INSET = 64;
/** A fresh float is tall but not full-height, so it reads as a window and not as a dock. */
const FLOAT_HEIGHT_FRACTION = 0.7;

/**
 * Connectivity probe for the settings view's "Test" button. Deliberately not in
 * core/prompts/: it is a diagnostic that must stay one cheap round trip proving auth, base
 * URL and model name, not product copy anyone should feel free to rewrite.
 */
const PROBE_MESSAGES: ChatMessage[] = [{ role: "user", content: "Reply with the single word: ready" }];
const PROBE_REPLY_MAX = 80;

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * The text of the last answer, or "" when the conversation has none yet.
 *
 * This is the test for "is this worth saving": an assistant turn with text means the user
 * got something back. An empty one is a stream that is still waiting, and a conversation
 * with no answer at all is a click the user abandoned.
 */
function lastAnswer(model: PanelModel): string {
  for (let index = model.turns.length - 1; index >= 0; index -= 1) {
    const turn = model.turns[index];
    if (turn?.role === "assistant" && turn.text.length > 0) return turn.text;
  }
  return "";
}

/**
 * Mode switch preserves the panel's width — the user sized it once — and invents only what
 * the target mode additionally needs. Everything else is left to `clampLayout`.
 */
function withMode(state: LayoutState, mode: LayoutMode, viewport: Viewport): LayoutState {
  const width = state.layout.mode === "float" ? state.layout.width : state.layout.size;
  if (mode !== "float") return { layout: { mode, size: width }, expanded: state.expanded };
  return {
    layout: {
      mode: "float",
      x: FLOAT_INSET,
      y: FLOAT_INSET,
      width,
      height: Math.round(viewport.height * FLOAT_HEIGHT_FRACTION),
    },
    expanded: state.expanded,
  };
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // No async clipboard (insecure context, Electron without the permission) or the user
    // denied it. Fall through: failing to copy must never throw into an event handler.
  }
  const carrier = document.createElement("textarea");
  carrier.value = text;
  carrier.setAttribute("style", "position:fixed;top:0;left:-9999px;opacity:0");
  document.body.append(carrier);
  carrier.select();
  try {
    document.execCommand("copy");
  } catch (err) {
    log.warn("clipboard copy failed", err);
  }
  carrier.remove();
}

export function mountPanel(adapter: PlatformAdapter, shell: Shell): PanelHandle {
  const { host, root } = createShadowHost({
    tag: "div",
    attrs: { [PANEL_HOST_ATTR]: "1" },
    css: panelCss,
  });
  // Preact owns every child of its container and removes the ones it did not create, so it
  // gets an element of its own rather than the shadow root that holds our <style>.
  const container = document.createElement("div");
  container.setAttribute("data-kibitz-root", "1");
  root.append(container);

  let model: PanelModel = INITIAL;
  /** Whole UI-state blob, so persisting the layout cannot drop a key another feature owns. */
  let uiState: Record<string, unknown> = {};
  let session = 0;
  let streamAbort: AbortController | null = null;
  let scanAbort: AbortController | null = null;
  let testAbort: AbortController | null = null;
  /** The title one-shot and the AI search: separate from the answer stream on purpose. */
  let titleAbort: AbortController | null = null;
  let findAbort: AbortController | null = null;
  /** Serialises the writes of one record; see `queueSave`. */
  let saveChain: Promise<void> = Promise.resolve();
  /** Latest list request wins; see `listFlow` for why `session` is the wrong guard here. */
  let listToken = 0;
  let persistTimer: number | undefined = undefined;

  function viewport(): Viewport {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function mirror(): void {
    host.setAttribute(PANEL_STATE_ATTR, model.status);
    host.setAttribute(VIEW_ATTR, model.view);
    if (model.ref === null) host.removeAttribute(PANEL_MESSAGE_ATTR);
    else host.setAttribute(PANEL_MESSAGE_ATTR, model.ref.messageId);
    if (model.error === null) host.removeAttribute(PANEL_ERROR_ATTR);
    else host.setAttribute(PANEL_ERROR_ATTR, model.error.slice(0, ERROR_ATTR_MAX));
    host.setAttribute(SCAN_STATE_ATTR, model.scan.state);
    host.setAttribute(SCAN_COUNT_ATTR, String(model.scan.count));
  }

  function dispatch(action: PanelAction): void {
    model = reduce(model, action);
    mirror();
    render(
      h(Panel, {
        model,
        actions,
        platform: adapter.platform,
        capabilities: shell.capabilities,
        keyStorageHint: shell.keyStorageHint,
      }),
      container,
    );
  }

  function stopStream(): void {
    streamAbort?.abort();
    streamAbort = null;
  }

  function stopScan(): void {
    scanAbort?.abort();
    scanAbort = null;
  }

  function persistLayout(state: LayoutState): void {
    uiState = { ...uiState, [UI_STATE_LAYOUT_KEY]: state };
    clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      persistTimer = undefined;
      void shell.saveUiState(uiState).catch((err: unknown) => log.warn("saveUiState failed", err));
    }, PERSIST_DEBOUNCE_MS);
  }

  /** One path for every layout change we initiate: clamp, apply, reduce, remember. */
  function applyLayout(next: LayoutState): void {
    const clamped = clampLayout(next, viewport());
    layout.setState(clamped);
    dispatch({ type: "layout", state: clamped });
    persistLayout(clamped);
  }

  /**
   * An answer is complete: the conversation has something in it worth keeping, so this is
   * the one moment a record is written (and, the first time, titled). A stopped answer is
   * still an answer, so an abort ends up here too.
   */
  function endStream(owner: number): void {
    dispatch({ type: "stream-end" });
    void recordAnswer(owner);
  }

  async function stream(history: ChatMessage[], owner: number): Promise<void> {
    stopStream();
    const abort = new AbortController();
    streamAbort = abort;
    dispatch({ type: "stream-start", history });
    try {
      await shell.streamChat(history, {
        signal: abort.signal,
        onDelta: (text) => {
          if (owner === session) dispatch({ type: "delta", text });
        },
      });
      if (owner === session) endStream(owner);
    } catch (err) {
      if (owner !== session) return;
      if (err instanceof ChatError && err.code === "aborted") {
        // A stopped answer is still an answer: keep what arrived as the assistant turn.
        endStream(owner);
        return;
      }
      log.warn("chat failed", err);
      dispatch({
        type: "stream-failed",
        error: describeError(err),
        unconfigured: err instanceof ChatError && err.code === "no-settings",
      });
    } finally {
      if (streamAbort === abort) streamAbort = null;
    }
  }

  /** Settings and the message load in parallel; "ready" waits only for the message. */
  function settingsPromise(): Promise<boolean> {
    return shell.settingsStatus().then(
      (s) => s.configured,
      (err: unknown) => {
        log.warn("settings-status failed", err);
        return false;
      },
    );
  }

  async function finishExplain(history: ChatMessage[], settings: Promise<boolean>, owner: number): Promise<void> {
    const configured = await settings;
    if (owner !== session) return;
    dispatch({ type: "settings", configured });
    if (configured) await stream(history, owner);
  }

  async function openFlow(ref: MessageRef, owner: number): Promise<void> {
    const settings = settingsPromise();
    let message: UniversalMessage;
    try {
      message = await adapter.readMessage(ref);
    } catch (err) {
      if (owner !== session) return;
      log.warn("readMessage failed", err);
      dispatch({ type: "load-failed", error: describeError(err) });
      return;
    }
    if (owner !== session) return;
    dispatch({ type: "loaded", message });
    await finishExplain(buildExplainMessages(message), settings, owner);
  }

  /**
   * A second click while a conversation is open. The message is read FIRST, because whether it
   * belongs to this conversation is decided by its author and its reply target, and only the
   * read knows either (see `admitsMessage` for the rule and the reasoning).
   *
   * The channel is checked by the caller on purpose. The same person's messages in another
   * server are another subject, and folding them into one prompt would quietly ship one
   * server's content as context for a question about another.
   */
  async function continueFlow(ref: MessageRef, owner: number): Promise<void> {
    const settings = settingsPromise();
    const cards = conversationMessages(model.turns);
    let message: UniversalMessage;
    try {
      message = await adapter.readMessage(ref);
    } catch (err) {
      if (owner !== session) return;
      log.warn("readMessage failed", err);
      // A note, not `load-failed`: the conversation on screen is still valid and the user
      // has not lost it. `load-failed` would replace it with "could not read this message".
      dispatch({ type: "note", text: `Could not read that message: ${describeError(err)}` });
      return;
    }
    if (owner !== session) return;
    if (!admitsMessage(cards, message)) {
      dispatch({ type: "open", ref });
      dispatch({ type: "loaded", message });
      await finishExplain(buildExplainMessages(message), settings, owner);
      return;
    }
    const history = appendExplain(model.history, message);
    dispatch({ type: "continue", ref, message });
    // The card is part of the conversation now, so the stored record has to contain it even
    // if the answer for it never arrives (provider down, key expired, user closes Discord).
    void queueSave(owner);
    await finishExplain(history, settings, owner);
  }

  async function scanFlow(ref: MessageRef, owner: number): Promise<void> {
    stopScan();
    const abort = new AbortController();
    scanAbort = abort;
    dispatch({ type: "scan-start" });
    try {
      const thread = await adapter.collectAround(
        ref,
        { maxMessages: SCAN_MAX_MESSAGES, maxDurationMs: SCAN_MAX_DURATION_MS, signal: abort.signal },
        (progress) => {
          if (owner === session) dispatch({ type: "scan-progress", count: progress.collected });
        },
      );
      if (owner !== session) return;
      const count = thread.messages.length;
      dispatch({ type: "scan-done", count });
      dispatch({
        type: "note",
        text: `Scanned ${count} related message${count === 1 ? "" : "s"}${thread.truncated ? " (limit reached)" : ""}`,
      });
      if (model.configured === true) await stream(buildSynthesisMessages(thread), owner);
    } catch (err) {
      if (owner !== session) return;
      log.warn("collectAround failed", err);
      dispatch({ type: "scan-failed", error: describeError(err) });
    } finally {
      if (scanAbort === abort) scanAbort = null;
    }
  }

  /**
   * Writes the conversation on screen into the store, minting its identity on the first
   * call so that every later write REPLACES the same record.
   *
   * Reads `model` when it runs rather than when it was queued, which is what makes
   * serialising the writes (see `queueSave`) safe: a save that waited stores the newest
   * transcript, never an older snapshot of the same conversation.
   */
  async function saveNow(owner: number): Promise<void> {
    const messages = conversationMessages(model.turns);
    const first = messages[0];
    // No answer yet means an abandoned click: an empty record in the list is worse than no
    // record, because the user has to open it to find out it says nothing.
    if (first === undefined || lastAnswer(model) === "") return;
    let identity = model.conversation;
    if (identity === null) {
      identity = { id: newConversationId(), createdAt: new Date().toISOString(), title: null, titleAsked: false };
      dispatch({ type: "conversation-recorded", id: identity.id, createdAt: identity.createdAt });
    }
    const record: ConversationRecord = {
      id: identity.id,
      // From the message itself, not from the panel's platform: the record is what a list
      // and a search read months later, and the card knows where it came from.
      platform: first.platform,
      channelId: first.channel.id,
      title: identity.title ?? fallbackTitle(messages),
      participants: participantsOf(messages),
      messages,
      turns: model.turns,
      history: model.history,
      createdAt: identity.createdAt,
      updatedAt: new Date().toISOString(),
    };
    let result: SaveHistoryResult;
    try {
      result = await shell.saveConversation(record);
    } catch (err) {
      log.warn("saveConversation failed", err);
      result = { ok: false, error: describeError(err) };
    }
    if (owner !== session) return;
    if (!result.ok) {
      // A note, not an error turn: the answer is on screen and intact, and there is nothing
      // to retry — a full store needs the user to delete something. An error turn would
      // offer the Retry button, i.e. pay for an answer they are already reading.
      dispatch({ type: "note", text: `This conversation was not saved: ${result.error}` });
      return;
    }
    // Only when the list has already been looked at: the first visit to the History tab
    // fetches it itself, and a user who never opened the tab should not pay for the read.
    if (model.saved.list !== null) await listFlow();
  }

  /**
   * Saves are serialised. Two overlapping writes of one record (a message appended while an
   * answer is finishing) can otherwise complete out of order and leave the older transcript
   * in the store.
   */
  function queueSave(owner: number): Promise<void> {
    saveChain = saveChain.then(() => saveNow(owner)).catch((err: unknown) => {
      // One rejection would poison the chain and silently stop every later save, so the
      // failure ends here and the next conversation starts from a resolved promise.
      log.warn("save flow failed", err);
    });
    return saveChain;
  }

  /**
   * One extra request per conversation for a 3-5 word label, made once the first answer is
   * complete (the model needs the answer to name the subject).
   *
   * Deliberately not part of the conversation: it is neither added to the transcript nor to
   * `model.history`, so the user never reads it and the follow-ups never re-send it.
   *
   * Every failure is swallowed after a log line. The list already has `fallbackTitle`, and a
   * nicer label is not worth an error the user has to read and cannot act on.
   */
  async function titleFlow(first: UniversalMessage, answer: string, owner: number): Promise<void> {
    dispatch({ type: "conversation-title-requested" });
    titleAbort?.abort();
    const abort = new AbortController();
    titleAbort = abort;
    let text = "";
    try {
      await shell.streamChat(buildTitleMessages(first, answer), {
        signal: abort.signal,
        onDelta: (delta) => {
          text += delta;
        },
      });
    } catch (err) {
      log.warn("title request failed", err);
      return;
    } finally {
      if (titleAbort === abort) titleAbort = null;
    }
    if (owner !== session) return;
    // First line only: a model that adds "Here is your title:" gets its second line dropped
    // rather than pasted into the list.
    const title = clip((text.trim().split("\n")[0] ?? "").trim());
    if (title === "") return;
    dispatch({ type: "conversation-titled", title });
    await queueSave(owner);
  }

  /** Save, then title if this conversation has never asked for one. */
  async function recordAnswer(owner: number): Promise<void> {
    const answer = lastAnswer(model);
    const first = conversationMessages(model.turns)[0];
    if (answer === "" || first === undefined) return;
    const untitled = model.conversation === null || !model.conversation.titleAsked;
    await queueSave(owner);
    if (owner !== session || !untitled) return;
    // A save that failed left no record, so there is nothing to title either.
    if (model.conversation === null) return;
    await titleFlow(first, answer, owner);
  }

  /**
   * Refreshes the list. Guarded by its own token rather than by `session`, because the saved
   * conversations are not about the message that is open: closing the panel must not throw
   * away a list that is on its way, and two overlapping reads must not land backwards.
   */
  async function listFlow(): Promise<void> {
    const token = ++listToken;
    dispatch({ type: "history-busy", busy: true });
    try {
      const list = await shell.listConversations();
      if (token === listToken) dispatch({ type: "history-listed", list });
    } catch (err) {
      log.warn("listConversations failed", err);
      if (token === listToken) {
        dispatch({ type: "history-list-failed", error: `Could not read your saved conversations: ${describeError(err)}` });
      }
    }
  }

  /**
   * Puts a stored conversation back on screen. The session is bumped first: a stream still
   * arriving for the message the panel was showing must not append itself to the transcript
   * the user just restored.
   */
  async function openConversationFlow(id: string): Promise<void> {
    session += 1;
    stopStream();
    stopScan();
    const owner = session;
    dispatch({ type: "history-busy", busy: true });
    let record: ConversationRecord | null;
    try {
      record = await shell.loadConversation(id);
    } catch (err) {
      log.warn("loadConversation failed", err);
      dispatch({ type: "history-list-failed", error: `Could not open that conversation: ${describeError(err)}` });
      return;
    }
    if (owner !== session) return;
    if (record === null) {
      // Unknown or unreadable id: the record is gone or was written by something that is not
      // us. The row is dropped from the list rather than left as a button that does nothing.
      dispatch({ type: "history-deleted", id });
      dispatch({ type: "history-list-failed", error: "That conversation could not be read, so it is no longer listed." });
      return;
    }
    dispatch({ type: "history-restore", record });
    // The composer only appears once Kibitz is known to be configured, and the panel may
    // have been opened on a message whose settings check has not happened (or failed).
    if (model.configured !== true) {
      const configured = await settingsPromise();
      if (owner === session) dispatch({ type: "settings", configured });
    }
  }

  /**
   * The AI search: ONE request over a one-line-per-conversation catalogue (owner's decision,
   * 2026-09-03 — no second pass, no embeddings).
   *
   * The local filter narrows the catalogue only when it found something: a question asked in
   * prose ("Yunus'un AI ile ilgili konusu vardı, geçmişten bulabilir misin?") matches no line
   * literally, and sending an empty catalogue would spend a request on nothing. The history
   * view computes the same set for the sentence that says what is about to be sent.
   */
  async function findFlow(question: string, owner: number): Promise<void> {
    const list = model.saved.list ?? [];
    const filtered = list.filter((summary) => matchesQuery(summarySearchText(summary), question));
    const chosen = filtered.length > 0 ? filtered : list;
    if (chosen.length === 0) {
      dispatch({ type: "history-list-failed", error: "Nothing is saved yet, so there is nothing to look through." });
      return;
    }
    findAbort?.abort();
    const abort = new AbortController();
    findAbort = abort;
    dispatch({ type: "history-find-start" });
    try {
      await shell.streamChat(buildFindMessages(chosen.map(catalogueLine).join("\n"), question), {
        signal: abort.signal,
        onDelta: (text) => {
          if (owner === session) dispatch({ type: "history-find-delta", text });
        },
      });
      if (owner === session) dispatch({ type: "history-find-end" });
    } catch (err) {
      if (owner !== session) return;
      log.warn("history search failed", err);
      // An aborted search still shows what arrived, exactly like a stopped answer.
      if (err instanceof ChatError && err.code === "aborted") dispatch({ type: "history-find-end" });
      else dispatch({ type: "history-find-failed", error: `The search failed: ${describeError(err)}` });
    } finally {
      if (findAbort === abort) findAbort = null;
    }
  }

  /**
   * Removed from the list first so the click feels immediate, then re-listed from the store
   * so a delete that failed cannot leave the UI claiming something is gone.
   */
  async function deleteFlow(id: string): Promise<void> {
    dispatch({ type: "history-deleted", id });
    try {
      await shell.deleteConversation(id);
    } catch (err) {
      log.warn("deleteConversation failed", err);
      dispatch({ type: "history-list-failed", error: `Could not delete that conversation: ${describeError(err)}` });
    }
    await listFlow();
  }

  async function clearFlow(): Promise<void> {
    dispatch({ type: "history-cleared" });
    try {
      await shell.clearConversations();
    } catch (err) {
      log.warn("clearConversations failed", err);
      dispatch({ type: "history-list-failed", error: `Could not delete your conversations: ${describeError(err)}` });
    }
    await listFlow();
  }

  async function loadDraft(): Promise<void> {
    try {
      dispatch({ type: "settings-loaded", draft: await shell.loadSettings() });
    } catch (err) {
      log.warn("loadSettings failed", err);
      dispatch({ type: "settings-result", status: `Could not read the stored settings: ${describeError(err)}`, grantOrigin: null });
    }
  }

  async function saveFlow(result: Promise<SaveSettingsResult>): Promise<void> {
    dispatch({ type: "settings-busy", busy: true });
    let outcome: SaveSettingsResult;
    try {
      outcome = await result;
    } catch (err) {
      log.warn("saveSettings failed", err);
      dispatch({ type: "settings-result", status: `Could not save: ${describeError(err)}`, grantOrigin: null });
      return;
    }
    if (!outcome.ok) {
      dispatch({ type: "settings-result", status: outcome.error, grantOrigin: outcome.grantOrigin ?? null });
      return;
    }
    dispatch({ type: "settings-result", status: "Saved.", grantOrigin: null });
    await loadDraft();
    // "Configured" gates the composer and the explain flow, so it must be re-asked here:
    // the user may have just fixed the very thing the chat view is complaining about.
    try {
      const status = await shell.settingsStatus();
      dispatch({ type: "settings", configured: status.configured });
    } catch (err) {
      log.warn("settings-status failed", err);
    }
  }

  async function testFlow(): Promise<void> {
    testAbort?.abort();
    const abort = new AbortController();
    testAbort = abort;
    dispatch({ type: "settings-busy", busy: true });
    let reply = "";
    try {
      await shell.streamChat(PROBE_MESSAGES, {
        signal: abort.signal,
        onDelta: (text) => {
          reply += text;
        },
      });
      const line = reply.trim().split("\n")[0] ?? "";
      dispatch({
        type: "settings-result",
        status: line === "" ? "Connected, but the provider returned no text." : `Provider replied: ${line.slice(0, PROBE_REPLY_MAX)}`,
        grantOrigin: null,
      });
    } catch (err) {
      log.warn("settings test failed", err);
      let grantOrigin: string | null = null;
      const baseUrl = model.settings.draft?.baseUrl;
      if (err instanceof ChatError && err.code === "no-permission" && baseUrl !== undefined) {
        try {
          grantOrigin = originPattern(baseUrl);
        } catch {
          // Unparsable base URL: the error text already says what is wrong.
        }
      }
      dispatch({ type: "settings-result", status: `Test failed: ${describeError(err)}`, grantOrigin });
    } finally {
      if (testAbort === abort) testAbort = null;
    }
  }

  const actions: PanelActions = {
    close() {
      session += 1;
      stopStream();
      stopScan();
      testAbort?.abort();
      testAbort = null;
      // The title one-shot and the AI search are billed requests for a panel that is gone.
      titleAbort?.abort();
      titleAbort = null;
      findAbort?.abort();
      findAbort = null;
      dispatch({ type: "close" });
    },
    send(text) {
      if (model.status !== "ready" || model.message === null || model.streaming) return;
      // If the opening explanation never happened (e.g. it failed), the follow-up still
      // needs the message as context; seed the history with the explain prompt.
      const base = model.history.length > 0 ? model.history : buildExplainMessages(model.message);
      dispatch({ type: "user-turn", text });
      void stream(appendFollowUp(base, text), session);
    },
    scan() {
      if (model.status !== "ready" || model.ref === null || model.scan.state === "running" || model.streaming) return;
      void scanFlow(model.ref, session);
    },
    stop() {
      stopStream();
    },
    retry() {
      if (model.streaming) return;
      // `history` is the request that failed (the assistant reply is only appended on
      // success), so retrying is literally re-sending it.
      const again = model.history.length > 0 ? model.history : model.message === null ? null : buildExplainMessages(model.message);
      if (again === null) return;
      dispatch({ type: "retry" });
      void stream(again, session);
    },
    showView(id) {
      dispatch({ type: "show-view", id });
      if (id === "settings" && model.settings.draft === null) void loadDraft();
      // Only on the first visit: the list is refreshed by every successful save afterwards,
      // so re-reading it on every tab click would be a round trip for no new information.
      if (id === "history" && model.saved.list === null) void listFlow();
    },
    saveSettings(input) {
      return saveFlow(shell.saveSettings(input));
    },
    testSettings() {
      if (model.settings.busy) return;
      void testFlow();
    },
    requestAccess(origin) {
      void shell.requestAccess(origin).then(
        (granted) => {
          // `false` is not a refusal in the extension: Chrome only accepts a permission
          // request from a real user gesture, so that host opens its own window and the
          // answer arrives later. Both hosts end the same way — press Save again.
          dispatch({
            type: "settings-result",
            status: granted
              ? "Access granted — press Save again."
              : "A permission window is open. Approve access there, then press Save again.",
            grantOrigin: granted ? null : origin,
          });
        },
        (err: unknown) => {
          log.warn("request-access failed", err);
          dispatch({ type: "settings-result", status: describeError(err), grantOrigin: origin });
        },
      );
    },
    openOptions() {
      void shell.openOptions().catch((err: unknown) => log.warn("open-options failed", err));
    },
    setLayout(mode) {
      applyLayout(withMode(model.layout, mode, viewport()));
    },
    toggleExpanded() {
      applyLayout({ ...model.layout, expanded: !model.layout.expanded });
    },
    resetLayout() {
      applyLayout(DEFAULT_LAYOUT_STATE);
    },
    copyTurn(index) {
      const turn = model.turns[index];
      // A card has no text to copy; the button only exists on answers, so this is a guard
      // against a stale index (the transcript grows while a click is in flight), not a case.
      if (turn === undefined || !isTextTurn(turn)) return;
      void copyText(turn.text);
    },
    searchConversations(query) {
      dispatch({ type: "history-query", query });
    },
    askConversations(question) {
      if (model.saved.asking || question === "") return;
      void findFlow(question, session);
    },
    openConversation(id) {
      void openConversationFlow(id);
    },
    deleteConversation(id) {
      void deleteFlow(id);
    },
    confirmClearConversations(pending) {
      dispatch({ type: "history-confirm-clear", pending });
    },
    clearConversations() {
      void clearFlow();
    },
  };

  const layout = installLayoutController({
    host,
    root,
    initial: DEFAULT_LAYOUT_STATE,
    onChange: (state) => {
      // Only user drags reach this; our own changes go through applyLayout.
      dispatch({ type: "layout", state });
      persistLayout(state);
    },
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && model.status !== "closed") actions.close();
  });

  // Our shadow host stops keyboard events from reaching document (that is the whole point
  // of ui/shadow-host.ts), so the panel's own shortcuts must be bound inside the tree.
  root.addEventListener("keydown", (event: Event) => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key === "Escape") {
      actions.close();
      return;
    }
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    const composer = root.querySelector("textarea");
    if (composer === null) return;
    const text = composer.value.trim();
    if (text === "") return;
    event.preventDefault();
    composer.value = "";
    actions.send(text);
  });

  document.body.append(host);
  dispatch({ type: "close" });

  void shell.loadUiState().then(
    (state) => {
      uiState = state;
      const stored = parseLayoutState(state[UI_STATE_LAYOUT_KEY]);
      layout.setState(stored);
      dispatch({ type: "layout", state: stored });
    },
    (err: unknown) => log.warn("loadUiState failed", err),
  );

  return {
    open(ref) {
      const sameMessage = model.ref?.messageId === ref.messageId && model.ref?.channelId === ref.channelId;
      // The button of a message that is already answered: keep what is on screen. Re-asking
      // the same question would cost the user a second request for the same answer.
      if (sameMessage && model.status === "ready") return;
      // Another message while a conversation is open, in the same channel: it MIGHT belong to
      // it - by author or by reply - which only the read can tell (see continueFlow).
      const mayContinue =
        model.status === "ready" && model.ref?.channelId === ref.channelId && conversationMessages(model.turns).length > 0;
      session += 1;
      stopStream();
      stopScan();
      if (mayContinue) {
        void continueFlow(ref, session);
        return;
      }
      dispatch({ type: "open", ref });
      void openFlow(ref, session);
    },
  };
}
