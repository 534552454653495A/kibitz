/**
 * Watches the page and mounts a button on every message item that lacks one.
 *
 * The list is virtualised (AGENTS.md 3.3): items appear and vanish constantly, so nothing
 * is cached across scans — every scan re-queries the adapter. Mutation batches are
 * coalesced to one scan per debounce window; a scan per mutation record would run hundreds
 * of times per scroll.
 *
 * The window is a timer, never requestAnimationFrame. A background or occluded window is
 * delivered no frames at all, so a rAF handle armed there is never called back: the
 * "already scheduled" guard stayed latched and every later mutation was dropped. Measured
 * live 2026-09-02 — after a reload with the window in the background, a list of 33 rendered
 * items had 0 buttons for 100s, and they appeared (11/11) only once the window was brought
 * to the foreground and a frame was finally delivered.
 */
import type { PlatformAdapter } from "../core/adapter";
import type { MessageRef } from "../core/types";
import { BUTTON_HOST_ATTR } from "../shared/dom-markers";
import { mountButton } from "../ui/button/mount";

/**
 * Two frames' worth. Long enough that one React render's burst of mutation records
 * collapses into a single scan (the property rAF was chosen for), short enough that a
 * message never visibly waits for its button.
 */
const SCAN_DEBOUNCE_MS = 32;

const HAS_BUTTON = `[${BUTTON_HOST_ATTR}]`;

export function startInjector(adapter: PlatformAdapter, onClick: (ref: MessageRef) => void): () => void {
  // Presence is checked in the DOM on every scan rather than remembered per element:
  // React may re-create a message's content node (edits, embed resolution) and drop the
  // host we appended while keeping the same <li>. A per-item querySelector is microseconds;
  // a stale "already done" memory is a missing button.
  let pending: number | null = null;

  function scan(): void {
    const root = adapter.findListRoot(document);
    if (root === null) return;
    for (const ref of adapter.listMessageElements(root)) {
      if (ref.element.querySelector(HAS_BUTTON) !== null) continue;
      const anchor = adapter.buttonAnchor(ref);
      // No anchor yet is not final (the item may still be filling in); retry next scan.
      if (anchor === null) continue;
      mountButton(anchor, { platform: ref.platform, channelId: ref.channelId, messageId: ref.messageId }, onClick);
    }
  }

  // Chrome throttles timers in a background TAB (the extension case) to as little as once
  // per minute, so a tab the user just brought forward must not wait for a throttled tick;
  // the desktop window case is the reload measured above. One extra scan per foreground.
  function onVisibilityChange(): void {
    if (document.visibilityState !== "visible") return;
    // Drop any armed tick: this scan does its work, a second one 32ms later would be waste.
    if (pending !== null) window.clearTimeout(pending);
    pending = null;
    scan();
  }

  function schedule(): void {
    if (pending !== null) return;
    pending = window.setTimeout(() => {
      // Cleared by the tick that actually ran, never by scan(): a handle is only ever
      // "already scheduled" while a tick is genuinely still owed. Timers are throttled in
      // the background but always delivered, so this cannot latch the way rAF did.
      pending = null;
      scan();
    }, SCAN_DEBOUNCE_MS);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", onVisibilityChange);
  scan();

  return () => {
    observer.disconnect();
    // A listener left on a page Kibitz was unloaded from would keep scanning with a
    // disconnected adapter for as long as the tab lives.
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (pending !== null) window.clearTimeout(pending);
    pending = null;
  };
}
