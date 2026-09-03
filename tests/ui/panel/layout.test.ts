// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { LAYOUT_ATTR } from "../../../src/shared/dom-markers";
import {
  DEFAULT_LAYOUT_STATE,
  MAX_DOCK_FRACTION,
  MIN_HEIGHT,
  MIN_WIDTH,
  type LayoutState,
  type Viewport,
} from "../../../src/ui/panel/layout-model";
import {
  clampLayout,
  DRAG_ATTR,
  installLayoutController,
  layoutStyle,
  nextLayoutForDrag,
  parseLayoutState,
  resizeLayout,
  SNAP_DISTANCE,
  UNDOCK_DISTANCE,
  type LayoutController,
} from "../../../src/ui/panel/layout";

const WIDE: Viewport = { width: 1400, height: 900 };

function dock(mode: "left" | "right", size: number, expanded = false): LayoutState {
  return { layout: { mode, size }, expanded };
}

function float(x: number, y: number, width: number, height: number, expanded = false): LayoutState {
  return { layout: { mode: "float", x, y, width, height }, expanded };
}

describe("parseLayoutState", () => {
  it("falls back to the default dock instead of throwing when the stored value is not an object", () => {
    expect(parseLayoutState("panel-right-380")).toEqual(DEFAULT_LAYOUT_STATE);
    expect(parseLayoutState(undefined)).toEqual(DEFAULT_LAYOUT_STATE);
    expect(parseLayoutState(["right", 380])).toEqual(DEFAULT_LAYOUT_STATE);
  });

  it("rejects an unknown mode rather than producing a layout the style function cannot render", () => {
    expect(parseLayoutState({ layout: { mode: "top", size: 400 } })).toEqual(DEFAULT_LAYOUT_STATE);
    expect(parseLayoutState({ layout: { size: 400 } })).toEqual(DEFAULT_LAYOUT_STATE);
  });

  it("rejects NaN and Infinity, which would propagate into every px in the host style", () => {
    expect(parseLayoutState({ layout: { mode: "right", size: Number.NaN } })).toEqual(DEFAULT_LAYOUT_STATE);
    expect(parseLayoutState({ layout: { mode: "left", size: Number.POSITIVE_INFINITY } })).toEqual(
      DEFAULT_LAYOUT_STATE,
    );
    expect(parseLayoutState({ layout: { mode: "float", x: 0, y: Number.NaN, width: 400, height: 400 } })).toEqual(
      DEFAULT_LAYOUT_STATE,
    );
  });

  it("rejects a non-positive size, which would render an invisible panel the user cannot grab", () => {
    expect(parseLayoutState({ layout: { mode: "right", size: -380 } })).toEqual(DEFAULT_LAYOUT_STATE);
    expect(parseLayoutState({ layout: { mode: "left", size: 0 } })).toEqual(DEFAULT_LAYOUT_STATE);
    expect(parseLayoutState({ layout: { mode: "float", x: 10, y: 10, width: 400, height: -1 } })).toEqual(
      DEFAULT_LAYOUT_STATE,
    );
  });

  it("drops a float that is missing a coordinate instead of defaulting it to a wrong position", () => {
    expect(parseLayoutState({ layout: { mode: "float", x: 10, width: 400, height: 400 } })).toEqual(
      DEFAULT_LAYOUT_STATE,
    );
  });

  it("restores a complete float, including a negative coordinate that clamping will rescue", () => {
    expect(
      parseLayoutState({ layout: { mode: "float", x: -40, y: 12, width: 420, height: 560 }, expanded: true }),
    ).toEqual(float(-40, 12, 420, 560, true));
  });

  it("treats an unreadable `expanded` as not expanded rather than discarding the layout", () => {
    expect(parseLayoutState({ layout: { mode: "left", size: 420 }, expanded: "yes" })).toEqual(dock("left", 420));
  });
});

