/**
 * Discord implementation of PlatformAdapter — the isolated-world half of the adapter.
 *
 * DOM discovery (list root, items, button anchors) happens here through the selector
 * contract; message *content* is never read from the DOM but requested from the
 * MAIN-world bridge over RPC (decision 3.2). Two consequences shape this file:
 *   - the bridge may not be listening yet when the content script starts, so the first
 *     call is a bounded `ping` handshake with retries rather than a hopeful `readMessage`;
 *   - everything that comes back is JSON produced from undocumented internals, so it is
 *     re-validated with assertUniversalMessage before the core is allowed to see it.
 */
import type { ButtonAnchor, CollectOptions, CollectProgress, MessageElementRef, PlatformAdapter } from "../../core/adapter";
import type { MessageRef, UniversalMessage, UniversalThread } from "../../core/types";
import { ContractError, assertUniversalMessage } from "../../core/validate";
import { createRpcClient, RpcTimeoutError, type RpcClient } from "../../shared/page-rpc";
import { DISCORD_RPC, type DiscordBridgeMethods, type ReadMessagesResult } from "./bridge-protocol";
import { collectByScrollBack } from "./scroller";
import {
  HOSTS,
  MESSAGE_ARTICLE,
  MESSAGE_ITEM,
  MESSAGE_LIST,
  messageContentId,
  parseMessageItemId,
} from "./selectors";

/** document_start (bridge) precedes document_idle (us); the retry only covers reloads and races. */
const PING_ATTEMPTS = 5;
const PING_INTERVAL_MS = 400;

let client: RpcClient<DiscordBridgeMethods> | null = null;
let handshake: Promise<void> | null = null;

async function pingUntilAlive(rpc: RpcClient<DiscordBridgeMethods>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rpc.call("ping", {}, PING_INTERVAL_MS);
      return;
    } catch (err) {
      if (!(err instanceof RpcTimeoutError) || attempt >= PING_ATTEMPTS) throw err;
    }
  }
}

async function bridge(): Promise<RpcClient<DiscordBridgeMethods>> {
  client ??= createRpcClient<DiscordBridgeMethods>(DISCORD_RPC);
  // A failed handshake is forgotten so the next user click retries instead of being stuck.
  handshake ??= pingUntilAlive(client).catch((err: unknown) => {
    handshake = null;
    throw err;
  });
  await handshake;
  return client;
}

async function readMessages(channelId: string, messageIds: string[]): Promise<ReadMessagesResult> {
  const result = await (await bridge()).call("readMessages", { channelId, messageIds });
  result.messages.forEach((m, i) => assertUniversalMessage(m, `readMessages.messages[${i}]`));
  return result;
}

export const discordAdapter: PlatformAdapter = {
  platform: "discord",

  matches(location) {
    return (HOSTS as readonly string[]).includes(location.hostname);
  },

  findListRoot(doc) {
    return doc.querySelector(MESSAGE_LIST);
  },

  listMessageElements(root) {
    const refs: MessageElementRef[] = [];
    for (const element of root.querySelectorAll(MESSAGE_ITEM)) {
      const ids = parseMessageItemId(element.id);
      if (ids) refs.push({ platform: "discord", ...ids, element });
    }
    return refs;
  },

  buttonAnchor(ref) {
    const content = ref.element.querySelector(`#${CSS.escape(messageContentId(ref.messageId))}`);
    if (content) return { parent: content, placement: "inline" } satisfies ButtonAnchor;
    // Attachment-only / embed-only messages have no text body; fall back to the article
    // (or the item itself) and take a full line so the button is not lost inside media.
    const parent = ref.element.querySelector(MESSAGE_ARTICLE) ?? ref.element;
    return { parent, placement: "block" };
  },

  async readMessage(ref: MessageRef): Promise<UniversalMessage> {
    const message = await (await bridge()).call("readMessage", { channelId: ref.channelId, messageId: ref.messageId });
    assertUniversalMessage(message);
    return message;
  },

  async collectAround(ref: MessageRef, options: CollectOptions, onProgress?: (p: CollectProgress) => void): Promise<UniversalThread> {
    const listRoot = document.querySelector(MESSAGE_LIST);
    if (!listRoot) throw new ContractError("dom.list", `${MESSAGE_LIST} not in DOM`);
    return collectByScrollBack({
      listRoot,
      anchor: ref,
      read: (ids) => readMessages(ref.channelId, ids),
      ...options,
      onProgress,
    });
  },
};
