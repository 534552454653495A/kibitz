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
 * The value is the id of the init script, so a rebuilt bundle can replace the old one
 * instead of stacking a second copy on the next document.
 */
const attached = new WeakMap<Page, string>();

export async function attachKibitz(page: Page, options: AttachOptions): Promise<void> {
  if (attached.has(page)) return;
  try {
    await page.exposeFunction(DESKTOP_CALL_BINDING, options.onRequest);
    const script = await page.evaluateOnNewDocument(options.bundle);
    attached.set(page, script.identifier);
    if (page.url() !== "about:blank") await page.evaluate(options.bundle);
  } catch (err) {
    attached.delete(page);
    throw err;
  }
}

/**
 * Replaces the bundle registered for future documents.
 *
 * Why this exists: the companion reads dist/desktop-renderer.js once, at start, and
 * `evaluateOnNewDocument` captured that text — so after `npm run build` the running Discord
 * keeps executing the OLD renderer, and even Ctrl+R re-runs the old copy. That cost the
 * owner a whole feature: image support looked broken for hours because the injected code
 * predated it (AGENTS.md §12, 2026-09-02). Now `runCompanion` watches the file and calls
 * this, so a reload picks up the new build.
 *
 * Only the init script is swapped; the live document keeps the old code until it reloads
 * (evaluating a second copy into the same document would fight the `DESKTOP_MARKER` guard),
 * which is why the caller tells the user to press Ctrl+R.
 */
export async function replaceBundle(page: Page, bundle: string): Promise<boolean> {
  const previous = attached.get(page);
  if (previous === undefined) return false;
  await page.removeScriptToEvaluateOnNewDocument(previous);
  const script = await page.evaluateOnNewDocument(bundle);
  attached.set(page, script.identifier);
  return true;
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
