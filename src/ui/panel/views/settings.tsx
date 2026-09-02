/**
 * Settings, inside the panel. The owner's requirement was explicit: entering an API key
 * must not mean leaving Discord for a browser settings page.
 *
 * Consequences this file has to live with:
 *   - the form is local component state, seeded from the redacted draft the host sent
 *     (`hasKey` stands in for the key itself — the stored key never comes back to the UI);
 *   - an empty key field means "keep the stored one", so editing a base URL does not force
 *     the user to find their key again;
 *   - preset switching is a *suggestion*: it fills a field only when the field is empty or
 *     still holds the previous preset's value, so a hand-tuned URL is never overwritten;
 *   - the image toggle starts on when no draft has arrived yet, because that is what a
 *     configuration written before the field existed parses as; a checkbox that flashed
 *     "off" and then corrected itself would read as the setting having been lost;
 *   - on the desktop host the panel shares Discord's window, so the key is typed into a
 *     page Discord's own JS can read. That is a real risk and is stated in the UI rather
 *     than hidden behind a capability flag.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { PROVIDER_IDS, PROVIDER_PRESETS, type ProviderId } from "../../../core/settings";
import { ACTION_ATTR } from "../../../shared/dom-markers";
import type { SettingsDraft } from "../../../shell/types";
import type { PanelContext, PanelView } from "../views";

function SettingsView({ ctx }: { ctx: PanelContext }) {
  const { actions, capabilities, keyStorageHint } = ctx;
  const { draft, status, pendingGrant, busy } = ctx.model.settings;

  const [provider, setProvider] = useState<ProviderId>(draft?.provider ?? "openai-compatible");
  const [baseUrl, setBaseUrl] = useState(draft?.baseUrl ?? PROVIDER_PRESETS["openai-compatible"].baseUrl);
  const [model, setModel] = useState(draft?.model ?? PROVIDER_PRESETS["openai-compatible"].model);
  const [apiKey, setApiKey] = useState("");
  const [sendImages, setSendImages] = useState(draft?.sendImages ?? true);
  const [revealed, setRevealed] = useState(false);

  // The initial state above already carries whatever draft existed at mount, so the effect
  // must only react to a draft that ARRIVES later (the host answers `load-settings` a round
  // trip after the view opens, and `save-settings` produces a fresh one). Re-seeding on
  // every run would fight the user's typing — that race really happens: the effect fires
  // after the first paint, i.e. after the first keystroke is possible.
  const adopted = useRef<SettingsDraft | null | undefined>(undefined);
  if (adopted.current === undefined) adopted.current = draft;
  useEffect(() => {
    if (draft === null || draft === adopted.current) return;
    adopted.current = draft;
    setProvider(draft.provider);
    setBaseUrl(draft.baseUrl);
    setModel(draft.model);
    setSendImages(draft.sendImages);
    // A key that was just saved must not linger in the DOM; the placeholder takes over.
    if (draft.hasKey) setApiKey("");
  }, [draft]);

  const preset = PROVIDER_PRESETS[provider];
  /**
   * Functional updates, not the rendered values: a keystroke and this change event can land
   * in the same frame, and reading `baseUrl` from the closure would then compare against a
   * value the user has already replaced and overwrite their URL.
   */
  const switchProvider = (next: ProviderId): void => {
    const from = PROVIDER_PRESETS[provider];
    const to = PROVIDER_PRESETS[next];
    setBaseUrl((current) => (current === "" || current === from.baseUrl ? to.baseUrl : current));
    setModel((current) => (current === "" || current === from.model ? to.model : current));
    setProvider(next);
  };

  return (
    <div class="view settings">
      <label class="field">
        <span>Provider</span>
        <select
          value={provider}
          onChange={(event) => switchProvider(event.currentTarget.value as ProviderId)}
        >
          {PROVIDER_IDS.map((id) => (
            <option value={id} key={id}>
              {PROVIDER_PRESETS[id].label}
            </option>
          ))}
        </select>
        <small>{preset.hint}</small>
      </label>

      <label class="field">
        <span>Base URL</span>
        <input type="url" value={baseUrl} spellcheck={false} onInput={(e) => setBaseUrl(e.currentTarget.value)} />
      </label>

      <label class="field">
        <span>API key</span>
        <span class="key-row">
          <input
            type={revealed ? "text" : "password"}
            value={apiKey}
            autocomplete="off"
            spellcheck={false}
            placeholder={draft?.hasKey === true ? "leave empty to keep the stored key" : "sk-…"}
            onInput={(event) => setApiKey(event.currentTarget.value)}
          />
          <button
            class="button"
            {...{ [ACTION_ATTR]: "reveal-key" }}
            title={revealed ? "Hide the key" : "Show the key"}
            aria-pressed={revealed}
            onClick={() => setRevealed(!revealed)}
          >
            {revealed ? "Hide" : "Show"}
          </button>
        </span>
        <small>{keyStorageHint}</small>
      </label>

      {capabilities.keyIsPageVisible && (
        <p class="warning">
          This window is Discord's own: JavaScript running in it could read a key typed here.
          For a key you cannot afford to leak, use <code>kibitz-desktop setup</code> in a terminal instead.
        </p>
      )}

      <label class="field">
        <span>Model</span>
        <input type="text" value={model} spellcheck={false} onInput={(e) => setModel(e.currentTarget.value)} />
      </label>

      <label class="field">
        <span class="check-row">
          <input type="checkbox" checked={sendImages} onChange={(event) => setSendImages(event.currentTarget.checked)} />
          <span>Send images to the model</span>
        </span>
        <small>
          Image attachments are sent to the API above as a link to Discord's CDN. Needs a
          vision-capable model.
        </small>
      </label>

      <div class="toolbar">
        <button
          class="button primary"
          {...{ [ACTION_ATTR]: "save-settings" }}
          disabled={busy}
          onClick={() => void actions.saveSettings({ provider, baseUrl, model, apiKey, sendImages })}
        >
          Save
        </button>
        <button class="button" {...{ [ACTION_ATTR]: "test-settings" }} disabled={busy} onClick={actions.testSettings}>
          Test
        </button>
        <span class="spacer" />
        {capabilities.canOpenOptionsPage && (
          <button class="link" {...{ [ACTION_ATTR]: "open-options" }} onClick={actions.openOptions}>
            Full settings page
          </button>
        )}
      </div>

      {status !== null && <p class="status">{status}</p>}

      {pendingGrant !== null && (
        <div class="cta">
          <p>
            Kibitz has no permission to talk to <code>{pendingGrant}</code> yet. Chrome must ask you first.
          </p>
          <button
            class="button primary"
            {...{ [ACTION_ATTR]: "grant-access" }}
            onClick={() => actions.requestAccess(pendingGrant)}
          >
            Grant access
          </button>
        </div>
      )}
    </div>
  );
}

export const settingsView: PanelView = {
  id: "settings",
  title: "Settings",
  icon: "⚙",
  available: () => true,
  render: (ctx) => <SettingsView ctx={ctx} />,
};
