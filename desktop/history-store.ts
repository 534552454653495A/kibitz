/**
 * Saved conversations on disk — the desktop counterpart of the extension's history keys in
 * chrome.storage.local.
 *
 * Layout, beside settings.json so an overridden settings path keeps the whole profile
 * together:
 *
 *   <config>/kibitz/history/index.json     one ConversationSummary per saved conversation
 *   <config>/kibitz/history/<id>.json      one ConversationRecord, transcript and all
 *
 * The index exists so listing stays one file read: retention is unlimited by the owner's
 * decision (2026-09-03), so a user will have thousands of records, and parsing every
 * transcript to draw a list would make the panel slower the longer they use it.
 *
 * This is the user's Discord content, so it gets the same treatment as the file holding the
 * API key: 0o700 directory, 0o600 files. Nothing here is secret to the provider, but it is
 * private to the user, and a world-readable transcript of someone's DMs is a leak whether or
 * not it contains a key.
 *
 * Writes are in place (`writeFile` over the existing path), exactly like settings-store.ts
 * and ui-state-store.ts: one scheme for the whole profile beats a second, cleverer one here.
 * The cost of that choice is that a crash mid-write can tear index.json, which is the only
 * pointer to an unlimited history — so a missing or unreadable index is not fatal: the list
 * is rebuilt by parsing the record files, which are still there. That rebuild is a recovery
 * path, never the normal one, and it does not write from a read.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  byRecency,
  type ConversationRecord,
  type ConversationSummary,
  parseConversation,
  parseSummary,
  type SaveHistoryResult,
  summarise,
} from "../src/core/history";
import { log } from "../src/shared/log";
import { settingsPath } from "./settings-store";

const DIR_NAME = "history";
const INDEX_NAME = "index.json";

/**
 * Ids are `<epoch ms>-<random>` (core/history.ts), but they reach this module from the
 * renderer, which shares Discord's realm. `path.join(dir, `${id}.json`)` would happily
 * follow `../../settings` out of the history directory, so an id that is not ours is not a
 * file name at all.
 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Beside the settings file, in a directory of its own so `clearConversations` can drop it whole. */
export function historyDir(settingsFile: string = settingsPath()): string {
  return path.join(path.dirname(settingsFile), DIR_NAME);
}

export function historyIndexPath(dir: string = historyDir()): string {
  return path.join(dir, INDEX_NAME);
}

function recordPath(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; tighten a pre-existing, wider file too.
  await fs.chmod(file, 0o600);
}

async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    log.warn(`${file} is not valid JSON; it is being ignored`);
    return undefined;
  }
}

/** The stored index, or null when there is none to read. Unparseable rows are dropped, never fatal. */
async function readIndex(dir: string): Promise<ConversationSummary[] | null> {
  const value = await readJson(historyIndexPath(dir));
  if (!Array.isArray(value)) return null;
  const summaries: ConversationSummary[] = [];
  for (const entry of value) {
    const summary = parseSummary(entry);
    if (summary !== null) summaries.push(summary);
  }
  // A non-empty index where nothing parsed is not a partly damaged index, it is an index we
  // did not write; treat it as absent so the records themselves can rebuild the list.
  if (summaries.length === 0 && value.length > 0) return null;
  return summaries;
}

/** Recovery only: the index is gone, so every record pays for the parse it normally avoids. */
async function scanRecords(dir: string): Promise<ConversationSummary[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const summaries: ConversationSummary[] = [];
  for (const name of names) {
    if (name === INDEX_NAME || !name.endsWith(".json")) continue;
    const record = parseConversation(await readJson(path.join(dir, name)));
    if (record !== null) summaries.push(summarise(record));
  }
  if (summaries.length > 0) log.warn(`rebuilt the Kibitz history list from ${summaries.length} record(s) in ${dir}`);
  return summaries;
}

async function summariesOf(dir: string): Promise<ConversationSummary[]> {
  const indexed = await readIndex(dir);
  return (indexed ?? (await scanRecords(dir))).sort(byRecency);
}

/**
 * Newest first, and never a rejection: a history the panel cannot list is a panel the user
 * cannot use, so an unreadable store degrades to whatever parsed.
 */
export async function listConversations(dir: string = historyDir()): Promise<ConversationSummary[]> {
  try {
    return await summariesOf(dir);
  } catch (err) {
    log.warn(`could not read the Kibitz history in ${dir}`, err);
    return [];
  }
}

/** Null for an id that was never saved, was deleted, or no longer parses as a conversation. */
export async function loadConversation(id: string, dir: string = historyDir()): Promise<ConversationRecord | null> {
  if (!SAFE_ID.test(id)) return null;
  return parseConversation(await readJson(recordPath(dir, id)));
}

/**
 * Saves or replaces the record with this id, then the index row derived from it. Never
 * prunes: unlimited retention means only the user's own delete removes anything.
 *
 * A failure comes back as `{ok:false,error}` rather than throwing, and the sentence names
 * the path, because the failure that matters (a full disk, a directory the user's account
 * cannot write) is something they can only fix if they know which file to look at.
 */
export async function saveConversation(record: ConversationRecord, dir: string = historyDir()): Promise<SaveHistoryResult> {
  if (!SAFE_ID.test(record.id)) {
    return { ok: false, error: `Could not save this conversation: "${record.id}" is not a usable conversation id.` };
  }
  const file = recordPath(dir, record.id);
  try {
    await writeJson(file, record);
  } catch (err) {
    return { ok: false, error: `Could not save this conversation to ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Record first, index second: an unlisted file is recoverable (scanRecords finds it),
  // while a listed file that was never written would be a row that opens onto nothing.
  try {
    const summaries = await summariesOf(dir);
    const next = [summarise(record), ...summaries.filter((s) => s.id !== record.id)].sort(byRecency);
    await writeJson(historyIndexPath(dir), next);
  } catch (err) {
    return {
      ok: false,
      error: `Saved the conversation, but could not update the history list at ${historyIndexPath(dir)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return { ok: true };
}

export async function deleteConversation(id: string, dir: string = historyDir()): Promise<void> {
  if (!SAFE_ID.test(id)) return;
  await fs.rm(recordPath(dir, id), { force: true });
  const summaries = await summariesOf(dir);
  const next = summaries.filter((s) => s.id !== id);
  // Only rewrite when the row was actually there; a delete of an unknown id touches nothing.
  if (next.length !== summaries.length) await writeJson(historyIndexPath(dir), next);
}

/**
 * Drops the history directory whole. It is a directory of its own precisely so this cannot
 * reach settings.json or ui-state.json, which live beside it: "clear my history" must never
 * cost the user their API key or their panel layout.
 */
export async function clearConversations(dir: string = historyDir()): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
