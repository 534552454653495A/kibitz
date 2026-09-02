/**
 * The ordered selector-contract checks (AGENTS.md 4.2: every export of selectors.ts is
 * exercised here). Each later check depends on the earlier ones, so run.ts stops at the
 * first failure — a red `panel-opens` after a red `list-root` would only be noise.
 *
 * Every attribute and selector string is imported from src/shared/dom-markers.ts or
 * src/adapters/discord/selectors.ts. The probe never invents its own; if it needs a new
 * hook, the hook is added to those files first so the UI and the probe cannot drift apart.
 *
 * Functions passed to `page.evaluate` are serialised, so constants travel as arguments.
 */
import type { ElementHandle, Page } from "puppeteer";
import { setTimeout } from "node:timers/promises";
import {
  ACTION_ATTR,
  BUTTON_HOST_ATTR,
  PANEL_ERROR_ATTR,
  PANEL_HOST_ATTR,
  PANEL_MESSAGE_ATTR,
  PANEL_STATE_ATTR,
  SCAN_COUNT_ATTR,
  SCAN_STATE_ATTR,
} from "../src/shared/dom-markers";
import { MESSAGE_ITEM, MESSAGE_LIST, parseChannelPath, parseMessageItemId } from "../src/adapters/discord/selectors";
import { assertUniversalMessage, isSnowflake } from "../src/core/validate";
import type { UniversalMessage } from "../src/core/types";
import type { ReadMessagesResult } from "../src/adapters/discord/bridge-protocol";

export interface ProbeContext {
  page: Page;
  host: string;
  guildId: string;
  channelId: string;
  /** IIFE bundle of probe/page-helper.ts; re-evaluated if a hard reload wiped the page. */
  helperCode: string;
  /** Left by `button-clickable` for `panel-opens`. */
  clickedMessageId: string | null;
}

export interface ProbeCheck {
  id: string;
  description: string;
  /** Outer safety net; the inner waits are tighter and produce the useful error. */
  timeoutMs: number;
  /** Resolves with a human detail string; rejects (any Error) to fail the probe. */
  run(ctx: ProbeContext): Promise<string>;
}

/**
 * Thrown when the probe never reached a usable channel view — token rejected, login
 * challenge, unreadable channel. That is a *session* failure, not a *contract* failure: the
 * report classifies it (`failureKind: "session"`) so canary-probe files it under a different
 * label and the fix agent is never started on evidence that contains no message list.
 */
export class ProbeSessionError extends Error {
  override readonly name = "ProbeSessionError";
}

/** CDP round-trips are cheap, but tighter polling only speeds up a check by half a tick. */
const POLL_INTERVAL_MS = 500;

/**
 * Polls `probe` until it returns non-null. Used instead of `page.waitForFunction` so a
 * check can return structured state (and fail *early* on an "error" state) rather than a
 * bare boolean, and so every timeout message carries the last thing observed.
 */
