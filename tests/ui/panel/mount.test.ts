// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "../../../src/core/adapter";
import { catalogueLine, summarise, type ConversationRecord } from "../../../src/core/history";
import type { ChatMessage, PortRequest, PortResponse } from "../../../src/core/messaging";
// The title one-shot is a chat request like every other one; its prompt is what tells them
// apart, so the discriminator is taken from the prompt file instead of retyped here.
import titleTemplate from "../../../src/core/prompts/title.md";
import type { UniversalMessage, UniversalThread } from "../../../src/core/types";
import { isRecord } from "../../../src/core/validate";
import {
  ACTION_ATTR,
  PANEL_ERROR_ATTR,
  PANEL_HOST_ATTR,
  PANEL_MESSAGE_ATTR,
  PANEL_STATE_ATTR,
  SCAN_COUNT_ATTR,
  SCAN_STATE_ATTR,
  VIEW_ATTR,
} from "../../../src/shared/dom-markers";
import { createExtensionShell } from "../../../src/shell/extension";
import { mountPanel } from "../../../src/ui/panel/mount";

interface FakePort {
  sent: PortRequest[];
  disconnected: boolean;
  emit: (msg: PortResponse) => void;
}

// A scripted stand-in for the background, installed before `shared/ext.ts` evaluates
// `chrome` at import time (hence vi.hoisted). One port per request, answers driven by the
// test; the one-shot replies mirror core/messaging.ts's RuntimeResponse union exactly,
// because the shell validates them (src/shell/replies.ts) and a sloppy stub would test the
// validator instead of the panel.
const fakeRuntime = vi.hoisted(() => {
  const state = {
    configured: true,
    draft: { provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", hasKey: true } as
      | { provider: string; baseUrl: string; model: string; hasKey: boolean }
      | null,
    saveResult: { ok: true } as Record<string, unknown>,
    granted: true,
    uiState: {} as Record<string, unknown>,
    savedUiStates: [] as Record<string, unknown>[],
    /** The background's conversation store, keyed by id exactly like a real host's. */
    conversations: [] as unknown[],
    /** What `save-conversation` answers; a full store is the failure that matters. */
    historySaveResult: { ok: true } as Record<string, unknown>,
    ports: [] as Array<{ sent: PortRequest[]; disconnected: boolean; emit: (msg: PortResponse) => void }>,
    sendMessage: vi.fn(),
  };
  const runtime = {
    lastError: undefined,
    sendMessage: (req: { type: string; state?: Record<string, unknown>; id?: string; record?: unknown }) => {
      state.sendMessage(req);
      switch (req.type) {
        case "settings-status":
          return Promise.resolve({ configured: state.configured });
        case "load-settings":
          return Promise.resolve({ draft: state.draft });
        case "save-settings":
          return Promise.resolve(state.saveResult);
        case "request-access":
          return Promise.resolve({ granted: state.granted });
        case "load-ui-state":
          return Promise.resolve({ state: state.uiState });
        case "save-ui-state":
          state.savedUiStates.push(req.state ?? {});
          return Promise.resolve({ ok: true });
        case "list-conversations":
          // Summaries, through the core's own `summarise`: a hand-written summary here would
          // test this stub's idea of the shape instead of the panel's.
          return Promise.resolve({
            conversations: state.conversations.map((record) => summarise(record as ConversationRecord)),
          });
        case "load-conversation":
          return Promise.resolve({
            conversation: state.conversations.find((entry) => (entry as ConversationRecord).id === req.id) ?? null,
          });
        case "save-conversation": {
          if (state.historySaveResult.ok === true) {
            const record = req.record as ConversationRecord;
            const at = state.conversations.findIndex((entry) => (entry as ConversationRecord).id === record.id);
            if (at === -1) state.conversations.push(record);
            else state.conversations[at] = record;
          }
          return Promise.resolve(state.historySaveResult);
        }
        case "delete-conversation":
          state.conversations = state.conversations.filter((entry) => (entry as ConversationRecord).id !== req.id);
          return Promise.resolve({ ok: true });
        case "clear-conversations":
          state.conversations = [];
          return Promise.resolve({ ok: true });
        default:
          return Promise.resolve({ ok: true });
      }
    },
    connect: () => {
      const listeners: Array<(msg: PortResponse) => void> = [];
      const port = {
        sent: [] as PortRequest[],
        disconnected: false,
        emit: (msg: PortResponse) => listeners.forEach((l) => l(msg)),
        postMessage: (msg: PortRequest) => port.sent.push(msg),
        disconnect: () => {
          port.disconnected = true;
        },
        onMessage: { addListener: (l: (msg: PortResponse) => void) => listeners.push(l) },
        onDisconnect: { addListener: () => undefined },
      };
      state.ports.push(port);
      return port;
    },
  };
  Object.assign(globalThis, { chrome: { runtime } });
  return state;
});

const message: UniversalMessage = {
  platform: "discord",
  id: "m1",
  channel: { id: "c1" },
  author: { id: "u1", name: "Alice", isBot: false },
  content: "hello there",
  createdAt: "2026-01-01T00:00:00.000Z",
  attachments: [],
  embeds: [],
  reactions: [],
  mentions: [],
  isSystem: false,
};

const ref = { platform: "discord" as const, channelId: "c1", messageId: "m1" };

function adapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    platform: "discord",
    matches: () => true,
    findListRoot: () => null,
    listMessageElements: () => [],
    buttonAnchor: () => null,
    readMessage: () => Promise.resolve(message),
    collectAround: () => Promise.resolve({ anchor: message, messages: [message], truncated: false }),
    ...overrides,
  };
}

