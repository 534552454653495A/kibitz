/**
 * Panel layout: the geometry maths as pure functions, plus the one impure piece — the
 * pointer-drag controller that turns a gesture into a new `LayoutState`.
 *
 * Why the split: everything that decides *where the panel goes* is a pure function of
 * (state, viewport), so docking, snapping, clamping and the "my window got smaller"
 * recovery are testable without a DOM and cannot drift between the two hosts. Only
 * `installLayoutController` touches elements, and all it does is (a) write the computed
 * style/attribute onto the shadow HOST and (b) feed pointer deltas back into those pure
 * functions.
 *
 * Two decisions that are load-bearing rather than stylistic:
 *
 * 1. **Listeners live on the shadow root and on `window`, never on `document`.** Discord's
 *    global handlers sit on `document` (that is the bug that made our composer unusable —
 *    see `src/ui/shadow-host.ts`). The host's bubble-phase guard stops our events before
 *    they get there, so a `document` listener of ours would never fire anyway; a `window`
 *    listener only ever sees pointer releases that happened *outside* our panel, which is
 *    exactly the "the pointer escaped and capture was unavailable" case we want to catch.
 * 2. **`onChange` fires once per completed gesture, not per `pointermove`.** It lands in
 *    `Shell.saveUiState`, i.e. `chrome.storage` or a JSON file on disk; a write per frame
 *    would be dozens of writes per drag. The live drag only repaints the host style.
 *
 * Stored layouts are user data that we did not write ourselves (the file is editable, the
 * schema may change between versions), so `parseLayoutState` never throws: a corrupt
 * preference must degrade to the default panel, not to no panel.
 */
import { isRecord } from "../../core/validate";
import { LAYOUT_ATTR } from "../../shared/dom-markers";
import {
  DEFAULT_LAYOUT_STATE,
  MAX_DOCK_FRACTION,
  MIN_HEIGHT,
  MIN_WIDTH,
  type DockLayout,
  type FloatLayout,
  type LayoutState,
  type LayoutStyle,
  type PanelLayout,
  type Viewport,
} from "./layout-model";

/** Key the layout round-trips under in `Shell.loadUiState()` / `saveUiState()`. */
export const UI_STATE_LAYOUT_KEY = "panelLayout";

/**
 * Marker on the elements a drag starts from. Not in `dom-markers.ts` because it is not part
 * of the probe/test surface — it is a private handshake between the panel view (which puts
 * the attribute on its header and its resize gripper) and this controller.
 */
export const DRAG_ATTR = "data-kibitz-drag";
export type DragRole = "move" | "resize";

/** Drag start → current pointer offset, in CSS px. */
export interface DragDelta {
  dx: number;
  dy: number;
}

/**
 * How far a docked panel must be dragged before it comes loose. Small enough that "pull it
 * into the middle" works on the first try, large enough that a sloppy click on the header
 * (or a click that starts a scroll) does not un-dock the panel by accident.
 */
export const UNDOCK_DISTANCE = 120;

/**
 * How close a floating panel's leading edge must get to a viewport side to snap into that
 * dock. Deliberately smaller than `UNDOCK_DISTANCE` so undock → re-dock is not a loop: the
 * gesture that frees a panel is longer than the one that captures it.
 */
export const SNAP_DISTANCE = 60;

/**
 * Rescue bounds for a floating panel. `MIN_VISIBLE_WIDTH` keeps a grabbable strip on screen
 * (the contract asks for "never past viewport.width - 80"; 120 is stricter, and equals the
 * undock threshold so a rescued panel is still draggable), `HEADER_KEEP` keeps the whole
 * header row — the only drag handle — inside the viewport.
 */
const MIN_VISIBLE_WIDTH = 120;
const HEADER_KEEP = 48;

/** Expanded float: a window-like inset instead of true fullscreen, so the page stays visible. */
const EXPANDED_INSET = 24;

/** Height a panel gets when it stops being a dock and has no remembered float height. */
const FLOAT_HEIGHT_FRACTION = 0.7;

/** One below the 32-bit max Discord-adjacent overlays fight over; leaves room to go higher. */
const HOST_STYLE_BASE = "position:fixed;z-index:2147483000;";

/** Radius hook only; the shadow stylesheet clips its own content to match. */
const FLOAT_RADIUS = 12;

/**
 * A non-finite input resolves to the minimum rather than propagating: `NaN` reaches here
 * whenever a stored preference or a synthetic pointer event was garbage, and the minimum
 * (0 for a coordinate, `MIN_WIDTH`/`MIN_HEIGHT` for an extent) is the safe reading. This is
 * what makes `clampLayout` total for every caller, including the panel's dock buttons.
 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** Widest useful dock; `MIN_WIDTH` wins on a viewport too narrow for the fraction to matter. */
