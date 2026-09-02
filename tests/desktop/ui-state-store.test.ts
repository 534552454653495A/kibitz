import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadUiState, saveUiState, uiStatePath } from "../../desktop/ui-state-store";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kibitz-ui-state-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("loadUiState / saveUiState", () => {
  it("round-trips a layout blob through a directory that did not exist yet", async () => {
    const file = path.join(dir, "nested", "ui-state.json");
    await saveUiState({ panelLayout: { mode: "float", x: 40, y: 12 } }, file);
    expect(await loadUiState(file)).toEqual({ panelLayout: { mode: "float", x: 40, y: 12 } });
  });

  it("returns {} on a first run so the panel opens at its default layout", async () => {
    expect(await loadUiState(path.join(dir, "ui-state.json"))).toEqual({});
  });

  it("survives a truncated file instead of failing every panel mount until it is deleted", async () => {
    const file = path.join(dir, "ui-state.json");
    await fs.writeFile(file, '{"panelLayout": {"mode"');
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadUiState(file)).toEqual({});
  });

  it("ignores valid JSON that is not an object", async () => {
    const file = path.join(dir, "ui-state.json");
    await fs.writeFile(file, "[1,2,3]");
    expect(await loadUiState(file)).toEqual({});
  });

  it("keeps preferences out of the file that holds the API key", () => {
    const settings = path.join(dir, "settings.json");
    expect(uiStatePath(settings)).toBe(path.join(dir, "ui-state.json"));
  });
});
