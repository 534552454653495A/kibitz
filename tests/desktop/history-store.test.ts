/**
 * The desktop history store. The behaviours that matter are the ones a user notices: the
 * list survives a store that has been damaged, saving the same conversation twice leaves one
 * row rather than two, "clear history" cannot reach the file holding the API key, and a
 * write that fails says so instead of throwing away the answer the user just got.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearConversations,
  deleteConversation,
  historyDir,
  historyIndexPath,
  listConversations,
  loadConversation,
  saveConversation,
} from "../../desktop/history-store";
import type { ConversationRecord } from "../../src/core/history";
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

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
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
    history: [{ role: "user", content: "explain" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
    ...overrides,
  };
}

let profile: string;
let dir: string;
beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), "kibitz-history-"));
  dir = path.join(profile, "history");
});
afterEach(async () => {
  await fs.rm(profile, { recursive: true, force: true });
});

describe("saveConversation / loadConversation / listConversations", () => {
  it("round-trips a record through a directory that did not exist yet", async () => {
    const saved = record();
    expect(await saveConversation(saved, dir)).toEqual({ ok: true });
    expect(await loadConversation(saved.id, dir)).toEqual(saved);
    expect(await listConversations(dir)).toEqual([
      expect.objectContaining({ id: saved.id, title: "Spider-Man ISO isteği", messageCount: 1, excerpt: saved.messages[0]?.content }),
    ]);
  });

  it("returns an empty list on a first run rather than failing the panel", async () => {
    await expect(listConversations(dir)).resolves.toEqual([]);
  });

  it("returns null for an id that was never saved", async () => {
    await expect(loadConversation("1767225600000-nope", dir)).resolves.toBeNull();
  });

  it("replaces the record and keeps exactly one index row when the same conversation grows", async () => {
    const first = record();
    await saveConversation(first, dir);
    const grown = record({
      title: "Spider-Man ISO isteği (devam)",
      messages: [message(), message({ id: "1000000000000000002", content: "hangi sürüm?" })],
      updatedAt: "2026-01-01T00:09:00.000Z",
    });
    expect(await saveConversation(grown, dir)).toEqual({ ok: true });

    const list = await listConversations(dir);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: grown.id, messageCount: 2, updatedAt: "2026-01-01T00:09:00.000Z" });
    expect((await loadConversation(grown.id, dir))?.messages).toHaveLength(2);
  });

  it("lists newest first", async () => {
    await saveConversation(record({ id: "1767225600000-old", updatedAt: "2026-01-01T00:00:00.000Z" }), dir);
    await saveConversation(record({ id: "1767225600000-new", updatedAt: "2026-02-01T00:00:00.000Z" }), dir);
    expect((await listConversations(dir)).map((s) => s.id)).toEqual(["1767225600000-new", "1767225600000-old"]);
  });

  it("skips an index row it cannot read instead of blanking the whole list", async () => {
    await saveConversation(record({ id: "1767225600000-good" }), dir);
    const rows = JSON.parse(await fs.readFile(historyIndexPath(dir), "utf8")) as unknown[];
    await fs.writeFile(historyIndexPath(dir), JSON.stringify([{ id: 7, nonsense: true }, ...rows]));
    expect((await listConversations(dir)).map((s) => s.id)).toEqual(["1767225600000-good"]);
  });

  it("skips a record file that is not a conversation", async () => {
    await saveConversation(record(), dir);
    await fs.writeFile(path.join(dir, "1767225600000-torn.json"), '{"id":"1767225600000-torn","messages"');
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(loadConversation("1767225600000-torn", dir)).resolves.toBeNull();
    expect((await listConversations(dir)).map((s) => s.id)).toEqual(["1767225600000-abc"]);
  });

  it("rebuilds the list from the record files when the index itself is unreadable", async () => {
    await saveConversation(record({ id: "1767225600000-a", updatedAt: "2026-01-01T00:00:00.000Z" }), dir);
    await saveConversation(record({ id: "1767225600000-b", updatedAt: "2026-03-01T00:00:00.000Z" }), dir);
    await fs.writeFile(historyIndexPath(dir), '[{"id": "1767');
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await listConversations(dir)).map((s) => s.id)).toEqual(["1767225600000-b", "1767225600000-a"]);
  });

  it("rebuilds the list when every index row is unreadable, rather than showing an empty history", async () => {
    await saveConversation(record(), dir);
    await fs.writeFile(historyIndexPath(dir), JSON.stringify([{ nonsense: true }]));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await listConversations(dir)).map((s) => s.id)).toEqual(["1767225600000-abc"]);
  });

  it("reports the path when the record cannot be written", async () => {
    // A directory where the record file belongs: the same ENOTDIR/EISDIR a full or
    // permission-denied disk produces, without needing to be root to arrange it.
    await fs.mkdir(path.join(dir, "1767225600000-abc.json"), { recursive: true });
    const result = await saveConversation(record(), dir);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(path.join(dir, "1767225600000-abc.json"));
  });

  it("refuses an id that would escape the history directory", async () => {
    const escaped = record({ id: "../settings" });
    expect(await saveConversation(escaped, dir)).toMatchObject({ ok: false });
    await expect(loadConversation("../settings", dir)).resolves.toBeNull();
    await expect(fs.readdir(dir).catch(() => [])).resolves.toEqual([]);
  });

  it.skipIf(process.platform === "win32")("keeps transcripts readable by the owner only, even over a wider existing file", async () => {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "1767225600000-abc.json");
    await fs.writeFile(file, "{}", { mode: 0o644 });
    await saveConversation(record(), dir);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(historyIndexPath(dir))).mode & 0o777).toBe(0o600);
  });
});

describe("deleteConversation / clearConversations", () => {
  it("removes one conversation and its index row, leaving the others", async () => {
    await saveConversation(record({ id: "1767225600000-a" }), dir);
    await saveConversation(record({ id: "1767225600000-b" }), dir);
    await deleteConversation("1767225600000-a", dir);
    expect(await loadConversation("1767225600000-a", dir)).toBeNull();
    expect((await listConversations(dir)).map((s) => s.id)).toEqual(["1767225600000-b"]);
  });

  it("does nothing for an id that is not there", async () => {
    await saveConversation(record(), dir);
    await deleteConversation("1767225600000-gone", dir);
    expect((await listConversations(dir)).map((s) => s.id)).toEqual(["1767225600000-abc"]);
  });

  it("clears every conversation without touching settings.json or ui-state.json", async () => {
    await fs.writeFile(path.join(profile, "settings.json"), '{"apiKey":"sk-1"}');
    await fs.writeFile(path.join(profile, "ui-state.json"), '{"view":"chat"}');
    await saveConversation(record(), dir);

    await clearConversations(dir);

    expect(await listConversations(dir)).toEqual([]);
    expect(await fs.readFile(path.join(profile, "settings.json"), "utf8")).toBe('{"apiKey":"sk-1"}');
    expect(await fs.readFile(path.join(profile, "ui-state.json"), "utf8")).toBe('{"view":"chat"}');
  });

  it("is a no-op on a store that was never written", async () => {
    await expect(clearConversations(dir)).resolves.toBeUndefined();
  });
});

describe("historyDir", () => {
  it("puts conversations in their own directory beside the settings file", () => {
    expect(historyDir(path.join(profile, "settings.json"))).toBe(dir);
    expect(historyIndexPath(dir)).toBe(path.join(dir, "index.json"));
  });
});
