/**
 * The panel frame: header (drag handle, view tabs, layout controls, close) and the active
 * view's body. A pure function of PanelContext — every observable state lives in the
 * reducer, so the host attributes the probe reads and what the user sees cannot drift.
 *
 * The frame deliberately knows nothing about chat or settings: it maps over the registry
 * (registry.ts) to build tabs and calls `render(ctx)` on whichever view is active. Adding a
 * view therefore changes one array, not this file.
 *
 * When the panel is closed the frame renders nothing at all, rather than rendering a hidden
 * tree: unmounting is what discards a half-typed follow-up and the settings form's local
 * state, which is the behaviour a user expects from "I closed it".
 */
import type { VNode } from "preact";
import { ACTION_ATTR, type ActionName, type LayoutMode } from "../../shared/dom-markers";
import { DRAG_ATTR } from "./layout";
import { findView, VIEWS } from "./registry";
import type { PanelContext } from "./views";

interface DockControl {
  action: ActionName;
  mode: LayoutMode;
  glyph: string;
  label: string;
}

const DOCK_CONTROLS: DockControl[] = [
  { action: "dock-left", mode: "left", glyph: "⇤", label: "Dock left" },
  { action: "float", mode: "float", glyph: "▣", label: "Float" },
  { action: "dock-right", mode: "right", glyph: "⇥", label: "Dock right" },
];

export function Panel(ctx: PanelContext): VNode | null {
  const { model, actions } = ctx;
  if (model.status === "closed") return null;

  const views = VIEWS.filter((view) => view.available(ctx));
  const active = findView(model.view) ?? VIEWS[0];

  return (
    <div class="panel">
      <header class="header">
        <div class={`drag${model.layout.layout.mode === "float" ? " movable" : ""}`} {...{ [DRAG_ATTR]: "move" }}>
          <span class="title">Kibitz</span>
          <span class="platform">{ctx.platform}</span>
        </div>

        <nav class="tabs" role="tablist">
          {views.map((view) => {
            const action: ActionName = `view-${view.id}`;
            const selected = view.id === model.view;
            return (
              <button
                key={view.id}
                class={selected ? "tab selected" : "tab"}
                role="tab"
                aria-selected={selected}
                title={view.title}
                {...{ [ACTION_ATTR]: action }}
                onClick={() => actions.showView(view.id)}
              >
                <span class="tab-icon">{view.icon}</span>
                <span class="tab-label">{view.title}</span>
              </button>
            );
          })}
        </nav>

        <div class="controls">
          {DOCK_CONTROLS.map((control) => (
            <button
              key={control.action}
              class={model.layout.layout.mode === control.mode ? "icon-button selected" : "icon-button"}
              title={control.label}
              aria-label={control.label}
              aria-pressed={model.layout.layout.mode === control.mode}
              {...{ [ACTION_ATTR]: control.action }}
              onClick={() => actions.setLayout(control.mode)}
            >
              {control.glyph}
            </button>
          ))}
          <button
            class={model.layout.expanded ? "icon-button selected" : "icon-button"}
            title={model.layout.expanded ? "Shrink" : "Expand"}
            aria-label="Expand"
            aria-pressed={model.layout.expanded}
            {...{ [ACTION_ATTR]: "expand" }}
            onClick={actions.toggleExpanded}
          >
            ⤢
          </button>
          <button
            class="icon-button"
            title="Reset size and position"
            aria-label="Reset layout"
            {...{ [ACTION_ATTR]: "reset-layout" }}
            onClick={actions.resetLayout}
          >
            ⟲
          </button>
          <button
            class="icon-button close"
            title="Close (Esc)"
            aria-label="Close"
            {...{ [ACTION_ATTR]: "close" }}
            onClick={actions.close}
          >
            ×
          </button>
        </div>
      </header>

      <div class="body">{active?.render(ctx)}</div>

      <div class="grip" {...{ [DRAG_ATTR]: "resize" }} title="Drag to resize" aria-hidden="true" />
    </div>
  );
}
