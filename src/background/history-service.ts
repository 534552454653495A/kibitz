/**
 * The service worker's conversation-history storage, split out of index.ts for the same
 * reason settings-service.ts is: the message handler there stays a router and this stays
 * testable against a fake chrome.storage.
 *
 * Layout: one key per conversation (`kibitz.conv.<id>`) plus a single index of summaries
 * (`kibitz.conv.index`). Listing must stay cheap when a user has kept a thousand
 * conversations — which they will, because retention is unlimited by the owner's decision
 * (2026-09-03) and only their own delete removes anything — and reading one index is one
 * storage hit instead of parsing every transcript. The companion keeps the same shape in
 * files, so both hosts answer the same protocol (core/messaging.ts).
 *
 * Nothing here prunes. The only failure that gets to be loud is a store that will not take
 * the write: `saveConversation` reports it in a sentence the user can act on rather than
 * dropping the answer they just paid for. Everything a read cannot understand degrades —
 * a corrupt entry is skipped, not thrown, because a history list that will not open is a
 * worse outcome than a history list missing one row.
 */
import {
  type ConversationRecord,
  type ConversationSummary,
  type SaveHistoryResult,
  byRecency,
  parseConversation,
  parseSummary,
  summarise,
} from "../core/history";
import { ext } from "../shared/ext";
import { log } from "../shared/log";

/** Namespaced so a record key can never collide with `settings` or `uiState`. */
const RECORD_PREFIX = "kibitz.conv.";
const INDEX_KEY = "kibitz.conv.index";

function recordKey(id: string): string {
  return `${RECORD_PREFIX}${id}`;
}

/** Storage is untrusted input: an index written by an older build may be anything. */
async function readIndex(): Promise<ConversationSummary[]> {
  const stored = await ext.storage.local.get(INDEX_KEY);
  const value = stored[INDEX_KEY];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    log.warn("conversation index is not a list; starting a new one");
    return [];
  }
  return value.flatMap((entry) => {
    const summary = parseSummary(entry);
    if (summary === null) log.warn("skipping an unreadable conversation index entry");
    return summary === null ? [] : [summary];
  });
}

export async function listConversations(): Promise<ConversationSummary[]> {
  // Never rejects: the panel renders this list on open, so a storage read that throws would
  // cost the user their history *and* the view it lives in.
  try {
    return (await readIndex()).sort(byRecency);
  } catch (err: unknown) {
    log.warn("could not read the conversation index", err);
    return [];
  }
}

export async function loadConversation(id: string): Promise<ConversationRecord | null> {
  try {
    const key = recordKey(id);
    const stored = await ext.storage.local.get(key);
    return parseConversation(stored[key]);
  } catch (err: unknown) {
    log.warn(`could not read conversation ${id}`, err);
    return null;
  }
}

/**
 * The record and its index entry go out in ONE `set`: Chrome applies the items of a single
 * call together and rejects the whole call when the store refuses it, so a failed write can
 * never leave a listed conversation whose transcript is missing (or the reverse).
 *
 * Saving the same id replaces both — the panel saves the same conversation over and over as
 * it grows, so a second entry for it would be a duplicate row in the list, not a new one.
 */
export async function saveConversation(record: ConversationRecord): Promise<SaveHistoryResult> {
  const summary = summarise(record);
  let detail: string | null = null;
  try {
    const index = await readIndex();
    const next = [...index.filter((entry) => entry.id !== record.id), summary];
    await ext.storage.local.set({ [recordKey(record.id)]: record, [INDEX_KEY]: next });
    // Chrome's callback API reports a quota failure here instead of rejecting, the promise
    // API rejects. Both shapes exist in the wild, so both are read as the same failure.
    detail = ext.runtime.lastError?.message ?? null;
  } catch (err: unknown) {
    detail = err instanceof Error ? err.message : String(err);
  }
  if (detail === null) return { ok: true };
  log.warn("could not save a conversation", detail);
  // Retention is unlimited, so the only way out of a full store is the user's own delete —
  // the sentence has to say that. The detail is kept so a failure that is *not* quota (a
  // locked profile, a disabled storage backend) is still diagnosable from the panel.
  return {
    ok: false,
    error: `Kibitz could not save this conversation: ${detail}. Delete some conversations from the history list to free space, then try again.`,
  };
}

/**
 * Index row first, transcript second: if the second write never lands, the user is left
 * with an unreachable record (which `clearConversations` still sweeps by prefix) instead of
 * a listed conversation that opens to nothing.
 */
export async function deleteConversation(id: string): Promise<void> {
  const index = await readIndex();
  await ext.storage.local.set({ [INDEX_KEY]: index.filter((entry) => entry.id !== id) });
  await ext.storage.local.remove(recordKey(id));
}

/**
 * Clears by key prefix rather than by what the index lists: an index that was corrupted or
 * partially written would otherwise strand records the user asked to be rid of, forever,
 * since nothing prunes. The index key shares the prefix, so it goes with them. Settings and
 * UI state survive because neither is namespaced under `kibitz.conv.`.
 */
export async function clearConversations(): Promise<void> {
  const all = await ext.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(RECORD_PREFIX));
  if (keys.length > 0) await ext.storage.local.remove(keys);
}
