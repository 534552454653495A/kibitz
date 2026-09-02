/**
 * Panel-side client for the streaming chat protocol (core/messaging.ts).
 *
 * One Port per request, not one long-lived Port for the panel's lifetime: an MV3 service
 * worker may be terminated between two answers, and a Port that died with it looks
 * connected until the first postMessage throws. Connecting per request keeps the worker
 * alive exactly as long as one answer takes and turns "worker died" into a clean reject.
 */
import type { ChatErrorCode, ChatMessage, PortRequest, PortResponse } from "../../core/messaging";
import { CHAT_PORT_NAME } from "../../core/messaging";
import { isRecord } from "../../core/validate";
import { ext } from "../../shared/ext";

export class ChatError extends Error {
  override readonly name = "ChatError";
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface StreamChatOptions {
  onDelta: (text: string) => void;
  signal: AbortSignal;
}

export function streamChat(messages: ChatMessage[], { onDelta, signal }: StreamChatOptions): Promise<void> {
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
