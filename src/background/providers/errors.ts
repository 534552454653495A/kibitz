/**
 * Provider failure → ChatErrorCode. The panel decides what to show (an "open settings"
 * button, a retry, a plain message) from `code` alone, so every failure must land on
 * exactly one code, classified by error class or abort state — never by matching message
 * text, which providers change freely.
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

export function classifyError(err: unknown, aborted: boolean): ClassifiedError {
  // The abort check comes first: an aborted fetch may surface as AbortError, as a
  // stream read failure, or as nothing at all — the signal is the ground truth.
  if (aborted || (err instanceof Error && err.name === "AbortError")) {
    return { code: "aborted", message: "Request cancelled." };
  }
  if (err instanceof ProviderHttpError) return { code: "http", message: `HTTP ${err.status}: ${err.bodyExcerpt}` };
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
