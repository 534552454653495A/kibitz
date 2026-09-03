/**
 * Discord DOM + React contract — THE ONLY FILE that knows what Discord looks like.
 *
 * Architecture decisions 1 and 6:
 *   - Never a CSS class. Discord uses CSS Modules; class names are hashed per build and
 *     change on every deploy. Anything bound to them dies within days.
 *   - Everything Discord-specific and DOM/React-facing lives here. When Discord ships a
 *     breaking change, this file is updated, the probe goes green, a release is cut.
 *
 * What IS allowed: `id` and `data-*` attributes (Discord sets them for its own list
 * virtualisation and accessibility — they are semantic, not cosmetic), ARIA `role`s, and
 * URL structure. Each export below states why it is expected to be stable.
 *
 * Authority: probe/checks.ts exercises every export against live Discord Stable + Canary
 * every 6 hours. A comment here is a hypothesis; a green probe is the fact.
 */

/** Web client hosts. `ptb` = public test build, `canary` = alpha — changes land there first. */
export const HOSTS = ["discord.com", "canary.discord.com", "ptb.discord.com"] as const;

/**
 * Channel URL: /channels/<guildId | @me>/<channelId>[/<messageId>].
 * Stable because it is Discord's public permalink format (shared in every "Copy Message Link").
 */
export const CHANNEL_PATH = /^\/channels\/(@me|\d+)\/(\d+)(?:\/(\d+))?/;

export interface ChannelLocation {
  /** null for DMs (`@me`). */
  guildId: string | null;
  channelId: string;
  messageId?: string;
}

export function parseChannelPath(pathname: string): ChannelLocation | null {
  const m = CHANNEL_PATH.exec(pathname);
  if (!m) return null;
  const guild = m[1]!;
  return { guildId: guild === "@me" ? null : guild, channelId: m[2]!, ...(m[3] ? { messageId: m[3] } : {}) };
}

/**
 * The message list container. `data-list-id` is set by Discord's own list-navigation
 * code (keyboard focus management) — a functional attribute, not styling, so it has
 * survived every redesign so far. There is exactly one per chat view.
 */
export const MESSAGE_LIST = '[data-list-id="chat-messages"]';

/**
 * One rendered message. The `id` is required by Discord for `aria-labelledby` / focus
 * targeting: "chat-messages-<channelId>-<messageId>". Both parts are numeric snowflakes.
 * Items outside the viewport are REMOVED from the DOM (virtualised list, decision 3), so
 * never cache elements — re-query on every mutation batch.
 */
export const MESSAGE_ITEM = 'li[id^="chat-messages-"]';
export const MESSAGE_ITEM_ID = /^chat-messages-(\d+)-(\d+)$/;

export interface MessageItemId {
  channelId: string;
  messageId: string;
}

export function parseMessageItemId(id: string): MessageItemId | null {
  const m = MESSAGE_ITEM_ID.exec(id);
  return m ? { channelId: m[1]!, messageId: m[2]!} : null;
}

export function messageItemId(channelId: string, messageId: string): string {
  return `chat-messages-${channelId}-${messageId}`;
}

/**
 * The text body of a message: id "message-content-<messageId>". Used ONLY as the button
 * anchor (the button is appended inline after the text so it never collides with
 * Discord's hover toolbar in the top-right corner). Content itself comes from fiber.
 * Messages with no text (attachment-only) have no such element → fall back to the item.
 */
export const MESSAGE_CONTENT = '[id^="message-content-"]';
export function messageContentId(messageId: string): string {
  return `message-content-${messageId}`;
}

/** The message body wrapper inside an item. ARIA role — part of Discord's accessibility contract. */
export const MESSAGE_ARTICLE = '[role="article"]';

/**
 * React internals. React ≥17 stores the fiber on the DOM node under a key prefixed
 * "__reactFiber$" (React 16 used "__reactInternalInstance$"; Discord is on 18+).
 * From a message <li>'s fiber we walk `.return` (ancestors) looking for a component whose
 * `memoizedProps.message.id` equals the item's messageId; if not found we do a bounded
 * breadth-first walk down `.child`/`.sibling`. Both directions because the `<li>` may be
 * rendered either by the per-message component (props above) or by the list mapper
 * (props below). Limits keep a broken contract from turning into a CPU spin.
 */
export const FIBER = {
  keyPrefix: "__reactFiber$",
  /** Prop on the message component carrying Discord's MessageRecord. */
  messageProp: "message",
  /** Prop carrying the ChannelRecord; found on the same component or an ancestor. */
  channelProp: "channel",
  ancestorLimit: 40,
  descendantLimit: 300,
} as const;

/**
 * Discord `message.type` values that are ordinary user speech. Everything else (join,
 * pin, boost, thread-created, automod…) is a system notice → UniversalMessage.isSystem.
 * Source: Discord API "Message Types" (public documentation, stable numbering).
 *   0 DEFAULT, 19 REPLY, 20 CHAT_INPUT_COMMAND, 21 THREAD_STARTER_MESSAGE, 23 CONTEXT_MENU_COMMAND
 */
export const USER_MESSAGE_TYPES: Record<number, true> = { 0: true, 19: true, 20: true, 21: true, 23: true };

/**
 * Message-content markup (Discord API "Message Formatting", public + stable):
 *   <@id> / <@!id> user, <@&id> role, <#id> channel, <:name:id> / <a:name:id> custom emoji.
 */
export const CONTENT_MARKUP = {
  user: /<@!?(\d+)>/g,
  role: /<@&(\d+)>/g,
  channel: /<#(\d+)>/g,
  customEmoji: /<a?:(\w+):(\d+)>/g,
} as const;

