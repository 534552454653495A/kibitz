/**
 * Every piece of Kibitz UI lives in a shadow host created here, because two things must be
 * isolated from the host page and only one of them is CSS.
 *
 * 1. Styles — Discord's global CSS would restyle our UI and ours would leak into Discord
 *    (AGENTS.md 3.5).
 * 2. **Events** — this is the part that cost a working chat box. Shadow DOM *retargets*
 *    events on their way out: a keydown in our `<textarea>` arrives at document with
 *    `target` = the host `<div>`. Discord's global key handling sees an event that did not
 *    come from an input it knows, applies its "type anywhere to start typing" rule, focuses
 *    its own message box and takes over the keystrokes. Measured on Discord Stable
 *    (2026-09-02): typing "abc" into our composer left it empty and put "abc" in Discord's
 *    message box.
 *
 * The fix is a bubble-phase listener on the host that calls `stopPropagation()`. Phase
 * matters: our own handlers live inside the shadow tree, so by the time the event reaches
 * the host they have already run — while `document` never sees it. A capture-phase guard on
 * `window` also blocks Discord but swallows our handlers too (measured: Enter inserted a
 * newline instead of sending), which is why the guard sits on the host, not on window.
 *
 * `preventDefault` is never called: inside our own UI the default action is what we want.
 */

const ISOLATED_EVENTS = [
  // Keyboard and text input — the measured bug above. These are the load-bearing entries.
  "keydown",
  "keypress",
  "keyup",
  "beforeinput",
  "input",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  // Clipboard: Discord binds paste to its upload/attachment flow, so a paste into our
  // composer would otherwise also open Discord's "upload this file?" modal.
  "paste",
  "copy",
  "cut",
  // Pointer and drag: precautionary, not measured. Discord keeps document-level handlers
  // for closing popouts, focus management and drag-and-drop; our own handlers run first
  // (they are inside the shadow tree), so stopping these at the host costs us nothing and
  // removes a class of surprises. Remove an entry here only with evidence, not by guess.
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "contextmenu",
  "dragstart",
  // NOT `wheel`: scroll chaining is not propagation. When one of our scroll panes reaches
  // its end the browser scrolls the nearest scrollable ancestor whether or not a listener
  // called stopPropagation, so a wheel guard here would be a comment that lies. Containment
  // belongs in CSS — `overscroll-behavior: contain` on our scroll panes (panel.css).
] as const;

export interface ShadowHostOptions {
  /** Element used as the host. `span` for inline buttons, `div` for panels. */
  tag: "div" | "span";
  /** Attributes set on the host — dom-markers values, so tests and the probe can find it. */
  attrs: Record<string, string>;
  /** Stylesheet text injected into the shadow root. */
  css: string;
  /** Inline style on the host. The host lives in the page's light DOM where page rules beat `:host`. */
  style?: string;
}

export interface ShadowHost {
  host: HTMLElement;
  root: ShadowRoot;
}

export function createShadowHost(options: ShadowHostOptions): ShadowHost {
  const host = document.createElement(options.tag);
  for (const [name, value] of Object.entries(options.attrs)) host.setAttribute(name, value);
  if (options.style !== undefined) host.setAttribute("style", options.style);

  // `open` (not `closed`) so tests and the canary probe can drive the UI through
  // `host.shadowRoot`; the page could reach in too, but it can see the DOM anyway.
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = options.css;
  root.append(style);

  for (const type of ISOLATED_EVENTS) host.addEventListener(type, stopPropagation);
  return { host, root };
}

function stopPropagation(event: Event): void {
  event.stopPropagation();
}

/** Exported for the regression test in tests/ui/shadow-host.test.ts. */
export const ISOLATED_EVENT_TYPES: readonly string[] = ISOLATED_EVENTS;
