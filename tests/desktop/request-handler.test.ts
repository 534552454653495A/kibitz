import { setImmediate as nextTick } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopRequestHandler, type DesktopRequestHandler, type RequestHandlerDeps } from "../../desktop/request-handler";
import type { ChatMessage } from "../../src/core/messaging";
import type { Settings } from "../../src/core/settings";
import type { DesktopDelivery } from "../../src/shell/desktop-protocol";

// The provider is the network; the handler's contract is what it does around it.
const stub = vi.hoisted(() => ({
  stream: (_messages: ChatMessage[], _signal: AbortSignal): AsyncIterable<string> => (async function* () {})(),
  created: 0,
}));
vi.mock("../../src/background/providers/index", () => ({
  createProvider: () => {
    stub.created += 1;
    return { stream: stub.stream };
  },
}));

const SETTINGS: Settings = { provider: "anthropic", baseUrl: "https://example.test", apiKey: "sk-very-secret", model: "m" };
const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];

async function* yields(...chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk;
}

interface Harness {
  handler: DesktopRequestHandler;
  deliveries: DesktopDelivery[];
  /** Resolves when a `done` or `error` delivery for `requestId` has arrived. */
  terminal(requestId: string): Promise<DesktopDelivery>;
  /** Resolves when the n-th delivery has arrived. */
  nth(n: number): Promise<DesktopDelivery>;
  openOptions: ReturnType<typeof vi.fn>;
}

function harness(settings: Settings | null): Harness {
  const deliveries: DesktopDelivery[] = [];
  const listeners: Array<() => void> = [];
  const openOptions = vi.fn();
  const deps: RequestHandlerDeps = {
    loadSettings: async () => settings,
    deliver: async (json) => {
      deliveries.push(JSON.parse(json) as DesktopDelivery);
      for (const fn of listeners.splice(0)) fn();
      return true;
    },
    openOptions,
  };
  const waitFor = (test: () => DesktopDelivery | undefined): Promise<DesktopDelivery> => {
    const { promise, resolve } = Promise.withResolvers<DesktopDelivery>();
    const check = (): void => {
      const hit = test();
      if (hit !== undefined) resolve(hit);
      else listeners.push(check);
    };
    check();
    return promise;
  };
  return {
    handler: createDesktopRequestHandler(deps),
    deliveries,
    openOptions,
    terminal: (requestId) =>
      waitFor(() => deliveries.find((d) => d.requestId === requestId && (d.type === "done" || d.type === "error"))),
    nth: (n) => waitFor(() => deliveries[n - 1]),
  };
}

beforeEach(() => {
  stub.created = 0;
  stub.stream = () => yields();
});

describe("chat", () => {
  it("replies {ok:true} before any delivery, then delivers delta, delta, done in order", async () => {
    stub.stream = () => yields("a", "b");
    const h = harness(SETTINGS);
    const reply = JSON.parse(await h.handler.handle(JSON.stringify({ type: "chat", requestId: "r1", messages: MESSAGES })));
    expect(reply).toEqual({ ok: true });
    expect(h.deliveries).toEqual([]);
    await h.terminal("r1");
    expect(h.deliveries).toEqual([
      { type: "delta", requestId: "r1", text: "a" },
      { type: "delta", requestId: "r1", text: "b" },
      { type: "done", requestId: "r1" },
    ]);
  });

  it("delivers a no-settings error and never constructs a provider when settings are null", async () => {
    const h = harness(null);
    await h.handler.handle(JSON.stringify({ type: "chat", requestId: "r2", messages: MESSAGES }));
    const end = await h.terminal("r2");
    expect(end).toMatchObject({ type: "error", requestId: "r2", code: "no-settings" });
    expect(h.deliveries).toHaveLength(1);
    expect(stub.created).toBe(0);
  });

  it("cancel aborts the provider signal and ends the stream with an aborted error", async () => {
    stub.stream = (_messages, signal) =>
      (async function* () {
        yield "first";
        const { promise, resolve } = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => resolve(), { once: true });
        await promise;
        yield "never delivered";
      })();
    const h = harness(SETTINGS);
    await h.handler.handle(JSON.stringify({ type: "chat", requestId: "r3", messages: MESSAGES }));
    await h.nth(1);
    const cancelReply = JSON.parse(await h.handler.handle(JSON.stringify({ type: "cancel", requestId: "r3" })));
    expect(cancelReply).toEqual({ ok: true });
    const end = await h.terminal("r3");
    expect(end).toMatchObject({ type: "error", requestId: "r3", code: "aborted" });
    expect(h.deliveries.filter((d) => d.type === "delta").map((d) => d.text)).toEqual(["first"]);
  });

  it("maps a provider throw to a classified error delivery instead of rejecting the call", async () => {
    stub.stream = () =>
      (async function* () {
        yield "partial";
        throw new TypeError("fetch failed");
      })();
    const h = harness(SETTINGS);
    await h.handler.handle(JSON.stringify({ type: "chat", requestId: "r4", messages: MESSAGES }));
    const end = await h.terminal("r4");
    expect(end).toMatchObject({ type: "error", requestId: "r4", code: "network" });
  });

  it("abortAll cancels every in-flight stream", async () => {
    stub.stream = (_messages, signal) =>
      (async function* () {
        const { promise, resolve } = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => resolve(), { once: true });
        await promise;
      })();
    const h = harness(SETTINGS);
    await h.handler.handle(JSON.stringify({ type: "chat", requestId: "a", messages: MESSAGES }));
    await h.handler.handle(JSON.stringify({ type: "chat", requestId: "b", messages: MESSAGES }));
    // Both streams must be past loadSettings and parked on the signal before abortAll runs.
    await nextTick();
    h.handler.abortAll();
    const ends = await Promise.all([h.terminal("a"), h.terminal("b")]);
    expect(ends.map((d) => d.type === "error" && d.code)).toEqual(["aborted", "aborted"]);
  });
});

describe("control requests", () => {
  it("settings-status reports provider and model but never the key", async () => {
    const h = harness(SETTINGS);
    const json = await h.handler.handle(JSON.stringify({ type: "settings-status" }));
    expect(JSON.parse(json)).toEqual({ configured: true, provider: "anthropic", model: "m" });
    expect(json).not.toContain(SETTINGS.apiKey);
  });

  it("settings-status is {configured:false} without settings", async () => {
    const h = harness(null);
    expect(JSON.parse(await h.handler.handle(JSON.stringify({ type: "settings-status" })))).toEqual({ configured: false });
  });

  it("open-options invokes the companion's instructions hook and acknowledges", async () => {
    const h = harness(SETTINGS);
    expect(JSON.parse(await h.handler.handle(JSON.stringify({ type: "open-options" })))).toEqual({ ok: true });
    expect(h.openOptions).toHaveBeenCalledTimes(1);
  });
});

describe("malformed input", () => {
  it("answers {ok:false} to non-JSON instead of throwing across the CDP binding", async () => {
    const h = harness(SETTINGS);
    expect(JSON.parse(await h.handler.handle("{not json"))).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("answers {ok:false} to a chat without requestId and starts no stream", async () => {
    const h = harness(SETTINGS);
    expect(JSON.parse(await h.handler.handle(JSON.stringify({ type: "chat", messages: MESSAGES })))).toMatchObject({ ok: false });
    expect(JSON.parse(await h.handler.handle(JSON.stringify({ type: "reboot" })))).toMatchObject({ ok: false });
    expect(stub.created).toBe(0);
  });
});
