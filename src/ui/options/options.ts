/**
 * Options page logic: provider/base URL/key/model form, host-permission grant, and a
 * "Test" round-trip through the real chat Port. Also the extension's grant surface: opened
 * as `options.html?grant=<pattern>` it shows one button and nothing else.
 *
 * The one non-obvious decision is in both grant paths: `permissions.request` is called
 * synchronously, before the first `await`, because Chrome only honours the request while
 * a user gesture is active and an intervening await can end that gesture — the prompt
 * then silently never appears and every later chat fails with "no-permission". That is
 * also why the panel cannot ask for itself: a content script has no permissions API and
 * the service worker has no gesture, so the request has to happen on a page like this one.
 * The key is never logged, never echoed into the status line, and never sent anywhere
 * but chrome.storage.local.
 */
import { CHAT_PORT_NAME, type PortResponse } from "../../core/messaging";
import { ext } from "../../shared/ext";
import { log } from "../../shared/log";
import { originPattern, PROVIDER_IDS, PROVIDER_PRESETS, type ProviderId, type Settings } from "../../core/settings";
import { loadSettings, saveSettings } from "../../shared/settings";

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`options.html is missing #${id}`);
  return element as T;
}

const els = {
  form: requireElement<HTMLFormElement>("settings-form"),
  provider: requireElement<HTMLSelectElement>("provider"),
  providerHint: requireElement<HTMLParagraphElement>("provider-hint"),
  baseUrl: requireElement<HTMLInputElement>("base-url"),
  apiKey: requireElement<HTMLInputElement>("api-key"),
  model: requireElement<HTMLInputElement>("model"),
  save: requireElement<HTMLButtonElement>("save"),
  test: requireElement<HTMLButtonElement>("test"),
  permission: requireElement<HTMLSpanElement>("permission"),
  status: requireElement<HTMLParagraphElement>("status"),
  testOutput: requireElement<HTMLPreElement>("test-output"),
  settingsView: requireElement<HTMLElement>("settings-view"),
  grantView: requireElement<HTMLElement>("grant-view"),
  grantOrigin: requireElement<HTMLParagraphElement>("grant-origin"),
  grant: requireElement<HTMLButtonElement>("grant"),
  grantStatus: requireElement<HTMLParagraphElement>("grant-status"),
};

function selectedProvider(): ProviderId {
  const value = els.provider.value;
  return PROVIDER_IDS.includes(value as ProviderId) ? (value as ProviderId) : PROVIDER_IDS[0]!;
}

function setStatus(text: string, kind: "info" | "ok" | "error" = "info"): void {
  els.status.textContent = text;
  els.status.dataset.kind = kind;
}

function showPermission(state: "granted" | "missing" | "unknown"): void {
  els.permission.dataset.granted = state;
  els.permission.textContent = {
    granted: "Permission: granted for this origin",
    missing: "Permission: not granted — Save to request it",
    unknown: "Permission: enter a valid base URL",
  }[state];
}

async function refreshPermission(): Promise<void> {
  let pattern: string;
  try {
    pattern = originPattern(els.baseUrl.value.trim());
  } catch {
    showPermission("unknown");
    return;
  }
  const granted = await ext.permissions.contains({ origins: [pattern] });
  showPermission(granted ? "granted" : "missing");
}

function applyProvider(next: ProviderId, previous: ProviderId | null): void {
  const preset = PROVIDER_PRESETS[next];
  els.providerHint.textContent = preset.hint;
  // Only overwrite fields the user has not customised: an empty field, or one still
  // holding the previous preset's value, is safe to replace; anything else is theirs.
  const old = previous === null ? null : PROVIDER_PRESETS[previous];
  if (els.baseUrl.value === "" || (old !== null && els.baseUrl.value === old.baseUrl)) els.baseUrl.value = preset.baseUrl;
  if (els.model.value === "" || (old !== null && els.model.value === old.model)) els.model.value = preset.model;
}

function readForm(): { settings: Settings; pattern: string } | null {
  const baseUrl = els.baseUrl.value.trim();
  const apiKey = els.apiKey.value.trim();
  const model = els.model.value.trim();
  let pattern: string;
  try {
    pattern = originPattern(baseUrl);
  } catch (err) {
    setStatus(`Base URL is not a valid http(s) URL${err instanceof Error ? ` (${err.message})` : ""}.`, "error");
    els.baseUrl.focus();
    return null;
  }
  if (apiKey.length === 0) {
    setStatus("API key is required.", "error");
    els.apiKey.focus();
    return null;
  }
  if (model.length === 0) {
    setStatus("Model is required.", "error");
    els.model.focus();
    return null;
  }
  return { settings: { provider: selectedProvider(), baseUrl, apiKey, model }, pattern };
}

