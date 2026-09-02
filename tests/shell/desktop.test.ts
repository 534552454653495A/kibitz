// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/core/messaging";
import { createDesktopShell } from "../../src/shell/desktop";
import {
  DESKTOP_CALL_BINDING,
  DESKTOP_DELIVER_FN,
  type DesktopDelivery,
  type DesktopRequest,
} from "../../src/shell/desktop-protocol";
import { ChatError } from "../../src/shell/types";

const messages: ChatMessage[] = [{ role: "user", content: "explain this" }];

// A scripted stand-in for the companion's `page.exposeFunction` binding: records every
// request and answers with whatever the test scripted for that request type.
const companion = {
  requests: [] as DesktopRequest[],
  reply: {} as Partial<Record<DesktopRequest["type"], unknown>>,
};

function installBinding(): void {
  window[DESKTOP_CALL_BINDING] = (json: string) => {
    const request = JSON.parse(json) as DesktopRequest;
    companion.requests.push(request);
    return Promise.resolve(JSON.stringify(companion.reply[request.type] ?? { ok: true }));
  };
}

/** The companion pushes by `page.evaluate`, i.e. by calling the window function with one JSON string. */
function push(delivery: DesktopDelivery): void {
  const fn = window[DESKTOP_DELIVER_FN];
  if (fn === undefined) throw new Error("the shell has not defined the deliver function");
  fn(JSON.stringify(delivery));
}

const chatRequest = (index: number): Promise<Extract<DesktopRequest, { type: "chat" }>> =>
  vi.waitFor(() => {
    const chats = companion.requests.filter((r): r is Extract<DesktopRequest, { type: "chat" }> => r.type === "chat");
    const found = chats[index];
    if (found === undefined) throw new Error(`chat request ${index} not sent yet`);
    return found;
  });

async function rejection(promise: Promise<unknown>): Promise<ChatError> {
  try {
    await promise;
  } catch (err: unknown) {
    if (err instanceof ChatError) return err;
    throw new Error(`rejected with a non-ChatError: ${String(err)}`);
  }
  throw new Error("promise resolved but a ChatError rejection was expected");
}

beforeEach(() => {
  companion.requests.length = 0;
  companion.reply = {};
  installBinding();
});

describe("desktop shell streamChat", () => {
  it("forwards every delta in order and resolves on done", async () => {
    const shell = createDesktopShell();
    const seen: string[] = [];
    const done = shell.streamChat(messages, { onDelta: (t) => seen.push(t), signal: new AbortController().signal });
    const { requestId } = await chatRequest(0);
    push({ type: "delta", requestId, text: "It says " });
    push({ type: "delta", requestId, text: "hi." });
    push({ type: "done", requestId });
    await done;
    expect(seen).toEqual(["It says ", "hi."]);
  });

  it("rejects with the delivered error code and message", async () => {
    const shell = createDesktopShell();
    const done = shell.streamChat(messages, { onDelta: () => undefined, signal: new AbortController().signal });
    const { requestId } = await chatRequest(0);
    push({ type: "error", requestId, code: "http", message: "401 from provider" });
    const err = await rejection(done);
    expect(err.code).toBe("http");
    expect(err.message).toBe("401 from provider");
  });

  it("sends a cancel for the request and rejects aborted when the signal fires mid-stream", async () => {
    const shell = createDesktopShell();
    const abort = new AbortController();
    const seen: string[] = [];
    const done = shell.streamChat(messages, { onDelta: (t) => seen.push(t), signal: abort.signal });
    const { requestId } = await chatRequest(0);
    push({ type: "delta", requestId, text: "partial" });
    abort.abort();
    const err = await rejection(done);
    expect(err.code).toBe("aborted");
    expect(companion.requests).toContainEqual({ type: "cancel", requestId });
    // The companion keeps streaming until it processes the cancel; nothing may leak through.
    push({ type: "delta", requestId, text: "late" });
    expect(seen).toEqual(["partial"]);
  });

  it("rejects aborted without contacting the companion when the signal is already aborted", async () => {
    const shell = createDesktopShell();
    const abort = new AbortController();
    abort.abort();
    const err = await rejection(shell.streamChat(messages, { onDelta: () => undefined, signal: abort.signal }));
    expect(err.code).toBe("aborted");
    expect(companion.requests).toEqual([]);
  });

  it("rejects with code provider naming the companion when the call binding is missing", async () => {
    delete window[DESKTOP_CALL_BINDING];
    const shell = createDesktopShell();
    const err = await rejection(shell.streamChat(messages, { onDelta: () => undefined, signal: new AbortController().signal }));
    expect(err.code).toBe("provider");
    expect(err.message).toContain("companion");
  });

  it("rejects with the companion's error when the immediate reply is ok:false", async () => {
    companion.reply.chat = { ok: false, error: "malformed request" };
    const shell = createDesktopShell();
    const err = await rejection(shell.streamChat(messages, { onDelta: () => undefined, signal: new AbortController().signal }));
    expect(err.code).toBe("provider");
    expect(err.message).toBe("malformed request");
  });

  it("ignores deliveries for unknown request ids without disturbing the live stream", async () => {
    const shell = createDesktopShell();
    const seen: string[] = [];
    const done = shell.streamChat(messages, { onDelta: (t) => seen.push(t), signal: new AbortController().signal });
    const { requestId } = await chatRequest(0);
    push({ type: "delta", requestId: "cancelled-earlier", text: "stale" });
    push({ type: "error", requestId: "cancelled-earlier", code: "network", message: "stale failure" });
    push({ type: "delta", requestId, text: "live" });
    push({ type: "done", requestId });
    await done;
    expect(seen).toEqual(["live"]);
  });

  it("keeps the first inbox when a second shell instance is created", async () => {
    const first = createDesktopShell();
    const inbox = window[DESKTOP_DELIVER_FN];
    const seen: string[] = [];
    const done = first.streamChat(messages, { onDelta: (t) => seen.push(t), signal: new AbortController().signal });
    const { requestId } = await chatRequest(0);
    createDesktopShell();
    expect(window[DESKTOP_DELIVER_FN]).toBe(inbox);
    push({ type: "delta", requestId, text: "still routed" });
    push({ type: "done", requestId });
    await done;
    expect(seen).toEqual(["still routed"]);
  });
});

