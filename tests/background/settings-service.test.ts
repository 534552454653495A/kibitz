import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDraft, loadUiState, saveDraft, saveUiState } from "../../src/background/settings-service";
import type { Settings } from "../../src/core/settings";

// A stand-in for chrome.storage.local + chrome.permissions, installed before shared/ext.ts
// evaluates `chrome` at import time (hence vi.hoisted). The store is the assertion target:
// what ends up under which key is the contract, not which API call was made.
const fakeChrome = vi.hoisted(() => {
  const state = { store: {} as Record<string, unknown>, granted: [] as string[] };
  Object.assign(globalThis, {
    chrome: {
      storage: {
        local: {
          get: (key: string) => Promise.resolve(key in state.store ? { [key]: state.store[key] } : {}),
          set: (items: Record<string, unknown>) => {
            Object.assign(state.store, items);
            return Promise.resolve();
          },
        },
      },
      permissions: {
        contains: ({ origins }: { origins: string[] }) => Promise.resolve(origins.every((o) => state.granted.includes(o))),
      },
    },
  });
  return state;
});

const STORED: Settings = {
  provider: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-stored",
  model: "gpt-4o-mini",
};

const stored = (): Settings | undefined => fakeChrome.store.settings as Settings | undefined;

beforeEach(() => {
  fakeChrome.store = {};
  fakeChrome.granted = [];
});

describe("loadDraft", () => {
  it("never puts the stored key in the draft the panel receives", async () => {
    fakeChrome.store.settings = STORED;
    const draft = await loadDraft();
    expect(draft).toEqual({ provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", hasKey: true });
    expect(JSON.stringify(draft)).not.toContain("sk-stored");
  });

  it("is null when nothing usable is stored, so the panel opens its empty form", async () => {
    expect(await loadDraft()).toBeNull();
    fakeChrome.store.settings = { ...STORED, apiKey: "" };
    expect(await loadDraft()).toBeNull();
  });
});

describe("saveDraft", () => {
  it("keeps the stored key when the user edits the model without retyping it", async () => {
    fakeChrome.store.settings = STORED;
    fakeChrome.granted = ["https://api.openai.com/*"];
    const result = await saveDraft({ provider: "openai-compatible", baseUrl: STORED.baseUrl, model: "gpt-5", apiKey: "" });
    expect(result).toEqual({ ok: true });
    expect(stored()).toEqual({ ...STORED, model: "gpt-5" });
  });

  it("refuses and stores nothing when no key is typed and none is stored", async () => {
    const result = await saveDraft({ provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "m", apiKey: "" });
    expect(result).toEqual({ ok: false, error: "An API key is required." });
    expect(stored()).toBeUndefined();
  });

  it("rejects a base URL parseSettings cannot use and leaves the previous settings intact", async () => {
    fakeChrome.store.settings = STORED;
    const result = await saveDraft({ provider: "openai-compatible", baseUrl: "api.openai.com", model: "m", apiKey: "sk-new" });
    expect(result).toEqual({
      ok: false,
      error: "Base URL must be a full http(s) URL, for example https://api.openai.com/v1.",
    });
    expect(stored()).toEqual(STORED);
  });

  it("rejects an empty model before touching storage", async () => {
    const result = await saveDraft({ provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "  ", apiKey: "sk-new" });
    expect(result).toEqual({ ok: false, error: "A model name is required." });
    expect(stored()).toBeUndefined();
  });

  it("persists the settings even when the origin is not granted yet, and reports the pattern to request", async () => {
    const result = await saveDraft({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude",
      apiKey: "sk-new",
    });
    expect(result).toEqual({
      ok: false,
      error: "Settings saved. Chrome must approve access to https://api.anthropic.com/* before Kibitz can use it.",
      grantOrigin: "https://api.anthropic.com/*",
    });
    expect(stored()).toEqual({ provider: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-new", model: "claude" });
  });
});

describe("ui state", () => {
  it("stores preferences under their own key so a save cannot overwrite the settings", async () => {
    fakeChrome.store.settings = STORED;
    await saveUiState({ panelLayout: { mode: "float", x: 12 } });
    expect(fakeChrome.store).toEqual({ settings: STORED, uiState: { panelLayout: { mode: "float", x: 12 } } });
  });

  it("returns {} rather than a non-object left in storage by an older build", async () => {
    expect(await loadUiState()).toEqual({});
    fakeChrome.store.uiState = "left";
    expect(await loadUiState()).toEqual({});
  });

  it("round-trips the stored blob", async () => {
    await saveUiState({ view: "settings", expanded: true });
    expect(await loadUiState()).toEqual({ view: "settings", expanded: true });
  });
});
