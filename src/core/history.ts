/**
 * Conversation history: the shape a saved conversation has, and the pure helpers both hosts
 * and the panel need for it.
 *
 * Why the transcript vocabulary lives HERE and not in the panel: a saved conversation has to
 * be re-openable, which means the display turns are part of the record, and a record is
 * something both hosts read and write. `Turn` therefore belongs to the core; the panel's
 * state machine imports it rather than declaring its own (two shapes for one thing is a bug
 * even when both work — AGENTS.md 5).
 *
 * What is deliberately NOT here: storage. The extension keeps records in
 * `chrome.storage.local` and the companion in files, so both sit behind `Shell`
 * (AGENTS.md 3.7). This module stays pure and Node-safe, because the companion imports it.
 */
import type { ChatMessage } from "./messaging";
import type { UniversalMessage } from "./types";
import { assertUniversalMessage, isRecord } from "./validate";

/**
 * One entry in a conversation transcript, in render order. A message card is a turn like any
 * other because a conversation can cover several messages: clicking a second message that
 * belongs to it appends its card and its answer under the first (owner's request,
 * 2026-09-03). A fixed card above the turns could only ever show one.
 */
export type Turn =
  | { role: "user" | "assistant" | "note" | "error"; text: string }
  | { role: "message"; message: UniversalMessage };

/** Narrowing helper: the text roles are the ones that carry `text`. */
export function isTextTurn(turn: Turn): turn is { role: "user" | "assistant" | "note" | "error"; text: string } {
  return turn.role !== "message";
}

export interface Participant {
  id: string;
  name: string;
}

/**
 * A saved conversation, everything needed to reopen it AND to keep asking: `turns` is what
 * the panel renders, `history` is what the model is given. Both are stored because neither
 * can be derived from the other — a synthesis after "Scan related messages" replaces the
 * history with a thread prompt that the display turns do not contain, and the display turns
 * carry notes and errors the model never saw.
 */
export interface ConversationRecord {
  /** Sortable, unique, and readable in a filename: `<epoch ms>-<random>`. */
  id: string;
  platform: string;
  channelId: string;
  /** 3-5 words from the model, or the fallback below when that request could not run. */
  title: string;
  /** Everyone whose message is in the conversation, for the list and for search. */
  participants: Participant[];
  /** The cards, in the order they were asked about. */
  messages: UniversalMessage[];
  turns: Turn[];
  history: ChatMessage[];
  /** ISO 8601. `updatedAt` moves every time an answer or a message is added. */
  createdAt: string;
  updatedAt: string;
}

/** What a list needs: no transcript, so listing a thousand conversations stays cheap. */
export interface ConversationSummary {
  id: string;
  platform: string;
  channelId: string;
  title: string;
  participants: Participant[];
  messageCount: number;
  /** First message's text, clipped — the one line that says what this was about. */
  excerpt: string;
  createdAt: string;
  updatedAt: string;
}

export type SaveHistoryResult = { ok: true } | { ok: false; error: string };

/** Long enough to recognise a conversation, short enough that a catalogue of them fits. */
const EXCERPT_MAX = 140;
/** A title is a label, not a sentence; anything longer is the model ignoring the prompt. */
const TITLE_MAX = 60;

