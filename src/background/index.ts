/**
 * Service worker entry: the only place that holds the API key and talks to LLM APIs
 * (AGENTS.md 3.4). Pure listener wiring — every listener is registered synchronously at
 * top level because MV3 workers are started on demand and Chrome only replays events
 * to listeners that exist by the end of the first turn.
 *
 * Requests are validated before dispatch, like the companion validates its own (see
 * desktop/request-handler.ts): `runtime.onMessage` is reachable from any extension page,
 * so "the panel would never send that" is not a guarantee this side may rely on.
 *
 * `request-access` is the odd one out. Chrome grants an optional host permission only from
 * a user gesture in an extension page, and a service worker has neither, so this handler
 * cannot prompt — it opens the options page in grant mode, where one button click can, and
 * answers `{granted:false}` at once. The panel then tells the user to finish there and save
 * again; pretending to have granted would strand the next request on a silent failure.
 */
import {
  CHAT_PORT_NAME,
  type RuntimeRequest,
  type RuntimeResponse,
  type SettingsInputMessage,
} from "../core/messaging";
import { isRecord } from "../core/validate";
import { ext } from "../shared/ext";
import { log } from "../shared/log";
import { loadSettings } from "../shared/settings";
import { attachChatPort } from "./chat-session";
import { loadDraft, loadUiState, saveDraft, saveUiState } from "./settings-service";

/** Big enough for the sentence and the button, small enough to read as a prompt, not a page. */
const GRANT_WINDOW = { width: 460, height: 340 } as const;

function parseInput(value: unknown): SettingsInputMessage | null {
  if (!isRecord(value)) return null;
  const { provider, baseUrl, model, apiKey, sendImages } = value;
  if (typeof provider !== "string" || typeof baseUrl !== "string" || typeof model !== "string" || typeof apiKey !== "string") {
    return null;
  }
  // A panel from before the image toggle sends no `sendImages`; `mergeSettingsInput` reads
  // that absence as "on" instead of turning the feature off behind the user's back.
  return typeof sendImages === "boolean" ? { provider, baseUrl, model, apiKey, sendImages } : { provider, baseUrl, model, apiKey };
}

function parseRequest(message: unknown): RuntimeRequest | null {
  if (!isRecord(message)) return null;
  switch (message.type) {
    case "open-options":
    case "settings-status":
    case "load-settings":
    case "load-ui-state":
      return { type: message.type };
    case "save-settings": {
      const input = parseInput(message.input);
      return input === null ? null : { type: "save-settings", input };
    }
    case "request-access":
      return typeof message.origin === "string" ? { type: "request-access", origin: message.origin } : null;
    case "save-ui-state":
      return isRecord(message.state) ? { type: "save-ui-state", state: message.state } : null;
    default:
      return null;
  }
}

async function dispatch(request: RuntimeRequest): Promise<RuntimeResponse> {
  switch (request.type) {
    // Deliberately redacted: the content script shares a tab with a site we do not
    // control, so it only ever learns *whether* a key exists, never the key or base URL.
    case "settings-status": {
      const settings = await loadSettings();
      return settings === null
        ? { configured: false }
        : { configured: true, provider: settings.provider, model: settings.model };
    }
    case "load-settings":
      return { draft: await loadDraft() };
    case "save-settings":
      return await saveDraft(request.input);
    case "request-access": {
      log.info(`opening the grant window for ${request.origin}`);
      await ext.windows.create({
        url: ext.runtime.getURL(`options.html?grant=${encodeURIComponent(request.origin)}`),
        type: "popup",
        ...GRANT_WINDOW,
      });
      return { granted: false };
    }
    case "load-ui-state":
      return { state: await loadUiState() };
    case "save-ui-state":
      await saveUiState(request.state);
      return { ok: true };
    case "open-options":
      await ext.runtime.openOptionsPage();
      return { ok: true };
  }
}

ext.action.onClicked.addListener(() => {
  void ext.runtime.openOptionsPage();
});

ext.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (response: RuntimeResponse) => void) => {
  const request = parseRequest(message);
  if (request === null) {
    log.warn("ignoring unknown runtime message");
    return false;
  }
  dispatch(request).then(sendResponse, (err: unknown) => {
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
