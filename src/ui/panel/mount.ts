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
 */
import { h, render } from "preact";
import type { PlatformAdapter } from "../../core/adapter";
import type { ChatMessage } from "../../core/messaging";
import { appendFollowUp, buildExplainMessages, buildSynthesisMessages } from "../../core/prompt";
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
import { INITIAL, reduce, type PanelAction, type PanelModel } from "./state";

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
      if (owner === session) dispatch({ type: "stream-end" });
    } catch (err) {
      if (owner !== session) return;
      if (err instanceof ChatError && err.code === "aborted") {
        // A stopped answer is still an answer: keep what arrived as the assistant turn.
        dispatch({ type: "stream-end" });
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

  async function openFlow(ref: MessageRef, owner: number): Promise<void> {
    // Settings and the message load in parallel; "ready" waits only for the message so
    // the probe (and the user) see the card even when the background is slow.
    const settings = shell.settingsStatus().then(
      (s) => s.configured,
      (err: unknown) => {
        log.warn("settings-status failed", err);
        return false;
      },
    );

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

    const configured = await settings;
    if (owner !== session) return;
    dispatch({ type: "settings", configured });
    if (configured) await stream(buildExplainMessages(message), owner);
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
      if (turn === undefined) return;
      void copyText(turn.text);
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
      session += 1;
      stopStream();
      stopScan();
      dispatch({ type: "open", ref });
      void openFlow(ref, session);
    },
  };
}
