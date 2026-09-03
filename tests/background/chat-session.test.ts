/**
 * Failure mode defended: `attachChatPort` is the extension's last stop before the request
 * leaves the machine, so it is where the "send images" setting has to be honoured. If it
 * forwarded `images` regardless, unticking the box in the panel would change nothing —
 * the panel builds the messages and never sees `Settings`, so nothing upstream can enforce
 * it. The assertion target is therefore what the provider was handed, not what was posted.
 *
 * Runs in the Node environment: a chrome.runtime.Port is a plain object with two listener
 * registries, so the whole state machine is drivable without a browser.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachChatPort } from "../../src/background/chat-session";
import type { ChatMessage, PortResponse } from "../../src/core/messaging";
import { AUTO_LANGUAGE, type Settings } from "../../src/core/settings";

const fakeChrome = vi.hoisted(() => {
  const state = { store: {} as Record<string, unknown>, granted: [] as string[] };
  Object.assign(globalThis, {
    chrome: {
      storage: {
        local: {
          get: (key: string) => Promise.resolve(key in state.store ? { [key]: state.store[key] } : {}),
          set: (items: Record<string, unknown>) => {
            Object.assign(state.store, items);
            return Promise.resolve();
          },
        },
      },
      permissions: {
        contains: ({ origins }: { origins: string[] }) => Promise.resolve(origins.every((o) => state.granted.includes(o))),
      },
    },
  });
  return state;
});

const stub = vi.hoisted(() => ({ received: [] as ChatMessage[][] }));
vi.mock("../../src/background/providers", () => ({
  createProvider: () => ({
    stream: (messages: ChatMessage[]) => {
      stub.received.push(messages);
      return (async function* () {
        yield "ok";
      })();
    },
  }),
}));

const SETTINGS: Settings = {
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-stored",
  model: "m",
  sendImages: true,
  language: AUTO_LANGUAGE,
};

const WITH_IMAGE: ChatMessage[] = [
  { role: "system", content: "rules" },
  { role: "user", content: "explain", images: [{ url: "https://cdn.discordapp.test/shot.png", name: "shot.png" }] },
];

interface Harness {
  send: (raw: unknown) => void;
  posted: PortResponse[];
  /** Resolves once a `done` or `error` for `requestId` has been posted back. */
  terminal: (requestId: string) => Promise<PortResponse>;
}

function harness(): Harness {
  const posted: PortResponse[] = [];
  const waiters: Array<() => void> = [];
  const messageListeners: Array<(raw: unknown) => void> = [];
  const port = {
    postMessage: (response: PortResponse) => {
      posted.push(response);
      for (const fn of waiters.splice(0)) fn();
    },
    onMessage: { addListener: (fn: (raw: unknown) => void) => messageListeners.push(fn) },
    onDisconnect: { addListener: () => undefined },
  };
  attachChatPort(port as unknown as chrome.runtime.Port);
  return {
    send: (raw) => {
      for (const fn of messageListeners) fn(raw);
    },
    posted,
    terminal: (requestId) => {
      const { promise, resolve } = Promise.withResolvers<PortResponse>();
      const check = (): void => {
        const hit = posted.find((p) => p.requestId === requestId && (p.type === "done" || p.type === "error"));
        if (hit !== undefined) resolve(hit);
        else waiters.push(check);
      };
      check();
      return promise;
    },
  };
}

beforeEach(() => {
  fakeChrome.store = { settings: SETTINGS };
  fakeChrome.granted = ["https://api.anthropic.com/*"];
  stub.received = [];
});

describe("attachChatPort image policy", () => {
  it("hands the provider no images at all when sendImages is off", async () => {
    fakeChrome.store.settings = { ...SETTINGS, sendImages: false };
    const h = harness();
    h.send({ type: "chat", requestId: "r1", messages: WITH_IMAGE });
    await h.terminal("r1");
    expect(stub.received[0]).toEqual([
      { role: "system", content: "rules" },
      { role: "user", content: "explain" },
    ]);
  });

  it("hands the provider the images unchanged when sendImages is on", async () => {
    const h = harness();
    h.send({ type: "chat", requestId: "r2", messages: WITH_IMAGE });
    await h.terminal("r2");
    expect(stub.received[0]).toEqual(WITH_IMAGE);
  });

  // A configuration written before the toggle existed parses as "on"; a user who never
  // opened the new settings must not find image support quietly disabled.
  it("still sends images when the stored configuration predates the sendImages field", async () => {
    fakeChrome.store.settings = { provider: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-old", model: "m" };
    const h = harness();
    h.send({ type: "chat", requestId: "r3", messages: WITH_IMAGE });
    await h.terminal("r3");
    expect(stub.received[0]).toEqual(WITH_IMAGE);
  });
});

// Same failure mode as the image policy above, one field over: the panel builds the messages
// and never sees `Settings`, so if the service worker did not fold the language into the
// outgoing conversation, choosing "Türkçe" would change nothing the model ever sees.
describe("attachChatPort answer-language policy", () => {
  it("hands the provider a system message that names the configured language", async () => {
    fakeChrome.store.settings = { ...SETTINGS, language: "Türkçe" };
    const h = harness();
    h.send({ type: "chat", requestId: "r4", messages: WITH_IMAGE });
    await h.terminal("r4");
    const sent = stub.received[0] ?? [];
    expect(sent[0]?.role).toBe("system");
    expect(sent[0]?.content).toContain("Türkçe");
    // Appended, not substituted: the prompt's own rules must still reach the model, and
    // nothing outside the system message may change.
    expect(sent[0]?.content.startsWith("rules")).toBe(true);
    expect(sent.slice(1)).toEqual(WITH_IMAGE.slice(1));
  });

  it("hands the provider the conversation untouched when the language is auto", async () => {
    const h = harness();
    h.send({ type: "chat", requestId: "r5", messages: WITH_IMAGE });
    await h.terminal("r5");
    expect(stub.received[0]).toEqual(WITH_IMAGE);
  });
});
