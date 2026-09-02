import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFileSettings, saveFileSettings, settingsPath } from "../../desktop/settings-store";
import type { Settings } from "../../src/core/settings";

const SETTINGS: Settings = { provider: "openai-compatible", baseUrl: "https://example.test/v1", apiKey: "sk-1", model: "m" };

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kibitz-settings-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("loadFileSettings / saveFileSettings", () => {
  it("round-trips settings through a file in a directory that did not exist yet", async () => {
    const file = path.join(dir, "nested", "deeper", "settings.json");
    await saveFileSettings(SETTINGS, file);
    expect(await loadFileSettings(file)).toEqual(SETTINGS);
  });

  it("returns null when the file does not exist", async () => {
    expect(await loadFileSettings(path.join(dir, "missing.json"))).toBeNull();
  });

  it("returns null for a file that is not JSON", async () => {
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, "{ provider: anthropic");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadFileSettings(file)).toBeNull();
  });

  it("returns null for valid JSON that is not a complete configuration", async () => {
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, JSON.stringify({ ...SETTINGS, apiKey: "" }));
    expect(await loadFileSettings(file)).toBeNull();
  });

  it.skipIf(process.platform === "win32")("writes the key file readable by the owner only, even over a wider existing file", async () => {
    const file = path.join(dir, "settings.json");
    await fs.writeFile(file, "{}", { mode: 0o644 });
    await saveFileSettings(SETTINGS, file);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("settingsPath", () => {
  it("uses %APPDATA% on Windows", () => {
    vi.stubEnv("APPDATA", path.join("C:", "Users", "x", "AppData", "Roaming"));
    expect(settingsPath("win32")).toBe(path.join("C:", "Users", "x", "AppData", "Roaming", "kibitz", "settings.json"));
  });

  it("uses ~/Library/Application Support on macOS", () => {
    expect(settingsPath("darwin")).toBe(path.join(os.homedir(), "Library", "Application Support", "kibitz", "settings.json"));
  });

  it("honours XDG_CONFIG_HOME on Linux and falls back to ~/.config without it", () => {
    vi.stubEnv("XDG_CONFIG_HOME", path.join("/tmp", "xdg"));
    expect(settingsPath("linux")).toBe(path.join("/tmp", "xdg", "kibitz", "settings.json"));
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    expect(settingsPath("linux")).toBe(path.join(os.homedir(), ".config", "kibitz", "settings.json"));
  });
});
