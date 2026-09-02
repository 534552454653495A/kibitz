import { describe, expect, it } from "vitest";
import {
  appendFollowUp,
  buildExplainMessages,
  buildSynthesisMessages,
  MAX_IMAGES_PER_REQUEST,
  renderTemplate,
} from "../../src/core/prompt";
import type { ChatMessage } from "../../src/core/messaging";
import type { UniversalAttachment, UniversalMessage } from "../../src/core/types";

function image(id: string, extra: Partial<UniversalAttachment> = {}): UniversalAttachment {
  return { id, kind: "image", name: `${id}.png`, url: `https://cdn/${id}.png`, mimeType: "image/png", ...extra };
}

const message: UniversalMessage = {
  platform: "discord",
  id: "42",
  channel: { id: "c1" },
  author: { id: "u1", name: "Zeynep", isBot: false },
  content: "bu ne demek ya {{weird}}",
  createdAt: "2026-01-01T00:00:00.000Z",
  attachments: [],
  embeds: [],
  reactions: [],
  mentions: [],
  isSystem: false,
};

describe("renderTemplate", () => {
  it("substitutes every placeholder, including repeated ones", () => {
    expect(renderTemplate("{{a}} and {{b}} and {{a}}", { a: "1", b: "2" })).toBe("1 and 2 and 1");
  });

  it("throws naming the placeholder the caller forgot to supply", () => {
    expect(() => renderTemplate("hi {{name}}", {})).toThrow("unresolved placeholder: name");
  });

  it("throws naming a variable the template never references", () => {
    expect(() => renderTemplate("hi", { extra: "x" })).toThrow("unused variable: extra");
  });

  it("does not mistake braces inside a substituted value for a placeholder", () => {
    expect(renderTemplate("{{v}}", { v: "{{not-a-var}}" })).toBe("{{not-a-var}}");
  });
});

describe("buildExplainMessages", () => {
  it("returns a system turn followed by a user turn carrying the message's author and content", () => {
    const out = buildExplainMessages(message);
    expect(out.map((m) => m.role)).toEqual(["system", "user"]);
    expect(out[1]?.content).toContain("Zeynep");
    expect(out[1]?.content).toContain("bu ne demek ya {{weird}}");
  });

  it("sends the resized previewUrl when the adapter offered one, so the user is not billed for a full-size photo", () => {
    const out = buildExplainMessages({
      ...message,
      attachments: [image("a", { previewUrl: "https://media/a.png?width=1024" }), image("b")],
    });
    expect(out[1]?.images).toEqual([
      { url: "https://media/a.png?width=1024", name: "a.png", mimeType: "image/png" },
      { url: "https://cdn/b.png", name: "b.png", mimeType: "image/png" },
    ]);
  });

  it("leaves images undefined when the message has none, so a text-only turn stays text-only", () => {
    expect(buildExplainMessages(message)[1]?.images).toBeUndefined();
    const withFile: UniversalMessage = {
      ...message,
      attachments: [{ id: "f", kind: "file", name: "notes.pdf", url: "https://cdn/notes.pdf" }],
    };
    expect(buildExplainMessages(withFile)[1]?.images).toBeUndefined();
  });

  it("caps the images at MAX_IMAGES_PER_REQUEST and leaves the dropped ones as URLs in the text", () => {
    const attachments = ["a", "b", "c", "d", "e"].map((id) => image(id));
    const out = buildExplainMessages({ ...message, attachments });
    expect(out[1]?.images).toHaveLength(MAX_IMAGES_PER_REQUEST);
    expect(out[1]?.content).toContain("[image attached to this request: a.png]");
    expect(out[1]?.content).toContain("[attachment: image e.png https://cdn/e.png]");
  });
});

describe("buildSynthesisMessages", () => {
  it("puts every collected message's content into the user turn", () => {
    const other: UniversalMessage = { ...message, id: "43", content: "cevap burada", createdAt: "2026-01-01T00:00:01.000Z" };
    const out = buildSynthesisMessages({ anchor: message, messages: [message, other], truncated: false });
    expect(out.map((m) => m.role)).toEqual(["system", "user"]);
    expect(out[1]?.content).toContain("cevap burada");
    expect(out[1]?.content).toContain(">>> [2026-01-01T00:00:00.000Z] Zeynep");
  });

  it("sends the anchor's images first: the clicked message is what the question is about", () => {
    const anchor: UniversalMessage = { ...message, attachments: [image("anchor1"), image("anchor2")] };
    const other: UniversalMessage = {
      ...message,
      id: "43",
      createdAt: "2026-01-01T00:00:01.000Z",
      attachments: [image("other1")],
    };
    const out = buildSynthesisMessages({ anchor, messages: [other, anchor], truncated: false });
    expect(out[1]?.images?.map((i) => i.name)).toEqual(["anchor1.png", "anchor2.png", "other1.png"]);
  });

  it("takes at most one image per surrounding message so one image dump cannot fill the request", () => {
    const anchor: UniversalMessage = { ...message, attachments: [image("anchor1")] };
    const dump: UniversalMessage = {
      ...message,
      id: "43",
      createdAt: "2026-01-01T00:00:01.000Z",
      attachments: [image("d1"), image("d2"), image("d3"), image("d4")],
    };
    const late: UniversalMessage = {
      ...message,
      id: "44",
      createdAt: "2026-01-01T00:00:02.000Z",
      attachments: [image("late1")],
    };
    const out = buildSynthesisMessages({ anchor, messages: [anchor, dump, late], truncated: false });
    expect(out[1]?.images?.map((i) => i.name)).toEqual(["anchor1.png", "d1.png", "late1.png"]);
    // d2..d4 were not sent, so the thread text must still hand the reader their URLs.
    expect(out[1]?.content).toContain("[attachment: image d2.png https://cdn/d2.png]");
  });

  it("never exceeds MAX_IMAGES_PER_REQUEST even when the anchor alone carries more", () => {
    const anchor: UniversalMessage = {
      ...message,
      attachments: ["a", "b", "c", "d", "e", "f"].map((id) => image(id)),
    };
    const other: UniversalMessage = { ...message, id: "43", createdAt: "2026-01-01T00:00:01.000Z", attachments: [image("z")] };
    const out = buildSynthesisMessages({ anchor, messages: [anchor, other], truncated: false });
    expect(out[1]?.images).toHaveLength(MAX_IMAGES_PER_REQUEST);
    expect(out[1]?.images?.some((i) => i.name === "z.png")).toBe(false);
  });

  it("leaves images undefined when nothing in the thread has one", () => {
    expect(buildSynthesisMessages({ anchor: message, messages: [message], truncated: false })[1]?.images).toBeUndefined();
  });
});

describe("appendFollowUp", () => {
  it("returns a longer copy and leaves the original history untouched", () => {
    const history: ChatMessage[] = [{ role: "system", content: "s" }];
    const next = appendFollowUp(history, "why?");
    expect(history).toHaveLength(1);
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ role: "user", content: "why?" });
  });
});
