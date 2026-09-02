/**
 * Namespaced console logger.
 *
 * Every line is prefixed with "[kibitz]" so the probe can separate our console errors from
 * Discord's own (probe/report.ts filters on this prefix). `debug` is silent unless
 * `globalThis.KIBITZ_DEBUG = true` — Discord's console is noisy enough without us.
 *
 * The flag is per JS world. Almost everything that logs (injector, panel, adapter,
 * scroller) runs in the content script's ISOLATED world, whose globalThis is not the
 * page's: typing the flag into DevTools' default "top" context sets it on Discord's
 * world and changes nothing. In DevTools, switch the console's context dropdown from
 * "top" to the Kibitz entry first, then set the flag. Only bridge.main.ts logs from the
 * page world.
 */
const PREFIX = "[kibitz]";

declare global {
  // eslint-disable-next-line no-var
  var KIBITZ_DEBUG: boolean | undefined;
}

export const log = {
  debug(...args: unknown[]): void {
    if (globalThis.KIBITZ_DEBUG === true) console.debug(PREFIX, ...args);
  },
  info(...args: unknown[]): void {
    console.info(PREFIX, ...args);
  },
  warn(...args: unknown[]): void {
    console.warn(PREFIX, ...args);
  },
  error(...args: unknown[]): void {
    console.error(PREFIX, ...args);
  },
};

export const LOG_PREFIX = PREFIX;