export function clip(text: string, max = EXCERPT_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Ids are `<epoch ms>-<random>`: sortable by time without parsing, unique without a
 * dependency, and safe as a filename on every platform the companion runs on.
 */
export function newConversationId(now = Date.now()): string {
  const random = Math.floor(Math.random() * 0xfff_fff).toString(36);
  return `${now.toString(10)}-${random}`;
}

export function participantsOf(messages: readonly UniversalMessage[]): Participant[] {
  const seen = new Map<string, string>();
  for (const message of messages) {
    if (!seen.has(message.author.id)) seen.set(message.author.id, message.author.name);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

/**
 * The label used until the model's title arrives (and permanently if that request fails or
 * the user has no key): the first message's own words. Never "Untitled" — a conversation the
 * user can recognise beats a placeholder that needs a click to identify.
 */
export function fallbackTitle(messages: readonly UniversalMessage[]): string {
  const first = messages[0];
  if (first === undefined) return "New conversation";
  const text = clip(first.content, 48);
  return text.length > 0 ? `${first.author.name}: ${text}` : `${first.author.name}'s message`;
}

export function summarise(record: ConversationRecord): ConversationSummary {
  const { messages, turns: _turns, history: _history, ...rest } = record;
  return { ...rest, messageCount: messages.length, excerpt: clip(messages[0]?.content ?? "") };
}

/**
 * Everything a local search can see, lowercased once. Answers are included on purpose: the
 * thing a user remembers is often what Kibitz told them, not the message that prompted it.
 */
export function searchableText(record: ConversationRecord): string {
  const parts = [record.title, ...record.participants.map((p) => p.name), ...record.messages.map((m) => m.content)];
  for (const turn of record.turns) {
    if (isTextTurn(turn) && (turn.role === "assistant" || turn.role === "user")) parts.push(turn.text);
  }
  return parts.join("\n").toLowerCase();
}

/**
 * Instant, free filter over a summary: every whitespace-separated word must appear somewhere
 * in the haystack. AND rather than OR because two words are how a user narrows, and an OR
 * search over a long history returns everything.
 */
export function matchesQuery(haystack: string, query: string): boolean {
  const needles = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (needles.length === 0) return true;
  return needles.every((needle) => haystack.includes(needle));
}

/** What a summary contributes to a local search when the full record is not loaded. */
export function summarySearchText(summary: ConversationSummary): string {
  return [summary.title, summary.excerpt, ...summary.participants.map((p) => p.name)].join("\n").toLowerCase();
}

/**
 * One line per conversation for the model to choose from: id first so it can name matches
 * exactly, then the facts a person searches by (when, who, what).
 *
 * Kept to one line each because the whole point of the single-request design is that the
 * catalogue is small enough to send in full — a two-pass search would cost twice as much for
 * a question the user asks casually.
 */
export function catalogueLine(summary: ConversationSummary): string {
  const when = summary.updatedAt.slice(0, 10);
  const who = summary.participants.map((p) => p.name).join(", ");
  return `${summary.id} | ${when} | ${who} | ${summary.title} | ${clip(summary.excerpt, 100)}`;
}

/** The ids the model named, tolerant of formatting: a missing line means "no matches". */
export function parseMatches(answer: string): string[] {
  const line = /^\s*MATCHES:\s*(.+)$/im.exec(answer);
  if (line?.[1] === undefined) return [];
  return line[1]
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter((id) => /^\d+-[a-z0-9]+$/.test(id));
}

/**
 * A stored message is validated with the project's own contract validator rather than being
 * cast: this is storage, so the value may predate a field or have been written by a bug, and
 * the panel renders it straight into the UI.
 */
function messageOf(value: unknown): UniversalMessage | null {
  try {
    assertUniversalMessage(value);
    return value;
  } catch {
    return null;
  }
}

function turnOf(value: unknown): Turn | null {
  if (!isRecord(value)) return null;
  if (value.role === "message") {
    const message = messageOf(value.message);
    return message === null ? null : { role: "message", message };
  }
  if (value.role !== "user" && value.role !== "assistant" && value.role !== "note" && value.role !== "error") return null;
  return typeof value.text === "string" ? { role: value.role, text: value.text } : null;
}

/**
 * Records come back from storage, which is untrusted input: a record written by an older
 * version, a half-written file, or a value some other extension put in the same key. A
 * conversation that cannot be parsed is dropped from the list rather than crashing it —
 * losing one history entry is recoverable, a panel that will not open is not.
 */
export function parseConversation(value: unknown): ConversationRecord | null {
  if (!isRecord(value)) return null;
  const { id, platform, channelId, title, createdAt, updatedAt } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof platform !== "string" || typeof channelId !== "string") return null;
  if (typeof createdAt !== "string" || typeof updatedAt !== "string") return null;
  if (!Array.isArray(value.messages) || !Array.isArray(value.turns) || !Array.isArray(value.history)) return null;
  const messages = value.messages.flatMap((entry) => {
    const message = messageOf(entry);
    return message === null ? [] : [message];
  });
  if (messages.length === 0) return null;
  const turns = value.turns.map(turnOf).filter((turn): turn is Turn => turn !== null);
  const history = value.history.filter((entry): entry is ChatMessage => isRecord(entry) && typeof entry.content === "string");
  return {
    id,
    platform,
    channelId,
    title: typeof title === "string" && title.length > 0 ? clip(title, TITLE_MAX) : fallbackTitle(messages),
    participants: Array.isArray(value.participants)
      ? value.participants.flatMap((p) => (isRecord(p) && typeof p.id === "string" && typeof p.name === "string" ? [{ id: p.id, name: p.name }] : []))
      : participantsOf(messages),
    messages,
    turns,
    history,
    createdAt,
    updatedAt,
  };
}

export function parseSummary(value: unknown): ConversationSummary | null {
  if (!isRecord(value)) return null;
  const { id, platform, channelId, title, excerpt, createdAt, updatedAt, messageCount } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof platform !== "string" || typeof channelId !== "string" || typeof title !== "string") return null;
  if (typeof createdAt !== "string" || typeof updatedAt !== "string") return null;
  return {
    id,
    platform,
    channelId,
    title,
    excerpt: typeof excerpt === "string" ? excerpt : "",
    messageCount: typeof messageCount === "number" && Number.isFinite(messageCount) ? messageCount : 0,
    participants: Array.isArray(value.participants)
      ? value.participants.flatMap((p) => (isRecord(p) && typeof p.id === "string" && typeof p.name === "string" ? [{ id: p.id, name: p.name }] : []))
      : [],
    createdAt,
    updatedAt,
  };
}

/** Newest first: the conversation a user wants next is almost always the last one they had. */
export function byRecency(a: ConversationSummary, b: ConversationSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}