describe("clampLayout", () => {
  it("caps a dock at 80% of a narrow viewport so the chat behind it stays usable", () => {
    const narrow: Viewport = { width: 400, height: 800 };
    const clamped = clampLayout(dock("right", 900), narrow);
    expect(clamped.layout).toEqual({ mode: "right", size: narrow.width * MAX_DOCK_FRACTION });
  });

  it("keeps a dock at least MIN_WIDTH wide when a stored size is smaller than the panel needs", () => {
    expect(clampLayout(dock("left", 40), WIDE).layout).toEqual({ mode: "left", size: MIN_WIDTH });
  });

  it("prefers MIN_WIDTH over the viewport when the window is narrower than the panel minimum", () => {
    expect(clampLayout(dock("right", 380), { width: 200, height: 600 }).layout).toEqual({
      mode: "right",
      size: MIN_WIDTH,
    });
  });

  it("drags a float back on screen when the viewport shrinks under it", () => {
    const shrunk: Viewport = { width: 600, height: 400 };
    const clamped = clampLayout(float(900, 700, 500, 600), shrunk);
    if (clamped.layout.mode !== "float") throw new Error("mode must not change while clamping");
    const box = clamped.layout;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    // At least a grabbable strip of panel and the whole header row stay reachable.
    expect(box.x).toBeLessThanOrEqual(shrunk.width - 120);
    expect(box.y).toBeLessThanOrEqual(shrunk.height - 48);
    expect(box.width).toBeLessThanOrEqual(shrunk.width);
    expect(box.height).toBeLessThanOrEqual(shrunk.height);
  });

  it("keeps a float at least MIN_WIDTH by MIN_HEIGHT so its header and composer still fit", () => {
    expect(clampLayout(float(10, 10, 50, 60), WIDE).layout).toEqual({
      mode: "float",
      x: 10,
      y: 10,
      width: MIN_WIDTH,
      height: MIN_HEIGHT,
    });
  });

  it("resolves a NaN geometry to the axis minimum instead of writing NaNpx into the host style", () => {
    const clamped = clampLayout(float(Number.NaN, Number.NaN, Number.NaN, Number.NaN), WIDE);
    expect(clamped.layout).toEqual({ mode: "float", x: 0, y: 0, width: MIN_WIDTH, height: MIN_HEIGHT });
  });

  it("is idempotent, so re-clamping a persisted state does not drift the panel", () => {
    const once = clampLayout(float(1390.4, 880.6, 900.5, 950.2), WIDE);
    expect(clampLayout(once, WIDE)).toEqual(once);
  });
});

describe("layoutStyle", () => {
  it("pins a right dock to the right edge and a left dock to the left at the same width", () => {
    const right = layoutStyle(dock("right", 380), WIDE);
    const left = layoutStyle(dock("left", 380), WIDE);

    expect(right.mode).toBe("right");
    expect(right.host).toContain("right:0;");
    expect(right.host).not.toContain("left:0;");
    expect(left.mode).toBe("left");
    expect(left.host).toContain("left:0;");
    expect(left.host).not.toContain("right:0;");
    for (const style of [right.host, left.host]) {
      expect(style).toContain("width:380px;");
      expect(style).toContain("position:fixed;");
      // A dock spans the full height; a missing bottom would leave it floating mid-screen.
      expect(style).toContain("top:0;");
      expect(style).toContain("bottom:0;");
    }
  });

  it("widens an expanded dock to the dock maximum for the current viewport", () => {
    expect(layoutStyle(dock("right", 380, true), { width: 1000, height: 800 }).host).toContain("width:800px;");
  });

  it("insets an expanded float from every edge instead of hiding the page completely", () => {
    const style = layoutStyle(float(10, 10, 400, 400, true), { width: 1000, height: 800 });
    expect(style.mode).toBe("float");
    expect(style.host).toContain("top:24px;");
    expect(style.host).toContain("left:24px;");
    expect(style.host).toContain("width:952px;");
    expect(style.host).toContain("height:752px;");
  });

  it("places a float at its own coordinates with an explicit box, not at a dock edge", () => {
    const style = layoutStyle(float(120, 64, 420, 560), WIDE);
    expect(style.host).toContain("top:64px;");
    expect(style.host).toContain("left:120px;");
    expect(style.host).toContain("width:420px;");
    expect(style.host).toContain("height:560px;");
    expect(style.host).not.toContain("bottom:0;");
  });

  it("never sets `display`, so the panel's own closed/open rule keeps working", () => {
    expect(layoutStyle(dock("right", 380), WIDE).host).not.toContain("display");
    expect(layoutStyle(float(10, 10, 400, 400), WIDE).host).not.toContain("display");
  });
});

