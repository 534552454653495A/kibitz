/**
 * OpenAI-compatible chat completions provider (OpenAI, OpenRouter, Groq, Ollama, LM Studio…).
 *
 * The wire format is the de-facto standard, so this one client covers most servers the
 * user could point us at. It is deliberately lenient about the stream's ending: the
 * `data: [DONE]` sentinel is documented by OpenAI but several compatible servers just
 * close the connection after the last chunk. Failing a fully received answer because a
 * sentinel was missing would punish the user for a server quirk, so EOF after any data
 * counts as completion; EOF with no data at all is still a protocol error.
 */
import type { ChatMessage } from "../../core/messaging";
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
        body: JSON.stringify({ model: options.model, messages, stream: true }),
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
