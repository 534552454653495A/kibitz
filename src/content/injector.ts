/**
 * Watches the page and mounts a button on every message item that lacks one.
 *
 * The list is virtualised (AGENTS.md 3.3): items appear and vanish constantly, so nothing
 * is cached across scans — every scan re-queries the adapter. Mutation batches are
 * coalesced to one scan per animation frame; a scan per mutation record would run
 * hundreds of times per scroll.
 */
import type { PlatformAdapter } from "../core/adapter";
import type { MessageRef } from "../core/types";
import { BUTTON_HOST_ATTR } from "../shared/dom-markers";
import { mountButton } from "../ui/button/mount";

const HAS_BUTTON = `[${BUTTON_HOST_ATTR}]`;

export function startInjector(adapter: PlatformAdapter, onClick: (ref: MessageRef) => void): () => void {
  // Presence is checked in the DOM on every scan rather than remembered per element:
  // React may re-create a message's content node (edits, embed resolution) and drop the
  // host we appended while keeping the same <li>. A per-item querySelector is microseconds;
  // a stale "already done" memory is a missing button.
  let frame: number | null = null;

  function scan(): void {
    frame = null;
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

  function schedule(): void {
    if (frame !== null) return;
    frame = requestAnimationFrame(scan);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  scan();

  return () => {
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
}
