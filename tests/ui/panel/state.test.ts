/**
 * The reducer's history half. Two failure modes are worth a test each:
 *
 *   - the record identity. It is minted once and must survive everything that happens
 *     *inside* one conversation (more messages, more answers) and nothing that starts a new
 *     one — get this wrong and the user either gets one entry per answer or one entry that
 *     silently overwrites the conversation they had before.
 *   - deleting what is on screen. If the identity outlives the delete, the next answer
 *     re-creates the record the user just removed, which reads as a delete that failed.
 */
import { describe, expect, it } from "vitest";
import type { ConversationRecord, ConversationSummary } from "../../../src/core/history";
import type { UniversalMessage } from "../../../src/core/types";
import { INITIAL, reduce, type PanelAction, type PanelModel } from "../../../src/ui/panel/state";

const message: UniversalMessage = {
  platform: "discord",
  id: "m1",
  channel: { id: "c1" },
  author: { id: "u1", name: "yunus", isBot: false },
  content: "spider man 2 türkçe iso",
  createdAt: "2026-09-01T10:00:00.000Z",
  attachments: [],
  embeds: [],
  reactions: [],
  mentions: [],
  isSystem: false,
};

const ref = { platform: "discord" as const, channelId: "c1", messageId: "m1" };

const run = (model: PanelModel, ...actions: PanelAction[]): PanelModel =>
  actions.reduce((current, action) => reduce(current, action), model);

/** A conversation with one message, one answer and a record identity, as mount.ts leaves it. */
function recorded(): PanelModel {
  return run(
    INITIAL,
    { type: "open", ref },
    { type: "loaded", message },
    { type: "settings", configured: true },
    { type: "stream-start", history: [{ role: "user", content: "explain" }] },
    { type: "delta", text: "It is a torrent link." },
    { type: "stream-end" },
    { type: "conversation-recorded", id: "1756900000000-abc", createdAt: "2026-09-03T09:00:00.000Z" },
  );
}

const summary = (id: string): ConversationSummary => ({
  id,
  platform: "discord",
  channelId: "c1",
  title: `title ${id}`,
  participants: [{ id: "u1", name: "yunus" }],
  messageCount: 1,
  excerpt: "spider man 2 türkçe iso",
  createdAt: "2026-09-03T09:00:00.000Z",
  updatedAt: "2026-09-03T09:00:00.000Z",
});

describe("record identity", () => {
  it("survives another message and another answer in the same conversation", () => {
    const second: UniversalMessage = { ...message, id: "m2", content: "and this one" };
    const after = run(
      recorded(),
      { type: "continue", ref: { ...ref, messageId: "m2" }, message: second },
      { type: "stream-start", history: [{ role: "user", content: "explain both" }] },
      { type: "delta", text: "Same thread." },
      { type: "stream-end" },
    );

    expect(after.conversation?.id).toBe("1756900000000-abc");
    expect(after.conversation?.createdAt).toBe("2026-09-03T09:00:00.000Z");
  });

  it("is dropped when a different message opens a new conversation", () => {
    expect(run(recorded(), { type: "open", ref: { ...ref, messageId: "m9" } }).conversation).toBeNull();
  });

  it("remembers that the title was asked for, whether or not one arrived", () => {
    const asked = run(recorded(), { type: "conversation-title-requested" });
    expect(asked.conversation?.titleAsked).toBe(true);
    expect(asked.conversation?.title).toBeNull();

    const titled = run(asked, { type: "conversation-titled", title: "Türkçe ISO bağlantısı" });
    expect(titled.conversation?.title).toBe("Türkçe ISO bağlantısı");
  });

  it("ignores a title for a conversation that was never recorded", () => {
    const model = run(INITIAL, { type: "open", ref }, { type: "loaded", message }, { type: "conversation-titled", title: "x" });
    expect(model.conversation).toBeNull();
  });
});

