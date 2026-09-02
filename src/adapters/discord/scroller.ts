/**
 * Bulk collection from Discord's virtualised message list by programmatic scroll-back.
 *
 * Only the viewport's neighbourhood exists in the DOM (decision 3.3), so "scan related
 * messages" walks the scroller upwards in viewport-sized steps, reads whatever <li>s
 * appear through the bridge, and stops on a limit or when two steps in a row surface
 * nothing new (Discord loads older history lazily near the top; a second empty step
 * distinguishes "still fetching" from "there is no more"). Every wait is bounded, the
 * AbortSignal is checked on every poll, and the user's viewport is restored in `finally`
 * — a scan that leaves the user scrolled to last week is worse than no scan.
 */
import type { CollectProgress } from "../../core/adapter";
import type { MessageRef, UniversalMessage, UniversalThread } from "../../core/types";
import { ContractError } from "../../core/validate";
import { findScrollContainer, MESSAGE_ITEM, messageItemId, parseMessageItemId } from "./selectors";

export interface ScrollBackOptions {
  listRoot: Element;
  anchor: MessageRef;
  read: (ids: string[]) => Promise<{ messages: UniversalMessage[]; missing: string[] }>;
  maxMessages: number;
  maxDurationMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: CollectProgress) => void;
}

/** Less than a full viewport so consecutive windows overlap and no row is skipped. */
const STEP_VIEWPORT_FRACTION = 0.8;
const RENDER_POLL_MS = 100;
/**
 * Two different waits, on purpose:
 * - after a scroll step inside already-rendered rows the DOM usually changes within a
 *   frame or not at all (the list keeps a buffer around the viewport), so wait briefly;
 * - at the very top only a history fetch can add rows, and Discord's fetch on a CI runner
 *   can take seconds, so wait longer before calling the history exhausted.
 */
const SCROLL_SETTLE_MS = 500;
const FETCH_SETTLE_MS = 3000;
/** Two empty waits at the top in a row = history exhausted (one may just be a slow fetch). */
const EXHAUSTED_AFTER_EMPTY_STEPS = 2;

function renderedIds(listRoot: Element, channelId: string): string[] {
  if (!listRoot.isConnected) throw new ContractError("dom.list", "message list left the DOM during collection");
  const ids: string[] = [];
  for (const el of listRoot.querySelectorAll(MESSAGE_ITEM)) {
    const parsed = parseMessageItemId(el.id);
    if (parsed && parsed.channelId === channelId) ids.push(parsed.messageId);
  }
  return ids;
}

async function waitForRenderChange(
  listRoot: Element,
  channelId: string,
  before: string[],
  settleMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + settleMs;
  const key = before.join(",");
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, RENDER_POLL_MS);
    await tick.promise;
    if (renderedIds(listRoot, channelId).join(",") !== key) return;
  }
}

function byCreatedAt(a: UniversalMessage, b: UniversalMessage): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  // Snowflakes are monotonic; compare numerically without BigInt by length then lexically.
  return a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export async function collectByScrollBack(opts: ScrollBackOptions): Promise<UniversalThread> {
  const { listRoot, anchor, signal } = opts;
  const container = findScrollContainer(listRoot);
  if (!container) throw new ContractError("dom.scroller", "no scrollable ancestor of the message list");

  const startedAt = Date.now();
  const originalScrollTop = container.scrollTop;
  // Dynamic membership across steps; ids repeat between overlapping windows.
  const collected = new Map<string, UniversalMessage>();

  const readNew = async (ids: string[]): Promise<number> => {
    // Exact cap: a rendered window can hold more rows than the remaining budget, and the
    // panel promises "up to N", not "N plus whatever the last screen held".
    const fresh = ids.filter((id) => !collected.has(id)).slice(0, Math.max(0, opts.maxMessages - collected.size));
    if (fresh.length === 0) return 0;
    const { messages } = await opts.read(fresh);
    for (const m of messages) collected.set(m.id, m);
    return messages.length;
  };

  let truncated = false;
  try {
    signal?.throwIfAborted();
    // The anchor is what the user asked about; it must be in the result even if the
    // list has already scrolled it out by the time the rest is collected.
    await readNew([anchor.messageId]);
    if (!collected.has(anchor.messageId)) {
      throw new ContractError("scan.anchor", `anchor ${anchor.messageId} could not be read (not rendered?)`);
    }
    await readNew(renderedIds(listRoot, anchor.channelId));
    opts.onProgress?.({ collected: collected.size });

    // Exhaustion is only ever concluded at the top: while there is room to scroll, an
    // unchanged DOM just means the list's render buffer has not shifted yet (virtualised
    // lists keep rows around the viewport), and counting that as "no more history" would
    // end a scan after the first screen.
    let emptyFetches = 0;
    for (;;) {
      signal?.throwIfAborted();
      if (collected.size >= opts.maxMessages || Date.now() - startedAt > opts.maxDurationMs) {
        truncated = true;
        break;
      }
      const before = renderedIds(listRoot, anchor.channelId);
      const atTop = container.scrollTop <= 0;
      container.scrollTop = Math.max(0, container.scrollTop - container.clientHeight * STEP_VIEWPORT_FRACTION);
      await waitForRenderChange(listRoot, anchor.channelId, before, atTop ? FETCH_SETTLE_MS : SCROLL_SETTLE_MS, signal);
      const added = await readNew(renderedIds(listRoot, anchor.channelId));
      opts.onProgress?.({ collected: collected.size });
      if (atTop) {
        emptyFetches = added === 0 ? emptyFetches + 1 : 0;
        if (emptyFetches >= EXHAUSTED_AFTER_EMPTY_STEPS) break;
      }
    }
  } finally {
    const anchorEl = document.getElementById(messageItemId(anchor.channelId, anchor.messageId));
    if (anchorEl) anchorEl.scrollIntoView({ block: "center" });
    else container.scrollTop = originalScrollTop;
  }

  const messages = [...collected.values()].sort(byCreatedAt);
  return { anchor: collected.get(anchor.messageId)!, messages, truncated };
}
