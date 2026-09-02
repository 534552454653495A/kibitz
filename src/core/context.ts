/**
 * Serialises UniversalMessage / UniversalThread into the plain-text block the LLM reads.
 *
 * Plain text rather than JSON: a model reads "[time] Alice: hi" far more reliably than a
 * nested object, and the output is stable enough to be diffed in tests. Deterministic and
 * DOM-free on purpose — the same function runs in tests, in the panel and (potentially)
 * in the service worker.
 */
import type { UniversalMessage, UniversalThread } from "./types";

/** Marks the anchor message inside a serialised thread; the synthesis prompt refers to it. */
export const ANCHOR_MARK = ">>> ";

const INDENT = "    ";
const MESSAGE_SEPARATOR = "\n\n";

function authorLabel(m: UniversalMessage): string {
  const { author } = m;
  let label = author.name;
  if (author.handle !== undefined && author.handle !== author.name) label += ` (@${author.handle})`;
  if (author.isBot) label += " [bot]";
  if (m.isSystem) label += " [system notice]";
  return label;
}

export interface SerializeMessageOptions {
  /**
   * Ids of image attachments that travel with this request as real pictures. They are
   * named rather than linked: told a URL, a model describes the link ("an image called
   * cat.png is attached") instead of the picture it can already see, and a model without
   * vision would try to reason about the filename. Everything else keeps its URL, which
   * is all the user can do with it too.
   */
  attachedImageIds?: ReadonlySet<string>;
}

export function serializeMessage(m: UniversalMessage, opts: SerializeMessageOptions = {}): string {
  const lines: string[] = [`[${m.createdAt}] ${authorLabel(m)}: ${m.content}`];
  if (m.editedAt !== undefined) lines.push(`${INDENT}(edited ${m.editedAt})`);

  if (m.replyTo !== undefined) {
    const who = m.replyTo.authorName ?? "unknown";
    const excerpt = m.replyTo.excerpt === undefined ? "" : `: ${m.replyTo.excerpt}`;
    lines.push(`${INDENT}↳ reply to ${who}${excerpt}`);
  }

  for (const a of m.attachments) {
    lines.push(
      opts.attachedImageIds?.has(a.id) === true
        ? `${INDENT}[image attached to this request: ${a.name}]`
        : `${INDENT}[attachment: ${a.kind} ${a.name} ${a.url}]`,
    );
  }

  for (const e of m.embeds) {
    const parts: string[] = [];
    if (e.title !== undefined) parts.push(e.title);
    if (e.description !== undefined) parts.push(e.description);
    let head = parts.join(" — ");
    if (e.provider !== undefined) head += ` (${e.provider})`;
    if (e.url !== undefined) head += ` ${e.url}`;
    lines.push(`${INDENT}[embed: ${head.trim()}]`);
    for (const f of e.fields) lines.push(`${INDENT}${INDENT}${f.name}: ${f.value}`);
  }

  if (m.reactions.length > 0) {
    lines.push(`${INDENT}reactions: ${m.reactions.map((r) => `${r.emoji}×${r.count}`).join(" ")}`);
  }

  if (m.permalink !== undefined) lines.push(`${INDENT}permalink: ${m.permalink}`);

  return lines.join("\n");
}

export interface SerializeThreadOptions extends SerializeMessageOptions {
  /** Upper bound on the returned text length; the anchor always survives trimming. */
  charBudget: number;
}

/** Messages in the order the adapter collected them, with the anchor guaranteed present. */
function orderedMessages(t: UniversalThread): UniversalMessage[] {
  if (t.messages.some((m) => m.id === t.anchor.id)) return t.messages;
  // An adapter that forgot to include the anchor still gets a coherent thread rather
  // than a summary of a conversation whose subject is missing.
  return [...t.messages, t.anchor].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function serializeThread(t: UniversalThread, opts: SerializeThreadOptions): string {
  const messages = orderedMessages(t);
  const anchorIndex = messages.findIndex((m) => m.id === t.anchor.id);
  const blocks = messages.map((m, i) => {
    const text = serializeMessage(m, opts);
    return i === anchorIndex ? ANCHOR_MARK + text : text;
  });

  // Shrink a window [lo, hi] around the anchor, always removing the message farthest
  // from it: proximity is the best proxy for relevance in a linear chat.
  let lo = 0;
  let hi = blocks.length - 1;
  let total = blocks.reduce((sum, b) => sum + b.length, 0) + MESSAGE_SEPARATOR.length * (blocks.length - 1);
  while (total > opts.charBudget && lo < hi) {
    const dropLow = anchorIndex - lo > hi - anchorIndex;
    const dropped = dropLow ? blocks[lo++] : blocks[hi--];
    total -= (dropped?.length ?? 0) + MESSAGE_SEPARATOR.length;
  }

  const out: string[] = [];
  if (lo > 0) out.push(`(… ${lo} earlier message${lo === 1 ? "" : "s"} omitted)`);
  out.push(...blocks.slice(lo, hi + 1));
  const later = blocks.length - 1 - hi;
  if (later > 0) out.push(`(… ${later} later message${later === 1 ? "" : "s"} omitted)`);
  return out.join(MESSAGE_SEPARATOR);
}
