/**
 * Raw Discord MessageRecord → UniversalMessage. Pure: no DOM, no React, no chrome.*.
 *
 * Runs inside the MAIN-world bridge, so every field it touches is an undocumented Discord
 * internal. The decision here is to fail loud at the source: essential fields that are
 * absent or malformed throw a ContractError whose `.path` names the raw field
 * ("raw.author"), and the finished message is re-validated before it leaves, so a drift
 * in Discord's record shape is reported by the probe as one precise path instead of
 * surfacing as "undefined" in the panel.
 */
import type {
  AttachmentKind,
  UniversalAttachment,
  UniversalEmbed,
  UniversalMention,
  UniversalMessage,
  UniversalReaction,
  UniversalReply,
} from "../../core/types";
import { ContractError, assertUniversalMessage, isRecord } from "../../core/validate";
import {
  CONTENT_MARKUP,
  permalink,
  USER_MESSAGE_TYPES,
  type RawDiscordChannel,
  type RawDiscordMessage,
  type RawDiscordTimestamp,
  type RawDiscordUser,
} from "./selectors";

export interface NormalizeContext {
  channel: RawDiscordChannel | null;
  host: string;
  guildId: string | null;
  /** Looks up the replied-to message when it is still rendered; null when it is not. */
  resolveReply?: (messageId: string) => { authorName?: string; excerpt?: string } | null;
}

/** Placeholders for ids we cannot resolve; the LLM still sees that *something* was mentioned. */
const UNKNOWN_USER = "user";
const ROLE_MENTION = "@role";
const CHANNEL_MENTION = "#channel";

const ATTACHMENT_KIND_BY_MIME_PREFIX: Record<string, AttachmentKind> = {
  image: "image",
  video: "video",
  audio: "audio",
};

function toIso(ts: RawDiscordTimestamp, path: string): string {
  if (typeof ts === "string") {
    if (Number.isNaN(Date.parse(ts))) throw new ContractError(path, `not an ISO date: ${ts}`);
    return new Date(ts).toISOString();
  }
  if (isRecord(ts) && typeof ts.toISOString === "function") {
    const iso: unknown = ts.toISOString();
    if (typeof iso !== "string" || Number.isNaN(Date.parse(iso))) {
      throw new ContractError(path, "toISOString() did not return an ISO date");
    }
    return iso;
  }
  throw new ContractError(path, "missing or not a Moment-like timestamp");
}

function displayName(user: RawDiscordUser): string | undefined {
  return user.globalName ?? user.username ?? undefined;
}

function isUserObject(entry: RawDiscordUser | string): entry is RawDiscordUser & { id: string; username: string } {
  return isRecord(entry) && typeof entry.id === "string" && typeof entry.username === "string";
}

function resolveMarkup(content: string, mentions: RawDiscordMessage["mentions"]): string {
  // Built per message: membership is dynamic, so a Map (not a Record) is the right tool.
  const names = new Map<string, string>();
  for (const entry of mentions ?? []) {
    if (isUserObject(entry)) names.set(entry.id, displayName(entry) ?? entry.username);
  }
  return content
    .replace(CONTENT_MARKUP.user, (_m, id: string) => `@${names.get(id) ?? UNKNOWN_USER}`)
    .replace(CONTENT_MARKUP.role, ROLE_MENTION)
    .replace(CONTENT_MARKUP.channel, CHANNEL_MENTION)
    .replace(CONTENT_MARKUP.customEmoji, (_m, name: string) => `:${name}:`);
}

function normalizeAttachments(raw: RawDiscordMessage["attachments"]): UniversalAttachment[] {
  const out: UniversalAttachment[] = [];
  for (const a of raw ?? []) {
    const url = a.url ?? a.proxy_url;
    // An attachment without a URL is not something the LLM or the user can open; skip it.
    if (!a.id || !url) continue;
    const prefix = a.content_type?.split("/")[0] ?? "";
    out.push({
      id: a.id,
      kind: ATTACHMENT_KIND_BY_MIME_PREFIX[prefix] ?? "file",
      name: a.filename ?? "",
      url,
      ...(a.content_type ? { mimeType: a.content_type } : {}),
      ...(typeof a.size === "number" ? { sizeBytes: a.size } : {}),
    });
  }
  return out;
}