describe("resizeLayout", () => {
  it("widens a left dock as the pointer moves right and narrows it as the pointer moves left", () => {
    expect(resizeLayout(dock("left", 380), { dx: 120, dy: 0 }, WIDE).layout).toEqual({ mode: "left", size: 500 });
    expect(resizeLayout(dock("left", 380), { dx: -60, dy: 0 }, WIDE).layout).toEqual({ mode: "left", size: 320 });
  });

  it("widens a right dock as the pointer moves LEFT — the gripper is on its inner edge", () => {
    expect(resizeLayout(dock("right", 380), { dx: -120, dy: 0 }, WIDE).layout).toEqual({ mode: "right", size: 500 });
    expect(resizeLayout(dock("right", 380), { dx: 60, dy: 0 }, WIDE).layout).toEqual({ mode: "right", size: 320 });
  });

  it("grows a float on both axes and leaves its position where the user put it", () => {
    expect(resizeLayout(float(100, 80, 400, 400), { dx: 90, dy: 45 }, WIDE).layout).toEqual({
      mode: "float",
      x: 100,
      y: 80,
      width: 490,
      height: 445,
    });
  });

  it("stops a resize at the dock maximum instead of covering the whole conversation", () => {
    const viewport: Viewport = { width: 1000, height: 800 };
    expect(resizeLayout(dock("left", 380), { dx: 5000, dy: 0 }, viewport).layout).toEqual({
      mode: "left",
      size: 800,
    });
  });

  it("does not shrink a float below the minimum when the pointer is dragged far inwards", () => {
    expect(resizeLayout(float(10, 10, 400, 400), { dx: -5000, dy: -5000 }, WIDE).layout).toEqual({
      mode: "float",
      x: 10,
      y: 10,
      width: MIN_WIDTH,
      height: MIN_HEIGHT,
    });
  });
});

