/**
 * Boot sequence shared by every host: pick the adapter that owns this page, mount the
 * panel, start the button injector. The extension entry (content/index.ts) and the
 * desktop entry (desktop/renderer.ts) differ only in the Shell they pass in.
 */
import type { PlatformAdapter } from "../core/adapter";
import { discordAdapter } from "../adapters/discord/adapter";
import type { Shell } from "../shell/types";
import { log } from "../shared/log";
import { mountPanel } from "../ui/panel/mount";
import { startInjector } from "./injector";

/** Adding a platform = one line here (AGENTS.md section 11). */
const ADAPTERS: PlatformAdapter[] = [discordAdapter];

/** Returns false when no adapter owns the page (nothing was mounted). */
export function startKibitz(shell: Shell): boolean {
  const adapter = ADAPTERS.find((a) => a.matches(location));
  if (adapter === undefined) return false;

  const panel = mountPanel(adapter, shell);
  startInjector(adapter, (ref) => panel.open(ref));
  log.info(`kibitz ${__KIBITZ_VERSION__} active on ${adapter.platform}`);
  return true;
}
