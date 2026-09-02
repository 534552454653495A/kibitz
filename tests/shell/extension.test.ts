// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, PortRequest, PortResponse } from "../../src/core/messaging";
import { createExtensionShell } from "../../src/shell/extension";
import { ChatError } from "../../src/shell/types";

interface FakePort {
  sent: PortRequest[];
  disconnected: boolean;
  emit: (msg: PortResponse) => void;
  /** Simulates the service worker dying: fires onDisconnect on the page side. */
  drop: () => void;
}

// A scripted stand-in for the background, installed before `shared/ext.ts` evaluates
// `chrome` at import time (hence vi.hoisted). One port per connect, answers driven by the test.
const fakeRuntime = vi.hoisted(() => {
  const state = {
    ports: [] as Array<{
      sent: Array<{ type: string; requestId: string }>;
      disconnected: boolean;
      emit: (msg: unknown) => void;
      drop: () => void;
    }>,
    /** Every one-shot message the shell sent, so a test can assert what crossed the seam. */
    sent: [] as unknown[],
    reply: {} as Record<string, unknown>,
  };
  const runtime = {
    lastError: undefined as { message: string } | undefined,
    sendMessage: (req: { type: string }) => {
      state.sent.push(req);
      return Promise.resolve(state.reply[req.type]);
    },
    connect: () => {
      const listeners: Array<(msg: unknown) => void> = [];
      const disconnectListeners: Array<() => void> = [];
      const port = {
        sent: [] as Array<{ type: string; requestId: string }>,
        disconnected: false,
        emit: (msg: unknown) => listeners.forEach((l) => l(msg)),
        drop: () => disconnectListeners.forEach((l) => l()),
        postMessage: (msg: { type: string; requestId: string }) => port.sent.push(msg),
        disconnect: () => {
          port.disconnected = true;
        },
        onMessage: { addListener: (l: (msg: unknown) => void) => listeners.push(l) },
        onDisconnect: { addListener: (l: () => void) => disconnectListeners.push(l) },
      };
      state.ports.push(port);
      return port;
    },
  };
  Object.assign(globalThis, { chrome: { runtime } });
  return state;
});

const messages: ChatMessage[] = [{ role: "user", content: "explain this" }];
const options = () => ({ onDelta: () => undefined, signal: new AbortController().signal });

function port(index: number): FakePort {
  const found = fakeRuntime.ports[index];
  if (found === undefined) throw new Error(`port ${index} was never opened`);
  return found as FakePort;
}

function chatRequestId(p: FakePort): string {
  const first = p.sent[0];
  if (first?.type !== "chat") throw new Error("expected a chat request first");
  return first.requestId;
}

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
  fakeRuntime.ports.length = 0;
  fakeRuntime.sent.length = 0;
  fakeRuntime.reply = {};
});

describe("extension shell streamChat", () => {
  it("opens one port per call and disconnects only the finished one after done", async () => {
    const shell = createExtensionShell();
    const first = shell.streamChat(messages, options());
    const second = shell.streamChat(messages, options());
    expect(fakeRuntime.ports).toHaveLength(2);

    port(0).emit({ type: "done", requestId: chatRequestId(port(0)) });
    await first;
    expect(port(0).disconnected).toBe(true);
    expect(port(1).disconnected).toBe(false);

    port(1).emit({ type: "done", requestId: chatRequestId(port(1)) });
    await second;
    expect(port(1).disconnected).toBe(true);
  });

  it("posts a cancel for the request and rejects aborted when the signal fires", async () => {
    const abort = new AbortController();
    const done = createExtensionShell().streamChat(messages, { onDelta: () => undefined, signal: abort.signal });
    const requestId = chatRequestId(port(0));
    abort.abort();
    const err = await rejection(done);
    expect(err.code).toBe("aborted");
    expect(port(0).sent).toContainEqual({ type: "cancel", requestId });
    expect(port(0).disconnected).toBe(true);
  });

  it("rejects with code provider when the port disconnects before done", async () => {
    const done = createExtensionShell().streamChat(messages, options());
    port(0).drop();
    const err = await rejection(done);
    expect(err.code).toBe("provider");
  });

  it("ignores messages carrying another request's id", async () => {
    const seen: string[] = [];
    const done = createExtensionShell().streamChat(messages, { onDelta: (t) => seen.push(t), signal: new AbortController().signal });
    const requestId = chatRequestId(port(0));
    port(0).emit({ type: "delta", requestId: "someone-else", text: "stray" });
    port(0).emit({ type: "delta", requestId, text: "mine" });
    port(0).emit({ type: "done", requestId });
    await done;
    expect(seen).toEqual(["mine"]);
  });
});

