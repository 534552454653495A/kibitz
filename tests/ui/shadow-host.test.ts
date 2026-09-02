// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createShadowHost, ISOLATED_EVENT_TYPES, type ShadowHost } from "../../src/ui/shadow-host";

// Failure mode defended (observed on Discord Stable, 2026-09-02): keystrokes typed into a
// Kibitz textarea reached Discord's document-level key handling, which focused its own
// message box and stole the input — the chat composer was unusable. The contract is:
// handlers inside the shadow tree still run, nothing reaches `document`.
describe("createShadowHost", () => {
  const host = (): ShadowHost => {
    document.body.innerHTML = "";
    const created = createShadowHost({ tag: "div", attrs: { "data-test-host": "1" }, css: ":host{display:block}" });
    document.body.append(created.host);
    return created;
  };

  it("lets a handler inside the shadow tree see a keydown that document never receives", () => {
    const { root } = host();
    const input = document.createElement("textarea");
    root.append(input);
    const inner = vi.fn();
    const onDocument = vi.fn();
    input.addEventListener("keydown", inner);
    document.addEventListener("keydown", onDocument);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, composed: true }));

    expect(inner).toHaveBeenCalledTimes(1);
    expect(onDocument).not.toHaveBeenCalled();
    document.removeEventListener("keydown", onDocument);
  });

  it("blocks every isolated event type, including the ones Discord binds for paste and scroll", () => {
    const { root } = host();
    const inner = document.createElement("button");
    root.append(inner);
    const seen: string[] = [];
    const listener = (e: Event): void => {
      seen.push(e.type);
    };
    for (const type of ISOLATED_EVENT_TYPES) document.addEventListener(type, listener);

    for (const type of ISOLATED_EVENT_TYPES) inner.dispatchEvent(new Event(type, { bubbles: true, composed: true }));

    for (const type of ISOLATED_EVENT_TYPES) document.removeEventListener(type, listener);
    expect(seen).toEqual([]);
  });

  it("does not suppress the default action inside our own UI", () => {
    const { root } = host();
    const box = document.createElement("input");
    box.type = "checkbox";
    root.append(box);
    const event = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
    box.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("still lets events the page needs through — focus and navigation are not isolated", () => {
    const { root } = host();
    const inner = document.createElement("button");
    root.append(inner);
    const onFocusIn = vi.fn();
    document.addEventListener("focusin", onFocusIn);
    inner.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    expect(onFocusIn).toHaveBeenCalledTimes(1);
    document.removeEventListener("focusin", onFocusIn);
  });
});
