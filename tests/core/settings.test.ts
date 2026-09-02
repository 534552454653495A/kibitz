import { describe, expect, it } from "vitest";
import { originPattern, parseSettings } from "../../src/core/settings";

// Failure mode defended: "configured" must mean the same thing for the extension
// (chrome.storage) and the desktop companion (settings.json). A value that passes here
// is one the providers can actually use; anything else must read as "not configured".
describe("parseSettings", () => {
  const valid = { provider: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", model: "claude-sonnet-4-5" };

  it("accepts a complete configuration and drops unknown fields", () => {
    expect(parseSettings({ ...valid, extra: 1 })).toEqual(valid);
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
});

describe("originPattern", () => {
  it("covers the whole origin regardless of the path prefix", () => {
    expect(originPattern("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/*");
    expect(originPattern("http://localhost:11434/v1")).toBe("http://localhost:11434/*");
  });
});