function onSave(event: SubmitEvent): void {
  event.preventDefault();
  const form = readForm();
  if (form === null) return;
  // Must run before any await: see the file header for why.
  const grant = ext.permissions.request({ origins: [form.pattern] });
  els.save.disabled = true;
  setStatus("Saving…");
  void (async () => {
    try {
      const granted = await grant;
      await saveSettings(form.settings);
      showPermission(granted ? "granted" : "missing");
      setStatus(
        granted
          ? "Saved. Host permission granted."
          : "Saved, but host permission was declined — requests will fail until you Save again and allow it.",
        granted ? "ok" : "error",
      );
    } catch (err) {
      log.error("save failed", err);
      setStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      els.save.disabled = false;
    }
  })();
}

function onTest(): void {
  const requestId = crypto.randomUUID();
  const port = ext.runtime.connect({ name: CHAT_PORT_NAME });
  els.test.disabled = true;
  els.testOutput.hidden = false;
  els.testOutput.textContent = "";
  setStatus("Testing… (uses the saved settings, not unsaved edits)");

  const finish = (): void => {
    els.test.disabled = false;
    port.disconnect();
  };
  port.onMessage.addListener((raw: unknown) => {
    const response = raw as PortResponse;
    if (response.requestId !== requestId) return;
    if (response.type === "delta") {
      els.testOutput.textContent += response.text;
      return;
    }
    if (response.type === "done") {
      setStatus("Test succeeded.", "ok");
    } else {
      setStatus(`Test failed (${response.code}): ${response.message}`, "error");
    }
    finish();
  });
  port.onDisconnect.addListener(() => {
    els.test.disabled = false;
  });
  port.postMessage({ type: "chat", requestId, messages: [{ role: "user", content: "Reply with the single word OK." }] });
}

/**
 * Grant mode: one sentence, one button, then the window closes itself. The pattern comes
 * from the URL the background built, and is re-parsed here so a hand-edited link cannot
 * make us request an origin the user never configured.
 */
function initGrant(requested: string): void {
  let pattern: string;
  try {
    pattern = originPattern(requested.endsWith("/*") ? requested.slice(0, -2) : requested);
  } catch {
    els.grantOrigin.textContent = requested;
    els.grantStatus.textContent = "That is not an address Kibitz can ask for. Reopen the settings and check the base URL.";
    els.grantStatus.dataset.kind = "error";
    els.grant.disabled = true;
    return;
  }
  els.grantOrigin.textContent = pattern;
  els.grant.addEventListener("click", () => {
    // Must run before any await: see the file header for why.
    const grant = ext.permissions.request({ origins: [pattern] });
    els.grant.disabled = true;
    void grant.then(
      (granted) => {
        if (granted) {
          window.close();
          return;
        }
        els.grant.disabled = false;
        els.grantStatus.textContent = "Chrome did not grant access. Kibitz cannot reach the API until it does.";
        els.grantStatus.dataset.kind = "error";
      },
      (err: unknown) => {
        els.grant.disabled = false;
        els.grantStatus.textContent = `Requesting access failed: ${err instanceof Error ? err.message : String(err)}`;
        els.grantStatus.dataset.kind = "error";
      },
    );
  });
}

async function init(): Promise<void> {
  for (const id of PROVIDER_IDS) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = PROVIDER_PRESETS[id].label;
    els.provider.append(option);
  }

  const saved = await loadSettings();
  let currentProvider: ProviderId = saved?.provider ?? PROVIDER_IDS[0]!;
  els.provider.value = currentProvider;
  if (saved !== null) {
    els.baseUrl.value = saved.baseUrl;
    els.apiKey.value = saved.apiKey;
    els.model.value = saved.model;
  }
  applyProvider(currentProvider, null);
  await refreshPermission();

  els.provider.addEventListener("change", () => {
    const next = selectedProvider();
    applyProvider(next, currentProvider);
    currentProvider = next;
    void refreshPermission();
  });
  els.baseUrl.addEventListener("change", () => void refreshPermission());
  els.form.addEventListener("submit", onSave);
  els.test.addEventListener("click", onTest);
}

const requestedGrant = new URLSearchParams(window.location.search).get("grant");
if (requestedGrant === null) {
  init().catch((err: unknown) => {
    log.error("options init failed", err);
    setStatus(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`, "error");
  });
} else {
  // A popup opened to answer one question: showing the whole form here would invite the
  // user to edit settings in a 460px window and lose the grant they came for.
  els.settingsView.hidden = true;
  els.grantView.hidden = false;
  initGrant(requestedGrant);
}