const host = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[${PANEL_HOST_ATTR}="1"]`);
  if (el === null) throw new Error("panel host missing");
  return el;
};
const action = (name: string): HTMLElement => {
  const el = host().shadowRoot?.querySelector<HTMLElement>(`[${ACTION_ATTR}="${name}"]`);
  if (el === null || el === undefined) throw new Error(`action ${name} missing`);
  return el;
};
const composer = (): HTMLTextAreaElement => {
  const el = host().shadowRoot?.querySelector("textarea");
  if (el === null || el === undefined) throw new Error("composer missing");
  return el;
};
const untilState = (attr: string, value: string): Promise<void> =>
  vi.waitFor(() => expect(host().getAttribute(attr)).toBe(value));
/**
 * Kibitz opens a port per request, and one of them is not part of the conversation: after
 * the first answer it asks the model for a 3-5 word title. The conversation's own requests
 * are therefore indexed with that one filtered out, which is also what keeps these tests
 * from depending on when the title request happens to be issued.
 */
const titleLine = titleTemplate.split("\n")[0] ?? "";
const isTitleRequest = (port: FakePort): boolean => {
  const request = port.sent[0];
  return request?.type === "chat" && (request.messages[1]?.content ?? "").startsWith(titleLine);
};
const chatPorts = (): FakePort[] => fakeRuntime.ports.filter((port) => !isTitleRequest(port));
const titlePorts = (): FakePort[] => fakeRuntime.ports.filter(isTitleRequest);
const untilPort = (index: number): Promise<FakePort> =>
  vi.waitFor(() => {
    const port = chatPorts()[index];
    if (port === undefined) throw new Error(`chat port ${index} not opened yet`);
    return port;
  });
const untilTitlePort = (): Promise<FakePort> =>
  vi.waitFor(() => {
    const port = titlePorts()[0];
    if (port === undefined) throw new Error("no title request yet");
    return port;
  });
/** What the panel asked the *conversation's* last request to answer. */
const chatRequest = (port: FakePort): { requestId: string; messages: ChatMessage[] } => {
  const request = port.sent[0];
  if (request?.type !== "chat") throw new Error("expected a chat request");
  return request;
};
const answerOn = (port: FakePort, text: string): void => {
  const { requestId } = chatRequest(port);
  port.emit({ type: "delta", requestId, text });
  port.emit({ type: "done", requestId });
};
const stored = (): ConversationRecord[] => fakeRuntime.conversations as ConversationRecord[];
const untilStored = (count: number): Promise<ConversationRecord[]> =>
  vi.waitFor(() => {
    expect(stored()).toHaveLength(count);
    return stored();
  });
/** The ids every `save-conversation` named, in order: proof of one record per conversation. */
const savedIds = (): string[] =>
  fakeRuntime.sendMessage.mock.calls.flatMap((call: unknown[]) => {
    const request = call[0];
    if (!isRecord(request) || request.type !== "save-conversation") return [];
    const record = request.record;
    return isRecord(record) && typeof record.id === "string" ? [record.id] : [];
  });
const untilAction = (name: string): Promise<HTMLElement> => vi.waitFor(() => action(name));

/** Drives the composer the way a user does: type, then press the key. */
const type = (text: string): HTMLTextAreaElement => {
  const el = composer();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el;
};
const pressEnter = (el: HTMLElement): void => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
};

/** Answers the opening explain stream so the panel is idle and the composer is live. */
async function settleFirstAnswer(text = "It says hi."): Promise<FakePort> {
  const port = await untilPort(0);
  const first = port.sent[0];
  if (first?.type !== "chat") throw new Error("expected a chat request first");
  port.emit({ type: "delta", requestId: first.requestId, text });
  port.emit({ type: "done", requestId: first.requestId });
  await untilAction("send");
  return port;
}

beforeEach(() => {
  document.body.replaceChildren();
  fakeRuntime.ports.length = 0;
  fakeRuntime.savedUiStates.length = 0;
  fakeRuntime.configured = true;
  fakeRuntime.draft = { provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", hasKey: true };
  fakeRuntime.saveResult = { ok: true };
  fakeRuntime.granted = true;
  fakeRuntime.uiState = {};
  fakeRuntime.conversations = [];
  fakeRuntime.historySaveResult = { ok: true };
  fakeRuntime.sendMessage.mockClear();
});

describe("mountPanel host attributes", () => {
  it("starts closed and moves loading → ready with the message id when the read succeeds", async () => {
    const panel = mountPanel(adapter(), createExtensionShell());
    expect(host().getAttribute(PANEL_STATE_ATTR)).toBe("closed");
    panel.open(ref);
    expect(host().getAttribute(PANEL_STATE_ATTR)).toBe("loading");
    expect(host().getAttribute(PANEL_MESSAGE_ATTR)).toBe("m1");
    await untilState(PANEL_STATE_ATTR, "ready");
    expect(host().getAttribute(PANEL_MESSAGE_ATTR)).toBe("m1");
  });

  it("moves to error with name: message when the adapter read rejects", async () => {
    const err = new Error("bridge timed out");
    err.name = "RpcTimeoutError";
    const panel = mountPanel(adapter({ readMessage: () => Promise.reject(err) }), createExtensionShell());
    panel.open(ref);
    await untilState(PANEL_STATE_ATTR, "error");
    expect(host().getAttribute(PANEL_ERROR_ATTR)).toBe("RpcTimeoutError: bridge timed out");
  });

  it("streams the explanation into the panel once the message is ready", async () => {
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    const port = await untilPort(0);
    const first = port.sent[0];
    if (first?.type !== "chat") throw new Error("expected a chat request first");
    expect(first.messages.map((m) => m.role)).toEqual(["system", "user"]);
    port.emit({ type: "delta", requestId: first.requestId, text: "It says " });
    port.emit({ type: "delta", requestId: first.requestId, text: "hi." });
    port.emit({ type: "done", requestId: first.requestId });
    await vi.waitFor(() => expect(host().shadowRoot?.textContent).toContain("It says hi."));
    expect(port.disconnected).toBe(true);
    await untilAction("send");
  });

  it("offers the options page instead of calling the LLM when nothing is configured", async () => {
    fakeRuntime.configured = false;
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    const cta = await untilAction("open-options");
    expect(host().getAttribute(PANEL_STATE_ATTR)).toBe("ready");
    expect(fakeRuntime.ports).toHaveLength(0);
    cta.click();
    expect(fakeRuntime.sendMessage).toHaveBeenCalledWith({ type: "open-options" });
  });

  it("reports scan progress and finishes with the collected count before any synthesis", async () => {
    fakeRuntime.configured = false;
    const thread: UniversalThread = { anchor: message, messages: [message, { ...message, id: "m2" }], truncated: false };
    const seenDuringScan: string[] = [];
    const panel = mountPanel(adapter({
      collectAround: (_ref, _opts, onProgress) => {
        onProgress?.({ collected: 1 });
        seenDuringScan.push(host().getAttribute(SCAN_STATE_ATTR) ?? "", host().getAttribute(SCAN_COUNT_ATTR) ?? "");
        return Promise.resolve(thread);
      },
    }), createExtensionShell());
    panel.open(ref);
    (await untilAction("scan")).click();
    await untilState(SCAN_STATE_ATTR, "done");
    expect(seenDuringScan).toEqual(["running", "1"]);
    expect(host().getAttribute(SCAN_COUNT_ATTR)).toBe("2");
    expect(fakeRuntime.ports).toHaveLength(0);
  });

  it("marks the scan as failed when collection rejects", async () => {
    fakeRuntime.configured = false;
    const panel = mountPanel(adapter({ collectAround: () => Promise.reject(new Error("scroll container lost")) }), createExtensionShell());
    panel.open(ref);
    (await untilAction("scan")).click();
    await untilState(SCAN_STATE_ATTR, "error");
  });

  it("closes on the close action and on Escape, clearing the message id", async () => {
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    await untilState(PANEL_STATE_ATTR, "ready");
    action("close").click();
    expect(host().getAttribute(PANEL_STATE_ATTR)).toBe("closed");
    expect(host().hasAttribute(PANEL_MESSAGE_ATTR)).toBe(false);
    panel.open(ref);
    await untilState(PANEL_STATE_ATTR, "ready");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(host().getAttribute(PANEL_STATE_ATTR)).toBe("closed");
  });

  it("ignores a late read result from a message that was replaced by a newer open", async () => {
    const { promise: slow, resolve } = Promise.withResolvers<UniversalMessage>();
    let calls = 0;
    const panel = mountPanel(adapter({
      readMessage: () => (++calls === 1 ? slow : Promise.resolve({ ...message, id: "m2", content: "second" })),
    }), createExtensionShell());
    panel.open(ref);
    panel.open({ ...ref, messageId: "m2" });
    await untilState(PANEL_STATE_ATTR, "ready");
    resolve({ ...message, content: "first" });
    await untilPort(0);
    expect(host().getAttribute(PANEL_MESSAGE_ATTR)).toBe("m2");
    expect(host().shadowRoot?.textContent).toContain("second");
    expect(host().shadowRoot?.textContent).not.toContain("first");
  });
});

// Failure mode defended: the owner clicks ✦ on several messages from the same person while
// reading a thread. Restarting the panel each time threw away the conversation (and the
// context the model had already been given) - so same author + same channel must append.
describe("mountPanel same-author conversation", () => {
  const second: UniversalMessage = { ...message, id: "m2", content: "and another thing" };
  const otherPerson: UniversalMessage = { ...message, id: "m3", author: { id: "u2", name: "Bob", isBot: false }, content: "unrelated" };
  const byId = (...messages: UniversalMessage[]): PlatformAdapter =>
    adapter({
      readMessage: (r) => {
        const found = messages.find((m) => m.id === r.messageId);
        return found === undefined ? Promise.reject(new Error(`no fixture for ${r.messageId}`)) : Promise.resolve(found);
      },
    });
  const cards = (): number => host().shadowRoot?.querySelectorAll("section.card").length ?? 0;

  it("keeps the conversation and appends the second message's card and answer", async () => {
    const panel = mountPanel(byId(message, second), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer("It says hi.");
    expect(cards()).toBe(1);

    panel.open({ ...ref, messageId: "m2" });
    const next = await untilPort(1);
    const request = next.sent[0];
    if (request?.type !== "chat") throw new Error("expected a chat request");
    // The model keeps everything it was already told: the first exchange is still there and
    // the new message arrives as one more user turn.
    expect(request.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(request.messages[3]?.content).toContain("and another thing");
    await vi.waitFor(() => expect(cards()).toBe(2));
    // The first answer is still on screen - that is the whole point.
    expect(host().shadowRoot?.textContent).toContain("It says hi.");
    expect(host().getAttribute(PANEL_MESSAGE_ATTR)).toBe("m2");
  });

  // The owner's report, verbatim scenario: Yunus writes, Adem REPLIES to him, and clicking
  // Adem's reply used to open a fresh panel - "o da aynı konu üzerine olduğu için aynı sohbete
  // katılmalı". The counterfactual they gave is the test below it: an unrelated message from
  // Adem still starts over.
  it("admits another author's reply to a message already in the conversation", async () => {
    const reply: UniversalMessage = {
      ...message,
      id: "m4",
      author: { id: "u2", name: "Adem", isBot: false },
      content: "3 yoomu",
      replyTo: { messageId: "m1", authorName: "yunus", excerpt: "Spider man 2 Türkçe iso" },
    };
    const panel = mountPanel(byId(message, reply), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer("It says hi.");

    panel.open({ ...ref, messageId: "m4" });
    const next = await untilPort(1);
    const request = next.sent[0];
    if (request?.type !== "chat") throw new Error("expected a chat request");
    expect(request.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    await vi.waitFor(() => expect(cards()).toBe(2));
    expect(host().shadowRoot?.textContent).toContain("It says hi.");
    expect(host().getAttribute(PANEL_MESSAGE_ATTR)).toBe("m4");
  });

  it("admits the message a card in the conversation was replying to (the mirror direction)", async () => {
    // Open the reply first, then click the original: the user read the answer about the reply
    // and wants the message it answered in the same thread.
    const reply: UniversalMessage = {
      ...message,
      id: "m4",
      author: { id: "u2", name: "Adem", isBot: false },
      replyTo: { messageId: "m1", authorName: "Alice" },
    };
    const panel = mountPanel(byId(message, reply), createExtensionShell());
    panel.open({ ...ref, messageId: "m4" });
    await settleFirstAnswer("It answers Alice.");

    panel.open(ref);
    const next = await untilPort(1);
    const request = next.sent[0];
    if (request?.type !== "chat") throw new Error("expected a chat request");
    expect(request.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    await vi.waitFor(() => expect(cards()).toBe(2));
  });

  it("starts over for a new author whose reply points outside the conversation", async () => {
    const elsewhere: UniversalMessage = {
      ...message,
      id: "m5",
      author: { id: "u3", name: "Cem", isBot: false },
      content: "about something else",
      replyTo: { messageId: "m99", authorName: "someone" },
    };
    const panel = mountPanel(byId(message, elsewhere), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer("It says hi.");

    panel.open({ ...ref, messageId: "m5" });
    const next = await untilPort(1);
    const request = next.sent[0];
    if (request?.type !== "chat") throw new Error("expected a chat request");
    expect(request.messages.map((m) => m.role)).toEqual(["system", "user"]);
    await vi.waitFor(() => expect(host().shadowRoot?.textContent).toContain("about something else"));
    expect(cards()).toBe(1);
  });

  it("starts over for a different author instead of mixing two people in one thread", async () => {
    const panel = mountPanel(byId(message, otherPerson), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer("It says hi.");

    panel.open({ ...ref, messageId: "m3" });
    const next = await untilPort(1);
    const request = next.sent[0];
    if (request?.type !== "chat") throw new Error("expected a chat request");
    expect(request.messages.map((m) => m.role)).toEqual(["system", "user"]);
    await vi.waitFor(() => expect(host().shadowRoot?.textContent).toContain("unrelated"));
    expect(cards()).toBe(1);
    expect(host().shadowRoot?.textContent).not.toContain("It says hi.");
  });

  it("starts over for the same author in another channel, so one server's context cannot leak into another", async () => {
    const elsewhere: UniversalMessage = { ...message, id: "m9", channel: { id: "c2" }, content: "same person, other server" };
    const panel = mountPanel(byId(message, elsewhere), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer("It says hi.");

    panel.open({ platform: "discord", channelId: "c2", messageId: "m9" });
    const next = await untilPort(1);
    const request = next.sent[0];
    if (request?.type !== "chat") throw new Error("expected a chat request");
    expect(request.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(cards()).toBe(1);
  });

  it("does nothing when the button of the message already answered is clicked again", async () => {
    const panel = mountPanel(byId(message), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer("It says hi.");

    panel.open(ref);
    // No second request for the conversation: the answer is already on screen and re-asking
    // would bill the user twice for it. (The title one-shot is Kibitz's own bookkeeping and
    // may or may not have been issued by now, hence `chatPorts`.)
    expect(chatPorts()).toHaveLength(1);
    expect(host().shadowRoot?.textContent).toContain("It says hi.");
    expect(cards()).toBe(1);
  });

  it("keeps the conversation when reading the next message fails, instead of replacing it with an error", async () => {
    const panel = mountPanel(byId(message), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer("It says hi.");

    panel.open({ ...ref, messageId: "m2" });
    await vi.waitFor(() => expect(host().shadowRoot?.textContent).toContain("Could not read that message"));
    expect(host().getAttribute(PANEL_STATE_ATTR)).toBe("ready");
    expect(host().shadowRoot?.textContent).toContain("It says hi.");
    expect(cards()).toBe(1);
  });
});

describe("mountPanel composer", () => {
  it("sends what was typed as a follow-up chat request when Enter is pressed", async () => {
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer();

    pressEnter(type("why does it matter?"));

    const follow = await untilPort(1);
    const request = follow.sent[0];
    if (request?.type !== "chat") throw new Error("Enter did not open a chat request");
    expect(request.messages.at(-1)).toEqual({ role: "user", content: "why does it matter?" });
    expect(host().shadowRoot?.textContent).toContain("why does it matter?");
    // The textarea is cleared by sending, not by the reply arriving.
    expect(composer().value).toBe("");
  });

  it("keeps the composer usable during a stream but refuses to send a second request", async () => {
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    const port = await untilPort(0);
    const first = port.sent[0];
    if (first?.type !== "chat") throw new Error("expected a chat request first");
    port.emit({ type: "delta", requestId: first.requestId, text: "thinking…" });
    await vi.waitFor(() => expect(host().shadowRoot?.textContent).toContain("thinking…"));

    const el = type("queued question");
    expect(el.disabled).toBe(false);
    pressEnter(el);

    expect(fakeRuntime.ports).toHaveLength(1);
    // Nothing was swallowed: the text is still there to send once the answer lands.
    expect(composer().value).toBe("queued question");
  });

  it("sends from Ctrl+Enter anywhere in the panel, not only from the textarea", async () => {
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer();

    type("ctrl question");
    action("scan").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    const follow = await untilPort(1);
    const request = follow.sent[0];
    if (request?.type !== "chat") throw new Error("Ctrl+Enter did not open a chat request");
    expect(request.messages.at(-1)).toEqual({ role: "user", content: "ctrl question" });
  });

  it("copies the assistant turn's text through the clipboard when copy-turn is clicked", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer("Alice is asking about deploys.");

    (await untilAction("copy-turn")).click();
    expect(writeText).toHaveBeenCalledWith("Alice is asking about deploys.");
  });
});

describe("mountPanel settings view", () => {
  it("switches the host's view attribute and shows the key field when the settings tab is used", async () => {
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    await untilState(PANEL_STATE_ATTR, "ready");
    expect(host().getAttribute(VIEW_ATTR)).toBe("chat");

    action("view-settings").click();

    expect(host().getAttribute(VIEW_ATTR)).toBe("settings");
    const key = host().shadowRoot?.querySelector<HTMLInputElement>('input[type="password"]');
    expect(key).not.toBeNull();
    await vi.waitFor(() => expect(key?.placeholder).toBe("leave empty to keep the stored key"));
    await untilAction("save-settings");
  });

  it("offers grant-access when the host reports a missing host permission for the saved origin", async () => {
    fakeRuntime.saveResult = { ok: false, error: "needs permission", grantOrigin: "https://api.openai.com/*" };
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    await untilState(PANEL_STATE_ATTR, "ready");
    action("view-settings").click();

    (await untilAction("save-settings")).click();

    const grant = await untilAction("grant-access");
    expect(host().shadowRoot?.textContent).toContain("needs permission");
    grant.click();
    await vi.waitFor(() =>
      expect(fakeRuntime.sendMessage).toHaveBeenCalledWith({
        type: "request-access",
        origin: "https://api.openai.com/*",
      }),
    );
  });

  it("re-asks whether Kibitz is configured after a successful save so the composer appears", async () => {
    fakeRuntime.configured = false;
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    await untilAction("view-settings");
    action("view-settings").click();

    fakeRuntime.configured = true;
    (await untilAction("save-settings")).click();
    action("view-chat").click();

    await untilAction("send");
  });
});

describe("mountPanel layout persistence", () => {
  it("restores the stored layout mode and writes the new one back when a dock button is used", async () => {
    fakeRuntime.uiState = { panelLayout: { layout: { mode: "left", size: 420 }, expanded: false } };
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    await vi.waitFor(() => expect(host().getAttribute("data-kibitz-layout")).toBe("left"));

    action("dock-right").click();
    expect(host().getAttribute("data-kibitz-layout")).toBe("right");

    await vi.waitFor(() => {
      const saved = fakeRuntime.savedUiStates.at(-1)?.panelLayout;
      expect(saved).toMatchObject({ layout: { mode: "right" } });
    });
  });
});

/**
 * Failure modes defended, all three reported or decided by the owner (2026-09-03):
 *   - a conversation the user can never get back. Saving on the answer, once per record, is
 *     what makes the History tab useful; saving per click would fill it with empty entries.
 *   - a store that is full and says nothing. Retention is unlimited, so the only way the
 *     user learns they are out of room is Kibitz telling them, in the conversation.
 *   - an answer lost to bookkeeping. Neither a failed save nor a failed title request may
 *     take the answer off the screen or interrupt the conversation.
 */
describe("mountPanel conversation history", () => {
  const second: UniversalMessage = { ...message, id: "m2", content: "and another thing" };
  const byId = (...messages: UniversalMessage[]): PlatformAdapter =>
    adapter({
      readMessage: (r) => {
        const found = messages.find((m) => m.id === r.messageId);
        return found === undefined ? Promise.reject(new Error(`no fixture for ${r.messageId}`)) : Promise.resolve(found);
      },
    });

  it("stores the answered conversation so its cards, transcript and model history round-trip", async () => {
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer("It says hi.");

    const [record] = await untilStored(1);
    expect(record?.platform).toBe("discord");
    expect(record?.channelId).toBe("c1");
    expect(record?.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(record?.participants).toEqual([{ id: "u1", name: "Alice" }]);
    // What the panel renders…
    expect(record?.turns).toEqual([
      { role: "message", message },
      { role: "assistant", text: "It says hi." },
    ]);
    // …and what the model was given, which is a different list on purpose.
    expect(record?.history.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(record?.history.at(-1)?.content).toBe("It says hi.");
    // Until the model's title arrives the label is the message's own words.
    expect(record?.title).toBe("Alice: hello there");
  });

  it("updates the same record when a second message and answer join the conversation", async () => {
    const panel = mountPanel(byId(message, second), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer("It says hi.");
    const [first] = await untilStored(1);

    panel.open({ ...ref, messageId: "m2" });
    answerOn(await untilPort(1), "Same subject.");

    await vi.waitFor(() => {
      const [record] = stored();
      expect(record?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    });
    const [record] = stored();
    expect(stored()).toHaveLength(1);
    expect(record?.id).toBe(first?.id);
    expect(record?.createdAt).toBe(first?.createdAt);
    // `updatedAt` moves with the conversation while `createdAt` does not.
    expect((record?.updatedAt ?? "") >= (first?.updatedAt ?? "")).toBe(true);
    // Every write named the one id, so nothing depended on the store de-duplicating for us.
    expect(savedIds().length).toBeGreaterThan(1);
    expect(savedIds().filter((id) => id !== first?.id)).toEqual([]);
  });

  it("saves nothing for a click whose answer never arrived", async () => {
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    const port = await untilPort(0);
    const { requestId } = chatRequest(port);

    port.emit({ type: "error", requestId, code: "http", message: "502 from the provider" });
    await vi.waitFor(() => expect(host().shadowRoot?.textContent).toContain("502 from the provider"));

    // An abandoned or failed click is not history; an empty entry in the list would be worse
    // than no entry, because the user has to open it to find out it says nothing.
    expect(stored()).toEqual([]);
    expect(savedIds()).toEqual([]);
  });

  it("says the conversation was not saved and keeps the answer when the store refuses", async () => {
    fakeRuntime.historySaveResult = { ok: false, error: "Storage is full — delete some conversations." };
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer("It says hi.");

    await vi.waitFor(() => expect(host().shadowRoot?.textContent).toContain("Storage is full"));
    expect(host().shadowRoot?.textContent).toContain("This conversation was not saved");
    // The answer the user is reading survives the bookkeeping failure…
    expect(host().shadowRoot?.textContent).toContain("It says hi.");
    // …and the panel stays usable, rather than offering a Retry that would re-buy it.
    expect(host().getAttribute(PANEL_STATE_ATTR)).toBe("ready");
    await untilAction("send");
  });

  it("asks the model for a title once per conversation, outside the transcript", async () => {
    const panel = mountPanel(byId(message, second), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer("It says hi.");

    const title = await untilTitlePort();
    const request = chatRequest(title);
    // The title request needs both halves to name the subject, and is a one-shot: system
    // prompt plus one user turn, never the conversation's history.
    expect(request.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(request.messages[1]?.content).toContain("hello there");
    expect(request.messages[1]?.content).toContain("It says hi.");
    answerOn(title, "Alice's greeting explained");

    await vi.waitFor(() => expect(stored()[0]?.title).toBe("Alice's greeting explained"));
    // Neither the user nor the model ever sees it.
    expect(host().shadowRoot?.textContent).not.toContain("Alice's greeting explained");
    expect(stored()[0]?.history.map((m) => m.role)).toEqual(["system", "user", "assistant"]);

    panel.open({ ...ref, messageId: "m2" });
    answerOn(await untilPort(1), "Same subject.");
    await vi.waitFor(() => expect(stored()[0]?.messages).toHaveLength(2));
    // A second answer in the same conversation must not buy a second title.
    expect(titlePorts()).toHaveLength(1);
    expect(stored()[0]?.title).toBe("Alice's greeting explained");
  });

  it("keeps the fallback title, silently, when the title request fails", async () => {
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    await settleFirstAnswer("It says hi.");

    const title = await untilTitlePort();
    const { requestId } = chatRequest(title);
    title.emit({ type: "error", requestId, code: "http", message: "429 rate limited" });

    await vi.waitFor(() => expect(stored()[0]?.title).toBe("Alice: hello there"));
    // A nicer label is not worth an error the user has to read and cannot act on.
    expect(host().shadowRoot?.textContent).not.toContain("429 rate limited");
    expect(host().getAttribute(PANEL_ERROR_ATTR)).toBeNull();
  });
});

describe("mountPanel history view", () => {
  /** Two conversations already in the store, as a previous session left them. */
  const older: UniversalMessage = {
    ...message,
    id: "m7",
    channel: { id: "c7" },
    author: { id: "u7", name: "yunus", isBot: false },
    content: "yerel ai modelleri hakkında",
  };
  const record = (id: string, anchor: UniversalMessage, title: string, answer: string, updatedAt: string): ConversationRecord => ({
    id,
    platform: "discord",
    channelId: anchor.channel.id,
    title,
    participants: [{ id: anchor.author.id, name: anchor.author.name }],
    messages: [anchor],
    turns: [
      { role: "message", message: anchor },
      { role: "assistant", text: answer },
    ],
    history: [
      { role: "system", content: "system prompt" },
      { role: "user", content: `explain ${anchor.content}` },
      { role: "assistant", content: answer },
    ],
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt,
  });
  const AI = record("1756900000000-abc", older, "Yerel AI modelleri", "Llama'yı kendi makinende çalıştırmaktan bahsediyor.", "2026-09-03T09:00:00.000Z");
  const ISO = record("1756800000000-def", { ...message, id: "m8", content: "spider man 2 iso" }, "Spider-Man 2 ISO", "Bir torrent bağlantısı.", "2026-09-02T09:00:00.000Z");

  /**
   * Opens the panel on a message and switches to the History tab with the list loaded. The
   * opening answer is deliberately left unanswered: an answer would save a THIRD
   * conversation (that is the feature) and these tests are about the two already stored.
   */
  async function openHistory(): Promise<void> {
    const panel = mountPanel(adapter(), createExtensionShell());
    panel.open(ref);
    (await untilAction("view-history")).click();
    await vi.waitFor(() => expect(host().getAttribute(VIEW_ATTR)).toBe("history"));
  }

  const search = (): HTMLInputElement => {
    const el = host().shadowRoot?.querySelector<HTMLInputElement>(`[${ACTION_ATTR}="history-search"]`);
    if (el === null || el === undefined) throw new Error("search box missing");
    return el;
  };
  const typeQuery = (text: string): void => {
    const box = search();
    box.value = text;
    box.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const rows = (): string[] => [...(host().shadowRoot?.querySelectorAll(".entry-title") ?? [])].map((el) => el.textContent ?? "");

  it("lists what is stored, newest first, and filters it locally without a request", async () => {
    fakeRuntime.conversations = [AI, ISO];
    await openHistory();
    await vi.waitFor(() => expect(rows()).toEqual(["Yerel AI modelleri", "Spider-Man 2 ISO"]));
    const before = chatPorts().length;

    typeQuery("spider");

    await vi.waitFor(() => expect(rows()).toEqual(["Spider-Man 2 ISO"]));
    // Typing is free: the filter is the core's own matcher over the summaries already here.
    expect(chatPorts()).toHaveLength(before);
  });

  it("restores a stored conversation and sends the follow-up with the history it was given", async () => {
    fakeRuntime.conversations = [AI];
    await openHistory();
    (await untilAction("history-open")).click();

    await vi.waitFor(() => expect(host().getAttribute(VIEW_ATTR)).toBe("chat"));
    // The card, the answer, and the anchor the conversation was left on.
    await vi.waitFor(() => expect(host().shadowRoot?.textContent).toContain("yerel ai modelleri hakkında"));
    expect(host().shadowRoot?.textContent).toContain("Llama'yı kendi makinende çalıştırmaktan bahsediyor.");
    expect(host().getAttribute(PANEL_MESSAGE_ATTR)).toBe("m7");

    pressEnter(type("peki hangi model?"));

    const follow = chatRequest(await untilPort(1));
    // The model gets the conversation it had before, not a cold start: that is the whole
    // reason the record stores `history` next to the display turns.
    expect(follow.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(follow.messages[2]?.content).toBe("Llama'yı kendi makinende çalıştırmaktan bahsediyor.");
    expect(follow.messages.at(-1)?.content).toBe("peki hangi model?");
  });

  it("sends one catalogue request for the AI search and opens the conversation it names", async () => {
    fakeRuntime.conversations = [AI, ISO];
    await openHistory();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));

    // The owner's own question: prose, matching no stored word literally.
    typeQuery("yunusun ai ile ilgili konusu vardı, bulabilir misin?");
    (await untilAction("history-ask")).click();

    const find = chatRequest(await untilPort(1));
    expect(find.messages.map((m) => m.role)).toEqual(["system", "user"]);
    const sent = find.messages[1]?.content ?? "";
    // One line per conversation, from the core's own formatter, plus the question itself.
    expect(sent).toContain(catalogueLine(summarise(AI)));
    expect(sent).toContain(catalogueLine(summarise(ISO)));
    expect(sent).toContain("yunusun ai ile ilgili konusu vardı, bulabilir misin?");
    expect(chatPorts()).toHaveLength(2);

    answerOn(await untilPort(1), `Yunus ile 3 Eylül'de.\n\nMATCHES: ${AI.id}`);

    (await untilAction("history-match")).click();
    await vi.waitFor(() => expect(host().getAttribute(PANEL_MESSAGE_ATTR)).toBe("m7"));
    expect(host().getAttribute(VIEW_ATTR)).toBe("chat");
  });

  it("deletes one conversation from the store and takes its row away", async () => {
    fakeRuntime.conversations = [AI, ISO];
    await openHistory();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));

    (await untilAction("history-delete")).click();

    await vi.waitFor(() => expect(rows()).toEqual(["Spider-Man 2 ISO"]));
    expect(stored().map((entry) => entry.id)).toEqual([ISO.id]);
  });

  it("deletes everything only after the confirmation step", async () => {
    fakeRuntime.conversations = [AI, ISO];
    await openHistory();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));

    (await untilAction("history-clear")).click();
    // Armed, not fired: retention is unlimited, so this is the one irreversible button.
    expect(stored()).toHaveLength(2);

    (await untilAction("history-clear-confirm")).click();

    await vi.waitFor(() => expect(stored()).toEqual([]));
    await vi.waitFor(() => expect(host().shadowRoot?.textContent).toContain("Ask about a message"));
  });
});
