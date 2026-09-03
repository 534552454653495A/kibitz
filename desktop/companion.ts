/**
 * The companion session: connect to a Discord that is listening on a DevTools port, put
 * the renderer bundle into every Discord window, answer its requests until either side
 * goes away.
 *
 * Decisions:
 * - One request handler per window, because deliveries must land in the window that
 *   asked; a popout that opens later gets its own via the target events.
 * - Settings are read from disk per request, never cached: `kibitz-desktop setup` in
 *   another terminal takes effect on the next question, no restart.
 * - Ctrl+C only disconnects. Discord is the user's app; it keeps running, minus Kibitz,
 *   until the next reload.
 */
import { type Stats, unwatchFile, watchFile } from "node:fs";
import * as fs from "node:fs/promises";
import puppeteer, { type Browser, type Page, type Target } from "puppeteer-core";
import { log } from "../src/shared/log";
import { isDiscordUrl } from "./cdp";
import {
  clearConversations,
  deleteConversation,
  historyDir,
  listConversations,
  loadConversation,
  saveConversation,
} from "./history-store";
import { attachKibitz, deliver, replaceBundle } from "./inject";
import { createDesktopRequestHandler } from "./request-handler";
import { loadFileSettings, saveFileSettings, settingsPath } from "./settings-store";
import { loadUiState, saveUiState, uiStatePath } from "./ui-state-store";

/** Something the user can fix (missing build, missing install, wrong flags). The CLI maps it to exit 2. */
export class UserError extends Error {
  override readonly name = "UserError";
}

export interface CompanionOptions {
  port: number;
  /** Contents of dist/desktop-renderer.js — read via `readBundle` BEFORE Discord is launched, so a missing build fails first. */
  bundle: string;
  /** Where `bundle` came from. Given, the file is watched and a rebuild re-arms the windows. */
  bundlePath?: string;
  settingsPath?: string;
}

/** Discord shows its updater splash first; the app window can take a while on a cold start. */
const MAIN_WINDOW_TIMEOUT_MS = 120_000;
/** One `npm run build` fires several fs events; wait for the writes to settle. */
const BUNDLE_DEBOUNCE_MS = 300;
/** How many times to re-read before giving up on a bundle whose size never settles. */
const BUNDLE_STABLE_TRIES = 8;
/** Poll interval for the bundle path. A stat per second is nothing next to a browser. */
const BUNDLE_POLL_MS = 1000;

export const SECURITY_NOTE =
  "While Discord runs with --remote-debugging-port, that port is open on localhost: any process on this machine can drive Discord through it. Close Discord when you are done.";

export function setupInstructions(file: string): string {
  return `Kibitz has no settings page inside Discord. Run \`npm run desktop -- setup\` in a terminal (writes ${file}), then reload Discord (Ctrl+R).`;
}

export async function readBundle(bundlePath: string): Promise<string> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(bundlePath, "utf8"), fs.stat(bundlePath)]);
    // Printed because a companion that has been running since before the last build injects
    // the OLD renderer, and nothing in Discord shows that (AGENTS.md §12, 2026-09-02).
    log.info(`renderer bundle: ${Math.round(text.length / 1024)} KiB, built ${stat.mtime.toISOString()}`);
    return text;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new UserError(`renderer bundle not found at ${bundlePath} — run \`npm run build\` first`);
    }
    throw err;
  }
}

async function findMainPage(browser: Browser): Promise<Page> {
  for (const page of await browser.pages()) {
    if (isDiscordUrl(page.url())) return page;
  }
  log.info(`waiting up to ${MAIN_WINDOW_TIMEOUT_MS / 1000}s for Discord's app window (the updater splash comes first)`);
  const target = await browser.waitForTarget((t) => t.type() === "page" && isDiscordUrl(t.url()), { timeout: MAIN_WINDOW_TIMEOUT_MS });
  const page = await target.page();
  if (page === null) throw new Error("Discord's app window target has no page");
  return page;
}

