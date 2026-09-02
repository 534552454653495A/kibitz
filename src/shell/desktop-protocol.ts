/**
 * Wire contract between the injected renderer bundle and the desktop companion (Node),
 * carried over Chrome DevTools Protocol bindings that Puppeteer installs on the page:
 *
 *   renderer → companion : window[DESKTOP_CALL_BINDING](json) → Promise<json>
 *                          (Puppeteer `page.exposeFunction`; one JSON string in, one out)
 *   companion → renderer : window[DESKTOP_DELIVER_FN](json)
 *                          (companion runs `page.evaluate`; the renderer shell defines
 *                          the function at load time)
 *
 * Request/response shapes are the extension's own protocol (core/messaging.ts) so the two
 * shells stay behaviourally identical; only the transport differs. Strings, not objects,
 * for the same reason page-rpc.ts uses strings: nothing with identity crosses a boundary.
 */
import type { PortRequest, PortResponse, RuntimeRequest, SettingsStatus } from "../core/messaging";

export const DESKTOP_CALL_BINDING = "__kibitzDesktopCall";
export const DESKTOP_DELIVER_FN = "__kibitzDesktopDeliver";
/** Set by the renderer entry so a second injection (evaluate + evaluateOnNewDocument) is a no-op. */
export const DESKTOP_MARKER = "__kibitzDesktop";

export type DesktopRequest = PortRequest | RuntimeRequest;

/** Immediate reply to a DesktopRequest. Chat deltas/done/error arrive later via DESKTOP_DELIVER_FN. */
export type DesktopReply = { ok: true } | { ok: false; error: string } | SettingsStatus;

/** Pushed by the companion; `requestId` matches the originating chat request. */
export type DesktopDelivery = PortResponse;

declare global {
  interface Window {
    [DESKTOP_CALL_BINDING]?: (json: string) => Promise<string>;
    [DESKTOP_DELIVER_FN]?: (json: string) => void;
    [DESKTOP_MARKER]?: true;
  }
}
