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
 * name rejects with "already exposed". Tracking by Page (not by URL) survives navigations,
 * which keep the Page.
 *
 * `attached` holds the id of the init script so a rebuilt bundle can replace the old one, and
 * `PENDING` is written **synchronously**, before the first await: `companion.ts` listens to
 * both `targetcreated` and `targetchanged`, which fire for the same page, so an id-only map
 * would let two overlapping calls past the guard and the second `exposeFunction` would reject.
 */
const PENDING = "";
const attached = new Map<Page, string>();

/**
 * The handler the exposed binding forwards to, per page. The binding is installed once and
 * then routes through this map, which is what makes a retry possible: `exposeFunction` cannot
 * be undone, so an attach that failed *after* installing it (a target that died between the
 * two CDP calls) used to release its claim and promise a retry that could only ever reject
 * with "already exposed". Now the retry re-registers the bundle and re-points the handler.
 */
const handlers = new WeakMap<Page, (json: string) => Promise<string>>();

/**
 * Pages whose binding is installed. Separate from `handlers` because the two failures need
 * opposite treatment: if `exposeFunction` itself failed, the retry MUST call it again, and if
 * it succeeded and a later CDP call failed, the retry MUST NOT.
 */
const bound = new WeakSet<Page>();

export async function attachKibitz(page: Page, options: AttachOptions): Promise<void> {
  if (attached.has(page)) return;
  attached.set(page, PENDING);
  page.once("close", () => {
    attached.delete(page);
    handlers.delete(page);
  });
  try {
    // The exposed closure reads the map on every call, so the newest handler always answers.
    handlers.set(page, options.onRequest);
    if (!bound.has(page)) {
      await page.exposeFunction(DESKTOP_CALL_BINDING, (json: string) =>
        handlers.get(page)?.(json) ?? Promise.reject(new Error("Kibitz is detached from this window")),
      );
      bound.add(page);
    }
    const script = await page.evaluateOnNewDocument(options.bundle);
    attached.set(page, script.identifier);
    if (page.url() !== "about:blank") await page.evaluate(options.bundle);
  } catch (err) {
    attached.delete(page);
    throw err;
  }
}

/**
 * Replaces the bundle registered for future documents. False means there was nothing to
 * replace: the page is not attached, or its attach is still in flight (`PENDING`), in which
 * case it is about to register the fresh bundle anyway.
 *
 * Why this exists: the companion reads dist/desktop-renderer.js once, at start, and
 * `evaluateOnNewDocument` captured that text — so after `npm run build` the running Discord
 * keeps executing the OLD renderer, and Ctrl+R re-runs the same captured copy. That cost the
 * owner a whole feature: image support looked broken for hours because the injected code
 * predated it (AGENTS.md §12, 2026-09-02).
 *
 * Only the init script is swapped; the live document keeps the old code until it reloads
 * (evaluating a second copy into the same document would fight the `DESKTOP_MARKER` guard),
 * which is why the caller tells the user to press Ctrl+R. Measured on live Discord: a
 * re-registered script runs on the next reload, and a removed one stops running — the
 * mechanism is sound, the *trigger* was the fragile half (see `watchBundle`).
 */
export async function replaceBundle(page: Page, bundle: string): Promise<boolean> {
  const previous = attached.get(page);
  if (previous === undefined || previous === PENDING) return false;
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
