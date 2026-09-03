// @vitest-environment jsdom
import { render } from "preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_LANGUAGE, LANGUAGE_PRESETS, PROVIDER_PRESETS } from "../../../src/core/settings";
import { ACTION_ATTR } from "../../../src/shared/dom-markers";
import type { SettingsDraft, ShellCapabilities } from "../../../src/shell/types";
import type { PanelActions } from "../../../src/ui/panel/actions";
import { INITIAL, type SettingsModel } from "../../../src/ui/panel/state";
import { settingsView } from "../../../src/ui/panel/views/settings";

/**
 * The view is rendered directly against a stub context: it must be usable without a shell,
 * a shadow host or a mounted panel, because that is exactly the seam PanelView promises.
 */
function stubActions(): PanelActions {
  return {
    send: vi.fn(),
    scan: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
    close: vi.fn(),
    showView: vi.fn(),
    saveSettings: vi.fn(() => Promise.resolve()),
    testSettings: vi.fn(),
    requestAccess: vi.fn(),
    openOptions: vi.fn(),
    setLayout: vi.fn(),
    toggleExpanded: vi.fn(),
    resetLayout: vi.fn(),
    copyTurn: vi.fn(),
    searchConversations: vi.fn(),
    askConversations: vi.fn(),
    openConversation: vi.fn(),
    deleteConversation: vi.fn(),
    confirmClearConversations: vi.fn(),
    clearConversations: vi.fn(),
  };
}

const DRAFT: SettingsDraft = {
  provider: "openai-compatible",
  baseUrl: PROVIDER_PRESETS["openai-compatible"].baseUrl,
  model: PROVIDER_PRESETS["openai-compatible"].model,
  hasKey: true,
  sendImages: true,
  language: AUTO_LANGUAGE,
};

let container: HTMLElement;
let actions: PanelActions;

interface ShowOptions {
  settings?: Partial<SettingsModel>;
  capabilities?: Partial<ShellCapabilities>;
}

function show(options: ShowOptions = {}): HTMLElement {
  const settings: SettingsModel = { draft: DRAFT, status: null, pendingGrant: null, busy: false, ...options.settings };
  render(
    settingsView.render({
      model: { ...INITIAL, status: "ready", view: "settings", settings },
      actions,
      platform: "discord",
      capabilities: { keyIsPageVisible: false, canOpenOptionsPage: true, ...options.capabilities },
      keyStorageHint: "Stored on this machine.",
    }),
    container,
  );
  return container;
}

