/**
 * Panel controller: owns the shadow host, the reducer store, every async flow (read,
 * explain, follow-up, scan, synthesis) and the host-attribute mirror the probe reads.
 *
 * The mirror is written from the reduced model on every dispatch, so the attributes are
 * a projection of state rather than a second bookkeeping path. Async work is guarded by a
 * session counter: re-opening the panel on another message must not let a late RPC or a
 * late stream chunk from the previous message leak into the new one.
 */
import { h, render } from "preact";
import type { PlatformAdapter } from "../../core/adapter";
import type { ChatMessage, RuntimeRequest, SettingsStatus } from "../../core/messaging";
import { appendFollowUp, buildExplainMessages, buildSynthesisMessages } from "../../core/prompt";
import type { MessageRef, UniversalMessage } from "../../core/types";
import { isRecord } from "../../core/validate";
import {
  PANEL_ERROR_ATTR,
  PANEL_HOST_ATTR,
  PANEL_MESSAGE_ATTR,
  PANEL_STATE_ATTR,
  SCAN_COUNT_ATTR,
  SCAN_STATE_ATTR,
} from "../../shared/dom-markers";
import { ext } from "../../shared/ext";
import { log } from "../../shared/log";
import { ChatError, streamChat } from "./chat-client";
import { Panel, type PanelActions } from "./Panel";
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

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

async function fetchSettingsStatus(): Promise<SettingsStatus> {
  const request: RuntimeRequest = { type: "settings-status" };
  const reply: unknown = await ext.runtime.sendMessage(request);
  if (!isRecord(reply) || typeof reply.configured !== "boolean") {
    throw new Error("background returned no settings status");
  }
  return reply as unknown as SettingsStatus;
}

export function mountPanel(adapter: PlatformAdapter): PanelHandle {
  const host = document.createElement("div");
  host.setAttribute(PANEL_HOST_ATTR, "1");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = panelCss;
  const root = document.createElement("div");
  root.style.height = "100%";
  shadow.append(style, root);

  let model: PanelModel = INITIAL;
  let session = 0;
  let streamAbort: AbortController | null = null;
  let scanAbort: AbortController | null = null;

  function mirror(): void {
    host.setAttribute(PANEL_STATE_ATTR, model.status);
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
    render(h(Panel, { platform: adapter.platform, model, actions }), root);
  }

  function stopStream(): void {
    streamAbort?.abort();
    streamAbort = null;
  }

  function stopScan(): void {
    scanAbort?.abort();
    scanAbort = null;
  }

  async function stream(history: ChatMessage[], owner: number): Promise<void> {
    stopStream();
    const abort = new AbortController();
    streamAbort = abort;
    dispatch({ type: "stream-start", history });
    try {
      await streamChat(history, {
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
    const settings = fetchSettingsStatus().then(
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
      dispatch({ type: "note", text: `Scanned ${count} related message${count === 1 ? "" : "s"}${thread.truncated ? " (limit reached)" : ""}` });
      if (model.configured === true) await stream(buildSynthesisMessages(thread), owner);
    } catch (err) {
      if (owner !== session) return;
      log.warn("collectAround failed", err);
      dispatch({ type: "scan-failed", error: describeError(err) });
    } finally {
      if (scanAbort === abort) scanAbort = null;
    }
  }

  const actions: PanelActions = {
    close() {
      session += 1;
      stopStream();
      stopScan();
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
    openOptions() {
      const request: RuntimeRequest = { type: "open-options" };
      void ext.runtime.sendMessage(request).catch((err: unknown) => log.warn("open-options failed", err));
    },
  };

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && model.status !== "closed") actions.close();
  });

  document.body.append(host);
  dispatch({ type: "close" });

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
