/**
 * The list of panel views, in tab order.
 *
 * This file is the extensibility seam: a new feature ("translate", "summarise channel",
 * "saved threads") is a new file under views/ plus one entry here. The frame reads this
 * array to build its tabs, so nothing in Panel.tsx, mount.ts or the layout engine has to
 * learn about the new view — the same rule as adding a platform adapter (AGENTS.md 11).
 *
 * Kept as an array rather than a Record because order is meaningful (it is the tab order)
 * and because `available(ctx)` decides membership at render time.
 */
import { chatView } from "./views/chat";
import { historyView } from "./views/history";
import { settingsView } from "./views/settings";
import type { PanelView } from "./views";

export const VIEWS: PanelView[] = [chatView, historyView, settingsView];

/**
 * Takes a plain string, not `PanelView["id"]`: the view id can come from persisted UI
 * state written by an older or newer build, so "unknown id" is a real case the caller
 * must handle rather than a type error.
 */
export function findView(id: string): PanelView | undefined {
  return VIEWS.find((view) => view.id === id);
}