export async function runCompanion(opts: CompanionOptions): Promise<void> {
  /**
   * The bundle currently armed, not the one this process started with. A popout or a window
   * re-created AFTER a rebuild goes through the same `attach`, and reading `opts.bundle`
   * there would inject the renderer this process booted with — the exact staleness the
   * watcher exists to end, reappearing for every new window.
   */
  const armed = { bundle: opts.bundle };
  const file = opts.settingsPath ?? settingsPath();
  // Preferences live beside whichever settings file is in play, so an overridden
  // `settingsPath` (tests, a second profile) keeps both halves of the state together.
  const uiState = uiStatePath(file);
  // Saved conversations follow the same file, in a directory of their own: dropping the
  // history must never be able to reach settings.json or ui-state.json beside it.
  const history = historyDir(file);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${opts.port}`, defaultViewport: null });
  log.warn(SECURITY_NOTE);

  // inject.ts remembers which pages carry the binding; this remembers which carry a handler.
  const wired = new WeakSet<Page>();
  const pages = new Set<Page>();
  const attach = async (page: Page): Promise<void> => {
    if (wired.has(page)) return;
    wired.add(page);
    pages.add(page);
    page.once("close", () => pages.delete(page));
    const handler = createDesktopRequestHandler({
      loadSettings: () => loadFileSettings(file),
      saveSettings: (settings) => saveFileSettings(settings, file),
      loadUiState: () => loadUiState(uiState),
      saveUiState: (state) => saveUiState(state, uiState),
      listConversations: () => listConversations(history),
      loadConversation: (id) => loadConversation(id, history),
      saveConversation: (record) => saveConversation(record, history),
      deleteConversation: (id) => deleteConversation(id, history),
      clearConversations: () => clearConversations(history),
      deliver: (json) => deliver(page, json),
      openOptions: () => console.log(setupInstructions(file)),
    });
    page.once("close", () => handler.abortAll());
    await attachKibitz(page, { bundle: armed.bundle, onRequest: handler.handle });
    log.info(`Kibitz attached to ${page.url()}`);
  };

  // Popouts and re-created windows arrive as new targets; a window that was created blank
  // and then navigated to Discord only becomes interesting on targetchanged.
  const onTarget = (target: Target): void => {
    if (target.type() !== "page" || !isDiscordUrl(target.url())) return;
    target
      .page()
      .then((page) => (page === null ? undefined : attach(page)))
      .catch((err: unknown) => log.warn("could not attach to a new Discord window", err));
  };
  browser.on("targetcreated", onTarget);
  browser.on("targetchanged", onTarget);

  await attach(await findMainPage(browser));
  const stopWatching = opts.bundlePath === undefined ? undefined : watchBundle(opts.bundlePath, pages, armed);

  const { promise, resolve } = Promise.withResolvers<void>();
  browser.once("disconnected", () => {
    log.info("DevTools connection closed; companion exiting (Discord keeps running without Kibitz until relaunched)");
    stopWatching?.();
    resolve();
  });
  process.once("SIGINT", () => {
    log.info("disconnecting — Discord keeps running");
    stopWatching?.();
    browser.disconnect();
  });
  return promise;
}

/**
 * Re-registers the renderer bundle whenever the build writes a new one.
 *
 * The trap this closes cost hours: the bundle is read once at start and captured by
 * `evaluateOnNewDocument`, so after `npm run build` the running Discord kept executing the
 * old renderer — image support looked broken because the injected code predated it, and
 * Ctrl+R did not help (the reload re-ran the same captured text).
 *
 * Polls the **path** with `watchFile` instead of using `fs.watch`, because every inode-based
 * watch this project tried went deaf on the first real build. Measured twice on Windows:
 * watching the file died when esbuild replaced it, and watching `dist/` died because
 * `scripts/build.ts` starts with `fs.rm(dist, { recursive: true })` — the directory itself is
 * a new inode after every build. Hand-written probes that rewrote the file *inside* `dist`
 * passed against both and proved nothing (AGENTS.md §12). A path poll has no inode identity
 * to lose; the cost is one `stat` per second in a process that already sits idle.
 *
 * `mtimeMs === 0` is `watchFile`'s "not there": the build's `rm` fires that before the new
 * file lands, so it is a signal to wait for the next tick, never to inject.
 */
function watchBundle(bundlePath: string, pages: ReadonlySet<Page>, armed: { bundle: string }): () => void {
  let timer: NodeJS.Timeout | undefined;
  const onChange = (current: Stats, previous: Stats): void => {
    if (current.mtimeMs === 0) return;
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void reloadBundle(bundlePath, pages, armed);
    }, BUNDLE_DEBOUNCE_MS);
  };
  watchFile(bundlePath, { interval: BUNDLE_POLL_MS }, onChange);
  return () => {
    clearTimeout(timer);
    unwatchFile(bundlePath, onChange);
  };
}

/** Reads the bundle only once it stops changing, so a half-written file is never injected. */
async function readStableBundle(bundlePath: string): Promise<string | undefined> {
  let previous = -1;
  for (let attempt = 0; attempt < BUNDLE_STABLE_TRIES; attempt++) {
    let text: string;
    try {
      text = await fs.readFile(bundlePath, "utf8");
    } catch (err) {
      // `npm run build` deletes dist/ before writing it, so "missing" is a normal moment in a
      // rebuild, not a failure. Keep waiting; only a file that never comes back gives up.
      log.debug("bundle not readable yet (build in progress?)", err);
      await new Promise((resolve) => setTimeout(resolve, BUNDLE_DEBOUNCE_MS));
      previous = -1;
      continue;
    }
    if (text.length > 0 && text.length === previous) return text;
    previous = text.length;
    await new Promise((resolve) => setTimeout(resolve, BUNDLE_DEBOUNCE_MS));
  }
  log.warn("renderer bundle kept changing; not injecting a half-written build");
  return undefined;
}

async function reloadBundle(bundlePath: string, pages: ReadonlySet<Page>, armed: { bundle: string }): Promise<void> {
  const fresh = await readStableBundle(bundlePath);
  if (fresh === undefined) return;
  // Windows attached from now on get this text too, not the one the process booted with.
  armed.bundle = fresh;
  let swapped = 0;
  for (const page of pages) {
    try {
      if (await replaceBundle(page, fresh)) swapped++;
    } catch (err) {
      log.debug("could not swap the bundle in a window", err);
    }
  }
  if (swapped > 0) log.info(`renderer bundle rebuilt — press Ctrl+R in Discord to load it (${swapped} window(s) armed)`);
}
