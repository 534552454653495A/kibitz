/**
 * The history contract. Two failure modes dominate here and both are defended below:
 * storage returns values this code did not write (older versions, half-written files), and a
 * search that is too eager returns everything, which is the same as returning nothing.
 */
import { describe, expect, it } from "vitest";
import {
  byRecency,
  catalogueLine,
  clip,
  fallbackTitle,
  matchesQuery,
  newConversationId,
  parseConversation,
  parseMatches,
  parseSummary,
  participantsOf,
  searchableText,
  summarise,
  summarySearchText,
  type ConversationRecord,
} from "../../src/core/history";
import type { UniversalMessage } from "../../src/core/types";

function message(overrides: Partial<UniversalMessage> = {}): UniversalMessage {
  return {
    platform: "discord",
    id: "1000000000000000001",
    channel: { id: "c1" },
    author: { id: "u1", name: "Yunus", isBot: false },
    content: "Spider man 2 Türkçe iso",
    createdAt: "2026-01-01T00:00:00.000Z",
    attachments: [],
    embeds: [],
    reactions: [],
    mentions: [],
    isSystem: false,
    ...overrides,
  };
}

const record: ConversationRecord = {
  id: "1767225600000-abc",
  platform: "discord",
  channelId: "c1",
  title: "Spider-Man ISO isteği",
  participants: [{ id: "u1", name: "Yunus" }],
  messages: [message()],
  turns: [
    { role: "message", message: message() },
    { role: "assistant", text: "Yunus bir ISO dosyası arıyor." },
  ],
  history: [
    { role: "system", content: "rules" },
    { role: "user", content: "explain" },
    { role: "assistant", content: "Yunus bir ISO dosyası arıyor." },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:05:00.000Z",
};

describe("newConversationId", () => {
  // Sortable by time and usable as a filename on the companion; both are load-bearing.
  it("sorts by creation time as a plain string and stays filename-safe", () => {
    const older = newConversationId(1_000);
    const newer = newConversationId(2_000);
    expect(older < newer).toBe(true);
    expect(newer).toMatch(/^\d+-[a-z0-9]+$/);
  });

  it("does not collide when two conversations start in the same millisecond", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newConversationId(5_000)));
    expect(ids.size).toBeGreaterThan(190);
  });
});

describe("summarise", () => {
  it("drops the transcript so a list of a thousand conversations stays cheap", () => {
    const summary = summarise(record);
    expect(summary).toMatchObject({ id: record.id, title: record.title, messageCount: 1 });
    expect(summary.excerpt).toBe("Spider man 2 Türkçe iso");
    expect(JSON.stringify(summary)).not.toContain("rules");
    expect("turns" in summary).toBe(false);
    expect("history" in summary).toBe(false);
  });
});

describe("participantsOf and fallbackTitle", () => {
  it("lists each author once, in the order they first appear", () => {
    expect(
      participantsOf([message(), message({ id: "2", author: { id: "u2", name: "Adem", isBot: false } }), message({ id: "3" })]),
    ).toEqual([
      { id: "u1", name: "Yunus" },
      { id: "u2", name: "Adem" },
    ]);
  });

  // A recognisable label beats a placeholder that needs a click to identify.
  it("names the author and their words rather than 'Untitled'", () => {
    expect(fallbackTitle([message()])).toBe("Yunus: Spider man 2 Türkçe iso");
    expect(fallbackTitle([message({ content: "" })])).toBe("Yunus's message");
  });
});

describe("matchesQuery", () => {
  const haystack = searchableText(record);

  it("requires every word, because two words are how a user narrows a long history", () => {
    expect(matchesQuery(haystack, "yunus iso")).toBe(true);
    expect(matchesQuery(haystack, "yunus minecraft")).toBe(false);
  });

  it("searches the answers too, not only the messages", () => {
    expect(matchesQuery(haystack, "dosyası arıyor")).toBe(true);
  });

  it("treats an empty query as no filter instead of no results", () => {
    expect(matchesQuery(haystack, "   ")).toBe(true);
  });

  it("finds a conversation from its summary alone, which is all the list has loaded", () => {
    expect(matchesQuery(summarySearchText(summarise(record)), "spider")).toBe(true);
  });
});

describe("catalogueLine", () => {
  it("leads with the id so the model can name a match exactly", () => {
    const line = catalogueLine(summarise(record));
    expect(line.startsWith(`${record.id} | 2026-01-01 | Yunus | Spider-Man ISO isteği |`)).toBe(true);
    expect(line).not.toContain("\n");
  });
});

describe("parseMatches", () => {
  it("reads the ids the model named", () => {
    expect(parseMatches("Yes, two fit.\nMATCHES: 1767225600000-abc, 1767225600001-def")).toEqual([
      "1767225600000-abc",
      "1767225600001-def",
    ]);
  });

  it("reads no matches from an empty line or a missing one, rather than guessing", () => {
    expect(parseMatches("Nothing fits.\nMATCHES:")).toEqual([]);
    expect(parseMatches("I could not find it.")).toEqual([]);
  });

  // A model that invents a match must not send the user to a conversation that cannot exist.
  it("ignores anything that is not shaped like an id", () => {
    expect(parseMatches("MATCHES: none, the-first-one, 1767225600000-abc")).toEqual(["1767225600000-abc"]);
  });
});

describe("parseConversation", () => {
  it("round-trips a record written by this version", () => {
    expect(parseConversation(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  // Storage holds whatever an older version wrote; a record we cannot read must be skipped,
  // never crash the list that contains it.
  it("rejects a value that is not a usable record", () => {
    expect(parseConversation(null)).toBeNull();
    expect(parseConversation({ ...record, id: "" })).toBeNull();
    expect(parseConversation({ ...record, messages: [] })).toBeNull();
    expect(parseConversation({ ...record, messages: [{ id: "no author" }] })).toBeNull();
    expect(parseConversation({ ...record, turns: "not an array" })).toBeNull();
  });

  it("keeps the record and drops only the unreadable turn", () => {
    const parsed = parseConversation({ ...record, turns: [...record.turns, { role: "assistant" }, { role: "??", text: "x" }] });
    expect(parsed?.turns).toEqual(record.turns);
  });

  it("recovers a missing title and missing participants instead of refusing the record", () => {
    const parsed = parseConversation({ ...record, title: "", participants: undefined });
    expect(parsed?.title).toBe("Yunus: Spider man 2 Türkçe iso");
    expect(parsed?.participants).toEqual([{ id: "u1", name: "Yunus" }]);
  });
});

describe("parseSummary", () => {
  it("round-trips a summary and rejects one with no id", () => {
    const summary = summarise(record);
    expect(parseSummary(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
    expect(parseSummary({ ...summary, id: undefined })).toBeNull();
  });
});

describe("byRecency and clip", () => {
  it("puts the most recently touched conversation first", () => {
    const older = { ...summarise(record), id: "a", updatedAt: "2026-01-01T00:00:00.000Z" };
    const newer = { ...summarise(record), id: "b", updatedAt: "2026-02-01T00:00:00.000Z" };
    expect([older, newer].sort(byRecency).map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("collapses whitespace and marks that it cut something", () => {
    expect(clip("  a\n\n  b  ")).toBe("a b");
    expect(clip("abcdef", 4)).toBe("abc…");
  });
});
