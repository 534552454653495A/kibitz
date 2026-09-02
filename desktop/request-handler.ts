/**
 * The companion's side of the desktop protocol (src/shell/desktop-protocol.ts): one
 * handler per attached Discord window, answering DesktopRequests and pushing chat
 * deliveries back.
 *
 * Mirrors background/chat-session.ts minus the host-permission check (Node has no such
 * concept) and minus the Port: a chat request is answered `{ok:true}` at once and the
 * stream runs detached, because a CDP binding call is one request → one reply and holding
 * it open for a whole answer would stall the renderer's call queue.
 *
 * Settings are re-read through `deps.loadSettings` on every chat so `kibitz-desktop setup`
 * takes effect without restarting the companion.
 */
import { classifyError } from "../src/background/providers/errors";
import { createProvider } from "../src/background/providers/index";
import type { ChatRequest, SettingsStatus } from "../src/core/messaging";
import type { Settings } from "../src/core/settings";
import { isRecord } from "../src/core/validate";
import { log } from "../src/shared/log";
import type { DesktopDelivery, DesktopReply, DesktopRequest } from "../src/shell/desktop-protocol";

export interface RequestHandlerDeps {
  loadSettings: () => Promise<Settings | null>;
  /** Pushes one DesktopDelivery JSON string into the page. */
  deliver: (json: string) => Promise<unknown>;
  /** The desktop has no options page; the companion tells the user what to run instead. */
  openOptions: () => void;
}

export interface DesktopRequestHandler {
  /** DesktopRequest JSON in, DesktopReply JSON out. Never rejects: bad input is `{ok:false}`. */
  handle(json: string): Promise<string>;
  /** Cancels every in-flight chat; used when the window or the CDP connection goes away. */
  abortAll(): void;
}

export const NO_SETTINGS_MESSAGE = "No API key configured. Run `npm run desktop -- setup`, then reload Discord (Ctrl+R).";

function parseRequest(raw: unknown): DesktopRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.type === "settings-status" || raw.type === "open-options") return { type: raw.type };
  if (typeof raw.requestId !== "string") return null;
  if (raw.type === "cancel") return { type: "cancel", requestId: raw.requestId };
  if (raw.type === "chat" && Array.isArray(raw.messages)) {
    return { type: "chat", requestId: raw.requestId, messages: raw.messages as ChatRequest["messages"] };
  }
  return null;
}

export function createDesktopRequestHandler(deps: RequestHandlerDeps): DesktopRequestHandler {
  const inflight = new Map<string, AbortController>();

  const push = (delivery: DesktopDelivery): void => {
    // A delivery nobody receives (window closed mid-answer) is not an error worth surfacing.
    deps.deliver(JSON.stringify(delivery)).catch((err: unknown) => log.debug("delivery failed", err));
  };

  const runChat = async (request: ChatRequest): Promise<void> => {
    const { requestId } = request;
    const controller = new AbortController();
    inflight.set(requestId, controller);
    try {
      const settings = await deps.loadSettings();
      if (settings === null) {
        push({ type: "error", requestId, code: "no-settings", message: NO_SETTINGS_MESSAGE });
        return;
      }
      for await (const text of createProvider(settings).stream(request.messages, controller.signal)) {
        if (controller.signal.aborted) break;
        push({ type: "delta", requestId, text });
      }
      if (controller.signal.aborted) {
        push({ type: "error", requestId, code: "aborted", message: "Request cancelled." });
      } else {
        push({ type: "done", requestId });
      }
    } catch (err) {
      const mapped = classifyError(err, controller.signal.aborted);
      if (mapped.code !== "aborted") log.warn("chat failed", mapped.code, mapped.message);
      push({ type: "error", requestId, ...mapped });
    } finally {
      inflight.delete(requestId);
    }
  };

  const dispatch = async (request: DesktopRequest): Promise<DesktopReply> => {
    switch (request.type) {
      case "chat":
        void runChat(request);
        return { ok: true };
      case "cancel":
        inflight.get(request.requestId)?.abort();
        return { ok: true };
      case "settings-status": {
        // Redacted exactly like the extension: the page learns whether a key exists, never the key.
        const settings = await deps.loadSettings();
        const status: SettingsStatus =
          settings === null
            ? { configured: false }
            : { configured: true, provider: settings.provider, model: settings.model };
        return status;
      }
      case "open-options":
        deps.openOptions();
        return { ok: true };
    }
  };

  return {
    async handle(json: string): Promise<string> {
      let raw: unknown;
      try {
        raw = JSON.parse(json);
      } catch {
        return JSON.stringify({ ok: false, error: "request is not valid JSON" } satisfies DesktopReply);
      }
      const request = parseRequest(raw);
      if (request === null) {
        log.warn("ignoring malformed desktop request");
        return JSON.stringify({ ok: false, error: "malformed request" } satisfies DesktopReply);
      }
      try {
        return JSON.stringify(await dispatch(request));
      } catch (err) {
        log.error("desktop request failed", err);
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies DesktopReply);
      }
    },
    abortAll(): void {
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
    },
  };
}
