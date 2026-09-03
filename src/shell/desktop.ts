/**
 * Desktop shell: the in-page side of the companion protocol (shell/desktop-protocol.ts).
 *
 * Requests leave through the CDP binding the companion installed with
 * `page.exposeFunction`; deltas come back through DESKTOP_DELIVER_FN, which THIS module
 * defines. A `page.evaluate` from Node can only call a function the page already exposes,
 * so the inbox has to exist on the window before the first chat request goes out — the
 * companion cannot create it for us. It is defined exactly once and routes through a
 * module-level map of pending streams: a second shell instance (a second `createDesktopShell`
 * call, a test) must not shadow the inbox the first one's streams are waiting on.
 *
 * Deliveries whose requestId is unknown are dropped on purpose. After the user stops an
 * answer the companion keeps streaming until it processes the cancel, so a delta or a late
 * error for a stream that no longer exists is the normal case, not a protocol violation.
 */
import type { ConversationRecord, ConversationSummary, SaveHistoryResult } from "../core/history";
import type { ChatMessage, SettingsStatus } from "../core/messaging";
import { isRecord } from "../core/validate";
import { DESKTOP_CALL_BINDING, DESKTOP_DELIVER_FN, type DesktopDelivery, type DesktopRequest } from "./desktop-protocol";
import { readConversation, readConversations, readDraft, readSaveResult, readUiState } from "./replies";
import { ChatError, type SaveSettingsResult, type SettingsDraft, type SettingsInput, type Shell, type StreamChatOptions } from "./types";

const NOT_CONNECTED = "Kibitz desktop companion is not connected";

interface PendingStream {
  onDelta: (text: string) => void;
  resolve: () => void;
  reject: (err: ChatError) => void;
}

const pending = new Map<string, PendingStream>();

function deliver(json: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return;
  }
  if (!isRecord(raw) || typeof raw.requestId !== "string") return;
  const stream = pending.get(raw.requestId);
  if (stream === undefined) return;
  const msg = raw as DesktopDelivery;
  switch (msg.type) {
    case "delta":
      stream.onDelta(msg.text);
      return;
    case "done":
      stream.resolve();
      return;
    case "error":
      stream.reject(new ChatError(msg.code, msg.message));
      return;
  }
}

/** One round trip over the binding; every failure surfaces as a ChatError the panel can classify. */
async function send(request: DesktopRequest): Promise<Record<string, unknown>> {
  const call = window[DESKTOP_CALL_BINDING];
  if (call === undefined) throw new ChatError("provider", NOT_CONNECTED);
  let reply: unknown;
  try {
    reply = JSON.parse(await call(JSON.stringify(request)));
  } catch (err: unknown) {
    throw new ChatError("provider", `companion call failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(reply)) throw new ChatError("provider", "companion returned a malformed reply");
  return reply;
}

function streamChat(messages: ChatMessage[], { onDelta, signal }: StreamChatOptions): Promise<void> {
  if (signal.aborted) return Promise.reject(new ChatError("aborted", "cancelled before start"));
  if (window[DESKTOP_CALL_BINDING] === undefined) return Promise.reject(new ChatError("provider", NOT_CONNECTED));

  const requestId = crypto.randomUUID();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let settled = false;

  const finish = (outcome: () => void): void => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    pending.delete(requestId);
    outcome();
  };

  const onAbort = (): void => {
    // The companion may already be gone; the reject below is what the panel waits for.
    send({ type: "cancel", requestId }).catch(() => undefined);
    finish(() => reject(new ChatError("aborted", "cancelled")));
  };

  pending.set(requestId, {
    onDelta,
    resolve: () => finish(resolve),
    reject: (err) => finish(() => reject(err)),
  });
  signal.addEventListener("abort", onAbort, { once: true });

  send({ type: "chat", requestId, messages }).then(
    (reply) => {
      if (reply.ok === true) return;
      const detail = typeof reply.error === "string" ? reply.error : "companion refused the request";
      finish(() => reject(new ChatError("provider", detail)));
    },
    (err: unknown) => finish(() => reject(err instanceof ChatError ? err : new ChatError("provider", String(err)))),
  );
  return promise;
}

async function settingsStatus(): Promise<SettingsStatus> {
  const reply = await send({ type: "settings-status" });
  if (typeof reply.configured !== "boolean") throw new Error("companion returned no settings status");
  return reply as unknown as SettingsStatus;
}

async function loadSettings(): Promise<SettingsDraft | null> {
  return readDraft(await send({ type: "load-settings" }), "companion");
}

async function saveSettings(input: SettingsInput): Promise<SaveSettingsResult> {
  return readSaveResult(await send({ type: "save-settings", input }), "companion");
}

/**
 * Nothing to ask for: the companion is a plain Node process making the HTTP call, with no
 * per-origin permission model between it and the provider. It answers `request-access` too
 * (an older renderer may still ask), but the shell short-circuits rather than spend a round
 * trip on a foregone answer.
 */
const GRANTED_WITHOUT_ASKING = (): Promise<boolean> => Promise.resolve(true);

async function loadUiState(): Promise<Record<string, unknown>> {
  return readUiState(await send({ type: "load-ui-state" }));
}

async function saveUiState(state: Record<string, unknown>): Promise<void> {
  await send({ type: "save-ui-state", state });
}

async function openOptions(): Promise<void> {
  await send({ type: "open-options" });
}

async function listConversations(): Promise<ConversationSummary[]> {
  return readConversations(await send({ type: "list-conversations" }), "companion");
}

async function loadConversation(id: string): Promise<ConversationRecord | null> {
  return readConversation(await send({ type: "load-conversation", id }), "companion");
}

/**
 * The companion answers a failed write rather than throwing, and that answer is passed
 * straight through: a full disk is something the user fixes, not an exception the panel
 * turns into a lost answer.
 */
async function saveConversation(record: ConversationRecord): Promise<SaveHistoryResult> {
  return readSaveResult(await send({ type: "save-conversation", record }), "companion");
}

async function deleteConversation(id: string): Promise<void> {
  await send({ type: "delete-conversation", id });
}

async function clearConversations(): Promise<void> {
  await send({ type: "clear-conversations" });
}

export function createDesktopShell(): Shell {
  window[DESKTOP_DELIVER_FN] ??= deliver;
  return {
    streamChat,
    settingsStatus,
    loadSettings,
    saveSettings,
    requestAccess: GRANTED_WITHOUT_ASKING,
    openOptions,
    loadUiState,
    saveUiState,
    listConversations,
    loadConversation,
    saveConversation,
    deleteConversation,
    clearConversations,
    // The renderer shares Discord's realm, so anything typed into the panel is reachable by
    // Discord's own JS; the settings view warns and points at the terminal wizard instead.
    capabilities: { keyIsPageVisible: true, canOpenOptionsPage: false },
    keyStorageHint:
      "Stored by the Kibitz companion on this machine (settings.json). Typed here, the key passes through Discord's own window — `npm run desktop -- setup` avoids that.",
  };
}