function maxDockSize(viewport: Viewport): number {
  return Math.max(MIN_WIDTH, Math.round(viewport.width * MAX_DOCK_FRACTION));
}

/**
 * Force a state into something usable on this viewport. Rounds to whole px as well, because
 * the value is persisted and shown as a px string — fractional drift would accumulate over
 * many drags and make stored states hard to read.
 *
 * The minimum size beats the viewport on purpose: on a 200px-wide window a 200px panel is
 * useless, so we overflow instead and let the user dock or resize.
 */
export function clampLayout(state: LayoutState, viewport: Viewport): LayoutState {
  const width = Math.round(viewport.width);
  const height = Math.round(viewport.height);
  const layout = state.layout;

  if (layout.mode === "float") {
    const w = clamp(Math.round(layout.width), MIN_WIDTH, Math.max(MIN_WIDTH, width));
    const h = clamp(Math.round(layout.height), MIN_HEIGHT, Math.max(MIN_HEIGHT, height));
    return {
      layout: {
        mode: "float",
        width: w,
        height: h,
        x: clamp(Math.round(layout.x), 0, Math.max(0, width - Math.min(MIN_VISIBLE_WIDTH, w))),
        y: clamp(Math.round(layout.y), 0, Math.max(0, height - HEADER_KEEP)),
      },
      expanded: state.expanded,
    };
  }

  return {
    layout: {
      mode: layout.mode,
      size: clamp(Math.round(layout.size), MIN_WIDTH, maxDockSize(viewport)),
    },
    expanded: state.expanded,
  };
}

/**
 * The inline style for the shadow host plus the `LAYOUT_ATTR` value. One declaration string
 * rather than individual `style.*` writes because the host's `style` attribute is owned
 * wholesale by this module — anything else on it would be silently overwritten, and a single
 * `setAttribute` is one style recalculation instead of five.
 */
export function layoutStyle(state: LayoutState, viewport: Viewport): LayoutStyle {
  const layout = state.layout;

  if (layout.mode === "float") {
    // Expanded float insets from every edge instead of going truly fullscreen, so the page
    // stays visible behind it and the user can still see what is being explained.
    const box = state.expanded
      ? {
          x: EXPANDED_INSET,
          y: EXPANDED_INSET,
          width: Math.max(MIN_WIDTH, Math.round(viewport.width) - EXPANDED_INSET * 2),
          height: Math.max(MIN_HEIGHT, Math.round(viewport.height) - EXPANDED_INSET * 2),
        }
      : layout;
    return {
      host:
        `${HOST_STYLE_BASE}top:${box.y}px;left:${box.x}px;` +
        `width:${box.width}px;height:${box.height}px;border-radius:${FLOAT_RADIUS}px;`,
      mode: "float",
    };
  }

  // A dock spans the full height, so it is pinned top and bottom and only carries a width.
  const size = state.expanded ? maxDockSize(viewport) : Math.round(layout.size);
  const side = layout.mode === "left" ? "left:0;" : "right:0;";
  return { host: `${HOST_STYLE_BASE}top:0;bottom:0;${side}width:${size}px;`, mode: layout.mode };
}

/**
 * Resize from the drag-start state by the cumulative pointer delta. Recomputing from the
 * gesture's origin (instead of accumulating per move event) means a drag that overshoots the
 * clamp and comes back lands exactly where the pointer is, with no hysteresis.
 *
 * The gripper sits on the panel's inner edge, so a left dock widens as the pointer moves
 * right and a right dock widens as it moves left.
 */
export function resizeLayout(
  state: LayoutState,
  delta: DragDelta,
  viewport: Viewport,
): LayoutState {
  const layout = state.layout;
  if (layout.mode === "float") {
    const grown: FloatLayout = {
      mode: "float",
      x: layout.x,
      y: layout.y,
      width: layout.width + delta.dx,
      height: layout.height + delta.dy,
    };
    return clampLayout({ layout: grown, expanded: state.expanded }, viewport);
  }
  const size = layout.size + (layout.mode === "left" ? delta.dx : -delta.dx);
  return clampLayout({ layout: { mode: layout.mode, size }, expanded: state.expanded }, viewport);
}

/**
 * Move from the drag-start state by the cumulative pointer delta, converting between dock
 * and float as the gesture warrants. This is what makes "drag it left / right / up / down"
 * work with one handle instead of a mode picker.
 *
 * A dock ignores small drags entirely (returned unchanged, so the caller can tell nothing
 * happened) and comes loose past `UNDOCK_DISTANCE`; vertical movement counts, because
 * dragging a full-height dock downwards can mean nothing else.
 */
