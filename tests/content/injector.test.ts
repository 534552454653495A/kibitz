// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
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

// Two frames: the injector schedules its scan on the frame after the mutation callback.
const nextFrame = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  return promise;
};

describe("startInjector", () => {
  it("mounts one explain button per message item and hands the click the message ref", async () => {
    document.body.innerHTML = "";
    const root = document.createElement("ol");
    root.append(item("1"), item("2"));
    document.body.append(root);
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
    document.body.innerHTML = "";
    const root = document.createElement("ol");
    root.append(item("1"));
    document.body.append(root);
    const dispose = startInjector(fakeAdapter(root), () => undefined);

    root.append(item("2"));
    await vi.waitFor(() => expect(root.querySelectorAll(`[${BUTTON_HOST_ATTR}]`)).toHaveLength(2));
    // A further unrelated mutation must not add a second button to either item.
    root.append(document.createElement("hr"));
    await nextFrame();
    expect(root.querySelectorAll(`[${BUTTON_HOST_ATTR}]`)).toHaveLength(2);
    dispose();
  });

  it("retries an item that had no anchor once it gains one", async () => {
    document.body.innerHTML = "";
    const root = document.createElement("ol");
    const pending = item("9");
    pending.setAttribute("data-test-no-anchor", "");
    root.append(pending);
    document.body.append(root);
    const dispose = startInjector(fakeAdapter(root), () => undefined);
    expect(root.querySelector(`[${BUTTON_HOST_ATTR}]`)).toBeNull();

    pending.removeAttribute("data-test-no-anchor");
    pending.append(document.createElement("span"));
    await vi.waitFor(() => expect(root.querySelector(`[${BUTTON_HOST_ATTR}="9"]`)).not.toBeNull());
    dispose();
  });

  it("re-injects when a retained item loses its button host (content node re-rendered)", async () => {
    // Discord keeps the <li> but replaces its content node on edit / embed resolution;
    // the host appended into the old node vanishes with it. A remembered "already done"
    // per element would leave that message without a button until it scrolled out.
    document.body.innerHTML = "";
    const root = document.createElement("ol");
    const li = item("5");
    root.append(li);
    document.body.append(root);
    const dispose = startInjector(fakeAdapter(root), () => undefined);
    const first = root.querySelector(`[${BUTTON_HOST_ATTR}="5"]`);
    expect(first).not.toBeNull();

    first?.remove();
    li.append(document.createElement("span"));
    await vi.waitFor(() => expect(root.querySelector(`[${BUTTON_HOST_ATTR}="5"]`)).not.toBeNull());
    expect(root.querySelectorAll(`[${BUTTON_HOST_ATTR}]`)).toHaveLength(1);
    dispose();
  });

  it("stops injecting after dispose", async () => {
    document.body.innerHTML = "";
    const root = document.createElement("ol");
    document.body.append(root);
    const dispose = startInjector(fakeAdapter(root), () => undefined);
    dispose();
    root.append(item("1"));
    await nextFrame();
    expect(root.querySelector(`[${BUTTON_HOST_ATTR}]`)).toBeNull();
  });
});
