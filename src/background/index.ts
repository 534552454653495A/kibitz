/**
 * Service worker entry: the only place that holds the API key and talks to LLM APIs
 * (AGENTS.md 3.4). Pure listener wiring — every listener is registered synchronously at
 * top level because MV3 workers are started on demand and Chrome only replays events
 * to listeners that exist by the end of the first turn.
 */
import { CHAT_PORT_NAME, type RuntimeRequest, type RuntimeResponse } from "../core/messaging";
import { isRecord } from "../core/validate";
import { ext } from "../shared/ext";
import { log } from "../shared/log";
import { loadSettings } from "../shared/settings";
import { attachChatPort } from "./chat-session";

const RUNTIME_HANDLERS: Record<RuntimeRequest["type"], () => Promise<RuntimeResponse>> = {
  // Deliberately redacted: the content script shares a tab with a site we do not
  // control, so it only ever learns *whether* a key exists, never the key or base URL.
  "settings-status": async () => {
    const settings = await loadSettings();
    return settings === null
      ? { configured: false }
      : { configured: true, provider: settings.provider, model: settings.model };
  },
  "open-options": async () => {
    await ext.runtime.openOptionsPage();
    return { ok: true };
  },
};

ext.action.onClicked.addListener(() => {
  void ext.runtime.openOptionsPage();
});

ext.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (response: RuntimeResponse) => void) => {
  if (!isRecord(message) || typeof message.type !== "string" || !(message.type in RUNTIME_HANDLERS)) {
    log.warn("ignoring unknown runtime message");
    return false;
  }
  RUNTIME_HANDLERS[message.type as RuntimeRequest["type"]]().then(sendResponse, (err: unknown) => {
    log.error("runtime message failed", err);
  });
  // `true` keeps the sendResponse channel open across the await above.
  return true;
});

ext.runtime.onConnect.addListener((port) => {
  if (port.name !== CHAT_PORT_NAME) return;
  attachChatPort(port);
});

log.debug(`background ${__KIBITZ_VERSION__} ready`);
