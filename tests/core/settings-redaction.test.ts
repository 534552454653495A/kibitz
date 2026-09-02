import { describe, expect, it } from "vitest";
import { redactSettings, type Settings } from "../../src/core/settings";

// Failure mode defended (2026-09-02, real incident): a diagnostic serialised settings with a
// text regex, the regex missed the pretty-printed spacing, and a live API key was written to
// a transcript. `redactSettings` must be impossible to defeat that way — it rebuilds the
// object, so no formatting of the input can carry the key through.
describe("redactSettings", () => {
  const settings: Settings = {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-proj-SHOULD-NEVER-APPEAR",
    model: "gpt-4o-mini",
  };

  it("keeps no trace of the key in any serialisation of the result", () => {
    const redacted = redactSettings(settings);
    expect(JSON.stringify(redacted)).not.toContain(settings.apiKey);
    expect(JSON.stringify(redacted, null, 2)).not.toContain("sk-proj");
    expect(Object.values(redacted)).not.toContain(settings.apiKey);
  });

  it("reports the key length so a caller can still tell empty from set", () => {
    expect(redactSettings(settings).apiKeyLength).toBe(settings.apiKey.length);
    expect(redactSettings({ ...settings, apiKey: "" }).apiKeyLength).toBe(0);
  });

  it("preserves the fields a diagnostic actually needs", () => {
    expect(redactSettings(settings)).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKeyLength: settings.apiKey.length,
    });
  });
});
