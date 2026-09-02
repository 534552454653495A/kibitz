import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/core/messaging";
import { applyImagePolicy, mergeSettingsInput, originPattern, parseSettings, type Settings } from "../../src/core/settings";

// Failure mode defended: "configured" must mean the same thing for the extension
// (chrome.storage) and the desktop companion (settings.json). A value that passes here
// is one the providers can actually use; anything else must read as "not configured".
describe("parseSettings", () => {
  const valid = { provider: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", model: "claude-sonnet-4-5" };

  it("accepts a complete configuration and drops unknown fields", () => {
    expect(parseSettings({ ...valid, extra: 1 })).toEqual({ ...valid, sendImages: true });
  });

  it("rejects an unknown provider, an empty key, an empty model and a non-http base URL", () => {
    expect(parseSettings({ ...valid, provider: "gemini" })).toBeNull();
    expect(parseSettings({ ...valid, apiKey: "" })).toBeNull();
    expect(parseSettings({ ...valid, model: "" })).toBeNull();
    expect(parseSettings({ ...valid, baseUrl: "ftp://x" })).toBeNull();
    expect(parseSettings({ ...valid, baseUrl: "not a url" })).toBeNull();
  });

  it("rejects non-objects and partial objects", () => {
    expect(parseSettings(undefined)).toBeNull();
    expect(parseSettings("sk-x")).toBeNull();
    expect(parseSettings({ provider: "anthropic" })).toBeNull();
  });

  // The field shipped after the first release, so every existing user's stored object lacks
  // it. Defaulting to false there would silently disable a feature they were told they have.
  it("reads a configuration stored before sendImages existed as image sending ON", () => {
    expect(parseSettings(valid)?.sendImages).toBe(true);
    expect(parseSettings({ ...valid, sendImages: undefined })?.sendImages).toBe(true);
  });

  it("keeps an explicit false instead of re-defaulting it to true on every load", () => {
    expect(parseSettings({ ...valid, sendImages: false })?.sendImages).toBe(false);
  });

  it("rejects a non-boolean sendImages rather than coercing corruption into a policy", () => {
    expect(parseSettings({ ...valid, sendImages: "yes" })).toBeNull();
    expect(parseSettings({ ...valid, sendImages: 0 })).toBeNull();
    expect(parseSettings({ ...valid, sendImages: null })).toBeNull();
  });
});

describe("mergeSettingsInput", () => {
  const stored: Settings = {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-stored",
    model: "gpt-4o-mini",
    sendImages: true,
  };

  it("persists the box the user unticked instead of dropping it on the way to storage", () => {
    const merged = mergeSettingsInput({ ...stored, apiKey: "", sendImages: false }, stored);
    expect(merged).toEqual({ ok: true, settings: { ...stored, sendImages: false } });
  });

  it("falls back to the stored policy when the sender omits the field, and to on when nothing is stored", () => {
    const fromOldPanel = { provider: "openai-compatible", baseUrl: stored.baseUrl, model: stored.model, apiKey: "" };
    expect(mergeSettingsInput(fromOldPanel, { ...stored, sendImages: false })).toEqual({
      ok: true,
      settings: { ...stored, sendImages: false },
    });
    expect(mergeSettingsInput({ provider: "anthropic", baseUrl: "https://a.test", model: "m", apiKey: "sk-1" }, null)).toEqual({
      ok: true,
      settings: { provider: "anthropic", baseUrl: "https://a.test", apiKey: "sk-1", model: "m", sendImages: true },
    });
  });
});

// Failure mode defended: the toggle is the user's only defence against a Discord CDN link
// reaching a third-party API, so "off" must mean no message carries an image — anywhere.
describe("applyImagePolicy", () => {
  const off: Settings = {
    provider: "anthropic",
    baseUrl: "https://a.test",
    apiKey: "sk-1",
    model: "m",
    sendImages: false,
  };
  const conversation = (): ChatMessage[] => [
    { role: "system", content: "rules" },
    { role: "user", content: "explain", images: [{ url: "https://cdn.test/a.png", name: "a.png" }] },
    { role: "assistant", content: "sure" },
  ];

  it("removes images from every message when the setting is off, keeping the text and order", () => {
    expect(applyImagePolicy(conversation(), off)).toEqual([
      { role: "system", content: "rules" },
      { role: "user", content: "explain" },
      { role: "assistant", content: "sure" },
    ]);
  });

  it("does not mutate the caller's messages, so a retry cannot lose images the user re-enabled", () => {
    const messages = conversation();
    applyImagePolicy(messages, off);
    expect(messages[1]?.images).toHaveLength(1);
  });

  it("passes images through untouched when the setting is on", () => {
    const messages = conversation();
    expect(applyImagePolicy(messages, { ...off, sendImages: true })[1]?.images).toEqual([
      { url: "https://cdn.test/a.png", name: "a.png" },
    ]);
  });

  it("returns the same array when there is nothing to strip, so the common request allocates nothing", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "no pictures here" }];
    expect(applyImagePolicy(messages, off)).toBe(messages);
  });
});

describe("originPattern", () => {
  it("covers the whole origin regardless of the path prefix", () => {
    expect(originPattern("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/*");
    expect(originPattern("http://localhost:11434/v1")).toBe("http://localhost:11434/*");
  });
});
