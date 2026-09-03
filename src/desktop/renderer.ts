/**
 * Desktop renderer entry — the bundle the companion injects into Discord's window over
 * CDP (dist/desktop-renderer.js).
 *
 * There is no extension runtime and no isolated world here: everything runs in the
 * page's own realm, so the MAIN-world bridge is simply imported (it self-starts) and the
 * page-rpc client talks to it across the same document. The companion may evaluate this
 * bundle twice (once into the live document, once via evaluateOnNewDocument for
 * reloads); the marker makes the second evaluation a no-op.
 *
 * evaluateOnNewDocument runs before the page has a <body> (the extension's content script
 * runs at document_idle instead), so the UI boot waits for DOMContentLoaded while the
 * bridge — listeners only — starts immediately.
 *
 * Nothing in this bundle may touch `chrome.*` — scripts/build.ts fails the build if it does.
 */
import "../adapters/discord/bridge.main";
import { startKibitz } from "../content/start";
import { createDesktopShell } from "../shell/desktop";
import { DESKTOP_MARKER } from "../shell/desktop-protocol";

function boot(): void {
  startKibitz(createDesktopShell());
}

if (window.top === window && !window[DESKTOP_MARKER]) {
  window[DESKTOP_MARKER] = true;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
}
