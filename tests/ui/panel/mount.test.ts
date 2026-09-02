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
} from "../../../src/shared/dom-markers";
import { mountPanel } from "../../../src/ui/panel/mount";

interface FakePort {
  sent: PortRequest[];
  disconnected: boolean;
  emit: (msg: PortResponse) => void;
}

// A scripted stand-in for the background, installed before `shared/ext.ts` evaluates
// `chrome` at import time (hence vi.hoisted). One port per request, answers driven by the test.
const fakeRuntime = vi.hoisted(() => {
  const state = {
    configured: true,
    ports: [] as Array<{ sent: PortRequest[]; disconnected: boolean; emit: (msg: PortResponse) => void }>,
    sendMessage: vi.fn(),
  };
  const runtime = {
    lastError: undefined,
    sendMessage: (req: { type: string }) => {
      state.sendMessage(req);
      return Promise.resolve(req.type === "settings-status" ? { configured: state.configured } : { ok: true });
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
const untilState = (attr: string, value: string): Promise<void> =>
  vi.waitFor(() => expect(host().getAttribute(attr)).toBe(value));
const untilPort = (index: number): Promise<FakePort> =>
  vi.waitFor(() => {
    const port = fakeRuntime.ports[index];
    if (port === undefined) throw new Error(`port ${index} not opened yet`);
    return port;
  });
const untilAction = (name: string): Promise<HTMLElement> => vi.waitFor(() => action(name));

beforeEach(() => {
  document.body.innerHTML = "";
  fakeRuntime.ports.length = 0;
  fakeRuntime.configured = true;
  fakeRuntime.sendMessage.mockClear();
});

describe("mountPanel host attributes", () => {
  it("starts closed and moves loading → ready with the message id when the read succeeds", async () => {
    const panel = mountPanel(adapter());
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
    const panel = mountPanel(adapter({ readMessage: () => Promise.reject(err) }));
    panel.open(ref);
    await untilState(PANEL_STATE_ATTR, "error");
    expect(host().getAttribute(PANEL_ERROR_ATTR)).toBe("RpcTimeoutError: bridge timed out");
  });

  it("streams the explanation into the panel once the message is ready", async () => {
    const panel = mountPanel(adapter());
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
    const panel = mountPanel(adapter());
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
    const panel = mountPanel(
      adapter({
        collectAround: (_ref, _opts, onProgress) => {
          onProgress?.({ collected: 1 });
          seenDuringScan.push(host().getAttribute(SCAN_STATE_ATTR) ?? "", host().getAttribute(SCAN_COUNT_ATTR) ?? "");
          return Promise.resolve(thread);
        },
      }),
    );
    panel.open(ref);
    (await untilAction("scan")).click();
    await untilState(SCAN_STATE_ATTR, "done");
    expect(seenDuringScan).toEqual(["running", "1"]);
    expect(host().getAttribute(SCAN_COUNT_ATTR)).toBe("2");
    expect(fakeRuntime.ports).toHaveLength(0);
  });

  it("marks the scan as failed when collection rejects", async () => {
    fakeRuntime.configured = false;
    const panel = mountPanel(adapter({ collectAround: () => Promise.reject(new Error("scroll container lost")) }));
    panel.open(ref);
    (await untilAction("scan")).click();
    await untilState(SCAN_STATE_ATTR, "error");
  });

  it("closes on the close action and on Escape, clearing the message id", async () => {
    const panel = mountPanel(adapter());
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
    const panel = mountPanel(
      adapter({
        readMessage: () => (++calls === 1 ? slow : Promise.resolve({ ...message, id: "m2", content: "second" })),
      }),
    );
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
