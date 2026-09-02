/**
 * Discord bridge — runs in the page's own JS realm (`world: "MAIN"` in the manifest).
 *
 * It exists because message content lives in React props (Discord's MessageRecord), which
 * an isolated-world content script cannot see (architecture decision 3.2). Everything
 * here is therefore page-visible and has NO chrome.* access on purpose: this file must
 * never import anything that reaches the extension API, and it never receives settings or
 * keys. It answers RPC over CustomEvents (page-rpc) with ids in, UniversalMessage JSON out.
 *
 * Fiber walk assumptions (see FIBER in selectors.ts): the <li>'s fiber is reachable via
 * React's own-property whose name starts with FIBER.keyPrefix; the component holding the
 * message prop is either an ancestor (per-message component renders the <li>) or a
 * descendant (the list mapper renders the <li>). Both walks are bounded so a broken
 * contract fails fast, never spins.
 */
import { ContractError, isRecord, isSnowflake } from "../../core/validate";
import { log } from "../../shared/log";
import { createRpcServer } from "../../shared/page-rpc";
import { DISCORD_RPC, type DiscordBridgeMethods, type ReadMessagesResult } from "./bridge-protocol";
import { normalizeMessage, type NormalizeContext } from "./normalize";
import {
  FIBER,
  messageItemId,
  parseChannelPath,
  type RawDiscordChannel,
  type RawDiscordMessage,
} from "./selectors";

declare global {
  interface Window {
    /** Set once per page so a second injection (extension reload, SPA re-run) is a no-op. */
    __kibitzDiscordBridge?: true;
  }
}

/** The subset of a React fiber node we navigate. Everything else is opaque. */
interface FiberNode {
  return?: FiberNode | null;
  child?: FiberNode | null;
  sibling?: FiberNode | null;
  memoizedProps?: unknown;
}

const REPLY_EXCERPT_CHARS = 160;

interface FiberRead {
  message: RawDiscordMessage;
  channel: RawDiscordChannel | null;
}

function propOf(fiber: FiberNode, prop: string): unknown {
  return isRecord(fiber.memoizedProps) ? fiber.memoizedProps[prop] : undefined;
}

function holdsMessage(fiber: FiberNode, messageId: string): boolean {
  const message = propOf(fiber, FIBER.messageProp);
  return isRecord(message) && message.id === messageId;
}

function findMessageFiber(root: FiberNode, messageId: string): FiberNode | null {
  let up: FiberNode | null | undefined = root;
  for (let i = 0; up && i < FIBER.ancestorLimit; i++) {
    if (holdsMessage(up, messageId)) return up;
    up = up.return;
  }
  // Breadth-first so a shallow match is found before the limit is spent deep in one branch.
  const queue: FiberNode[] = root.child ? [root.child] : [];
  for (let visited = 0; queue.length > 0 && visited < FIBER.descendantLimit; visited++) {
    const node = queue.shift()!;
    if (holdsMessage(node, messageId)) return node;
    if (node.sibling) queue.push(node.sibling);
    if (node.child) queue.push(node.child);
  }
  return null;
}

function findChannel(from: FiberNode): RawDiscordChannel | null {
  let node: FiberNode | null | undefined = from;
  for (let i = 0; node && i < FIBER.ancestorLimit; i++) {
    const channel = propOf(node, FIBER.channelProp);
    if (isRecord(channel)) return channel as RawDiscordChannel;
    node = node.return;
  }
  return null;
}

export function readFiberMessage(li: Element, messageId: string): FiberRead {
  const key = Object.keys(li).find((k) => k.startsWith(FIBER.keyPrefix));
  if (!key) throw new ContractError("fiber.key", `no "${FIBER.keyPrefix}*" property on #${li.id}`);
  const root = (li as unknown as Record<string, unknown>)[key];
  if (!isRecord(root)) throw new ContractError("fiber.key", `"${key}" is not a fiber node`);
  const fiber = findMessageFiber(root as FiberNode, messageId);
  if (!fiber) {
    throw new ContractError(
      "fiber.message",
      `no fiber within ${FIBER.ancestorLimit} ancestors / ${FIBER.descendantLimit} descendants has props.${FIBER.messageProp}.id === ${messageId}`,
    );
  }
  return { message: propOf(fiber, FIBER.messageProp) as RawDiscordMessage, channel: findChannel(fiber) };
}

function readItem(channelId: string, messageId: string): FiberRead {
  const li = document.getElementById(messageItemId(channelId, messageId));
  if (!li) throw new ContractError("dom.item", `#${messageItemId(channelId, messageId)} not in DOM (virtualised out?)`);
  return readFiberMessage(li, messageId);
}

function contextFor(channelId: string, channel: RawDiscordChannel | null): NormalizeContext {
  return {
    channel,
    host: location.host,
    guildId: parseChannelPath(location.pathname)?.guildId ?? null,
    resolveReply(refId) {
      // Replies point at messages in the same channel; if that <li> is still rendered we
      // can enrich the reply cheaply, otherwise the id alone is all the LLM gets.
      try {
        const { message } = readItem(channelId, refId);
        const author = message.author;
        const authorName = author?.globalName ?? author?.username;
        return {
          ...(authorName !== undefined ? { authorName } : {}),
          ...(typeof message.content === "string" ? { excerpt: message.content.slice(0, REPLY_EXCERPT_CHARS) } : {}),
        };
      } catch {
        return null;
      }
    },
  };
}

function readOne(channelId: string, messageId: string) {
  const { message, channel } = readItem(channelId, messageId);
  return normalizeMessage(message, contextFor(channelId, channel));
}

function start(): void {
  if (window.__kibitzDiscordBridge) return;
  window.__kibitzDiscordBridge = true;

  createRpcServer<DiscordBridgeMethods>(DISCORD_RPC, {
    ping: () => ({ version: __KIBITZ_VERSION__ }),
    readMessage: ({ channelId, messageId }) => {
      if (!isSnowflake(channelId)) throw new ContractError("params.channelId", `not a snowflake: ${channelId}`);
      if (!isSnowflake(messageId)) throw new ContractError("params.messageId", `not a snowflake: ${messageId}`);
      return readOne(channelId, messageId);
    },
    readMessages: ({ channelId, messageIds }) => {
      if (!isSnowflake(channelId)) throw new ContractError("params.channelId", `not a snowflake: ${channelId}`);
      const result: ReadMessagesResult = { messages: [], missing: [] };
      for (const messageId of messageIds) {
        try {
          result.messages.push(readOne(channelId, messageId));
        } catch (err) {
          // A bulk scan must survive one virtualised-out or odd message; but a normaliser
          // contract failure is drift worth a console line, not silent loss.
          result.missing.push(messageId);
          if (err instanceof ContractError && err.path.startsWith("raw.")) log.warn("readMessages skipped", messageId, err.message);
        }
      }
      return result;
    },
  });
  log.debug("discord bridge ready", __KIBITZ_VERSION__);
}

start();
