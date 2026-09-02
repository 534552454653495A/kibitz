// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "../../../src/core/adapter";
import type { PortRequest, PortResponse } from "../../../src/core/messaging";
import type { UniversalMessage, UniversalThread } from "../../../src/core/types";
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
    ports: [] as Array<{ sent: PortRequest[]; disconnected: boolean; emit: (msg: PortResponse) => void }>,
    sendMessage: vi.fn(),
  };
  const runtime = {
    lastError: undefined,
    sendMessage: (req: { type: string; state?: Record<string, unknown> }) => {
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
const untilPort = (index: number): Promise<FakePort> =>
  vi.waitFor(() => {
    const port = fakeRuntime.ports[index];
    if (port === undefined) throw new Error(`port ${index} not opened yet`);
    return port;
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
