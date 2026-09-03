import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearConversations,
  deleteConversation,
  listConversations,
  loadConversation,
  saveConversation,
} from "../../src/background/history-service";
import type { ConversationRecord } from "../../src/core/history";
import type { UniversalMessage } from "../../src/core/types";

// A stand-in for chrome.storage.local, installed before shared/ext.ts evaluates `chrome` at
// import time (hence vi.hoisted). The store is the assertion target: what ends up under
// which key is the contract, not which API call was made. `refuse` makes the next write
// fail the way a full profile does, which is the only save failure that matters here.
const fakeChrome = vi.hoisted(() => {
  const state = {
    store: {} as Record<string, unknown>,
    /** Set to a message to make every `set` reject, as a quota failure does. */
    refuse: null as string | null,
    /** The other way Chrome reports a refused write: a callback-style lastError. */
    lastError: undefined as { message: string } | undefined,
  };
  Object.assign(globalThis, {
    chrome: {
      runtime: {
        get lastError() {
          return state.lastError;
        },
      },
      storage: {
        local: {
          get: (key: string | null) => {
            if (key === null) return Promise.resolve({ ...state.store });
            return Promise.resolve(key in state.store ? { [key]: state.store[key] } : {});
          },
          set: (items: Record<string, unknown>) => {
            if (state.refuse !== null) return Promise.reject(new Error(state.refuse));
            Object.assign(state.store, items);
            return Promise.resolve();
          },
          remove: (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete state.store[key];
            return Promise.resolve();
          },
        },
      },
    },
  });
  return state;
});

const message: UniversalMessage = {
  platform: "discord",
  id: "1000000000000000001",
  channel: { id: "c1" },
  author: { id: "u-yunus", name: "Yunus", isBot: false },
  content: "AI konusunu tartışalım",
  createdAt: "2026-09-01T10:00:00.000Z",
  attachments: [],
  embeds: [],
  reactions: [],
  mentions: [],
  isSystem: false,
};

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: "1756700000000-abc",
    platform: "discord",
    channelId: "c1",
    title: "Yunus on AI models",
    participants: [{ id: "u-yunus", name: "Yunus" }],
    messages: [message],
    turns: [
      { role: "message", message },
      { role: "assistant", text: "It is about AI." },
    ],
    history: [{ role: "user", content: "explain" }],
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:05:00.000Z",
    ...overrides,
  };
}

const index = (): unknown[] => fakeChrome.store["kibitz.conv.index"] as unknown[];

