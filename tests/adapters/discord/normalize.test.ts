// Transformation contract of normalizeMessage: raw Discord MessageRecord fields → exact
// UniversalMessage fields. Each case names what the panel/LLM would get wrong if it broke.
import { describe, expect, it } from "vitest";
import { normalizeMessage, type NormalizeContext } from "../../../src/adapters/discord/normalize";
import type { RawDiscordMessage } from "../../../src/adapters/discord/selectors";
import { ContractError } from "../../../src/core/validate";

const CHANNEL = "1000000000000000001";
const GUILD = "2000000000000000002";
const MESSAGE = "3000000000000000003";
const ALICE = "4000000000000000004";
const BOB = "5000000000000000005";
const ISO = "2026-09-02T10:00:00.000Z";

const ctx: NormalizeContext = { channel: { id: CHANNEL, name: "general", guild_id: GUILD }, host: "discord.com", guildId: null };

function raw(overrides: Partial<RawDiscordMessage> = {}): RawDiscordMessage {
  return {
    id: MESSAGE,
    type: 0,
    channel_id: CHANNEL,
    content: "hello",
    author: { id: ALICE, username: "alice_h", globalName: "Alice" },
    timestamp: ISO,
    ...overrides,
  };
}

function contractPath(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ContractError) return err.path;
    throw err;
  }
  throw new Error("expected a ContractError");
}

describe("normalizeMessage timestamps", () => {
  it("yields the same ISO createdAt for a Moment-like object and an ISO string", () => {
    const fromString = normalizeMessage(raw({ timestamp: ISO }), ctx);
    const fromMoment = normalizeMessage(raw({ timestamp: { toISOString: () => ISO } }), ctx);
    expect(fromMoment.createdAt).toBe(ISO);
    expect(fromString.createdAt).toBe(fromMoment.createdAt);
  });

  it("omits editedAt when editedTimestamp is null", () => {
    expect("editedAt" in normalizeMessage(raw({ editedTimestamp: null }), ctx)).toBe(false);
  });

  it("sets editedAt from a Moment-like editedTimestamp", () => {
    const edited = "2026-09-02T11:00:00.000Z";
    expect(normalizeMessage(raw({ editedTimestamp: { toISOString: () => edited } }), ctx).editedAt).toBe(edited);
  });

  it("names raw.timestamp when the timestamp is unparseable", () => {
    expect(contractPath(() => normalizeMessage(raw({ timestamp: "yesterday" }), ctx))).toBe("raw.timestamp");
  });
});

describe("normalizeMessage content markup", () => {
  it("resolves <@id> to @displayName from user-object mentions", () => {
    const m = normalizeMessage(
      raw({ content: `hi <@${BOB}>`, mentions: [{ id: BOB, username: "bob", globalName: "Bobby" }] }),
      ctx,
    );
    expect(m.content).toBe("hi @Bobby");
    expect(m.mentions).toEqual([{ id: BOB, name: "Bobby" }]);
  });

  it("falls back to @user for <@!id> when mentions carry only ids", () => {
    const m = normalizeMessage(raw({ content: `hi <@!${BOB}>`, mentions: [BOB] }), ctx);
    expect(m.content).toBe("hi @user");
    expect(m.mentions).toEqual([]);
  });

  it("replaces role and channel mentions with generic placeholders", () => {
    expect(normalizeMessage(raw({ content: `<@&${GUILD}> see <#${CHANNEL}>` }), ctx).content).toBe("@role see #channel");
  });

  it("collapses custom (and animated) emoji to :name:", () => {
    expect(normalizeMessage(raw({ content: `<:pepe:${BOB}> <a:party:${BOB}>` }), ctx).content).toBe(":pepe: :party:");
  });
});

describe("normalizeMessage attachments", () => {
  it("derives kind from the MIME prefix and defaults to file", () => {
    const m = normalizeMessage(
      raw({
        attachments: [
          { id: "1", filename: "a.png", url: "https://cdn/a.png", content_type: "image/png" },
          { id: "2", filename: "b.mp4", url: "https://cdn/b.mp4", content_type: "video/mp4" },
          { id: "3", filename: "c.ogg", url: "https://cdn/c.ogg", content_type: "audio/ogg" },
          { id: "4", filename: "d.zip", url: "https://cdn/d.zip", content_type: "application/zip" },
          { id: "5", filename: "e", url: "https://cdn/e" },
        ],
      }),
      ctx,
    );
    expect(m.attachments.map((a) => a.kind)).toEqual(["image", "video", "audio", "file", "file"]);
  });

  it("uses proxy_url when url is absent and drops entries with neither", () => {
    const m = normalizeMessage(
      raw({
        attachments: [
          { id: "1", filename: "a.png", proxy_url: "https://proxy/a.png" },
          { id: "2", filename: "lost.png" },
        ],
      }),
      ctx,
    );
    expect(m.attachments).toEqual([{ id: "1", kind: "file", name: "a.png", url: "https://proxy/a.png" }]);
  });
});

