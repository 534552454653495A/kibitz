/**
 * The per-message AI button: a shadow host appended where the adapter says it fits.
 *
 * Placement is set as inline style on the host rather than via :host in the stylesheet
 * because the host lives in the page's light DOM, where page rules outrank :host rules;
 * an inline declaration is the only thing guaranteed to win.
 */
import type { ButtonAnchor } from "../../core/adapter";
import type { MessageRef } from "../../core/types";
import { ACTION_ATTR, BUTTON_HOST_ATTR } from "../../shared/dom-markers";
import buttonCss from "./button.css";

const HOST_STYLE: Record<ButtonAnchor["placement"], string> = {
  inline: "display:inline-block;margin-left:6px;vertical-align:middle;line-height:0",
  block: "display:block;margin-top:4px;line-height:0",
};

export function mountButton(anchor: ButtonAnchor, ref: MessageRef, onClick: (ref: MessageRef) => void): HTMLElement {
  const host = document.createElement("span");
  host.setAttribute(BUTTON_HOST_ATTR, ref.messageId);
  host.setAttribute("style", HOST_STYLE[anchor.placement]);

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = buttonCss;

  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute(ACTION_ATTR, "explain");
  button.title = "Ask Kibitz about this message";
  button.setAttribute("aria-label", "Ask Kibitz about this message");
  button.textContent = "✦";
  button.addEventListener("click", (event) => {
    // The page treats clicks inside a message as "select/focus message"; ours is not that.
    event.preventDefault();
    event.stopPropagation();
    onClick(ref);
  });

  shadow.append(style, button);
  anchor.parent.append(host);
  return host;
}