async function until<T>(
  label: string,
  timeoutMs: number,
  probe: () => Promise<T | null>,
  lastSeen?: () => Promise<string>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) {
      const seen = lastSeen ? ` (last seen: ${await lastSeen()})` : "";
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${seen}`);
    }
    await setTimeout(POLL_INTERVAL_MS);
  }
}

/** Ids of the message <li>s currently in the DOM — never cached (virtualised list). */
function renderedItemIds(page: Page): Promise<string[]> {
  return page.evaluate((sel: string) => Array.from(document.querySelectorAll(sel), (el) => el.id), MESSAGE_ITEM);
}

/**
 * Text currently in Discord's own message box, or null when there is none (the fixture).
 * `[role="textbox"][data-slate-editor]` is public markup, not a class name; the leading BOM
 * Slate keeps in an empty editor is stripped so "empty" compares equal across reads.
 */
function discordDraft(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const box = document.querySelector('[role="textbox"][data-slate-editor="true"]');
    return box === null ? null : (box.textContent ?? "").replace(/\uFEFF/g, "");
  });
}

async function ensureHelper(ctx: ProbeContext): Promise<void> {
  const present = await ctx.page.evaluate(() => window.__kibitzProbe !== undefined);
  if (!present) await ctx.page.evaluate(`${ctx.helperCode}\nKibitzProbeHelper.installProbeHelper();`);
}

function panelAttr(page: Page, attr: string): Promise<string | null> {
  return page.evaluate(
    (hostAttr: string, a: string) => document.querySelector(`[${hostAttr}]`)?.getAttribute(a) ?? null,
    PANEL_HOST_ATTR,
    attr,
  );
}

const MIN_CREATED_AT = Date.parse("2015-01-01T00:00:00Z");

export const CHECKS: ProbeCheck[] = [
  {
    id: "list-root",
    description: "the message list root is found by MESSAGE_LIST",
    // Discord's boot on a cold CI runner (no cache, gateway handshake) routinely takes a minute.
    timeoutMs: 95_000,
    async run({ page, channelId }) {
      const found = await until(
        `MESSAGE_LIST (${MESSAGE_LIST})`,
        90_000,
        () =>
          page.evaluate(
            (sel: string) => ({ list: document.querySelector(sel) !== null, path: location.pathname }),
            MESSAGE_LIST,
          ).then((r) => {
            // Leaving the channel URL means the token was rejected or the channel is
            // unreadable; waiting the full 90s for a list that will never appear is pointless.
            if (parseChannelPath(r.path)?.channelId !== channelId) {
              throw new ProbeSessionError(`navigated away from the channel: now at ${r.path} (token rejected, login challenge, or channel unreadable)`);
            }
            return r.list ? r : null;
          }),
        () => page.evaluate(() => location.pathname),
      );
      return `found at ${found.path}`;
    },
  },
  {
    id: "message-items",
    description: "rendered message items match MESSAGE_ITEM and their ids parse to this channel",
    timeoutMs: 35_000,
    async run({ page, channelId }) {
      const ids = await until("≥1 MESSAGE_ITEM", 30_000, async () => {
        const found = await renderedItemIds(page);
        return found.length > 0 ? found : null;
      });
      for (const id of ids) {
        const parsed = parseMessageItemId(id);
        if (!parsed) throw new Error(`item id does not parse with MESSAGE_ITEM_ID: "${id}"`);
        if (parsed.channelId !== channelId) {
          throw new Error(`item "${id}" belongs to channel ${parsed.channelId}, expected ${channelId}`);
        }
      }
      return `${ids.length} items rendered; sample ${ids[ids.length - 1]}`;
    },
  },
  {
    id: "fiber-read",
    description: "the MAIN-world bridge answers ping/readMessage/readMessages with valid UniversalMessages",
    timeoutMs: 40_000,
    async run(ctx) {
      const { page } = ctx;
      await ensureHelper(ctx);
      let lastError = "";
      const ping = await until(
        "bridge ping",
        10_000,
        () =>
          page
            .evaluate(() => {
              const h = window.__kibitzProbe;
              if (!h) throw new Error("probe helper missing");
              return h.rpc.call("ping", {}, 2000);
            })
            .catch((e: unknown) => {
              lastError = String(e);
              return null;
            }),
        async () => lastError,
      );

      const ids = await renderedItemIds(page);
      const lastId = ids[ids.length - 1];
      if (lastId === undefined) throw new Error("no message items rendered any more");
      const ref = parseMessageItemId(lastId);
      if (!ref) throw new Error(`item id does not parse: "${lastId}"`);

      const single: unknown = await page.evaluate(
        (channelId: string, messageId: string) => {
          const h = window.__kibitzProbe;
          if (!h) throw new Error("probe helper missing");
          return h.rpc.call("readMessage", { channelId, messageId });
        },
        ref.channelId,
        ref.messageId,
      );
      // ContractError.message is "<path>: <detail>" — the field name is what the fix agent needs.
      assertUniversalMessage(single);
      const m: UniversalMessage = single;
      if (!isSnowflake(m.id)) throw new Error(`id is not a snowflake: "${m.id}"`);
      if (!isSnowflake(m.author.id)) throw new Error(`author.id is not a snowflake: "${m.author.id}"`);
      if (m.author.name.trim() === "") throw new Error("author.name is empty");
      const created = Date.parse(m.createdAt);
      if (Number.isNaN(created) || created < MIN_CREATED_AT || created > Date.now() + 86_400_000) {
        throw new Error(`createdAt out of range: "${m.createdAt}"`);
      }

      const refs = ids.map(parseMessageItemId).filter((r): r is NonNullable<typeof r> => r !== null);
      const bulk: ReadMessagesResult = await page.evaluate(
        (channelId: string, messageIds: string[]) => {
          const h = window.__kibitzProbe;
          if (!h) throw new Error("probe helper missing");
          return h.rpc.call("readMessages", { channelId, messageIds });
        },
        ref.channelId,
        refs.map((r) => r.messageId),
      );
      if (bulk.missing.length > 0) {
        throw new Error(`readMessages missing ${bulk.missing.length}/${refs.length}: ${bulk.missing.slice(0, 5).join(", ")}`);
      }
      bulk.messages.forEach((msg, i) => assertUniversalMessage(msg, `messages[${i}]`));
      const withContent = bulk.messages.filter((msg) => msg.content.trim() !== "").length;
      if (withContent === 0) throw new Error(`none of ${bulk.messages.length} messages has content`);

      return `bridge v${ping.version}; readMessage ${m.id} by ${m.author.name} at ${m.createdAt}; readMessages ${bulk.messages.length}/${refs.length}, ${withContent} with content`;
    },
  },
  {
    id: "button-injected",
    description: "Kibitz buttons are injected into rendered items with a non-zero box",
    timeoutMs: 25_000,
    async run({ page }) {
      const state = () =>
        page.evaluate(
          (itemSel: string, hostAttr: string) => {
            const items = document.querySelectorAll(itemSel).length;
            const hosts = Array.from(document.querySelectorAll(`[${hostAttr}]`));
            const zero = hosts.filter((h) => {
              const r = h.getBoundingClientRect();
              return r.width === 0 || r.height === 0;
            }).length;
            return { items, hosts: hosts.length, zero };
          },
          MESSAGE_ITEM,
          BUTTON_HOST_ATTR,
        );
      const ok = await until(
        `≥min(3, items) [${BUTTON_HOST_ATTR}] hosts with non-zero boxes`,
        20_000,
        async () => {
          const s = await state();
          return s.items > 0 && s.hosts >= Math.min(3, s.items) && s.zero === 0 ? s : null;
        },
        async () => JSON.stringify(await state()),
      );
      return `${ok.hosts} buttons for ${ok.items} items`;
    },
  },
  {
    id: "button-clickable",
    description: "the last button host is unobstructed in the viewport and accepts a click",
    timeoutMs: 15_000,
    async run(ctx) {
      const { page } = ctx;
      const target = await page.evaluate((hostAttr: string) => {
        const hosts = document.querySelectorAll(`[${hostAttr}]`);
        const host = hosts[hosts.length - 1];
        if (!host) return { error: "no button host in DOM" };
        host.scrollIntoView({ block: "center" });
        const r = host.getBoundingClientRect();
        const inViewport = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
        if (!inViewport) return { error: `host outside viewport after scrollIntoView: ${JSON.stringify(r)}` };
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || !(hit === host || host.contains(hit))) {
          const desc = hit ? `${hit.tagName.toLowerCase()}#${hit.id}` : "nothing";
          return { error: `button host is covered by ${desc}` };
        }
        return { messageId: host.getAttribute(hostAttr) ?? "" };
      }, BUTTON_HOST_ATTR);
      if ("error" in target) throw new Error(target.error);
      if (!target.messageId) throw new Error(`button host has an empty ${BUTTON_HOST_ATTR}`);

      const handle: ElementHandle | null = await page.$(`[${BUTTON_HOST_ATTR}="${target.messageId}"]`);
      if (!handle) throw new Error(`button host for ${target.messageId} vanished before click`);
      await handle.click();
      await handle.dispose();
      ctx.clickedMessageId = target.messageId;
      return `clicked button of ${target.messageId}`;
    },
  },
  {
    id: "panel-opens",
    description: "the panel reads the clicked message and reaches state ready",
    timeoutMs: 20_000,
    async run({ page, clickedMessageId }) {
      if (!clickedMessageId) throw new Error("button-clickable left no message id");
      const observe = () =>
        page.evaluate(
          (hostAttr: string, stateAttr: string, msgAttr: string, errAttr: string) => {
            const host = document.querySelector(`[${hostAttr}]`);
            return host
              ? { state: host.getAttribute(stateAttr), messageId: host.getAttribute(msgAttr), error: host.getAttribute(errAttr) }
              : null;
          },
          PANEL_HOST_ATTR,
          PANEL_STATE_ATTR,
          PANEL_MESSAGE_ATTR,
          PANEL_ERROR_ATTR,
        );
      const ready = await until(
        `[${PANEL_HOST_ATTR}] ${PANEL_STATE_ATTR}=ready for ${clickedMessageId}`,
        15_000,
        async () => {
          const s = await observe();
          if (!s) return null;
          if (s.state === "error") throw new Error(`panel state error: ${s.error ?? "(no detail)"}`);
          return s.state === "ready" && s.messageId === clickedMessageId ? s : null;
        },
        async () => JSON.stringify(await observe()),
      );
      return `panel ready for ${ready.messageId}`;
    },
  },
  {
    id: "panel-input",
    description: "keystrokes typed into a panel field stay in the panel (Discord does not steal them)",
    timeoutMs: 25_000,
    /**
     * The regression this defends shipped once: Shadow DOM retargets our events, Discord's
     * global key handling saw them as "typing outside an input", focused its own message box
     * and swallowed everything typed into Kibitz — a user's prompt could end up posted to the
     * channel. The settings view's base-URL field is used rather than the chat composer
     * because the composer only exists once a key is configured and the probe never
     * configures one.
     *
     * The leak assertion compares Discord's message box BEFORE and AFTER typing, and must
     * stay that way: that box holds a per-channel draft that survives reloads, so asserting
     * it is empty would fail forever on any probe channel that ever held one — filing
     * `auto:broken-selector` and sending the fix agent after a selector that never broke.
     * A delta still catches a real leak and is immune to whatever the channel already had.
     */
    async run({ page }) {
      const settingsTab: ElementHandle | null = await page.$(`[${PANEL_HOST_ATTR}] >>> [${ACTION_ATTR}="view-settings"]`);
      if (!settingsTab) throw new Error(`no [${ACTION_ATTR}="view-settings"] in the panel`);
      await settingsTab.click();
      await settingsTab.dispose();

      const field: ElementHandle | null = await until(
        `[${PANEL_HOST_ATTR}] >>> input[type="url"]`,
        10_000,
        () => page.$(`[${PANEL_HOST_ATTR}] >>> input[type="url"]`),
      );
      // `null` on the fixture, which has no message box; a string (often "") on live Discord.
      const draftBefore = await discordDraft(page);
      await field.click();
      const probeText = "/kibitz-probe";
      await page.keyboard.type(probeText, { delay: 15 });
      const ours = await page.evaluate((hostAttr: string) => {
        const input = document.querySelector(`[${hostAttr}]`)?.shadowRoot?.querySelector('input[type="url"]');
        return input instanceof HTMLInputElement ? input.value : null;
      }, PANEL_HOST_ATTR);
      const draftAfter = await discordDraft(page);
      await field.dispose();

      if (ours === null || !ours.endsWith(probeText)) {
        throw new Error(`typing did not reach the panel field: value=${JSON.stringify(ours)} discordDraft=${JSON.stringify(draftAfter)}`);
      }
      if (draftAfter !== draftBefore) {
        throw new Error(
          `keystrokes leaked into Discord's message box: draft went from ${JSON.stringify(draftBefore?.slice(0, 40))} to ${JSON.stringify(draftAfter?.slice(0, 40))}`,
        );
      }

      // Leave the panel on the chat view: scroll-back drives the chat toolbar.
      const chatTab: ElementHandle | null = await page.$(`[${PANEL_HOST_ATTR}] >>> [${ACTION_ATTR}="view-chat"]`);
      if (!chatTab) throw new Error(`no [${ACTION_ATTR}="view-chat"] to return to`);
      await chatTab.click();
      await chatTab.dispose();
      return `typed ${probeText.length} chars into the panel; Discord's draft ${draftBefore === null ? "absent (fixture)" : `unchanged (${draftBefore.length} chars)`}`;
    },
  },
  {
    id: "scroll-back",
    description: "scan related messages scrolls back and collects more than what was rendered",
    timeoutMs: 90_000,
    async run({ page }) {
      const initial = (await renderedItemIds(page)).length;
      const scan: ElementHandle | null = await page.$(`[${PANEL_HOST_ATTR}] >>> [${ACTION_ATTR}="scan"]`);
      if (!scan) throw new Error(`no [${ACTION_ATTR}="scan"] inside the panel's shadow root`);
      await scan.click();
      await scan.dispose();

      const observe = async () => ({
        state: await panelAttr(page, SCAN_STATE_ATTR),
        count: await panelAttr(page, SCAN_COUNT_ATTR),
      });
      const done = await until(
        `${SCAN_STATE_ATTR}=done`,
        75_000,
        async () => {
          const s = await observe();
          if (s.state === "error") {
            throw new Error(`scan state error after ${s.count ?? "?"} messages: ${(await panelAttr(page, PANEL_ERROR_ATTR)) ?? "(no detail)"}`);
          }
          return s.state === "done" ? s : null;
        },
        async () => JSON.stringify(await observe()),
      );
      const count = Number(done.count);
      if (!Number.isFinite(count) || count <= initial) {
        throw new Error(`scan collected ${done.count ?? "?"} messages but ${initial} were already rendered — no older history was loaded`);
      }
      return `collected ${count} messages (${initial} were rendered before the scan)`;
    },
  },
];
