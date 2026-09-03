/**
 * Validators for the one-shot replies both shells receive (core/messaging.ts RuntimeResponse).
 *
 * Two call sites: `src/shell/extension.ts` (reply from the service worker) and
 * `src/shell/desktop.ts` (reply from the companion over the CDP binding). The transports
 * differ, the shapes do not, so the narrowing lives here once instead of being hand-rolled
 * twice and drifting. Host-agnostic on purpose: no chrome.*, no window — the desktop bundle
 * imports this and the build rejects a `chrome` identifier in it.
 *
 * `host` is only there so the thrown message names who misbehaved; a panel that shows
 * "companion returned a malformed settings draft" tells the user which half to restart.
 */
import { type ConversationRecord, type ConversationSummary, parseConversation, parseSummary } from "../core/history";
import { AUTO_LANGUAGE, PROVIDER_IDS, type ProviderId } from "../core/settings";
import { isRecord } from "../core/validate";
import type { SaveSettingsResult, SettingsDraft } from "./types";

function providerId(value: unknown): ProviderId | null {
  if (typeof value !== "string") return null;
  // PROVIDER_IDS is ProviderId[]; widening it is the only way to test an arbitrary string.
  return (PROVIDER_IDS as readonly string[]).includes(value) ? (value as ProviderId) : null;
}

/** `{draft:null}` means "nothing configured yet"; anything else malformed is a protocol bug. */
export function readDraft(reply: Record<string, unknown>, host: string): SettingsDraft | null {
  const draft = reply.draft;
  if (draft === null) return null;
  const provider = isRecord(draft) ? providerId(draft.provider) : null;
  // `sendImages` is deliberately not required: a service worker or companion that predates
  // the image toggle answers without it, and a panel that has already been reloaded must
  // still get a usable form instead of "malformed draft". Absent reads as on, matching
  // `parseSettings`. A present non-boolean is a protocol bug and fails with the rest.
  const sendImages: unknown = isRecord(draft) ? draft.sendImages : undefined;
  // Same tolerance for the language picker, same reason: an older host answers without it.
  const language: unknown = isRecord(draft) ? draft.language : undefined;
  if (
    !isRecord(draft) ||
    provider === null ||
    typeof draft.baseUrl !== "string" ||
    typeof draft.model !== "string" ||
    typeof draft.hasKey !== "boolean" ||
    (sendImages !== undefined && typeof sendImages !== "boolean") ||
    (language !== undefined && typeof language !== "string")
  ) {
    throw new Error(`${host} returned a malformed settings draft`);
  }
  return {
    provider,
    baseUrl: draft.baseUrl,
    model: draft.model,
    hasKey: draft.hasKey,
    sendImages: sendImages ?? true,
    language: language ?? AUTO_LANGUAGE,
  };
}

export function readSaveResult(reply: Record<string, unknown>, host: string): SaveSettingsResult {
  if (reply.ok === true) return { ok: true };
  if (reply.ok === false && typeof reply.error === "string") {
    return typeof reply.grantOrigin === "string"
      ? { ok: false, error: reply.error, grantOrigin: reply.grantOrigin }
      : { ok: false, error: reply.error };
  }
  throw new Error(`${host} returned a malformed save result`);
}

export function readGranted(reply: Record<string, unknown>, host: string): boolean {
  if (typeof reply.granted !== "boolean") throw new Error(`${host} returned no grant decision`);
  return reply.granted;
}

/**
 * UI state is a preference blob, not a contract: a host that has never stored one (or stored
 * something we can no longer read) gets an empty object rather than an error the panel would
 * have to render instead of the chat.
 */
export function readUiState(reply: Record<string, unknown>): Record<string, unknown> {
  return isRecord(reply.state) ? reply.state : {};
}

/**
 * A history list is allowed to be incomplete but not to be absent: an entry the host wrote
 * before a field existed is dropped so the other conversations still reach the list, while
 * a reply with no list at all is a protocol bug the panel should surface, not render as
 * "you have no history" over a store that is full of it.
 */
export function readConversations(reply: Record<string, unknown>, host: string): ConversationSummary[] {
  const { conversations } = reply;
  if (!Array.isArray(conversations)) throw new Error(`${host} returned a malformed conversation list`);
  return conversations.flatMap((entry) => {
    const summary = parseSummary(entry);
    return summary === null ? [] : [summary];
  });
}

/** `{conversation:null}` means "no such conversation"; a record we cannot read is a bug. */
export function readConversation(reply: Record<string, unknown>, host: string): ConversationRecord | null {
  if (reply.conversation === null) return null;
  const record = parseConversation(reply.conversation);
  if (record === null) throw new Error(`${host} returned a malformed conversation`);
  return record;
}
