import { describe, expect, it } from "vitest";
import { serializeMessage, serializeThread } from "../../src/core/context";
import type { UniversalMessage, UniversalThread } from "../../src/core/types";

function message(overrides: Partial<UniversalMessage> & { id: string }): UniversalMessage {
  return {
    platform: "discord",
    channel: { id: "c1" },
    author: { id: "u1", name: "Alice", isBot: false },
    content: `msg ${overrides.id}`,
    createdAt: `2026-01-01T00:00:${overrides.id.padStart(2, "0")}.000Z`,
    attachments: [],
    embeds: [],
    reactions: [],
    mentions: [],
    isSystem: false,
    ...overrides,
  };
}

describe("serializeMessage", () => {
  it("emits only the header line for a bare message", () => {
    const out = serializeMessage(message({ id: "1", content: "hello" }));
    expect(out).toBe("[2026-01-01T00:00:01.000Z] Alice: hello");
  });

  it("shows the handle and bot marker only when they add information", () => {
    const withHandle = serializeMessage(
      message({ id: "1", author: { id: "u", name: "Ali", handle: "alice", isBot: true } }),
    );
    expect(withHandle.split("\n")[0]).toContain("Ali (@alice) [bot]:");
    const sameHandle = serializeMessage(
      message({ id: "1", author: { id: "u", name: "alice", handle: "alice", isBot: false } }),
    );
    expect(sameHandle).not.toContain("(@alice)");
  });

  it("adds reply, attachment, embed, reaction and permalink lines only when present", () => {
    const out = serializeMessage(
      message({
        id: "2",
        replyTo: { messageId: "1", authorName: "Bob", excerpt: "the question" },
        attachments: [{ id: "a", kind: "image", name: "cat.png", url: "https://x/cat.png" }],
        embeds: [
          {
            title: "Repo",
            description: "A thing",
            provider: "GitHub",
            url: "https://gh/x",
            fields: [{ name: "stars", value: "3" }],
          },
        ],
        reactions: [{ emoji: "👍", count: 2 }],
        permalink: "https://p/2",
      }),
    );
    const lines = out.split("\n");
    expect(lines.slice(1)).toEqual([
      "    ↳ reply to Bob: the question",
      "    [attachment: image cat.png https://x/cat.png]",
      "    [embed: Repo — A thing (GitHub) https://gh/x]",
      "        stars: 3",
      "    reactions: 👍×2",
      "    permalink: https://p/2",
    ]);
  });

  it("marks system notices so the model treats them as events", () => {
    const out = serializeMessage(message({ id: "1", isSystem: true, content: "joined" }));
    expect(out).toContain("[system notice]");
  });
});

function thread(ids: string[], anchorId: string): UniversalThread {
  const messages = ids.map((id) => message({ id }));
  const anchor = messages.find((m) => m.id === anchorId);
  if (anchor === undefined) throw new Error("anchor not in fixture");
  return { anchor, messages, truncated: false };
}

describe("serializeThread", () => {
  it("keeps every message in chronological order when the budget allows", () => {
    const out = serializeThread(thread(["1", "2", "3"], "2"), { charBudget: 10_000 });
    const blocks = out.split("\n\n");
    expect(blocks.map((b) => b.replace(/^>>> /, "").slice(0, 26))).toEqual([
      "[2026-01-01T00:00:01.000Z]",
      "[2026-01-01T00:00:02.000Z]",
      "[2026-01-01T00:00:03.000Z]",
    ]);
    expect(out).not.toContain("omitted");
  });

  it("marks the anchor with the >>> prefix and never drops it", () => {
    const t = thread(["1", "2", "3", "4", "5"], "3");
    const out = serializeThread(t, { charBudget: 1 });
    expect(out).toContain(">>> [2026-01-01T00:00:03.000Z] Alice: msg 3");
    expect(out).toContain("(… 2 earlier messages omitted)");
    expect(out).toContain("(… 2 later messages omitted)");
  });

  it("drops the farthest messages first and reports the omitted count", () => {
    const t = thread(["1", "2", "3", "4", "5", "6", "7"], "5");
    const one = serializeMessage(t.messages[0]!).length;
    // Room for the anchor plus two neighbours; 4 must go, and they must be the far ones.
    const out = serializeThread(t, { charBudget: one * 3 + 8 });
    expect(out).toContain("msg 4");
    expect(out).toContain("msg 5");
    expect(out).toContain("msg 6");
    expect(out).not.toContain("msg 1");
    expect(out).not.toContain("msg 7");
    expect(out).toContain("(… 3 earlier messages omitted)");
    expect(out).toContain("(… 1 later message omitted)");
  });

  it("still includes the anchor when the adapter left it out of the list", () => {
    const anchor = message({ id: "2" });
    const t: UniversalThread = {
      anchor,
      messages: [message({ id: "1" }), message({ id: "3" })],
      truncated: false,
    };
    const blocks = serializeThread(t, { charBudget: 10_000 }).split("\n\n");
    expect(blocks[1]?.startsWith(">>> [2026-01-01T00:00:02.000Z]")).toBe(true);
  });
});
