/**
 * One chat Port = one session: the request/cancel state machine behind CHAT_PORT_NAME.
 *
 * Kept apart from the service-worker entry so the entry is only listener wiring. Error
 * classification is shared with the desktop companion (providers/errors.ts) so both
 * shells map a given failure to the same ChatErrorCode.
 */
import type { ChatRequest, PortRequest, PortResponse } from "../core/messaging";
import { originPattern } from "../core/settings";
import { isRecord } from "../core/validate";
import { ext } from "../shared/ext";
import { log } from "../shared/log";
import { loadSettings } from "../shared/settings";
import { createProvider } from "./providers";
import { classifyError } from "./providers/errors";

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
