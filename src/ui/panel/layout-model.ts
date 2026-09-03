/**
 * Panel geometry, as a value: where the panel sits, how big it is, whether it is expanded.
 *
 * Kept as data (not as CSS classes or ad-hoc inline styles scattered through the view) for
 * three reasons: it round-trips through `Shell.loadUiState/saveUiState` so the panel opens
 * where the user left it; `clampLayout` can keep it on screen when the window shrinks or a
 * stored value is nonsense; and the layout tests are pure functions with no DOM.
 *
 * `float` carries x/y so the panel can be dragged anywhere (the user asked for left, right,
 * up and down); the docks carry only a width because a docked panel spans the full height.
 */
import type { LayoutMode } from "../../shared/dom-markers";

export interface DockLayout {
  mode: "left" | "right";
  /** Panel width in px. */
  size: number;
}

export interface FloatLayout {
  mode: "float";
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PanelLayout = DockLayout | FloatLayout;

export interface Viewport {
  width: number;
  height: number;
}

export const MIN_WIDTH = 300;
export const MIN_HEIGHT = 240;
/** A dock wider than this hides too much of the chat to be useful. */
export const MAX_DOCK_FRACTION = 0.8;

export const DEFAULT_LAYOUT: DockLayout = { mode: "right", size: 380 };

/** Expanded = the dock grows to `MAX_DOCK_FRACTION`, a float fills the viewport with a margin. */
export interface LayoutState {
  layout: PanelLayout;
  expanded: boolean;
}

export const DEFAULT_LAYOUT_STATE: LayoutState = { layout: DEFAULT_LAYOUT, expanded: false };

export interface LayoutStyle {
  /** Inline style for the panel host. */
  host: string;
  /** LAYOUT_ATTR value. */
  mode: LayoutMode;
}