describe("extension shell settingsStatus", () => {
  it("returns the background's redacted status", async () => {
    fakeRuntime.reply["settings-status"] = { configured: true, provider: "openai", model: "gpt-5" };
    await expect(createExtensionShell().settingsStatus()).resolves.toEqual({ configured: true, provider: "openai", model: "gpt-5" });
  });

  it("throws when the background answers without a boolean configured flag", async () => {
    fakeRuntime.reply["settings-status"] = { ok: true };
    await expect(createExtensionShell().settingsStatus()).rejects.toThrow(/settings status/);
  });
});

describe("extension shell one-shot requests", () => {
  it("returns null for load-settings when nothing is configured, and the draft otherwise", async () => {
    fakeRuntime.reply["load-settings"] = { draft: null };
    await expect(createExtensionShell().loadSettings()).resolves.toBeNull();

    fakeRuntime.reply["load-settings"] = {
      draft: { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "m", hasKey: true, sendImages: false },
    };
    await expect(createExtensionShell().loadSettings()).resolves.toEqual({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "m",
      hasKey: true,
      sendImages: false,
    });
  });

  it("throws instead of handing the settings view a draft with an unknown provider", async () => {
    fakeRuntime.reply["load-settings"] = {
      draft: { provider: "gemini", baseUrl: "https://x.test", model: "m", hasKey: true, sendImages: true },
    };
    await expect(createExtensionShell().loadSettings()).rejects.toThrow(/malformed settings draft/);
  });

  // A service worker from before the image toggle answers without the field. The panel may
  // already have been reloaded (extensions update the page and the worker independently),
  // and refusing the draft would replace the whole settings form with "malformed draft".
  it("accepts a draft with no sendImages and shows the toggle as on rather than rejecting it", async () => {
    fakeRuntime.reply["load-settings"] = {
      draft: { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "m", hasKey: true },
    };
    await expect(createExtensionShell().loadSettings()).resolves.toMatchObject({ sendImages: true });
  });

  it("rejects a draft whose sendImages is not a boolean instead of guessing a policy", async () => {
    fakeRuntime.reply["load-settings"] = {
      draft: { provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "m", hasKey: true, sendImages: "yes" },
    };
    await expect(createExtensionShell().loadSettings()).rejects.toThrow(/malformed settings draft/);
  });

  it("throws when the worker died mid-request and sendMessage resolved with nothing", async () => {
    fakeRuntime.reply["load-settings"] = undefined;
    await expect(createExtensionShell().loadSettings()).rejects.toThrow(/no reply to load-settings/);
  });

  it("forwards the draft unchanged and preserves grantOrigin so the panel can offer the grant", async () => {
    fakeRuntime.reply["save-settings"] = {
      ok: false,
      error: "Settings saved. Chrome must approve access to https://api.openai.com/* before Kibitz can use it.",
      grantOrigin: "https://api.openai.com/*",
    };
    const input = {
      provider: "openai-compatible" as const,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt",
      apiKey: "sk-1",
      sendImages: true,
    };
    await expect(createExtensionShell().saveSettings(input)).resolves.toEqual({
      ok: false,
      error: "Settings saved. Chrome must approve access to https://api.openai.com/* before Kibitz can use it.",
      grantOrigin: "https://api.openai.com/*",
    });
    expect(fakeRuntime.sent).toContainEqual({ type: "save-settings", input });
  });

  it("throws when a save reply is neither ok:true nor an error message", async () => {
    fakeRuntime.reply["save-settings"] = { ok: false };
    await expect(
      createExtensionShell().saveSettings({ provider: "anthropic", baseUrl: "https://a.test", model: "m", apiKey: "", sendImages: true }),
    ).rejects.toThrow(/malformed save result/);
  });

  it("reports the background's grant decision rather than assuming success", async () => {
    fakeRuntime.reply["request-access"] = { granted: false };
    await expect(createExtensionShell().requestAccess("https://api.openai.com/*")).resolves.toBe(false);
    expect(fakeRuntime.sent).toContainEqual({ type: "request-access", origin: "https://api.openai.com/*" });
  });

  it("falls back to an empty ui state instead of throwing when the background has none stored", async () => {
    fakeRuntime.reply["load-ui-state"] = { state: { panelLayout: { mode: "right" } } };
    await expect(createExtensionShell().loadUiState()).resolves.toEqual({ panelLayout: { mode: "right" } });

    fakeRuntime.reply["load-ui-state"] = { ok: true };
    await expect(createExtensionShell().loadUiState()).resolves.toEqual({});
  });

  it("sends the ui state as one save-ui-state message", async () => {
    fakeRuntime.reply["save-ui-state"] = { ok: true };
    await createExtensionShell().saveUiState({ panelLayout: { mode: "float", x: 10 } });
    expect(fakeRuntime.sent).toContainEqual({ type: "save-ui-state", state: { panelLayout: { mode: "float", x: 10 } } });
  });
});