/**
 * Fields we read from Discord's in-memory records (via fiber props). This is the raw
 * contract; normalize.ts maps it to UniversalMessage. Every field is optional at the type
 * level because the probe — not the type checker — decides what is actually present.
 * Names follow Discord's MessageRecord (camelCase client fields, snake_case API leftovers).
 */
export interface RawDiscordUser {
  id?: string;
  username?: string;
  globalName?: string | null;
  bot?: boolean;
}

export interface RawDiscordAttachment {
  id?: string;
  filename?: string;
  url?: string;
  proxy_url?: string;
  content_type?: string;
  size?: number;
}

export interface RawDiscordEmbed {
  rawTitle?: string;
  title?: string;
  rawDescription?: string;
  description?: string;
  url?: string;
  provider?: { name?: string } | null;
  fields?: Array<{ rawName?: string; name?: string; rawValue?: string; value?: string }>;
}

/** Discord's timestamps are Moment objects in memory; ISO strings in some code paths. */
export type RawDiscordTimestamp = string | { toISOString(): string } | null | undefined;

export interface RawDiscordMessage {
  id?: string;
  type?: number;
  channel_id?: string;
  content?: string;
  author?: RawDiscordUser;
  timestamp?: RawDiscordTimestamp;
  editedTimestamp?: RawDiscordTimestamp;
  attachments?: RawDiscordAttachment[];
  embeds?: RawDiscordEmbed[];
  /** Mentioned users; some builds carry full user objects, others only ids. */
  mentions?: Array<RawDiscordUser | string>;
  messageReference?: { message_id?: string; channel_id?: string; guild_id?: string } | null;
  reactions?: Array<{ emoji?: { id?: string | null; name?: string }; count?: number }>;
}

export interface RawDiscordChannel {
  id?: string;
  name?: string;
  guild_id?: string | null;
}

/**
 * Attachment → the URL we hand to a vision model.
 *
 * Discord serves uploads from `cdn.discordapp.com` and mirrors the same path on
 * `media.discordapp.net`, which re-encodes and resizes on demand through the
 * `format`/`width`/`height` query parameters. That is exactly what Discord's own web and
 * desktop clients request for every inline preview, which is why it is expected to stay:
 * it is public, documented CDN behaviour that every client depends on, not an internal
 * detail. The point for us is money — a 4000×3000 phone photo costs the user several times
 * the tokens of the same picture bounded to 1024px, and no explanation needs the full one.
 *
 * `width`/`height` are a bounding box: the proxy preserves the aspect ratio and only ever
 * scales down, so passing a square box yields "longest edge ≤ 1024".
 *
 * The signature parameters Discord appends to modern attachment links (`ex`, `is`, `hm`)
 * MUST survive: an unsigned CDN link is a 404, and the model would then be told about an
 * image it cannot fetch. Hence "copy the query, add ours" rather than building a URL.
 *
 * The probe cannot verify this (2026-09-02): `probe/fixtures/discord-like.html` serves no
 * real attachments and a live probe would have to fetch a signed link from a throwaway
 * account's channel. It is verified by unit tests over URL strings instead — the rule is a
 * pure string transformation, so that covers everything except Discord retiring the proxy.
 */
export interface ImagePreviewRule {
  host: string;
  maxEdge: number;
  params: Record<string, string>;
}

const PREVIEW_MAX_EDGE = 1024;

export const IMAGE_PREVIEW: ImagePreviewRule = {
  host: "media.discordapp.net",
  maxEdge: PREVIEW_MAX_EDGE,
  // webp is what the client asks for and both vision APIs we target accept it.
  params: { format: "webp", width: String(PREVIEW_MAX_EDGE), height: String(PREVIEW_MAX_EDGE) },
};

/** Hosts whose path the proxy mirrors 1:1. Any other origin is not ours to rewrite. */
const PREVIEW_SOURCE_HOSTS = ["cdn.discordapp.com", "media.discordapp.net"];

function toPreviewUrl(candidate: string | undefined): string | undefined {
  if (candidate === undefined || candidate === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  // https only: the proxy is https, and rewriting anything else would invent a URL.
  if (parsed.protocol !== "https:" || !PREVIEW_SOURCE_HOSTS.includes(parsed.hostname)) return undefined;
  parsed.hostname = IMAGE_PREVIEW.host;
  for (const [key, value] of Object.entries(IMAGE_PREVIEW.params)) parsed.searchParams.set(key, value);
  return parsed.toString();
}

/**
 * `proxy_url` first — it is Discord's own mirror of the attachment — then the raw `url`.
 * Returns undefined when neither is a Discord CDN link we know how to resize; the caller
 * then sends the original URL, which is correct, just larger.
 */
export function previewUrlFor(rawUrl: string, proxyUrl: string | undefined): string | undefined {
  return toPreviewUrl(proxyUrl) ?? toPreviewUrl(rawUrl);
}

/**
 * The scrollable ancestor of the message list. Found by computed style rather than by a
 * selector: Discord's scroller element carries only hashed classes. Walks up from the
 * list root until it meets an element that actually scrolls vertically.
 */
export function findScrollContainer(listRoot: Element): HTMLElement | null {
  let el: HTMLElement | null = listRoot instanceof HTMLElement ? listRoot : listRoot.parentElement;
  while (el && el !== document.body) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return null;
}

/** Public permalink; guildId null → DM ("@me"). Matches Discord's "Copy Message Link". */
export function permalink(host: string, guildId: string | null, channelId: string, messageId: string): string {
  return `https://${host}/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
}
