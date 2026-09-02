/**
 * View registry — the extensibility seam for the panel.
 *
 * The panel is a frame (header with tabs, body, footer) plus a list of views. A new feature
 * ("summarise this channel", "translate", "saved threads") is a new file exporting a
 * `PanelView` and one entry in `VIEWS`; the frame, the layout engine, the shell and the
 * state machine do not change. That is the same rule as adding a platform adapter
 * (AGENTS.md 11), applied to the UI.
 *
 * A view gets `PanelContext`: the model it may read, the actions it may call, and the shell
 * capabilities it must respect. It never touches the shell or the adapter directly — so a
 * view cannot make a network call, and the probe's markers stay the only way in and out.
 */
import type { VNode } from "preact";
import type { PlatformAdapter } from "../../core/adapter";
import type { ShellCapabilities } from "../../shell/types";
import type { PanelActions } from "./actions";
import type { PanelModel } from "./state";

export interface PanelContext {
  model: PanelModel;
  actions: PanelActions;
  platform: PlatformAdapter["platform"];
  capabilities: ShellCapabilities;
  /** Where the host says the key is kept; shown by the settings view. */
  keyStorageHint: string;
}

export interface PanelView {
  /** Mirrored onto the host as VIEW_ATTR; also the tab's action name suffix (`view-<id>`). */
  id: "chat" | "settings";
  /** Tab label. */
  title: string;
  /** Single glyph for the tab in narrow layouts. */
  icon: string;
  /** True when the view should be reachable in the current state. */
  available(ctx: PanelContext): boolean;
  render(ctx: PanelContext): VNode;
}
