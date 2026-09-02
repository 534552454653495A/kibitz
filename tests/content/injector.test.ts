// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageElementRef, PlatformAdapter } from "../../src/core/adapter";
import type { MessageRef } from "../../src/core/types";
import { startInjector } from "../../src/content/injector";
import { ACTION_ATTR, BUTTON_HOST_ATTR } from "../../src/shared/dom-markers";

function fakeAdapter(root: Element): PlatformAdapter {
  return {
    platform: "discord",
    matches: () => true,
    findListRoot: () => root,
    listMessageElements: (r): MessageElementRef[] =>
      Array.from(r.querySelectorAll<HTMLElement>("[data-test-msg]")).map((element) => ({
        platform: "discord",
        channelId: "c1",
        messageId: element.dataset["testMsg"] ?? "",
        element,
      })),
    buttonAnchor: (ref) => (ref.element.hasAttribute("data-test-no-anchor") ? null : { parent: ref.element, placement: "inline" }),
    readMessage: () => Promise.reject(new Error("unused")),
    collectAround: () => Promise.reject(new Error("unused")),
  };
}

function item(id: string): HTMLElement {
  const li = document.createElement("li");
  li.setAttribute("data-test-msg", id);
  return li;
}

/**
 * Longer than the injector's coalescing window, advanced on the fake clock. The injector
 * debounces scans on a timer (never on an animation frame — see injector.ts), so moving the
 * clock, not producing frames, is what settles it.
 */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(100);
};

/** Wraps an adapter to count how many times a scan asked it for the list root. */
function countingAdapter(inner: PlatformAdapter, onScan: () => void): PlatformAdapter {
  return {
    ...inner,
    findListRoot: (doc) => {
      onScan();
      return inner.findListRoot(doc);
    },
  };
}

function listInBody(...ids: string[]): HTMLElement {
  document.body.innerHTML = "";
  const root = document.createElement("ol");
  root.append(...ids.map(item));
  document.body.append(root);
  return root;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startInjector", () => {
  it("mounts one explain button per message item and hands the click the message ref", async () => {
    const root = listInBody("1", "2");
    const clicks: MessageRef[] = [];
    const dispose = startInjector(fakeAdapter(root), (ref) => clicks.push(ref));

    const hosts = root.querySelectorAll(`[${BUTTON_HOST_ATTR}]`);
    expect(Array.from(hosts, (h) => h.getAttribute(BUTTON_HOST_ATTR))).toEqual(["1", "2"]);
    const button = hosts[1]?.shadowRoot?.querySelector<HTMLElement>(`[${ACTION_ATTR}="explain"]`);
    button?.click();
    expect(clicks).toEqual([{ platform: "discord", channelId: "c1", messageId: "2" }]);
    dispose();
  });

  it("injects into items added later without duplicating existing buttons", async () => {
    const root = listInBody("1");
    const dispose = startInjector(fakeAdapter(root), () => undefined);

    root.append(item("2"));
    await settle();
    expect(root.querySelectorAll(`[${BUTTON_HOST_ATTR}]`)).toHaveLength(2);
    // A further unrelated mutation must not add a second button to either item.
    root.append(document.createElement("hr"));
    await settle();
    expect(root.querySelectorAll(`[${BUTTON_HOST_ATTR}]`)).toHaveLength(2);
    dispose();
  });

  it("retries an item that had no anchor once it gains one", async () => {
    const root = listInBody();
    const pending = item("9");
    pending.setAttribute("data-test-no-anchor", "");
    root.append(pending);
    const dispose = startInjector(fakeAdapter(root), () => undefined);
    expect(root.querySelector(`[${BUTTON_HOST_ATTR}]`)).toBeNull();

    pending.removeAttribute("data-test-no-anchor");
    pending.append(document.createElement("span"));
    await settle();
    expect(root.querySelector(`[${BUTTON_HOST_ATTR}="9"]`)).not.toBeNull();
    dispose();
  });

  it("re-injects when a retained item loses its button host (content node re-rendered)", async () => {
    // Discord keeps the <li> but replaces its content node on edit / embed resolution;
    // the host appended into the old node vanishes with it. A remembered "already done"
    // per element would leave that message without a button until it scrolled out.
    const root = listInBody();
    const li = item("5");
    root.append(li);
    const dispose = startInjector(fakeAdapter(root), () => undefined);
    const first = root.querySelector(`[${BUTTON_HOST_ATTR}="5"]`);
    expect(first).not.toBeNull();

    first?.remove();
    li.append(document.createElement("span"));
    await settle();
    expect(root.querySelector(`[${BUTTON_HOST_ATTR}="5"]`)).not.toBeNull();
    expect(root.querySelectorAll(`[${BUTTON_HOST_ATTR}]`)).toHaveLength(1);
    dispose();
  });

  it("keeps mounting when no animation frame is ever delivered", async () => {
    // The measured production failure (2026-09-02): a background window is delivered no
    // frames, so a scan armed with requestAnimationFrame is never called back and the
    // "already scheduled" guard latches — 33 rendered items, 0 buttons, 100s. A rAF that
    // accepts callbacks and never runs them reproduces exactly that condition.
    const root = listInBody();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const dispose = startInjector(fakeAdapter(root), () => undefined);

    root.append(item("1"));
    await settle();
    expect(root.querySelector(`[${BUTTON_HOST_ATTR}="1"]`)).not.toBeNull();
    root.append(item("2"));
    await settle();
    expect(root.querySelectorAll(`[${BUTTON_HOST_ATTR}]`)).toHaveLength(2);
    dispose();
  });

  it("collapses a burst of mutations into a single scan", async () => {
    // Coalescing is why the scheduler exists at all: one scan per mutation record would run
    // hundreds of times per scroll. The items carry no anchor so the scan mounts nothing and
    // therefore provokes no follow-up mutation of its own — the count stays exact.
    const root = listInBody();
    let scans = 0;
    const dispose = startInjector(
      countingAdapter(fakeAdapter(root), () => {
        scans++;
      }),
      () => undefined,
    );
    expect(scans).toBe(1); // the scan startInjector runs immediately

    for (let i = 0; i < 50; i++) {
      const pending = item(`b${i}`);
      pending.setAttribute("data-test-no-anchor", "");
      root.append(pending);
    }
    await settle();
    expect(scans).toBe(2);
    dispose();
  });

  it("scans as soon as the document becomes visible, without waiting for the timer", async () => {
    // A tab the user just switched back to must not wait for a timer Chrome throttles to
    // once a minute; nothing below advances the clock, so only the visibility scan can mount.
    const root = listInBody();
    const dispose = startInjector(fakeAdapter(root), () => undefined);

    root.append(item("3"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(root.querySelector(`[${BUTTON_HOST_ATTR}="3"]`)).not.toBeNull();
    dispose();
  });

  it("stops injecting after dispose, for mutations and for visibility changes alike", async () => {
    // A visibility listener left behind on a page Kibitz was unloaded from would keep
    // scanning for as long as the tab lives.
    const root = listInBody();
    const dispose = startInjector(fakeAdapter(root), () => undefined);
    dispose();

    root.append(item("1"));
    await settle();
    expect(root.querySelector(`[${BUTTON_HOST_ATTR}]`)).toBeNull();

    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(root.querySelector(`[${BUTTON_HOST_ATTR}]`)).toBeNull();
  });
});
