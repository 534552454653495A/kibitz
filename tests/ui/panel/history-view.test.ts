// @vitest-environment jsdom
/**
 * Failure mode defended: an AI search over saved conversations uploads a catalogue of
 * everything the user ever asked about. If the view does not say so — in the same breath as
 * the button that does it — the feature quietly ships the user's own history to a provider
 * they only ever configured for single messages. The disclosure and the button are therefore
 * tested together, including the count and the lines that will actually be sent.
 *
 * The rest is the list a user switches conversations with: order, the facts each row shows,
 * the instant local filter, and the two-step delete-all (retention is unlimited, so that
 * button is the only irreversible one in the panel).
 */
import { render } from "preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogueLine, type ConversationSummary } from "../../../src/core/history";
import { ACTION_ATTR } from "../../../src/shared/dom-markers";
import type { PanelActions } from "../../../src/ui/panel/actions";
import { INITIAL, type HistoryModel } from "../../../src/ui/panel/state";
import { historyView } from "../../../src/ui/panel/views/history";

function stubActions(): PanelActions {
  return {
    send: vi.fn(),
    scan: vi.fn(),
    stop: vi.fn(),
    retry: vi.fn(),
    close: vi.fn(),
    showView: vi.fn(),
    saveSettings: vi.fn(() => Promise.resolve()),
    testSettings: vi.fn(),
    requestAccess: vi.fn(),
    openOptions: vi.fn(),
    setLayout: vi.fn(),
    toggleExpanded: vi.fn(),
    resetLayout: vi.fn(),
    copyTurn: vi.fn(),
    searchConversations: vi.fn(),
    askConversations: vi.fn(),
    openConversation: vi.fn(),
    deleteConversation: vi.fn(),
    confirmClearConversations: vi.fn(),
    clearConversations: vi.fn(),
  };
}

const summary = (id: string, title: string, overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id,
  platform: "discord",
  channelId: "c1",
  title,
  participants: [{ id: "u1", name: "yunus" }],
  messageCount: 2,
  excerpt: "spider man 2 türkçe iso",
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
  ...overrides,
});

const NEWER = summary("1756900000000-abc", "Yerel AI modelleri", {
  participants: [{ id: "u2", name: "adem" }],
  excerpt: "llama'yı kendi makinemde çalıştırmak",
  messageCount: 1,
  updatedAt: "2026-09-03T09:00:00.000Z",
});
const OLDER = summary("1756800000000-def", "Spider-Man 2 ISO sorunu");

let container: HTMLElement;
let actions: PanelActions;

function show(saved: Partial<HistoryModel>): void {
  actions = stubActions();
  render(
    historyView.render({
      model: { ...INITIAL, status: "ready", view: "history", saved: { ...INITIAL.saved, ...saved } },
      actions,
      platform: "discord",
      capabilities: { keyIsPageVisible: false, canOpenOptionsPage: true },
      keyStorageHint: "Stored on this machine.",
    }),
    container,
  );
}

const text = (): string => container.textContent ?? "";
const all = (name: string): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(`[${ACTION_ATTR}="${name}"]`)];
const one = (name: string): HTMLElement => {
  const el = all(name)[0];
  if (el === undefined) throw new Error(`action ${name} missing`);
  return el;
};
const titles = (): string[] => [...container.querySelectorAll(".entry-title")].map((el) => el.textContent ?? "");

beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement("main");
  document.body.append(container);
});

describe("history list", () => {
  it("keeps the order it was given and shows the facts a user picks a conversation by", () => {
    show({ list: [NEWER, OLDER] });

    // The host sorts newest first (core/history byRecency); the view must not re-order.
    expect(titles()).toEqual(["Yerel AI modelleri", "Spider-Man 2 ISO sorunu"]);
    expect(text()).toContain("adem");
    expect(text()).toContain("1 message");
    expect(text()).toContain("2 messages");
    // The date is relative, from the chat view's own formatter.
    expect(container.querySelector("time")?.textContent).toMatch(/(just now|\d+[mhd] ago)/);
  });

  it("opens the conversation whose row was clicked", () => {
    show({ list: [NEWER, OLDER] });

    all("history-open")[1]?.click();

    expect(actions.openConversation).toHaveBeenCalledWith(OLDER.id);
  });

  it("filters to what the query matches without asking anyone", () => {
    show({ list: [NEWER, OLDER], query: "adem llama" });

    expect(titles()).toEqual(["Yerel AI modelleri"]);
    expect(text()).toContain("1 of 2 saved");
  });

  it("reports every keystroke immediately, so the filter cannot lag behind the box", () => {
    show({ list: [NEWER, OLDER] });
    const box = one("history-search");
    if (!(box instanceof HTMLInputElement)) throw new Error("search box is not an input");

    box.value = "yerel";
    box.dispatchEvent(new Event("input", { bubbles: true }));

    expect(actions.searchConversations).toHaveBeenCalledWith("yerel");
  });

  it("says what will appear here rather than that there is nothing", () => {
    show({ list: [] });

    // The user has never seen a saved conversation at this point, so the empty state has to
    // describe what gets kept and when — "no conversations" would teach them nothing.
    expect(text()).toContain("Ask about a message");
    expect(text()).toContain("first answer saves it");
    // Nothing to delete, so the irreversible button is not even present.
    expect(all("history-clear")).toHaveLength(0);
    // And nothing to send either, so the sentence about what leaves the machine would only
    // be able to say "0 lines".
    expect(container.querySelector(".disclose")).toBeNull();
  });

  it("points at Ask when the words the user typed match nothing locally", () => {
    show({ list: [NEWER, OLDER], query: "kubernetes" });

    expect(titles()).toEqual([]);
    expect(text()).toContain("Ask");
    expect(one("history-ask").hasAttribute("disabled")).toBe(false);
  });
});

