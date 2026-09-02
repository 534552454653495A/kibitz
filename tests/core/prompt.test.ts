import { describe, expect, it } from "vitest";
import {
  appendFollowUp,
  buildExplainMessages,
  buildSynthesisMessages,
  renderTemplate,
} from "../../src/core/prompt";
import type { ChatMessage } from "../../src/core/messaging";
import type { UniversalMessage } from "../../src/core/types";

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
});

describe("buildSynthesisMessages", () => {
  it("puts every collected message's content into the user turn", () => {
    const other: UniversalMessage = { ...message, id: "43", content: "cevap burada", createdAt: "2026-01-01T00:00:01.000Z" };
    const out = buildSynthesisMessages({ anchor: message, messages: [message, other], truncated: false });
    expect(out.map((m) => m.role)).toEqual(["system", "user"]);
    expect(out[1]?.content).toContain("cevap burada");
    expect(out[1]?.content).toContain(">>> [2026-01-01T00:00:00.000Z] Zeynep");
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
