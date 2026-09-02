/**
 * PlatformAdapter — the contract every site integration implements.
 *
 * The core (content/injector.ts, ui/panel) drives an adapter through this interface and
 * nothing else. Adding a platform = adding a folder under src/adapters/ that implements
 * this; the core must not change (architecture decision 7). If a new platform needs a
 * method that is not here, add it here generically first, then implement it in every
 * adapter.
 */
import type { MessageRef, Platform, UniversalMessage, UniversalThread } from "./types";

/** A message item currently in the DOM, with the ids parsed out of it. */
export interface MessageElementRef extends MessageRef {
  element: Element;
}

export interface ButtonAnchor {
  /** Element the button host is appended to. */
  parent: Element;
  /** `inline` = flows after text; `block` = own line at the end of the item. */
  placement: "inline" | "block";
}

export interface CollectOptions {
  maxMessages: number;
  maxDurationMs: number;
  signal?: AbortSignal;
}

export interface CollectProgress {
  collected: number;
}

export interface PlatformAdapter {
  readonly platform: Platform;

  /** Whether this adapter owns the current page. Checked once at content-script start. */
  matches(location: Location): boolean;

  /**
   * Root under which message items appear. May return a different element after
   * navigation (SPAs replace it) or null while the page is loading — callers must re-query
   * on every mutation batch instead of caching.
   */
  findListRoot(doc: Document): Element | null;

  /** Every message item currently rendered under `root`, with ids parsed. */
  listMessageElements(root: Element): MessageElementRef[];

  /** Where the AI button attaches for a given item; null if the item has no usable anchor. */
  buttonAnchor(ref: MessageElementRef): ButtonAnchor | null;

  /** Structured read of one message (for Discord: via the MAIN-world bridge). */
  readMessage(ref: MessageRef): Promise<UniversalMessage>;

  /**
   * Collect messages around `ref` from a virtualised list, scrolling as needed and
   * restoring the viewport afterwards. Must honour `options.signal`.
   */
  collectAround(
    ref: MessageRef,
    options: CollectOptions,
    onProgress?: (progress: CollectProgress) => void,
  ): Promise<UniversalThread>;
}
