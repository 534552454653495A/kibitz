// Parsing contract of the Discord selector file: id ↔ (channelId, messageId), URL → channel
// location, permalink shape. If these go red, buttons attach to nothing or link nowhere.
import { describe, expect, it } from "vitest";
import {
  IMAGE_PREVIEW,
  messageItemId,
  parseChannelPath,
  parseMessageItemId,
  permalink,
  previewUrlFor,
} from "../../../src/adapters/discord/selectors";

const CHANNEL = "1234567890123456789";
const MESSAGE = "9876543210987654321";

describe("parseMessageItemId", () => {
  it("splits a chat-messages id into channel and message snowflakes", () => {
    expect(parseMessageItemId(`chat-messages-${CHANNEL}-${MESSAGE}`)).toEqual({ channelId: CHANNEL, messageId: MESSAGE });
  });

  it("returns null when either part is not numeric", () => {
    expect(parseMessageItemId("chat-messages-x-y")).toBeNull();
  });

  it("returns null for a message-content id (different element, same message)", () => {
    expect(parseMessageItemId("message-content-1")).toBeNull();
  });

  it("returns null when a third numeric segment is present", () => {
    expect(parseMessageItemId("chat-messages-1-2-3")).toBeNull();
  });

  it("round-trips through messageItemId", () => {
    expect(parseMessageItemId(messageItemId(CHANNEL, MESSAGE))).toEqual({ channelId: CHANNEL, messageId: MESSAGE });
  });
});

describe("parseChannelPath", () => {
  it("reads guild and channel ids from a guild channel path", () => {
    expect(parseChannelPath(`/channels/${CHANNEL}/${MESSAGE}`)).toEqual({ guildId: CHANNEL, channelId: MESSAGE });
  });

  it("maps @me to a null guild for DMs", () => {
    expect(parseChannelPath(`/channels/@me/${CHANNEL}`)).toEqual({ guildId: null, channelId: CHANNEL });
  });

  it("includes the message id when the path is a permalink", () => {
    expect(parseChannelPath(`/channels/${CHANNEL}/${CHANNEL}/${MESSAGE}`)).toEqual({
      guildId: CHANNEL,
      channelId: CHANNEL,
      messageId: MESSAGE,
    });
  });

  it("returns null for a non-channel route", () => {
    expect(parseChannelPath("/store")).toBeNull();
    expect(parseChannelPath("/channels/@me")).toBeNull();
  });
});

describe("permalink", () => {
  it("uses @me in place of the guild for DMs", () => {
    expect(permalink("discord.com", null, CHANNEL, MESSAGE)).toBe(`https://discord.com/channels/@me/${CHANNEL}/${MESSAGE}`);
  });

  it("keeps the host so canary links stay on canary", () => {
    expect(permalink("canary.discord.com", "1", CHANNEL, MESSAGE)).toBe(`https://canary.discord.com/channels/1/${CHANNEL}/${MESSAGE}`);
  });
});

// The preview rule decides what a vision model is actually shown. A dropped signature
// parameter means Discord answers 404 and the model sees nothing; a rewritten foreign
// host means we invent a URL that never existed.
describe("previewUrlFor", () => {
  const SIGNED = "https://cdn.discordapp.com/attachments/1/2/shot.png?ex=68b6&is=68b5&hm=deadbeef";

  it("keeps the ex/is/hm signature — stripping it turns the link into a 404 for the model", () => {
    const out = previewUrlFor(SIGNED, undefined);
    expect(out).toBe(
      "https://media.discordapp.net/attachments/1/2/shot.png?ex=68b6&is=68b5&hm=deadbeef&format=webp&width=1024&height=1024",
    );
  });

  it("bounds the image to the documented max edge so a phone photo is not billed at full size", () => {
    const params = new URL(previewUrlFor(SIGNED, undefined) ?? "").searchParams;
    expect(params.get("width")).toBe(String(IMAGE_PREVIEW.maxEdge));
    expect(params.get("height")).toBe(String(IMAGE_PREVIEW.maxEdge));
  });

  it("prefers proxy_url and still routes it through the media host", () => {
    const out = previewUrlFor(SIGNED, "https://media.discordapp.net/attachments/9/9/other.png?ex=1");
    expect(out).toBe("https://media.discordapp.net/attachments/9/9/other.png?ex=1&format=webp&width=1024&height=1024");
  });

  it("falls back to the raw url when proxy_url is not a Discord CDN link", () => {
    expect(previewUrlFor(SIGNED, "https://example.test/a.png")).toContain("media.discordapp.net/attachments/1/2/shot.png");
  });

  it("returns undefined for a foreign host instead of rewriting it onto the proxy", () => {
    expect(previewUrlFor("https://example.test/a.png", undefined)).toBeUndefined();
  });

  it("returns undefined for an unparsable or non-https url rather than a malformed one", () => {
    expect(previewUrlFor("", undefined)).toBeUndefined();
    expect(previewUrlFor("not a url", undefined)).toBeUndefined();
    expect(previewUrlFor("http://cdn.discordapp.com/attachments/1/2/a.png", undefined)).toBeUndefined();
  });

  it("overwrites a resize the link already carried so the bound is ours, not Discord's", () => {
    const out = previewUrlFor(`${SIGNED}&width=4096&height=3072`, undefined);
    expect(new URL(out ?? "").searchParams.get("width")).toBe("1024");
    expect(out).toContain("hm=deadbeef");
  });
});