export function nextLayoutForDrag(
  state: LayoutState,
  delta: DragDelta,
  viewport: Viewport,
): LayoutState {
  const layout = state.layout;

  if (layout.mode === "float") {
    const moved: FloatLayout = {
      mode: "float",
      x: layout.x + delta.dx,
      y: layout.y + delta.dy,
      width: layout.width,
      height: layout.height,
    };
    const snapped = dockForEdge(moved, viewport);
    return clampLayout({ layout: snapped ?? moved, expanded: state.expanded }, viewport);
  }

  const outward = layout.mode === "left" ? delta.dx : -delta.dx;
  if (Math.max(outward, Math.abs(delta.dy)) <= UNDOCK_DISTANCE) return state;

  // The float appears where the panel already is, offset by the drag: it must not jump.
  const dockedX = layout.mode === "left" ? 0 : Math.max(0, Math.round(viewport.width) - layout.size);
  const freed: FloatLayout = {
    mode: "float",
    x: dockedX + delta.dx,
    y: delta.dy,
    width: layout.size,
    height: Math.max(MIN_HEIGHT, Math.round(viewport.height * FLOAT_HEIGHT_FRACTION)),
  };
  return clampLayout({ layout: freed, expanded: state.expanded }, viewport);
}

/**
 * Snap test, run on the *unclamped* moved box so that dragging past an edge still snaps
 * (clamping would have pulled it back inside first and hidden the intent).
 */
function dockForEdge(float: FloatLayout, viewport: Viewport): DockLayout | null {
  if (float.x <= SNAP_DISTANCE) return { mode: "left", size: float.width };
  if (float.x + float.width >= Math.round(viewport.width) - SNAP_DISTANCE) {
    return { mode: "right", size: float.width };
  }
  return null;
}

/** Gesture bookkeeping: "did this drag actually move anything worth persisting?" */
function sameState(a: LayoutState, b: LayoutState): boolean {
  if (a.expanded !== b.expanded) return false;
  const one = a.layout;
  const other = b.layout;
  if (one.mode !== other.mode) return false;
  if (one.mode === "float") {
    return (
      other.mode === "float" &&
      one.x === other.x &&
      one.y === other.y &&
      one.width === other.width &&
      one.height === other.height
    );
  }
  return other.mode !== "float" && one.size === other.size;
}

/**
 * A stored number. Rejects non-numbers, `NaN` and `Infinity`; sign and magnitude are the
 * caller's business, because only `clampLayout` knows the viewport and can judge range.
 */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseLayout(value: unknown): PanelLayout | null {
  if (!isRecord(value)) return null;
  const mode = value["mode"];

  if (mode === "left" || mode === "right") {
    const size = finiteNumber(value["size"]);
    // A zero or negative width was never a panel; anything else is clamped later.
    return size === null || size <= 0 ? null : { mode, size };
  }

  if (mode !== "float") return null;
  const x = finiteNumber(value["x"]);
  const y = finiteNumber(value["y"]);
  const width = finiteNumber(value["width"]);
  const height = finiteNumber(value["height"]);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  // Negative coordinates are legal input: an off-screen panel is rescued by clamping.
  return { mode: "float", x, y, width, height };
}

/**
 * Read back what `Shell.loadUiState()` stored under `UI_STATE_LAYOUT_KEY`. Anything we
 * cannot fully reconstruct falls back to `DEFAULT_LAYOUT_STATE` rather than to a
 * half-populated layout, because a panel at a plausible-but-wrong position is harder to
 * recover from than one back at its default dock. `expanded` is the exception: it is an
 * independent boolean, so an unreadable one is simply "not expanded".
 */
export function parseLayoutState(value: unknown): LayoutState {
  if (!isRecord(value)) return DEFAULT_LAYOUT_STATE;
  const layout = parseLayout(value["layout"]);
  if (layout === null) return DEFAULT_LAYOUT_STATE;
  return { layout, expanded: value["expanded"] === true };
}

export interface LayoutControllerOptions {
  /** The panel's shadow host; its `style` and `LAYOUT_ATTR` are owned by the controller. */
  host: HTMLElement;
  /** The panel's shadow root: where drag handles are found and pointer events are heard. */
  root: ShadowRoot;
  initial: LayoutState;
  /** Called once per settled gesture (and after a resize rescue) — it writes to storage. */
  onChange: (state: LayoutState) => void;
}

export interface LayoutController {
  setState(state: LayoutState): void;
  state(): LayoutState;
  dispose(): void;
}

interface Drag {
  role: DragRole;
  handle: Element;
  pointerId: number;
  originX: number;
  originY: number;
  /** The state the gesture started from; every move is computed from this, never from `current`. */
  base: LayoutState;
}

/** Resize first: a gripper is usually a child of the draggable header, and the inner one wins. */
const DRAG_ROLES: readonly DragRole[] = ["resize", "move"];

