// @vitest-environment jsdom
import { render } from "preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_PRESETS } from "../../../src/core/settings";
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
  };
}

const DRAFT: SettingsDraft = {
  provider: "openai-compatible",
  baseUrl: PROVIDER_PRESETS["openai-compatible"].baseUrl,
  model: PROVIDER_PRESETS["openai-compatible"].model,
  hasKey: true,
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
});
