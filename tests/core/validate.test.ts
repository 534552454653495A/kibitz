// The probe prints ContractError.path to tell the fix agent which field died, so the
// exact path per failure is the contract under test here.
import { describe, expect, it } from "vitest";
import type { UniversalMessage } from "../../src/core/types";
import { assertUniversalMessage, ContractError, isSnowflake } from "../../src/core/validate";

const valid: UniversalMessage = {
  platform: "discord",
  id: "3000000000000000003",
  channel: { id: "1000000000000000001", name: "general", guildId: "2000000000000000002" },
  author: { id: "4000000000000000004", name: "Alice", handle: "alice_h", isBot: false },
  content: "hello",
  createdAt: "2026-09-02T10:00:00.000Z",
  editedAt: "2026-09-02T10:05:00.000Z",
  replyTo: { messageId: "5000000000000000005", authorName: "Bob", excerpt: "earlier" },
  attachments: [{ id: "1", kind: "image", name: "a.png", url: "https://cdn/a.png", mimeType: "image/png", sizeBytes: 10 }],
  embeds: [{ title: "t", description: "d", url: "https://x", provider: "X", fields: [{ name: "k", value: "v" }] }],
  reactions: [{ emoji: "👍", count: 2 }],
  mentions: [{ id: "5000000000000000005", name: "Bob" }],
  isSystem: false,
  permalink: "https://discord.com/channels/2000000000000000002/1000000000000000001/3000000000000000003",
};

function pathOf(value: unknown): string {
  try {
    assertUniversalMessage(value);
  } catch (err) {
    if (err instanceof ContractError) return err.path;
    throw err;
  }
  throw new Error("expected a ContractError");
}

describe("assertUniversalMessage", () => {
  it("accepts a fully populated message", () => {
    const value: unknown = structuredClone(valid);
    assertUniversalMessage(value);
    expect(value).toEqual(valid);
  });

  it("names message.author.name when the author has no name", () => {
    expect(pathOf({ ...valid, author: { ...valid.author, name: undefined } })).toBe("message.author.name");
  });

  it("names message.createdAt when createdAt is not an ISO date", () => {
    expect(pathOf({ ...valid, createdAt: "last tuesday" })).toBe("message.createdAt");
  });

  it("names message.attachments when attachments is not an array", () => {
    expect(pathOf({ ...valid, attachments: {} })).toBe("message.attachments");
  });

  it("names the indexed reaction count when it is not a number", () => {
    expect(pathOf({ ...valid, reactions: [{ emoji: "👍", count: "2" }] })).toBe("message.reactions[0].count");
  });

  it("names the caller-supplied root path instead of the default", () => {
    expect(() => assertUniversalMessage({ ...valid, isSystem: "no" }, "readMessages.messages[3]")).toThrow(
      expect.objectContaining({ path: "readMessages.messages[3].isSystem" }),
    );
  });

  it("rejects a non-object at the root path", () => {
    expect(pathOf("nope")).toBe("message");
  });
});

describe("isSnowflake", () => {
  it("accepts 15–22 digit ids and rejects shorter or non-numeric ones", () => {
    expect(isSnowflake("123456789012345")).toBe(true);
    expect(isSnowflake("12345678901234")).toBe(false);
    expect(isSnowflake("1234567890123456x")).toBe(false);
  });
});