/**
 * jsdom implements no `PointerEvent`, so DOM tests dispatch `MouseEvent`s with no
 * `pointerId`. Treating a missing id as 0 keeps one code path for both environments; the id
 * is only used to ignore a second, unrelated pointer mid-drag.
 */
function pointerIdOf(event: MouseEvent): number {
  const id = (event as Partial<PointerEvent>).pointerId;
  return typeof id === "number" ? id : 0;
}

function viewportOf(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function installLayoutController(options: LayoutControllerOptions): LayoutController {
  const { host, root, onChange } = options;
  let current = clampLayout(options.initial, viewportOf());
  let drag: Drag | null = null;
  let frame: number | null = null;

  function apply(): void {
    const style = layoutStyle(current, viewportOf());
    host.setAttribute("style", style.host);
    host.setAttribute(LAYOUT_ATTR, style.mode);
  }

  /**
   * Handles are looked up per gesture, never cached: the view is re-rendered on every model
   * change, which replaces the header nodes a cached handle would still point at.
   */
  function handleAt(target: EventTarget | null): { role: DragRole; handle: Element } | null {
    if (!(target instanceof Node)) return null;
    for (const role of DRAG_ROLES) {
      for (const handle of root.querySelectorAll(`[${DRAG_ATTR}="${role}"]`)) {
        if (handle === target || handle.contains(target)) return { role, handle };
      }
    }
    return null;
  }

  /**
   * Capture keeps the moves coming when the pointer outruns the panel. It is an optimisation
   * only — the root and window listeners still deliver — and browsers throw
   * `InvalidPointerId` for a pointer that is already gone, so failure is ignored.
   */
  function capture(handle: Element, pointerId: number): void {
    if (typeof handle.setPointerCapture !== "function") return;
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // No capture; the fallback listeners cover it.
    }
  }

  function release(handle: Element, pointerId: number): void {
    if (typeof handle.releasePointerCapture !== "function") return;
    try {
      handle.releasePointerCapture(pointerId);
    } catch {
      // Already released.
    }
  }

  function onPointerDown(event: Event): void {
    if (drag !== null || !(event instanceof MouseEvent)) return;
    // Secondary buttons open context menus and trigger back/forward; they are not drags.
    if (event.button !== 0) return;
    const found = handleAt(event.target);
    if (found === null) return;
    drag = {
      role: found.role,
      handle: found.handle,
      pointerId: pointerIdOf(event),
      originX: event.clientX,
      originY: event.clientY,
      base: current,
    };
    // Without this the browser starts a text selection (or a native drag) under the cursor.
    event.preventDefault();
    capture(found.handle, drag.pointerId);
  }

  function onPointerMove(event: Event): void {
    if (drag === null || !(event instanceof MouseEvent)) return;
    if (pointerIdOf(event) !== drag.pointerId) return;
    const delta: DragDelta = { dx: event.clientX - drag.originX, dy: event.clientY - drag.originY };
    const viewport = viewportOf();
    current =
      drag.role === "move"
        ? nextLayoutForDrag(drag.base, delta, viewport)
        : resizeLayout(drag.base, delta, viewport);
    apply();
  }

  function onPointerUp(event: Event): void {
    if (drag === null || !(event instanceof MouseEvent)) return;
    if (pointerIdOf(event) !== drag.pointerId) return;
    const settled = drag;
    drag = null;
    release(settled.handle, settled.pointerId);
    // One storage write per gesture, and none at all for a drag that went nowhere.
    if (!sameState(settled.base, current)) onChange(current);
  }

  function onResize(): void {
    if (frame !== null) return;
    // Resize fires per frame while a window is dragged; coalescing to one frame keeps the
    // rescue arithmetic (and any resulting storage write) off the critical path.
    frame = window.requestAnimationFrame(() => {
      frame = null;
      const rescued = clampLayout(current, viewportOf());
      const moved = !sameState(rescued, current);
      current = rescued;
      // Applied unconditionally: dock width and the expanded insets are viewport-derived,
      // so the style changes even when the state does not.
      apply();
      if (moved) onChange(current);
    });
  }

  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerUp);
  // Only ever sees releases outside our shadow tree (the host stops the inside ones), which
  // is exactly the drag that would otherwise get stuck when capture is unavailable.
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("resize", onResize);

  apply();

  return {
    setState(state: LayoutState): void {
      // Caller-driven (a dock button, "reset layout"): it already knows, so no onChange.
      current = clampLayout(state, viewportOf());
      apply();
    },
    state(): LayoutState {
      return current;
    },
    dispose(): void {
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerup", onPointerUp);
      root.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("resize", onResize);
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      drag = null;
    },
  };
}
