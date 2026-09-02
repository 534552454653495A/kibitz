/**
 * RPC surface between the isolated-world adapter and the MAIN-world bridge (bridge.main.ts).
 * Shared by three consumers: the bridge (server), the adapter (client) and the probe
 * (drives the server directly from page context to validate the fiber contract).
 *
 * Event names are namespaced so a page listener cannot collide by accident. Payloads are
 * plain ids: the bridge locates the <li> by `messageItemId(channelId, messageId)` itself,
 * so nothing DOM-shaped crosses the boundary.
 */
import type { UniversalMessage } from "../../core/types";
import type { RpcChannel } from "../../shared/page-rpc";

export const DISCORD_RPC: RpcChannel = {
  requestEvent: "kibitz:discord:request",
  responseEvent: "kibitz:discord:response",
};

export interface ReadMessageParams {
  channelId: string;
  messageId: string;
}

export interface ReadMessagesParams {
  channelId: string;
  messageIds: string[];
}

export interface ReadMessagesResult {
  messages: UniversalMessage[];
  /** Ids whose <li> was not in the DOM (virtualised out) or whose fiber had no message. */
  missing: string[];
}

/** A `type` (not `interface`) so it satisfies RpcMethodMap without an index signature. */
export type DiscordBridgeMethods = {
  /** Liveness + version handshake; the client retries this until the bridge answers. */
  ping: { params: Record<string, never>; result: { version: string } };
  readMessage: { params: ReadMessageParams; result: UniversalMessage };
  readMessages: { params: ReadMessagesParams; result: ReadMessagesResult };
};
