/**
 * Single import point for the WebExtension API.
 *
 * Chrome-only MVP, so this is just `chrome`. It exists so that a future Firefox build
 * changes one line (`globalThis.browser ?? chrome`) instead of every call site, and so
 * that core/ can be grepped for `chrome.` to prove it never touches the browser API.
 */
export const ext = chrome;