describe("history AI search", () => {
  it("states how many lines leave for the provider and what is in them", () => {
    show({ list: [NEWER, OLDER] });

    expect(text()).toContain("2 lines to your provider");
    // The sentence is backed by the lines themselves, so a user can check the claim.
    expect(text()).toContain(catalogueLine(NEWER));
    expect(text()).toContain("The answers and the rest of the messages stay on this machine.");
  });

  it("counts only the conversations the local filter left, because those are the ones sent", () => {
    show({ list: [NEWER, OLDER], query: "adem" });

    expect(text()).toContain("1 line to your provider");
  });

  it("still offers the whole catalogue when the question matches nothing literally", () => {
    // The owner's own example is prose: "Yunus'un AI ile ilgili konusu vardı, geçmişten
    // bulabilir misin?" matches no catalogue line, and an empty catalogue would make the one
    // request we are allowed to send useless.
    show({ list: [NEWER, OLDER], query: "yunusun ai ile ilgili konusu vardı" });

    expect(text()).toContain("2 lines to your provider");
  });

  it("refuses to spend a request on an empty box and sends the trimmed question otherwise", () => {
    show({ list: [NEWER, OLDER], query: "   " });
    expect(one("history-ask").hasAttribute("disabled")).toBe(true);

    show({ list: [NEWER, OLDER], query: "  ai konusu  " });
    one("history-ask").click();

    expect(actions.askConversations).toHaveBeenCalledWith("ai konusu");
  });

  it("turns the ids the model named into buttons that open those conversations", () => {
    show({
      list: [NEWER, OLDER],
      answer: `Adem ile 3 Eylül'de yerel AI modellerini konuşmuşsun.\n\nMATCHES: ${NEWER.id}`,
      matches: [NEWER.id],
    });

    const buttons = all("history-match");
    expect(buttons.map((button) => button.textContent)).toEqual(["Yerel AI modelleri"]);
    buttons[0]?.click();
    expect(actions.openConversation).toHaveBeenCalledWith(NEWER.id);
  });

  it("keeps the machine line out of what the user reads", () => {
    show({
      list: [NEWER, OLDER],
      answer: `Adem ile 3 Eylül'de konuşmuşsun.\n\nMATCHES: ${NEWER.id}`,
      matches: [NEWER.id],
    });

    // `MATCHES:` is there for the parser (core/prompts/find.md asks for it); printing it
    // would put a row of raw ids above the buttons that already name the same conversation.
    const shown = container.querySelector(".find")?.textContent ?? "";
    expect(shown).toContain("Adem ile 3 Eylül'de konuşmuşsun.");
    expect(shown).not.toContain("MATCHES");
    expect(shown).not.toContain(NEWER.id);
  });

  it("offers no button for an id the list no longer has", () => {
    // Deleted between the answer arriving and the click: an id is not something a user can
    // act on, so the prose stays and the button does not appear.
    show({ list: [OLDER], answer: `Adem ile konuşmuşsun.\n\nMATCHES: ${NEWER.id}`, matches: [NEWER.id] });

    expect(container.querySelector(".find")?.textContent).toContain("Adem ile konuşmuşsun.");
    expect(all("history-match")).toHaveLength(0);
  });

  it("shows the failure inside the view instead of in any transcript", () => {
    show({ list: [NEWER], error: "The search failed: ChatError: no key" });

    expect(text()).toContain("The search failed: ChatError: no key");
  });
});

describe("deleting", () => {
  it("deletes the single conversation whose × was clicked", () => {
    show({ list: [NEWER, OLDER] });

    all("history-delete")[1]?.click();

    expect(actions.deleteConversation).toHaveBeenCalledWith(OLDER.id);
    expect(actions.clearConversations).not.toHaveBeenCalled();
  });

  it("arms delete-all instead of doing it, and names the count in the confirmation", () => {
    show({ list: [NEWER, OLDER] });

    one("history-clear").click();

    expect(actions.confirmClearConversations).toHaveBeenCalledWith(true);
    expect(actions.clearConversations).not.toHaveBeenCalled();
  });

  it("deletes everything only from the armed button, and lets the user back out", () => {
    show({ list: [NEWER, OLDER], confirmingClear: true });
    expect(text()).toContain("Delete all 2?");

    one("history-clear-cancel").click();
    expect(actions.confirmClearConversations).toHaveBeenCalledWith(false);
    expect(actions.clearConversations).not.toHaveBeenCalled();

    one("history-clear-confirm").click();
    expect(actions.clearConversations).toHaveBeenCalledTimes(1);
  });
});