describe("nextLayoutForDrag", () => {
  it("keeps a dock docked for a short drag, so a sloppy click on the header cannot undock it", () => {
    const state = dock("right", 380);
    expect(nextLayoutForDrag(state, { dx: -UNDOCK_DISTANCE, dy: 0 }, WIDE)).toEqual(state);
    expect(nextLayoutForDrag(state, { dx: 0, dy: 40 }, WIDE)).toEqual(state);
  });

  it("turns a dock dragged away from its edge into a float that starts where the panel was", () => {
    const next = nextLayoutForDrag(dock("right", 380), { dx: -400, dy: 60 }, WIDE);
    if (next.layout.mode !== "float") throw new Error("a dock dragged 400px inwards must come loose");
    // Docked right at width 1400 means x = 1020; dragging 400px left lands at 620.
    expect(next.layout.x).toBe(620);
    expect(next.layout.y).toBe(60);
    expect(next.layout.width).toBe(380);
    expect(next.layout.height).toBeGreaterThanOrEqual(MIN_HEIGHT);
  });

  it("undocks on a purely vertical drag, because a full-height dock cannot move up or down", () => {
    const next = nextLayoutForDrag(dock("left", 380), { dx: 0, dy: 300 }, WIDE);
    expect(next.layout.mode).toBe("float");
  });

  it("moves a float by the drag delta when it is nowhere near an edge", () => {
    expect(nextLayoutForDrag(float(400, 200, 400, 400), { dx: 150, dy: -80 }, WIDE).layout).toEqual({
      mode: "float",
      x: 550,
      y: 120,
      width: 400,
      height: 400,
    });
  });

  it("snaps a float dragged near the left edge into a left dock of the same width", () => {
    const next = nextLayoutForDrag(float(400, 200, 420, 400), { dx: -(400 - SNAP_DISTANCE), dy: 0 }, WIDE);
    expect(next.layout).toEqual({ mode: "left", size: 420 });
  });

  it("snaps a float dragged near the right edge into a right dock, not off the screen", () => {
    // x 400 + width 420 = 820; +560 puts the trailing edge at 1380, inside the 60px snap band.
    const next = nextLayoutForDrag(float(400, 200, 420, 400), { dx: 560, dy: 0 }, WIDE);
    expect(next.layout).toEqual({ mode: "right", size: 420 });
  });

  it("keeps a float on screen when it is dragged far past the bottom", () => {
    const next = nextLayoutForDrag(float(400, 200, 400, 400), { dx: 0, dy: 5000 }, WIDE);
    if (next.layout.mode !== "float") throw new Error("a downward drag must not dock the panel");
    expect(next.layout.y).toBeLessThanOrEqual(WIDE.height - 48);
  });

  it("preserves the expanded flag through a dock/float conversion", () => {
    expect(nextLayoutForDrag(dock("left", 380, true), { dx: 400, dy: 0 }, WIDE).expanded).toBe(true);
  });
});

