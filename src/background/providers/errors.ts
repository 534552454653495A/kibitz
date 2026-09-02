/**
 * Provider failure → ChatErrorCode. The panel decides what to show (an "open settings"
 * button, a retry, a plain message) from `code` alone, so every failure must land on
 * exactly one code, classified by error class or abort state — never by matching message
 * text, which providers change freely. Only the *advice* appended to an http failure is
 * allowed to read the body (see IMAGE_REJECTION): it changes what the user is told, never
 * which branch the panel takes.
 *
 * Lives next to the providers (not in the service worker) because the desktop companion
 * runs the same providers in Node and must map errors identically.
 */
import type { ChatErrorCode } from "../../core/messaging";
import { ProviderHttpError, ProviderStreamError } from "./types";

export interface ClassifiedError {
  code: ChatErrorCode;
  message: string;
}

/**
 * Providers refuse images in wildly different words ("Invalid content type: image_url",
 * "This model does not support vision", "modality not supported"), and the status is
 * always a plain 400/422 — indistinguishable from a bad temperature. Matching the body is
 * the only signal available, and the cost of a false positive is one extra sentence,
 * while the cost of a miss is a user who cannot tell why their local model broke.
 */
const IMAGE_REJECTION = /image|vision|multimodal|modalit/i;

const IMAGE_HINT =
  ' This model may not accept images; turn off "Send images" in settings to send text only.';

export function classifyError(err: unknown, aborted: boolean): ClassifiedError {
  // The abort check comes first: an aborted fetch may surface as AbortError, as a
  // stream read failure, or as nothing at all — the signal is the ground truth.
  if (aborted || (err instanceof Error && err.name === "AbortError")) {
    return { code: "aborted", message: "Request cancelled." };
  }
  if (err instanceof ProviderHttpError) {
    const message = `HTTP ${err.status}: ${err.bodyExcerpt}`;
    return { code: "http", message: IMAGE_REJECTION.test(err.bodyExcerpt) ? message + IMAGE_HINT : message };
  }
  if (err instanceof ProviderStreamError) return { code: "provider", message: err.message };
  // fetch() rejects with a TypeError for everything that never produced a response:
  // offline, DNS, a CORS block, or (extension) a host permission revoked after saving.
  if (err instanceof TypeError) {
    return {
      code: "network",
      message: `Could not reach the provider (${err.message}). Check that you are online and that the base URL is right; in the extension, save settings again to re-grant host permission.`,
    };
  }
  return { code: "provider", message: err instanceof Error ? err.message : String(err) };
}
