/**
 * Provider abstraction: one interface every LLM backend implements.
 *
 * A provider is nothing more than "messages in, text deltas out". Everything else
 * (settings, permission checks, port plumbing, error-code mapping) lives in
 * background/index.ts, so a provider can be tested with a stubbed fetch and nothing
 * else. Errors are distinguished by class, not by string matching, because the
 * background maps each class to exactly one ChatErrorCode.
 */
import type { ChatMessage } from "../../core/messaging";

export interface LlmProvider {
  /** Yields text deltas in order; completes when the provider signals the end of the answer. */
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
}

/** Provider answered with a non-2xx status. The body excerpt is what the user sees. */
export class ProviderHttpError extends Error {
  override readonly name = "ProviderHttpError";
  readonly status: number;
  readonly bodyExcerpt: string;

  constructor(status: number, bodyExcerpt: string) {
    super(`HTTP ${status}: ${bodyExcerpt}`);
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

/** The HTTP exchange succeeded but the stream body was not what the protocol promises. */
export class ProviderStreamError extends Error {
  override readonly name = "ProviderStreamError";
}

/** Bytes of body an error message may carry: enough to read a JSON error, not a whole HTML page. */
export const BODY_EXCERPT_CHARS = 300;

export async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) return;
  // Read the body defensively: a failed read must not mask the status we already know.
  const body = await response.text().catch(() => "");
  throw new ProviderHttpError(response.status, body.slice(0, BODY_EXCERPT_CHARS));
}

export function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (response.body === null) throw new ProviderStreamError("response had no body");
  return response.body;
}

/** JSON.parse with the failure reported as a stream error: both providers need exactly this. */
export function parseStreamJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new ProviderStreamError(`unparsable stream event: ${data.slice(0, 120)}`);
  }
}
