/**
 * OpenAI-compatible chat completions provider (OpenAI, OpenRouter, Groq, Ollama, LM Studio…).
 *
 * The wire format is the de-facto standard, so this one client covers most servers the
 * user could point us at. It is deliberately lenient about the stream's ending: the
 * `data: [DONE]` sentinel is documented by OpenAI but several compatible servers just
 * close the connection after the last chunk. Failing a fully received answer because a
 * sentinel was missing would punish the user for a server quirk, so EOF after any data
 * counts as completion; EOF with no data at all is still a protocol error.
 *
 * Multimodal turns: `content` becomes an array of parts only when a user turn actually
 * carries images. Text-only requests keep the plain-string form because several
 * "compatible" servers (older llama.cpp/LM Studio builds) only implement that one, and
 * churning the wire format for every request would break them for no gain.
 */
import type { ChatMessage, ChatRole } from "../../core/messaging";
import { isRecord } from "../../core/validate";
import { parseSse } from "./sse";
import { parseStreamJson, ProviderStreamError, requireBody, throwIfNotOk, type LlmProvider } from "./types";

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const DONE_SENTINEL = "[DONE]";

function deltaText(payload: string): string | null {
  const parsed = parseStreamJson(payload);
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return null;
  const first: unknown = parsed.choices[0];
  if (!isRecord(first) || !isRecord(first.delta)) return null;
  const content = first.delta.content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

interface OpenAiImagePart {
  type: "image_url";
  /** `detail` is optional and omitted: letting the server pick avoids paying for tiles nobody asked for. */
  image_url: { url: string };
}

interface OpenAiTurn {
  role: ChatRole;
  content: string | Array<OpenAiImagePart | { type: "text"; text: string }>;
}

function toOpenAiTurns(messages: ChatMessage[]): OpenAiTurn[] {
  return messages.map((message) => {
    // Images belong to the user's own turn; a system or assistant turn never carries one.
    const images = message.role === "user" ? message.images : undefined;
    if (images === undefined || images.length === 0) return { role: message.role, content: message.content };
    return {
      role: message.role,
      content: [
        ...images.map((image): OpenAiImagePart => ({ type: "image_url", image_url: { url: image.url } })),
        { type: "text" as const, text: message.content },
      ],
    };
  });
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): LlmProvider {
  // Users paste base URLs with and without a trailing slash; both must produce one "/".
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    async *stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string> {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ model: options.model, messages: toOpenAiTurns(messages), stream: true }),
        signal,
      });
      await throwIfNotOk(response);

      let received = false;
      for await (const event of parseSse(requireBody(response))) {
        if (event.data === DONE_SENTINEL) return;
        received = true;
        const text = deltaText(event.data);
        if (text !== null) yield text;
      }
      if (!received) throw new ProviderStreamError("stream ended before any data");
    },
  };
}
