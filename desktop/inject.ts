/**
 * Puts the renderer bundle and the companion's call binding into a Discord window over CDP.
 *
 * Order matters and is the one decision this file encodes: the binding is installed
 * BEFORE the bundle runs, because the renderer shell checks `window[DESKTOP_CALL_BINDING]`
 * to decide whether the companion is connected. The bundle is registered for future
 * documents (reloads, Ctrl+R) and evaluated into the current one; the marker in
 * src/desktop/renderer.ts makes the overlap harmless.
 *
 * Shared with the probe (`--shell desktop`), which passes a `puppeteer` Page — the same
 * class, since `puppeteer` re-exports `puppeteer-core`.
 */
import type { Page } from "puppeteer-core";
import { DESKTOP_CALL_BINDING, DESKTOP_DELIVER_FN } from "../src/shell/desktop-protocol";
import { log } from "../src/shared/log";

export interface AttachOptions {
  /** Contents of dist/desktop-renderer.js (an IIFE). */
  bundle: string;
  /** Answers one DesktopRequest (JSON in, DesktopReply JSON out). */
  onRequest: (json: string) => Promise<string>;
}

/**
 * A page binding can only be added once per Page; a second `exposeFunction` with the same
 * name rejects. Tracking by Page (not by URL) survives navigations, which keep the Page.
 */
const attached = new WeakSet<Page>();

export async function attachKibitz(page: Page, options: AttachOptions): Promise<void> {
  if (attached.has(page)) return;
  attached.add(page);
  try {
    await page.exposeFunction(DESKTOP_CALL_BINDING, options.onRequest);
    await page.evaluateOnNewDocument(options.bundle);
    if (page.url() !== "about:blank") await page.evaluate(options.bundle);
  } catch (err) {
    attached.delete(page);
    throw err;
  }
}

/**
 * Pushes one DesktopDelivery into the page. False means nobody was there to receive it:
 * the renderer has not defined its receiver yet (document still loading) or the page's
 * execution context died mid-evaluate (reload, window closed). Either way the stream that
 * produced the delivery has no consumer left, so callers treat false as "drop".
 */
export async function deliver(page: Page, json: string): Promise<boolean> {
  try {
    return await page.evaluate(
      (name: string, payload: string) => {
        // The Window augmentation keys on the literal; inside the serialised function only a string arrives.
        const receiver = (window as unknown as Record<string, unknown>)[name];
        if (typeof receiver !== "function") return false;
        receiver(payload);
        return true;
      },
      DESKTOP_DELIVER_FN,
      json,
    );
  } catch (err) {
    log.debug("delivery lost (page reloading?)", err);
    return false;
  }
}
