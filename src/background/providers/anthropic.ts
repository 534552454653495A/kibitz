/**
 * Anthropic Messages API provider.
 *
 * Differs from the OpenAI shape in two ways that this file absorbs so core/prompt.ts can
 * stay provider-agnostic: system prompts travel in a top-level `system` field rather than
 * as a message, and the `messages` array must strictly alternate user/assistant. Our
 * prompt builders may emit consecutive user turns (context block, then the question), so
 * same-role neighbours are merged with a blank line instead of being rejected by the API.
 * Merging carries images too: two user turns that become one turn must not lose the
 * pictures one of them was carrying.
 * Images go in `content` blocks *before* the text block, which is what Anthropic's own
 * guidance recommends for image-plus-question turns; a turn without images keeps the
 * plain-string content so the common case stays byte-identical to what it was.
 * The `anthropic-dangerous-direct-browser-access` header is what lets an extension call
 * the API without a proxy — the key stays on the user's machine, which is the whole
 * point of BYO keys (AGENTS.md 3.4).
 */
import type { ChatImage, ChatMessage } from "../../core/messaging";
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

interface AnthropicImageBlock {
  type: "image";
  /** URL source: we pass the link through rather than downloading and re-uploading bytes. */
  source: { type: "url"; url: string };
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicTurn {
  role: "user" | "assistant";
  content: string | Array<AnthropicImageBlock | AnthropicTextBlock>;
}

interface AnthropicBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicTurn[];
  stream: true;
}

/** A turn under construction: text and images stay apart until merging is done. */
interface MergedTurn {
  role: "user" | "assistant";
  text: string;
  images: ChatImage[];
}

export function toAnthropicBody(model: string, messages: ChatMessage[]): AnthropicBody {
  const system: string[] = [];
  const merged: MergedTurn[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    // Images belong to the user's own turn; an assistant turn never carries one.
    const images = message.role === "user" ? (message.images ?? []) : [];
    const last = merged[merged.length - 1];
    if (last !== undefined && last.role === message.role) {
      last.text = `${last.text}\n\n${message.content}`;
      last.images.push(...images);
    } else {
      merged.push({ role: message.role, text: message.content, images: [...images] });
    }
  }
  const turns = merged.map((turn): AnthropicTurn => {
    if (turn.images.length === 0) return { role: turn.role, content: turn.text };
    return {
      role: turn.role,
      content: [
        ...turn.images.map((image): AnthropicImageBlock => ({ type: "image", source: { type: "url", url: image.url } })),
        { type: "text", text: turn.text },
      ],
    };
  });
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