const field = (selector: string): HTMLInputElement => {
  const el = container.querySelector<HTMLInputElement>(selector);
  if (el === null) throw new Error(`no ${selector}`);
  return el;
};
const act = (name: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[${ACTION_ATTR}="${name}"]`);
  if (el === null) throw new Error(`action ${name} missing`);
  return el;
};
const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string, event: "input" | "change"): void => {
  el.value = value;
  el.dispatchEvent(new Event(event, { bubbles: true }));
};

/**
 * The answer-language select is found by the option it must offer rather than by position,
 * so adding another dropdown to the form does not silently retarget these tests.
 */
const languageSelect = (): HTMLSelectElement => {
  const el = [...container.querySelectorAll("select")].find(
    (candidate) => candidate.querySelector(`option[value="${AUTO_LANGUAGE}"]`) !== null,
  );
  if (el === undefined) throw new Error("no answer-language select");
  return el;
};
const customLanguage = (): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>('input[aria-label="Custom answer language"]');

beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("main");
  document.body.append(container);
  actions = stubActions();
});

describe("settings view", () => {
  it("keeps a stored key out of the DOM and says the field may be left empty", () => {
    show();
    const key = field('input[type="password"]');
    expect(key.value).toBe("");
    expect(key.placeholder).toBe("leave empty to keep the stored key");
  });

  it("asks for a key outright when the host has none stored", () => {
    show({ settings: { draft: { ...DRAFT, hasKey: false } } });
    expect(field('input[type="password"]').placeholder).not.toContain("keep");
  });

  it("reveals and re-hides the key instead of leaving it permanently readable", async () => {
    show();
    act("reveal-key").click();
    await vi.waitFor(() => expect(container.querySelector('input[type="text"]')).not.toBeNull());
    act("reveal-key").click();
    await vi.waitFor(() => expect(container.querySelector('input[type="password"]')).not.toBeNull());
  });

  it("submits the edited fields with an empty key so a URL fix does not require retyping it", async () => {
    show();
    setValue(field('input[type="url"]'), "https://proxy.local/v1", "input");
    await vi.waitFor(() => expect(field('input[type="url"]').value).toBe("https://proxy.local/v1"));

    act("save-settings").click();

    expect(actions.saveSettings).toHaveBeenCalledWith({
      provider: "openai-compatible",
      baseUrl: "https://proxy.local/v1",
      model: PROVIDER_PRESETS["openai-compatible"].model,
      apiKey: "",
      sendImages: true,
      language: AUTO_LANGUAGE,
    });
  });

  it("fills the new provider's base URL and model when the fields still hold the old preset", async () => {
    show();
    const select = container.querySelector("select");
    if (select === null) throw new Error("no provider select");
    setValue(select, "anthropic", "change");

    await vi.waitFor(() => {
      expect(field('input[type="url"]').value).toBe(PROVIDER_PRESETS.anthropic.baseUrl);
      expect(field('input[type="text"]').value).toBe(PROVIDER_PRESETS.anthropic.model);
    });
  });

  it("never overwrites a base URL the user typed when the provider changes", async () => {
    show();
    setValue(field('input[type="url"]'), "https://my-gateway.internal/v1", "input");
    const select = container.querySelector("select");
    if (select === null) throw new Error("no provider select");
    setValue(select, "anthropic", "change");

    await vi.waitFor(() => expect(field('input[type="text"]').value).toBe(PROVIDER_PRESETS.anthropic.model));
    expect(field('input[type="url"]').value).toBe("https://my-gateway.internal/v1");
  });

  it("warns that the key is readable by the page only on hosts where it really is", () => {
    show({ capabilities: { keyIsPageVisible: true } });
    expect(container.textContent).toContain("kibitz-desktop setup");

    render(null, container);
    show({ capabilities: { keyIsPageVisible: false } });
    expect(container.textContent).not.toContain("kibitz-desktop setup");
  });

  it("routes the grant button to the exact origin the host asked permission for", () => {
    show({ settings: { pendingGrant: "https://api.anthropic.com/*", status: "needs permission" } });
    act("grant-access").click();
    expect(actions.requestAccess).toHaveBeenCalledWith("https://api.anthropic.com/*");
    expect(container.textContent).toContain("needs permission");
  });

  it("blocks a second save while one is in flight", () => {
    show({ settings: { busy: true } });
    expect(act("save-settings").hasAttribute("disabled")).toBe(true);
    expect(act("test-settings").hasAttribute("disabled")).toBe(true);
  });

  // The checkbox is the only way to turn image sending off from inside Discord, so it has to
  // show the stored policy and travel with the save — not silently re-enable it.
  it("shows the stored image policy instead of always starting ticked", () => {
    show({ settings: { draft: { ...DRAFT, sendImages: false } } });
    expect(field('input[type="checkbox"]').checked).toBe(false);
  });

  it("submits sendImages:false once the user unticks the box", async () => {
    show();
    const box = field('input[type="checkbox"]');
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(field('input[type="checkbox"]').checked).toBe(false));

    act("save-settings").click();

    expect(actions.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ sendImages: false }));
  });

  it("starts ticked when no draft has arrived, matching how an unset configuration parses", () => {
    show({ settings: { draft: null } });
    expect(field('input[type="checkbox"]').checked).toBe(true);
  });

  // The language is the only per-answer instruction the user can set from inside Discord, so
  // the form has to show what is stored and hand exactly that back on save.
  it("shows a stored preset language and submits it unchanged", () => {
    show({ settings: { draft: { ...DRAFT, language: "Türkçe" } } });
    expect(languageSelect().value).toBe("Türkçe");
    expect(customLanguage()).toBeNull();

    act("save-settings").click();

    expect(actions.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ language: "Türkçe" }));
  });

  it("submits auto once the user picks Auto, so answers follow the message again", async () => {
    show({ settings: { draft: { ...DRAFT, language: "Deutsch" } } });
    setValue(languageSelect(), AUTO_LANGUAGE, "change");
    await vi.waitFor(() => expect(languageSelect().value).toBe(AUTO_LANGUAGE));

    act("save-settings").click();

    expect(actions.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ language: AUTO_LANGUAGE }));
  });

  it("submits a language typed into the Other row after normalising it", async () => {
    show();
    setValue(languageSelect(), "__other__", "change");
    await vi.waitFor(() => expect(customLanguage()).not.toBeNull());
    const custom = customLanguage();
    if (custom === null) throw new Error("no custom language input");
    // Padding and doubled spaces are what a paste really produces; the saved label must not
    // carry them into the prompt line.
    setValue(custom, "  Türkçe,   samimi ton  ", "input");
    await vi.waitFor(() => expect(customLanguage()?.value).toBe("  Türkçe,   samimi ton  "));

    act("save-settings").click();

    expect(actions.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ language: "Türkçe, samimi ton" }));
  });

  // The regression that matters: a label the dropdown cannot show must not be quietly reset
  // to Auto by a save that was only meant to change the model.
  it("keeps a stored custom language through a save that edits another field", async () => {
    const custom = "Türkçe, samimi ton";
    expect(LANGUAGE_PRESETS).not.toContain(custom);
    show({ settings: { draft: { ...DRAFT, language: custom } } });
    expect(customLanguage()?.value).toBe(custom);

    setValue(field('input[type="text"]'), "gpt-9", "input");
    await vi.waitFor(() => expect(field('input[type="text"]').value).toBe("gpt-9"));

    act("save-settings").click();

    expect(actions.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-9", language: custom }));
  });

  it("submits auto when no draft has arrived, matching how an unset configuration parses", () => {
    show({ settings: { draft: null } });
    expect(languageSelect().value).toBe(AUTO_LANGUAGE);

    act("save-settings").click();

    expect(actions.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ language: AUTO_LANGUAGE }));
  });
});

// Failure mode defended, measured on live Discord (2026-09-03): the view asks the host for the
// draft when it opens, so the reply lands a round trip later. Anything the user changed in that
// window used to be overwritten by the reply, and Save then wrote the value they did not pick.
//
// Each case waits for an OBSERVABLE consequence of the adopt (an untouched field taking the
// draft's value, the key field clearing) before asserting. Preact runs effects after the
// render, so asserting straight away would pass whether the adopt ran or not - the first
// version of these tests did exactly that and proved nothing.
describe("settings view late draft", () => {
  it("keeps a language the user picked before the draft arrived, while adopting untouched fields", async () => {
    show({ settings: { draft: null } });
    setValue(languageSelect(), "Türkçe", "change");

    // The host answers now with the stored configuration: a different model, language auto.
    show({ settings: { draft: { ...DRAFT, model: "claude-sonnet-4-5", language: AUTO_LANGUAGE } } });
    await vi.waitFor(() => expect(field('input[type="text"]').value).toBe("claude-sonnet-4-5"));
    expect(languageSelect().value).toBe("Türkçe");

    act("save-settings").click();
    expect(actions.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ language: "Türkçe" }));
  });

  it("adopts the draft again after a save, so a saved key stops lingering in the field", async () => {
    show({ settings: { draft: { ...DRAFT, hasKey: false } } });
    setValue(field('input[type="password"]'), "sk-typed", "input");
    act("save-settings").click();

    // The save's own fresh draft: the key is stored now, so the field must be cleared.
    show({ settings: { draft: { ...DRAFT, hasKey: true } } });
    await vi.waitFor(() => expect(field('input[type="password"]').value).toBe(""));
  });
});
