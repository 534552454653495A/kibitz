import { describe, expect, it } from "vitest";
import { pickNewestAppDir } from "../../desktop/discord-launch";

describe("pickNewestAppDir", () => {
  it("picks the highest build number and ignores non-app entries", () => {
    expect(pickNewestAppDir(["app-1.0.9010", "app-1.0.9100", "app-1.0.9009", "packages", "Update.exe"])).toBe("app-1.0.9100");
  });

  it("compares numerically, so app-1.0.10 beats app-1.0.9 despite lexical order", () => {
    expect(pickNewestAppDir(["app-1.0.9", "app-1.0.10"])).toBe("app-1.0.10");
    expect(pickNewestAppDir(["app-1.0.10", "app-1.0.9"])).toBe("app-1.0.10");
  });

  it("treats a missing trailing component as zero (app-2.0 < app-2.0.1)", () => {
    expect(pickNewestAppDir(["app-2.0.1", "app-2.0"])).toBe("app-2.0.1");
  });

  it("returns null when no entry is an app directory", () => {
    expect(pickNewestAppDir(["packages", "app-", "app-x.y"])).toBeNull();
    expect(pickNewestAppDir([])).toBeNull();
  });
});
