/**
 * The per-message AI button: a shadow host appended where the adapter says it fits.
 *
 * Placement is set as inline style on the host rather than via :host in the stylesheet
 * because the host lives in the page's light DOM, where page rules outrank :host rules;
 * an inline declaration is the only thing guaranteed to win.
 *
 * The host comes from `createShadowHost` (never `attachShadow` directly) so the click is
 * isolated the same way the panel's keystrokes are — a click that reaches Discord's own
 * handlers selects the message, opens popouts and moves focus (see ui/shadow-host.ts).
 * The handler below still calls preventDefault/stopPropagation itself: the host's guard
 * runs after our listener, and cancelling the default action is our decision, not the
 * helper's.
 */
import type { ButtonAnchor } from "../../core/adapter";
import type { MessageRef } from "../../core/types";
import { ACTION_ATTR, BUTTON_HOST_ATTR } from "../../shared/dom-markers";
import { createShadowHost } from "../shadow-host";
import buttonCss from "./button.css";

/**
 * `position: relative; z-index: 2` is the load-bearing part, not decoration. Discord's
 * per-message action toolbar is (measured 2026-09-02) `position: absolute; z-index: 1`
 * inside the message row, and it appears exactly when the pointer is over the row — i.e.
 * when someone is about to click. A message whose text reaches the right of the column puts
 * this button under it, and a static host loses the hit test: reproduced in the fixture, and
 * the `button-under-toolbar` probe check fails without these two declarations. Both live in
 * the same stacking context (the toolbar is not portaled out of the row), so out-stacking it
 * is enough; `relative` with no offsets moves nothing.
 */
const STACKING = "position:relative;z-index:2";

const HOST_STYLE: Record<ButtonAnchor["placement"], string> = {
  inline: `display:inline-block;margin-left:6px;vertical-align:middle;line-height:0;${STACKING}`,
  block: `display:block;margin-top:4px;line-height:0;${STACKING}`,
};

const LABEL = "Ask Kibitz about this message";

export function mountButton(anchor: ButtonAnchor, ref: MessageRef, onClick: (ref: MessageRef) => void): HTMLElement {
  const { host, root } = createShadowHost({
    tag: "span",
    attrs: { [BUTTON_HOST_ATTR]: ref.messageId },
    css: buttonCss,
    style: HOST_STYLE[anchor.placement],
  });

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute(ACTION_ATTR, "explain");
  button.title = LABEL;
  button.setAttribute("aria-label", LABEL);
  button.textContent = "✦";
  button.addEventListener("click", (event) => {
    // The page treats clicks inside a message as "select/focus message"; ours is not that.
    event.preventDefault();
    event.stopPropagation();
    onClick(ref);
  });

  root.append(button);
  anchor.parent.append(host);
  return host;
}
