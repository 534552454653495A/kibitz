/**
 * Content-script entry (isolated world, Chrome extension).
 *
 * Only the top frame is handled: embedded frames (widgets, OAuth popups) either have no
 * message list or would mount a second panel over the first.
 */
import { createExtensionShell } from "../shell/extension";
import { startKibitz } from "./start";

if (window.top === window) startKibitz(createExtensionShell());
