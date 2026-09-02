/**
 * Content-script entry (isolated world). Picks the adapter that owns this page, mounts the
 * panel once, then starts the button injector.
 *
 * Only the top frame is handled: embedded frames (widgets, OAuth popups) either have no
 * message list or would mount a second panel over the first.
 */
import type { PlatformAdapter } from "../core/adapter";
import { discordAdapter } from "../adapters/discord/adapter";
import { log } from "../shared/log";
import { startInjector } from "./injector";
import { mountPanel } from "../ui/panel/mount";

/** Adding a platform = one line here (AGENTS.md section 11). */
const ADAPTERS: PlatformAdapter[] = [discordAdapter];

function main(): void {
  if (window.top !== window) return;
  const adapter = ADAPTERS.find((a) => a.matches(location));
  if (adapter === undefined) return;

  const panel = mountPanel(adapter);
  startInjector(adapter, (ref) => panel.open(ref));
  log.info(`kibitz ${__KIBITZ_VERSION__} active on ${adapter.platform}`);
}

main();
