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
import * as fs from "node:fs/promises";
import puppeteer, { type Browser, type Page, type Target } from "puppeteer-core";
import { log } from "../src/shared/log";
import { isDiscordUrl } from "./cdp";
import { attachKibitz, deliver } from "./inject";
import { createDesktopRequestHandler } from "./request-handler";
import { loadFileSettings, settingsPath } from "./settings-store";

/** Something the user can fix (missing build, missing install, wrong flags). The CLI maps it to exit 2. */
export class UserError extends Error {
  override readonly name = "UserError";
}

export interface CompanionOptions {
  port: number;
  /** Contents of dist/desktop-renderer.js — read via `readBundle` BEFORE Discord is launched, so a missing build fails first. */
  bundle: string;
  settingsPath?: string;
}

/** Discord shows its updater splash first; the app window can take a while on a cold start. */
const MAIN_WINDOW_TIMEOUT_MS = 120_000;

export const SECURITY_NOTE =
  "While Discord runs with --remote-debugging-port, that port is open on localhost: any process on this machine can drive Discord through it. Close Discord when you are done.";

export function setupInstructions(file: string): string {
  return `Kibitz has no settings page inside Discord. Run \`npm run desktop -- setup\` in a terminal (writes ${file}), then reload Discord (Ctrl+R).`;
}

export async function readBundle(bundlePath: string): Promise<string> {
  try {
    return await fs.readFile(bundlePath, "utf8");
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
  const { bundle } = opts;
  const file = opts.settingsPath ?? settingsPath();
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${opts.port}`, defaultViewport: null });
  log.warn(SECURITY_NOTE);

  // inject.ts remembers which pages carry the binding; this remembers which carry a handler.
  const wired = new WeakSet<Page>();
  const attach = async (page: Page): Promise<void> => {
    if (wired.has(page)) return;
    wired.add(page);
    const handler = createDesktopRequestHandler({
      loadSettings: () => loadFileSettings(file),
      deliver: (json) => deliver(page, json),
      openOptions: () => console.log(setupInstructions(file)),
    });
    page.once("close", () => handler.abortAll());
    await attachKibitz(page, { bundle, onRequest: handler.handle });
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

  const { promise, resolve } = Promise.withResolvers<void>();
  browser.once("disconnected", () => {
    log.info("DevTools connection closed; companion exiting (Discord keeps running without Kibitz until relaunched)");
    resolve();
  });
  process.once("SIGINT", () => {
    log.info("disconnecting — Discord keeps running");
    browser.disconnect();
  });
  return promise;
}