describe("installLayoutController", () => {
  let controller: LayoutController | null = null;

  function setViewport(width: number, height: number): void {
    Object.defineProperty(window, "innerWidth", { value: width, writable: true, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: height, writable: true, configurable: true });
  }

  function mount(): { host: HTMLElement; root: ShadowRoot; move: HTMLElement; grip: HTMLElement } {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    const move = document.createElement("div");
    move.setAttribute(DRAG_ATTR, "move");
    const title = document.createElement("span");
    move.append(title);
    const grip = document.createElement("div");
    grip.setAttribute(DRAG_ATTR, "resize");
    root.append(move, grip);
    document.body.append(host);
    return { host, root, move, grip };
  }

  function pointer(target: EventTarget, type: string, x: number, y: number, button = 0): void {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, button, clientX: x, clientY: y }));
  }

  function dragBy(handle: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }): void {
    pointer(handle, "pointerdown", from.x, from.y);
    pointer(handle, "pointermove", (from.x + to.x) / 2, (from.y + to.y) / 2);
    pointer(handle, "pointermove", to.x, to.y);
    pointer(handle, "pointerup", to.x, to.y);
  }

  async function nextFrames(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    return promise;
  }

  afterEach(() => {
    controller?.dispose();
    controller = null;
    document.body.innerHTML = "";
    setViewport(1400, 900);
  });

  it("writes the geometry and the layout attribute onto the host at install time", () => {
    setViewport(1400, 900);
    const { host, root } = mount();
    controller = installLayoutController({ host, root, initial: dock("right", 420), onChange: vi.fn() });

    expect(host.getAttribute(LAYOUT_ATTR)).toBe("right");
    expect(host.getAttribute("style")).toContain("width:420px;");
    expect(host.getAttribute("style")).toContain("right:0;");
  });

  it("clamps a stored layout that no longer fits the current window before showing it", () => {
    setViewport(500, 700);
    const { host, root } = mount();
    controller = installLayoutController({ host, root, initial: dock("left", 900), onChange: vi.fn() });

    expect(controller.state().layout).toEqual({ mode: "left", size: 400 });
    expect(host.getAttribute("style")).toContain("width:400px;");
  });

  it("reports a completed move drag exactly once, with the geometry it ended at", () => {
    setViewport(1400, 900);
    const { host, root, move } = mount();
    const onChange = vi.fn();
    controller = installLayoutController({ host, root, initial: float(400, 200, 400, 400), onChange });

    dragBy(move, { x: 500, y: 220 }, { x: 700, y: 320 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual(float(600, 300, 400, 400));
    expect(controller.state().layout).toEqual({ mode: "float", x: 600, y: 300, width: 400, height: 400 });
    expect(host.getAttribute("style")).toContain("left:600px;");
  });

  it("updates the host during the drag but only persists after the pointer is released", () => {
    setViewport(1400, 900);
    const { host, root, move } = mount();
    const onChange = vi.fn();
    controller = installLayoutController({ host, root, initial: float(400, 200, 400, 400), onChange });

    pointer(move, "pointerdown", 500, 220);
    pointer(move, "pointermove", 560, 220);
    expect(host.getAttribute("style")).toContain("left:460px;");
    expect(onChange).not.toHaveBeenCalled();

    pointer(move, "pointermove", 620, 220);
    expect(host.getAttribute("style")).toContain("left:520px;");
    expect(onChange).not.toHaveBeenCalled();

    pointer(move, "pointerup", 620, 220);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // Failure mode: the pointer is released over Discord's UI (outside our shadow tree) and
  // pointer capture was unavailable, so the shadow root never sees the pointerup — the panel
  // would then follow the cursor forever.
  it("settles a drag whose pointer was released outside the panel", () => {
    setViewport(1400, 900);
    const { host, root, move } = mount();
    const onChange = vi.fn();
    controller = installLayoutController({ host, root, initial: float(400, 200, 400, 400), onChange });

    pointer(move, "pointerdown", 500, 220);
    pointer(move, "pointermove", 620, 260);
    pointer(window, "pointerup", 620, 260);
    const settled = host.getAttribute("style");
    pointer(move, "pointermove", 900, 500);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(controller.state().layout).toEqual({ mode: "float", x: 520, y: 240, width: 400, height: 400 });
    expect(host.getAttribute("style")).toBe(settled);
  });

  it("drives the resize grip instead of moving the panel when the drag starts there", () => {
    setViewport(1400, 900);
    const { host, root, grip } = mount();
    const onChange = vi.fn();
    controller = installLayoutController({ host, root, initial: float(200, 100, 400, 400), onChange });

    dragBy(grip, { x: 600, y: 500 }, { x: 700, y: 560 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(controller.state().layout).toEqual({ mode: "float", x: 200, y: 100, width: 500, height: 460 });
  });

  it("converts a docked panel into a float when the header is dragged off its edge", () => {
    setViewport(1400, 900);
    const { host, root, move } = mount();
    const onChange = vi.fn();
    controller = installLayoutController({ host, root, initial: dock("left", 380), onChange });

    dragBy(move, { x: 100, y: 40 }, { x: 500, y: 180 });

    expect(host.getAttribute(LAYOUT_ATTR)).toBe("float");
    expect(controller.state().layout.mode).toBe("float");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ignores a drag that starts on a node outside any handle", () => {
    setViewport(1400, 900);
    const { host, root } = mount();
    const body = document.createElement("div");
    root.append(body);
    const onChange = vi.fn();
    controller = installLayoutController({ host, root, initial: float(400, 200, 400, 400), onChange });
    const before = host.getAttribute("style");

    dragBy(body, { x: 500, y: 300 }, { x: 800, y: 400 });

    expect(onChange).not.toHaveBeenCalled();
    expect(host.getAttribute("style")).toBe(before);
  });

  it("ignores a secondary-button press, so a right-click on the header cannot move the panel", () => {
    setViewport(1400, 900);
    const { host, root, move } = mount();
    const onChange = vi.fn();
    controller = installLayoutController({ host, root, initial: float(400, 200, 400, 400), onChange });
    const before = host.getAttribute("style");

    pointer(move, "pointerdown", 500, 220, 2);
    pointer(move, "pointermove", 700, 320);
    pointer(move, "pointerup", 700, 320);

    expect(onChange).not.toHaveBeenCalled();
    expect(host.getAttribute("style")).toBe(before);
  });

  it("stays silent while the pointer merely hovers over the drag handle", () => {
    setViewport(1400, 900);
    const { host, root, move } = mount();
    const onChange = vi.fn();
    controller = installLayoutController({ host, root, initial: float(400, 200, 400, 400), onChange });
    const before = host.getAttribute("style");

    for (const x of [500, 540, 580]) pointer(move, "pointermove", x, 220);

    expect(onChange).not.toHaveBeenCalled();
    expect(host.getAttribute("style")).toBe(before);
  });

  it("does not persist a press-and-release that moved nothing", () => {
    setViewport(1400, 900);
    const { host, root, move } = mount();
    const onChange = vi.fn();
    controller = installLayoutController({ host, root, initial: float(400, 200, 400, 400), onChange });

    pointer(move, "pointerdown", 500, 220);
    pointer(move, "pointerup", 500, 220);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("finds the handle again after the view has re-rendered and replaced the header node", () => {
    setViewport(1400, 900);
    const { host, root, move } = mount();
    const onChange = vi.fn();
    controller = installLayoutController({ host, root, initial: float(400, 200, 400, 400), onChange });

    move.remove();
    const rerendered = document.createElement("div");
    rerendered.setAttribute(DRAG_ATTR, "move");
    root.append(rerendered);

    dragBy(rerendered, { x: 500, y: 220 }, { x: 620, y: 260 });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(controller.state().layout).toEqual({ mode: "float", x: 520, y: 240, width: 400, height: 400 });
  });

  it("rescues a float that a window resize pushed off screen, reporting it once", async () => {
    setViewport(1400, 900);
    const { host, root } = mount();
    const onChange = vi.fn();
    controller = installLayoutController({ host, root, initial: float(1200, 800, 400, 400), onChange });

    setViewport(600, 500);
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    await nextFrames();

    expect(onChange).toHaveBeenCalledTimes(1);
    const rescued = controller.state().layout;
    if (rescued.mode !== "float") throw new Error("a resize must not change the layout mode");
    expect(rescued.x).toBeLessThanOrEqual(600 - 120);
    expect(rescued.y).toBeLessThanOrEqual(500 - 48);
    expect(host.getAttribute("style")).toContain(`left:${rescued.x}px;`);
  });

  it("re-applies a viewport-derived expanded dock width on resize without persisting anything", async () => {
    setViewport(1000, 800);
    const { host, root } = mount();
    const onChange = vi.fn();
    controller = installLayoutController({ host, root, initial: dock("right", 380, true), onChange });
    expect(host.getAttribute("style")).toContain("width:800px;");

    setViewport(500, 800);
    window.dispatchEvent(new Event("resize"));
    await nextFrames();

    expect(host.getAttribute("style")).toContain("width:400px;");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("applies a caller-driven setState without reporting it back to the shell", () => {
    setViewport(1400, 900);
    const { host, root } = mount();
    const onChange = vi.fn();
    controller = installLayoutController({ host, root, initial: dock("right", 380), onChange });

    controller.setState(float(100, 50, 5000, 5000));

    expect(host.getAttribute(LAYOUT_ATTR)).toBe("float");
    expect(controller.state().layout).toEqual({ mode: "float", x: 100, y: 50, width: 1400, height: 900 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops listening after dispose, so a detached panel cannot move or persist anything", () => {
    setViewport(1400, 900);
    const { host, root, move } = mount();
    const onChange = vi.fn();
    const live = installLayoutController({ host, root, initial: float(400, 200, 400, 400), onChange });
    const before = host.getAttribute("style");

    live.dispose();
    dragBy(move, { x: 500, y: 220 }, { x: 900, y: 500 });
    window.dispatchEvent(new Event("resize"));

    expect(onChange).not.toHaveBeenCalled();
    expect(host.getAttribute("style")).toBe(before);
    expect(live.state().layout).toEqual({ mode: "float", x: 400, y: 200, width: 400, height: 400 });
  });
});
