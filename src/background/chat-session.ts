/**
 * One chat Port = one session: the request/cancel state machine behind CHAT_PORT_NAME.
 *
 * Kept apart from the service-worker entry so the entry is only listener wiring. The
 * key decision here is the error-code mapping: the panel decides what to show (an
 * "open options" button, a "retry" button, a plain message) from `code` alone, so every
 * failure must land on exactly one ChatErrorCode, and classification is by error class
 * or abort state — never by matching message text, which providers change freely.
 */
import type { ChatErrorCode, ChatRequest, PortRequest, PortResponse } from "../core/messaging";
import { isRecord } from "../core/validate";
import { ext } from "../shared/ext";
import { log } from "../shared/log";
import { loadSettings, originPattern } from "../shared/settings";
import { createProvider, ProviderHttpError, ProviderStreamError } from "./providers";

interface PortError {
  code: ChatErrorCode;
  message: string;
}

export function classifyError(err: unknown, aborted: boolean): PortError {
  // The abort check comes first: an aborted fetch may surface as AbortError, as a
  // stream read failure, or as nothing at all — the signal is the ground truth.
  if (aborted || (err instanceof Error && err.name === "AbortError")) {
    return { code: "aborted", message: "Request cancelled." };
  }
  if (err instanceof ProviderHttpError) return { code: "http", message: `HTTP ${err.status}: ${err.bodyExcerpt}` };
  if (err instanceof ProviderStreamError) return { code: "provider", message: err.message };
  // fetch() rejects with a TypeError for everything that never produced a response:
  // offline, DNS, a CORS block, or a host permission that was revoked after saving.
  if (err instanceof TypeError) {
    return {
      code: "network",
      message: `Could not reach the provider (${err.message}). Check that you are online, that the base URL is right, and that host permission was granted when you saved settings.`,
    };
  }
  return { code: "provider", message: err instanceof Error ? err.message : String(err) };
}

function parseRequest(raw: unknown): PortRequest | null {
  if (!isRecord(raw) || typeof raw.requestId !== "string") return null;
  if (raw.type === "cancel") return { type: "cancel", requestId: raw.requestId };
  if (raw.type === "chat" && Array.isArray(raw.messages)) {
    return { type: "chat", requestId: raw.requestId, messages: raw.messages as ChatRequest["messages"] };
  }
  return null;
}

export function attachChatPort(port: chrome.runtime.Port): void {
  const inflight = new Map<string, AbortController>();

  const post = (response: PortResponse): void => {
    // The panel may have been torn down (tab navigated, page reloaded) while a stream
    // was still producing; a closed port throws and there is nobody left to tell.
    try {
      port.postMessage(response);
    } catch (err) {
      log.debug("postMessage on closed port", err);
    }
  };

  const runChat = async (request: ChatRequest): Promise<void> => {
    const { requestId } = request;
    const controller = new AbortController();
    inflight.set(requestId, controller);
    try {
      const settings = await loadSettings();
      if (settings === null) {
        post({ type: "error", requestId, code: "no-settings", message: "No API key configured. Open Kibitz settings to add one." });
        return;
      }
      const granted = await ext.permissions.contains({ origins: [originPattern(settings.baseUrl)] });
      if (!granted) {
        post({
          type: "error",
          requestId,
          code: "no-permission",
          message: `Kibitz has no permission to contact ${new URL(settings.baseUrl).origin}. Open settings and save again to grant it.`,
        });
        return;
      }
      for await (const text of createProvider(settings).stream(request.messages, controller.signal)) {
        if (controller.signal.aborted) break;
        post({ type: "delta", requestId, text });
      }
      if (controller.signal.aborted) {
        post({ type: "error", requestId, code: "aborted", message: "Request cancelled." });
      } else {
        post({ type: "done", requestId });
      }
    } catch (err) {
      const mapped = classifyError(err, controller.signal.aborted);
      if (mapped.code !== "aborted") log.warn("chat failed", mapped.code, mapped.message);
      post({ type: "error", requestId, ...mapped });
    } finally {
      inflight.delete(requestId);
    }
  };

  port.onMessage.addListener((raw: unknown) => {
    const request = parseRequest(raw);
    if (request === null) {
      log.warn("ignoring malformed port message");
      return;
    }
    if (request.type === "cancel") {
      inflight.get(request.requestId)?.abort();
      return;
    }
    void runChat(request);
  });

  port.onDisconnect.addListener(() => {
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
  });
}