describe("normalizeMessage embeds", () => {
  it("prefers title over rawTitle and falls back when only rawTitle exists", () => {
    const m = normalizeMessage(
      raw({
        embeds: [
          { title: "Rendered", rawTitle: "Raw" },
          { rawTitle: "Raw only", rawDescription: "desc", provider: { name: "YouTube" } },
        ],
      }),
      ctx,
    );
    expect(m.embeds[0]?.title).toBe("Rendered");
    expect(m.embeds[1]).toEqual({ title: "Raw only", description: "desc", provider: "YouTube", fields: [] });
  });

  it("drops embed fields that have neither a name nor a value", () => {
    const m = normalizeMessage(raw({ embeds: [{ fields: [{ rawName: "k", value: "v" }, {}] }] }), ctx);
    expect(m.embeds[0]?.fields).toEqual([{ name: "k", value: "v" }]);
  });
});

describe("normalizeMessage reactions", () => {
  it("wraps custom emoji names in colons and keeps unicode as-is", () => {
    const m = normalizeMessage(
      raw({ reactions: [{ emoji: { id: BOB, name: "pepe" }, count: 3 }, { emoji: { id: null, name: "👍" } }] }),
      ctx,
    );
    expect(m.reactions).toEqual([
      { emoji: ":pepe:", count: 3 },
      { emoji: "👍", count: 0 },
    ]);
  });
});

describe("normalizeMessage system flag", () => {
  it("marks type 7 (member join) as system", () => {
    expect(normalizeMessage(raw({ type: 7 }), ctx).isSystem).toBe(true);
  });

  it("does not mark type 19 (reply) as system", () => {
    expect(normalizeMessage(raw({ type: 19 }), ctx).isSystem).toBe(false);
  });
});

describe("normalizeMessage author", () => {
  it("reports raw.author when the author is missing", () => {
    expect(contractPath(() => normalizeMessage(raw({ author: undefined }), ctx))).toBe("raw.author");
  });

  it("uses the username as name and omits handle when there is no globalName", () => {
    const m = normalizeMessage(raw({ author: { id: ALICE, username: "alice_h", globalName: null } }), ctx);
    expect(m.author).toEqual({ id: ALICE, name: "alice_h", isBot: false });
  });

  it("keeps the username as handle when it differs from the display name", () => {
    expect(normalizeMessage(raw(), ctx).author).toEqual({ id: ALICE, name: "Alice", handle: "alice_h", isBot: false });
  });

  it("flags bots", () => {
    expect(normalizeMessage(raw({ author: { id: ALICE, username: "clyde", bot: true } }), ctx).author.isBot).toBe(true);
  });
});

describe("normalizeMessage replies", () => {
  it("enriches replyTo with author and excerpt from resolveReply", () => {
    const m = normalizeMessage(raw({ type: 19, messageReference: { message_id: BOB } }), {
      ...ctx,
      resolveReply: (id) => (id === BOB ? { authorName: "Bobby", excerpt: "earlier" } : null),
    });
    expect(m.replyTo).toEqual({ messageId: BOB, authorName: "Bobby", excerpt: "earlier" });
  });

  it("keeps the bare messageId when the referenced message is not resolvable", () => {
    const m = normalizeMessage(raw({ messageReference: { message_id: BOB } }), { ...ctx, resolveReply: () => null });
    expect(m.replyTo).toEqual({ messageId: BOB });
  });
});

describe("normalizeMessage channel and permalink", () => {
  it("prefers channel.guild_id over the URL guildId", () => {
    const m = normalizeMessage(raw(), { ...ctx, guildId: "9" });
    expect(m.channel).toEqual({ id: CHANNEL, name: "general", guildId: GUILD });
    expect(m.permalink).toBe(`https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`);
  });

  it("falls back to the URL guildId when the channel record has none", () => {
    const m = normalizeMessage(raw(), { channel: { id: CHANNEL }, host: "discord.com", guildId: "9" });
    expect(m.channel.guildId).toBe("9");
  });

  it("produces an @me permalink for DMs with no guild anywhere", () => {
    const m = normalizeMessage(raw(), { channel: null, host: "ptb.discord.com", guildId: null });
    expect(m.channel).toEqual({ id: CHANNEL });
    expect(m.permalink).toBe(`https://ptb.discord.com/channels/@me/${CHANNEL}/${MESSAGE}`);
  });

  it("reports raw.channel_id when neither the record nor the context names a channel", () => {
    expect(contractPath(() => normalizeMessage(raw({ channel_id: undefined }), { channel: null, host: "discord.com", guildId: null }))).toBe(
      "raw.channel_id",
    );
  });
});
