/**
 * Anthropic Messages API provider.
 *
 * Differs from the OpenAI shape in two ways that this file absorbs so core/prompt.ts can
 * stay provider-agnostic: system prompts travel in a top-level `system` field rather than
 * as a message, and the `messages` array must strictly alternate user/assistant. Our
 * prompt builders may emit consecutive user turns (context block, then the question), so
 * same-role neighbours are merged with a blank line instead of being rejected by the API.
 * The `anthropic-dangerous-direct-browser-access` header is what lets an extension call
 * the API without a proxy — the key stays on the user's machine, which is the whole
 * point of BYO keys (AGENTS.md 3.4).
 */
import type { ChatMessage } from "../../core/messaging";
import { isRecord } from "../../core/validate";
import { parseSse } from "./sse";
import { ProviderStreamError, parseStreamJson, requireBody, throwIfNotOk, type LlmProvider } from "./types";

export interface AnthropicOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const API_VERSION = "2023-06-01";
// Generous ceiling so a long "scan" synthesis is not cut off; the model stops on its own.
const MAX_TOKENS = 4096;

interface AnthropicTurn {
  role: "user" | "assistant";
  content: string;
}

interface AnthropicBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicTurn[];
  stream: true;
}

export function toAnthropicBody(model: string, messages: ChatMessage[]): AnthropicBody {
  const system: string[] = [];
  const turns: AnthropicTurn[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === message.role) {
      last.content = `${last.content}\n\n${message.content}`;
    } else {
      turns.push({ role: message.role, content: message.content });
    }
  }
  const body: AnthropicBody = { model, max_tokens: MAX_TOKENS, messages: turns, stream: true };
  if (system.length > 0) body.system = system.join("\n\n");
  return body;
}

function errorMessage(payload: unknown): string {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  return "provider reported an error";
}

export function createAnthropicProvider(options: AnthropicOptions): LlmProvider {
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  return {
    async *stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string> {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": API_VERSION,
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify(toAnthropicBody(options.model, messages)),
        signal,
      });
      await throwIfNotOk(response);

      for await (const event of parseSse(requireBody(response))) {
        // Anthropic mirrors the type inside the JSON; the SSE `event:` field is the
        // authoritative one, but fall back to the payload when a proxy strips it.
        const payload = parseStreamJson(event.data);
        const type = event.event ?? (isRecord(payload) && typeof payload.type === "string" ? payload.type : undefined);
        if (type === "message_stop") return;
        if (type === "error") throw new ProviderStreamError(errorMessage(payload));
        if (type !== "content_block_delta" || !isRecord(payload) || !isRecord(payload.delta)) continue;
        if (payload.delta.type === "text_delta" && typeof payload.delta.text === "string" && payload.delta.text.length > 0) {
          yield payload.delta.text;
        }
      }
      throw new ProviderStreamError("stream ended without message_stop");
    },
  };
}