function normalizeEmbeds(raw: RawDiscordMessage["embeds"]): UniversalEmbed[] {
  return (raw ?? []).map((e) => {
    // Discord keeps both the markdown-rendered and the raw text; raw is the fallback.
    const title = e.title ?? e.rawTitle;
    const description = e.description ?? e.rawDescription;
    const provider = e.provider?.name;
    const fields = (e.fields ?? []).flatMap((f) => {
      const name = f.name ?? f.rawName;
      const value = f.value ?? f.rawValue;
      return name === undefined && value === undefined ? [] : [{ name: name ?? "", value: value ?? "" }];
    });
    return {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(e.url !== undefined ? { url: e.url } : {}),
      ...(provider !== undefined ? { provider } : {}),
      fields,
    };
  });
}

function normalizeReactions(raw: RawDiscordMessage["reactions"]): UniversalReaction[] {
  const out: UniversalReaction[] = [];
  for (const r of raw ?? []) {
    const name = r.emoji?.name;
    if (!name) continue;
    out.push({ emoji: r.emoji?.id ? `:${name}:` : name, count: r.count ?? 0 });
  }
  return out;
}

function normalizeMentions(raw: RawDiscordMessage["mentions"]): UniversalMention[] {
  const out: UniversalMention[] = [];
  for (const entry of raw ?? []) {
    if (isUserObject(entry)) out.push({ id: entry.id, name: displayName(entry) ?? entry.username });
  }
  return out;
}

function normalizeReply(raw: RawDiscordMessage, ctx: NormalizeContext): UniversalReply | undefined {
  const messageId = raw.messageReference?.message_id;
  if (!messageId) return undefined;
  const resolved = ctx.resolveReply?.(messageId) ?? null;
  return {
    messageId,
    ...(resolved?.authorName !== undefined ? { authorName: resolved.authorName } : {}),
    ...(resolved?.excerpt !== undefined ? { excerpt: resolved.excerpt } : {}),
  };
}

export function normalizeMessage(raw: RawDiscordMessage, ctx: NormalizeContext): UniversalMessage {
  if (!raw.id) throw new ContractError("raw.id", "missing");
  if (typeof raw.content !== "string") throw new ContractError("raw.content", "missing or not a string");
  const author = raw.author;
  if (!author || typeof author !== "object") throw new ContractError("raw.author", "missing");
  if (!author.id) throw new ContractError("raw.author.id", "missing");
  const name = displayName(author);
  if (!name) throw new ContractError("raw.author.name", "neither globalName nor username present");

  const channelId = raw.channel_id ?? ctx.channel?.id;
  if (!channelId) throw new ContractError("raw.channel_id", "missing and no channel in context");
  const guildId = ctx.channel?.guild_id ?? ctx.guildId ?? undefined;

  const createdAt = toIso(raw.timestamp, "raw.timestamp");
  const editedAt = raw.editedTimestamp == null ? undefined : toIso(raw.editedTimestamp, "raw.editedTimestamp");
  const replyTo = normalizeReply(raw, ctx);

  const result: UniversalMessage = {
    platform: "discord",
    id: raw.id,
    channel: {
      id: channelId,
      ...(ctx.channel?.name !== undefined ? { name: ctx.channel.name } : {}),
      ...(guildId !== undefined ? { guildId } : {}),
    },
    author: {
      id: author.id,
      name,
      ...(author.username !== undefined && author.username !== name ? { handle: author.username } : {}),
      isBot: !!author.bot,
    },
    content: resolveMarkup(raw.content, raw.mentions),
    createdAt,
    ...(editedAt !== undefined ? { editedAt } : {}),
    ...(replyTo !== undefined ? { replyTo } : {}),
    attachments: normalizeAttachments(raw.attachments),
    embeds: normalizeEmbeds(raw.embeds),
    reactions: normalizeReactions(raw.reactions),
    mentions: normalizeMentions(raw.mentions),
    isSystem: !USER_MESSAGE_TYPES[raw.type ?? 0],
    permalink: permalink(ctx.host, guildId ?? null, channelId, raw.id),
  };
  assertUniversalMessage(result);
  return result;
}
