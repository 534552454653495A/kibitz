// @vitest-environment jsdom
/**
 * Failure mode defended: the message card's chips are the only place a user can see what
 * their question will carry. Images are the one attachment kind whose *content* leaves for
 * the provider, so a card that folds them in with `file: notes.txt` gives no way to notice
 * that four pictures are about to be uploaded, or that unticking the setting mattered.
 */
import { render } from "preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UniversalAttachment, UniversalMessage } from "../../../src/core/types";
import type { PanelActions } from "../../../src/ui/panel/actions";
import { INITIAL } from "../../../src/ui/panel/state";
import { chatView } from "../../../src/ui/panel/views/chat";

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

const attachment = (id: string, kind: UniversalAttachment["kind"], name: string): UniversalAttachment => ({
  id,
  kind,
  name,
  url: `https://cdn.discordapp.test/${name}`,
});

let container: HTMLElement;

function show(attachments: UniversalAttachment[]): string[] {
  const message: UniversalMessage = {
    platform: "discord",
    id: "m1",
    channel: { id: "c1", name: "general" },
    author: { id: "u1", name: "ana", isBot: false },
    content: "look at this",
    createdAt: "2026-01-01T00:00:00.000Z",
    attachments,
    embeds: [],
    reactions: [],
    mentions: [],
    isSystem: false,
  };
  render(
    chatView.render({
      model: { ...INITIAL, status: "ready", view: "chat", message },
      actions: stubActions(),
      platform: "discord",
      capabilities: { keyIsPageVisible: false, canOpenOptionsPage: true },
      keyStorageHint: "Stored on this machine.",
    }),
    container,
  );
  return [...container.querySelectorAll(".chip")].map((chip) => chip.textContent ?? "");
}

beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("main");
  document.body.append(container);
});

describe("message card attachment chips", () => {
  it("counts images in one chip instead of burying them among the other attachments", () => {
    expect(
      show([
        attachment("a1", "image", "shot.png"),
        attachment("a2", "file", "notes.txt"),
        attachment("a3", "image", "graph.jpg"),
      ]),
    ).toEqual(["2 images", "file: notes.txt"]);
  });

  it("says 'image' rather than '1 images' for a single picture", () => {
    expect(show([attachment("a1", "image", "shot.png")])).toEqual(["1 image"]);
  });

  it("shows no image chip when the message has none, so the count never reads as zero pictures", () => {
    expect(show([attachment("a1", "audio", "voice.ogg")])).toEqual(["audio: voice.ogg"]);
  });
});
