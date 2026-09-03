/**
 * UniversalMessage — the only message shape the core, the UI and the prompts ever see.
 *
 * Architecture decision 7: adapters normalise platform records into this type; the core
 * knows nothing about Discord. When the second platform (YouTube) arrives, this file may
 * gain optional fields but must not gain platform-specific ones. If you find yourself
 * adding `discordFlags`, stop — put it behind a generic concept or leave it out.
 *
 * Everything here is JSON-serialisable on purpose: instances cross three boundaries
 * (MAIN world → isolated world → service worker) as JSON strings.
 */

/** Grows by one literal per adapter. */
export type Platform = "discord";

export interface UniversalAuthor {
  id: string;
  /** Name to show a human: display name / nickname, falling back to the handle. */
  name: string;
  /** Platform handle (e.g. Discord username) when distinct from `name`. */
  handle?: string;
  isBot: boolean;
}

export type AttachmentKind = "image" | "video" | "audio" | "file";

export interface UniversalAttachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  url: string;
  /** A URL better suited to a vision model than `url` when the platform offers one
   *  (Discord's media proxy re-encodes and resizes). Core never inspects why. */
  previewUrl?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface UniversalEmbedField {
  name: string;
  value: string;
}

export interface UniversalEmbed {
  title?: string;
  description?: string;
  url?: string;
  /** Site/provider name, e.g. "YouTube", "GitHub". */
  provider?: string;
  fields: UniversalEmbedField[];
}

export interface UniversalReaction {
  /** Unicode emoji, or `:name:` for platform-custom emoji. */
  emoji: string;
  count: number;
}

export interface UniversalMention {
  id: string;
  name: string;
}

export interface UniversalReply {
  messageId: string;
  authorName?: string;
  /** Short plain-text excerpt of the replied-to message when it was resolvable. */
  excerpt?: string;
}

export interface UniversalChannel {
  id: string;
  name?: string;
  guildId?: string;
  guildName?: string;
}

export interface UniversalMessage {
  platform: Platform;
  id: string;
  channel: UniversalChannel;
  author: UniversalAuthor;
  /**
   * Plain text with platform mention syntax already resolved to human-readable form
   * (`<@123>` → `@alice`). Markdown from the platform is kept as-is.
   */
  content: string;
  /** ISO 8601 (UTC). */
  createdAt: string;
  editedAt?: string;
  replyTo?: UniversalReply;
  attachments: UniversalAttachment[];
  embeds: UniversalEmbed[];
  reactions: UniversalReaction[];
  mentions: UniversalMention[];
  /** Join/pin/boost style notices — the LLM should treat these as events, not speech. */
  isSystem: boolean;
  permalink?: string;
}

/** Identity of a message without its content; what a button carries. */
export interface MessageRef {
  platform: Platform;
  channelId: string;
  messageId: string;
}

/** Result of a "scan related messages" collection. */
export interface UniversalThread {
  anchor: UniversalMessage;
  /** Chronological, includes the anchor. */
  messages: UniversalMessage[];
  /** True when collection stopped on a limit rather than on exhausting the history. */
  truncated: boolean;
}