beforeEach(() => {
  fakeChrome.store = {};
  fakeChrome.refuse = null;
  fakeChrome.lastError = undefined;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("saving and listing", () => {
  it("round-trips a record and lists it from an index that carries no transcript", async () => {
    await expect(saveConversation(record())).resolves.toEqual({ ok: true });

    const listed = await listConversations();
    expect(listed).toEqual([
      {
        id: "1756700000000-abc",
        platform: "discord",
        channelId: "c1",
        title: "Yunus on AI models",
        participants: [{ id: "u-yunus", name: "Yunus" }],
        messageCount: 1,
        excerpt: "AI konusunu tartışalım",
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-01T10:05:00.000Z",
      },
    ]);
    // The point of the index: listing a thousand conversations must not carry a thousand
    // transcripts, so the entry has none of the three heavy fields.
    const entry = index()[0] as Record<string, unknown>;
    expect(entry.messages).toBeUndefined();
    expect(entry.turns).toBeUndefined();
    expect(entry.history).toBeUndefined();

    const loaded = await loadConversation("1756700000000-abc");
    expect(loaded?.turns).toHaveLength(2);
    expect(loaded?.history).toEqual([{ role: "user", content: "explain" }]);
  });

  it("newest first, because the conversation a user wants next is the last one they had", async () => {
    await saveConversation(record({ id: "old", updatedAt: "2026-09-01T09:00:00.000Z" }));
    await saveConversation(record({ id: "new", updatedAt: "2026-09-02T09:00:00.000Z" }));
    expect((await listConversations()).map((s) => s.id)).toEqual(["new", "old"]);
  });

  // The panel saves the same conversation over and over as it grows; a second index entry
  // for it would show the user two rows for one conversation.
  it("replaces a record saved twice under one id and keeps exactly one index entry", async () => {
    await saveConversation(record({ title: "First guess" }));
    await saveConversation(record({ title: "Yunus on AI models", updatedAt: "2026-09-01T11:00:00.000Z" }));

    const listed = await listConversations();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toBe("Yunus on AI models");
    expect(listed[0]?.updatedAt).toBe("2026-09-01T11:00:00.000Z");
    expect(index()).toHaveLength(1);
  });
});

describe("a store that refuses the write", () => {
  it("reports the failure in words that name deletion, and leaves what was already saved", async () => {
    await saveConversation(record({ id: "kept" }));

    fakeChrome.refuse = "QUOTA_BYTES quota exceeded";
    const result = await saveConversation(record({ id: "doomed" }));

    expect(result.ok).toBe(false);
    const error = result.ok ? "" : result.error;
    expect(error).toMatch(/delete some conversations/i);
    expect(error).toContain("QUOTA_BYTES quota exceeded");

    fakeChrome.refuse = null;
    // Retention is unlimited and nothing prunes: the failed save must not have cost the
    // user the history they already had.
    expect((await listConversations()).map((s) => s.id)).toEqual(["kept"]);
    expect(await loadConversation("kept")).not.toBeNull();
    expect(await loadConversation("doomed")).toBeNull();
  });

  it("reports a callback-style failure reported through runtime.lastError the same way", async () => {
    fakeChrome.lastError = { message: "storage is unavailable" };
    const result = await saveConversation(record());
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toMatch(/delete some conversations/i);
  });
});

describe("unreadable storage", () => {
  it("skips a corrupt index entry and still returns the rest of the list", async () => {
    await saveConversation(record({ id: "good" }));
    fakeChrome.store["kibitz.conv.index"] = [{ id: "broken" }, ...index()];

    expect((await listConversations()).map((s) => s.id)).toEqual(["good"]);
  });

  it("answers null for a record that cannot be parsed instead of throwing at the panel", async () => {
    await saveConversation(record({ id: "half-written" }));
    fakeChrome.store["kibitz.conv.half-written"] = { id: "half-written", messages: "not a list" };

    expect(await loadConversation("half-written")).toBeNull();
    // The index entry is independent, so the conversation is still listed and the user can
    // delete the row rather than being stuck with a list that will not open.
    expect((await listConversations()).map((s) => s.id)).toEqual(["half-written"]);
  });

  it("degrades to an empty list when the whole index is not a list", async () => {
    fakeChrome.store["kibitz.conv.index"] = "corrupted";
    await expect(listConversations()).resolves.toEqual([]);
  });

  it("answers null for an id that was never stored", async () => {
    expect(await loadConversation("nope")).toBeNull();
  });
});

describe("deleting", () => {
  it("removes both the record and its index row, leaving the others alone", async () => {
    await saveConversation(record({ id: "a" }));
    await saveConversation(record({ id: "b" }));

    await deleteConversation("a");

    expect(await loadConversation("a")).toBeNull();
    expect((await listConversations()).map((s) => s.id)).toEqual(["b"]);
    expect(fakeChrome.store["kibitz.conv.a"]).toBeUndefined();
  });

  it("clears every conversation, including one the index lost track of", async () => {
    await saveConversation(record({ id: "a" }));
    await saveConversation(record({ id: "b" }));
    fakeChrome.store["kibitz.conv.orphan"] = record({ id: "orphan" });
    fakeChrome.store.settings = { provider: "anthropic", apiKey: "sk-stored" };
    fakeChrome.store.uiState = { panelLayout: { mode: "right" } };

    await clearConversations();

    expect(await listConversations()).toEqual([]);
    expect(Object.keys(fakeChrome.store).filter((k) => k.startsWith("kibitz.conv."))).toEqual([]);
    // Clearing history is not signing out: the key and the panel's layout survive it.
    expect(fakeChrome.store.settings).toEqual({ provider: "anthropic", apiKey: "sk-stored" });
    expect(fakeChrome.store.uiState).toEqual({ panelLayout: { mode: "right" } });
  });
});