describe("desktop shell settingsStatus", () => {
  it("returns the companion's redacted status", async () => {
    companion.reply["settings-status"] = { configured: true, provider: "anthropic", model: "claude-sonnet-4-5" };
    const status = await createDesktopShell().settingsStatus();
    expect(status).toEqual({ configured: true, provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(companion.requests).toEqual([{ type: "settings-status" }]);
  });

  it("throws when the reply carries no boolean configured flag", async () => {
    companion.reply["settings-status"] = { ok: true };
    await expect(createDesktopShell().settingsStatus()).rejects.toThrow(/settings status/);
  });

  it("rejects with code provider when the companion is not connected", async () => {
    delete window[DESKTOP_CALL_BINDING];
    const err = await rejection(createDesktopShell().settingsStatus());
    expect(err.code).toBe("provider");
  });
});

describe("desktop shell openOptions", () => {
  it("sends open-options to the companion", async () => {
    await createDesktopShell().openOptions();
    expect(companion.requests).toEqual([{ type: "open-options" }]);
  });
});

describe("desktop shell settings and ui state", () => {
  it("returns null for load-settings before the wizard has written settings.json", async () => {
    companion.reply["load-settings"] = { draft: null };
    await expect(createDesktopShell().loadSettings()).resolves.toBeNull();
  });

  it("throws when the companion answers load-settings with a draft missing hasKey", async () => {
    companion.reply["load-settings"] = { draft: { provider: "anthropic", baseUrl: "https://a.test", model: "m" } };
    await expect(createDesktopShell().loadSettings()).rejects.toThrow(/companion returned a malformed settings draft/);
  });

  it("sends the draft as a save-settings request and surfaces the companion's refusal", async () => {
    companion.reply["save-settings"] = { ok: false, error: "An API key is required." };
    const input = { provider: "anthropic" as const, baseUrl: "https://a.test", model: "m", apiKey: "", sendImages: false };
    await expect(createDesktopShell().saveSettings(input)).resolves.toEqual({ ok: false, error: "An API key is required." });
    expect(companion.requests).toEqual([{ type: "save-settings", input }]);
  });

  it("grants access without a round trip, because the companion has no permission model", async () => {
    await expect(createDesktopShell().requestAccess("https://a.test/*")).resolves.toBe(true);
    expect(companion.requests).toEqual([]);
  });

  it("reads the stored ui state and falls back to {} when the companion sends none", async () => {
    companion.reply["load-ui-state"] = { state: { panelLayout: { mode: "left", size: 380 } } };
    await expect(createDesktopShell().loadUiState()).resolves.toEqual({ panelLayout: { mode: "left", size: 380 } });

    companion.reply["load-ui-state"] = { ok: true };
    await expect(createDesktopShell().loadUiState()).resolves.toEqual({});
  });

  it("sends the ui state blob verbatim on save", async () => {
    await createDesktopShell().saveUiState({ view: "settings" });
    expect(companion.requests).toEqual([{ type: "save-ui-state", state: { view: "settings" } }]);
  });
});
