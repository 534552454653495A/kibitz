/**
 * Extension shell: the in-page side of the service-worker protocol (core/messaging.ts).
 *
 * One Port per request, not one long-lived Port for the panel's lifetime: an MV3 service
 * worker may be terminated between two answers, and a Port that died with it looks
 * connected until the first postMessage throws. Connecting per request keeps the worker
 * alive exactly as long as one answer takes and turns "worker died" into a clean reject.
 *
 * Every one-shot reply is narrowed before it reaches the panel (shared/replies.ts): a
 * `sendMessage` whose listener threw resolves with `undefined`, so an unchecked cast would
 * surface a service-worker crash as a blank settings form instead of an error.
 */
import type { ConversationRecord, ConversationSummary, SaveHistoryResult } from "../core/history";
import type {
  ChatMessage,
  PortRequest,
  PortResponse,
  RuntimeRequest,
  SettingsStatus,
} from "../core/messaging";
import { CHAT_PORT_NAME } from "../core/messaging";
import { isRecord } from "../core/validate";
import { ext } from "../shared/ext";
import { readConversation, readConversations, readDraft, readGranted, readSaveResult, readUiState } from "./replies";
import { ChatError, type SaveSettingsResult, type SettingsDraft, type SettingsInput, type Shell, type StreamChatOptions } from "./types";

function streamChat(messages: ChatMessage[], { onDelta, signal }: StreamChatOptions): Promise<void> {
  if (signal.aborted) return Promise.reject(new ChatError("aborted", "cancelled before start"));

  const requestId = crypto.randomUUID();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const port = ext.runtime.connect({ name: CHAT_PORT_NAME });
  let settled = false;

  const finish = (outcome: () => void): void => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", onAbort);
    port.disconnect();
    outcome();
  };

  const onAbort = (): void => {
    const cancel: PortRequest = { type: "cancel", requestId };
    // The port may already be gone if the worker died; the reject below is what matters.
    try {
      port.postMessage(cancel);
    } catch {
      /* already disconnected */
    }
    finish(() => reject(new ChatError("aborted", "cancelled")));
  };

  port.onMessage.addListener((raw: unknown) => {
    if (!isRecord(raw) || raw.requestId !== requestId) return;
    const msg = raw as PortResponse;
    switch (msg.type) {
      case "delta":
        onDelta(msg.text);
        return;
      case "done":
        finish(resolve);
        return;
      case "error":
        finish(() => reject(new ChatError(msg.code, msg.message)));
        return;
    }
  });

  port.onDisconnect.addListener(() => {
    const detail = ext.runtime.lastError?.message ?? "background disconnected before completion";
    finish(() => reject(new ChatError("provider", detail)));
  });

  signal.addEventListener("abort", onAbort, { once: true });
  const request: PortRequest = { type: "chat", requestId, messages };
  port.postMessage(request);
  return promise;
}

/** One round trip to the worker. A dead listener resolves with `undefined`, hence the guard. */
async function call(request: RuntimeRequest): Promise<Record<string, unknown>> {
  const reply: unknown = await ext.runtime.sendMessage(request);
  if (!isRecord(reply)) throw new Error(`background returned no reply to ${request.type}`);
  return reply;
}

async function settingsStatus(): Promise<SettingsStatus> {
  const reply = await call({ type: "settings-status" });
  if (typeof reply.configured !== "boolean") throw new Error("background returned no settings status");
  return reply as unknown as SettingsStatus;
}

async function loadSettings(): Promise<SettingsDraft | null> {
  return readDraft(await call({ type: "load-settings" }), "background");
}

async function saveSettings(input: SettingsInput): Promise<SaveSettingsResult> {
  return readSaveResult(await call({ type: "save-settings", input }), "background");
}

async function requestAccess(origin: string): Promise<boolean> {
  return readGranted(await call({ type: "request-access", origin }), "background");
}

async function loadUiState(): Promise<Record<string, unknown>> {
  return readUiState(await call({ type: "load-ui-state" }));
}

async function saveUiState(state: Record<string, unknown>): Promise<void> {
  await call({ type: "save-ui-state", state });
}

async function openOptions(): Promise<void> {
  await call({ type: "open-options" });
}

async function listConversations(): Promise<ConversationSummary[]> {
  return readConversations(await call({ type: "list-conversations" }), "background");
}

async function loadConversation(id: string): Promise<ConversationRecord | null> {
  return readConversation(await call({ type: "load-conversation", id }), "background");
}

/**
 * The save reply is the settings save shape (`{ok}` plus an error sentence), so it is read
 * with the same validator rather than a second copy of it; history has no `grantOrigin`,
 * and a host that sent one would simply be ignored by the caller's type.
 */
async function saveConversation(record: ConversationRecord): Promise<SaveHistoryResult> {
  return readSaveResult(await call({ type: "save-conversation", record }), "background");
}

async function deleteConversation(id: string): Promise<void> {
  await call({ type: "delete-conversation", id });
}

async function clearConversations(): Promise<void> {
  await call({ type: "clear-conversations" });
}

export function createExtensionShell(): Shell {
  return {
    streamChat,
    settingsStatus,
    loadSettings,
    saveSettings,
    requestAccess,
    openOptions,
    loadUiState,
    saveUiState,
    listConversations,
    loadConversation,
    saveConversation,
    deleteConversation,
    clearConversations,
    // The panel runs in the isolated world: Discord's JS cannot read what is typed into it,
    // so the settings view may take the key without the warning the desktop host needs.
    capabilities: { keyIsPageVisible: false, canOpenOptionsPage: true },
    keyStorageHint: "Stored with the extension on this machine (chrome.storage.local, never synced).",
  };
}