describe("restoring a stored conversation", () => {
  const record: ConversationRecord = {
    id: "1756800000000-def",
    platform: "discord",
    channelId: "c1",
    title: "Türkçe ISO bağlantısı",
    participants: [{ id: "u1", name: "yunus" }],
    messages: [message, { ...message, id: "m2" }],
    turns: [
      { role: "message", message },
      { role: "assistant", text: "It is a torrent link." },
      { role: "message", message: { ...message, id: "m2" } },
    ],
    history: [
      { role: "system", content: "system" },
      { role: "user", content: "explain" },
      { role: "assistant", content: "It is a torrent link." },
    ],
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
  };

  it("puts the transcript, the model's history and the anchor back, and shows the chat", () => {
    const after = run(
      run(INITIAL, { type: "open", ref }, { type: "loaded", message }, { type: "settings", configured: true }),
      { type: "show-view", id: "history" },
      { type: "history-restore", record },
    );

    expect(after.status).toBe("ready");
    expect(after.view).toBe("chat");
    expect(after.turns).toEqual(record.turns);
    expect(after.history).toEqual(record.history);
    // The anchor is the LAST stored message: that is where the conversation was left, so a
    // follow-up, a retry and a scan act on the same message they would have then.
    expect(after.ref).toEqual({ platform: "discord", channelId: "c1", messageId: "m2" });
    expect(after.message?.id).toBe("m2");
    // Configured survives: it is a fact about the settings, not about the conversation.
    expect(after.configured).toBe(true);
  });

  it("adopts the record's identity so a follow-up answer updates it instead of forking it", () => {
    const after = run(INITIAL, { type: "history-restore", record });

    expect(after.conversation).toEqual({
      id: record.id,
      createdAt: record.createdAt,
      title: record.title,
      // The one title request this conversation was entitled to already happened.
      titleAsked: true,
    });
  });
});

describe("the saved-conversation list", () => {
  it("clears a previous AI answer as soon as the question changes", () => {
    const asked = run(
      INITIAL,
      { type: "history-listed", list: [summary("1756900000000-abc")] },
      { type: "history-find-start" },
      { type: "history-find-delta", text: "Adem ile konuşmuşsun.\nMATCHES: 1756900000000-abc" },
      { type: "history-find-end" },
    );
    expect(asked.saved.matches).toEqual(["1756900000000-abc"]);
    expect(asked.saved.asking).toBe(false);

    const retyped = run(asked, { type: "history-query", query: "başka bir şey" });
    expect(retyped.saved.answer).toBe("");
    expect(retyped.saved.matches).toEqual([]);
  });

  it("names no match when the model said none fit", () => {
    const after = run(
      INITIAL,
      { type: "history-find-start" },
      { type: "history-find-delta", text: "Böyle bir sohbet yok.\nMATCHES:" },
      { type: "history-find-end" },
    );
    expect(after.saved.matches).toEqual([]);
  });

  it("forgets where it was saving when the conversation on screen is deleted", () => {
    const after = run(
      recorded(),
      { type: "history-listed", list: [summary("1756900000000-abc"), summary("1756800000000-def")] },
      { type: "history-deleted", id: "1756900000000-abc" },
    );

    expect(after.saved.list?.map((entry) => entry.id)).toEqual(["1756800000000-def"]);
    // Otherwise the next answer would rewrite the record the user just removed.
    expect(after.conversation).toBeNull();
  });

  it("keeps saving where it was when some other conversation is deleted", () => {
    const after = run(
      recorded(),
      { type: "history-listed", list: [summary("1756900000000-abc"), summary("1756800000000-def")] },
      { type: "history-deleted", id: "1756800000000-def" },
    );

    expect(after.conversation?.id).toBe("1756900000000-abc");
  });

  it("empties the list and the identity when everything is deleted", () => {
    const after = run(
      recorded(),
      { type: "history-listed", list: [summary("1756900000000-abc")] },
      { type: "history-confirm-clear", pending: true },
      { type: "history-cleared" },
    );

    expect(after.saved.list).toEqual([]);
    expect(after.saved.confirmingClear).toBe(false);
    expect(after.conversation).toBeNull();
  });

  it("keeps the list and the typed query across a close, but not a streaming search", () => {
    const before = run(
      recorded(),
      { type: "history-listed", list: [summary("1756900000000-abc")] },
      { type: "history-query", query: "ai" },
      { type: "history-find-start" },
      { type: "history-find-delta", text: "half an answer" },
    );

    const after = run(before, { type: "close" });

    expect(after.saved.list?.map((entry) => entry.id)).toEqual(["1756900000000-abc"]);
    expect(after.saved.query).toBe("ai");
    expect(after.saved.answer).toBe("");
    expect(after.saved.asking).toBe(false);
  });
});
