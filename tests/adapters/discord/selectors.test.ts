// Parsing contract of the Discord selector file: id ↔ (channelId, messageId), URL → channel
// location, permalink shape. If these go red, buttons attach to nothing or link nowhere.
import { describe, expect, it } from "vitest";
import {
  messageItemId,
  parseChannelPath,
  parseMessageItemId,
  permalink,
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
