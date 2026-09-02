import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../src/background/providers/anthropic";
import { createOpenAiCompatibleProvider } from "../../src/background/providers/openai-compatible";
import { classifyError } from "../../src/background/providers/errors";
import { ProviderHttpError, ProviderStreamError } from "../../src/background/providers/types";

const OPTIONS = { baseUrl: "https://example.test/v1", apiKey: "secret", model: "m" };
// Anthropic's preset base URL is the bare origin; the client appends /v1/messages itself.
const ANTHROPIC = { ...OPTIONS, baseUrl: "https://example.test" };

function sseResponse(text: string, status = 200): Response {
  return new Response(new TextEncoder().encode(text), {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

interface Captured {
  url: string;
  init: RequestInit;
}

// Stubs fetch with one canned response and records what the provider sent.
function stubFetch(response: Response): Captured {
  const captured: Captured = { url: "", init: {} };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init ?? {};
      return response;
    }),
  );
  return captured;
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const text of iterable) out.push(text);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openai-compatible provider", () => {
  const chunk = (content: string | null): string => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

  it("yields deltas in order and stops at [DONE] without reading past it", async () => {
    stubFetch(sseResponse(`${chunk("Hel")}${chunk("lo")}${chunk(null)}data: [DONE]\n\n${chunk("ignored")}`));
    const provider = createOpenAiCompatibleProvider(OPTIONS);
    const deltas = await collect(provider.stream([{ role: "user", content: "hi" }], new AbortController().signal));
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("posts to {baseUrl}/chat/completions with a bearer token even when baseUrl has a trailing slash", async () => {
    const captured = stubFetch(sseResponse(`${chunk("x")}data: [DONE]\n\n`));
    const provider = createOpenAiCompatibleProvider({ ...OPTIONS, baseUrl: "https://example.test/v1/" });
    await collect(provider.stream([{ role: "user", content: "hi" }], new AbortController().signal));
    expect(captured.url).toBe("https://example.test/v1/chat/completions");
    expect(new Headers(captured.init.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(String(captured.init.body))).toMatchObject({ model: "m", stream: true });
  });

  it("throws ProviderHttpError with the status and body excerpt on a 401", async () => {
    stubFetch(sseResponse('{"error":{"message":"bad key"}}', 401));
    const provider = createOpenAiCompatibleProvider(OPTIONS);
    const error = await collect(provider.stream([], new AbortController().signal)).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).status).toBe(401);
    expect((error as ProviderHttpError).bodyExcerpt).toBe('{"error":{"message":"bad key"}}');
  });

  it("treats EOF after data as completion when the server omits [DONE]", async () => {
    stubFetch(sseResponse(`${chunk("a")}${chunk("b")}`));
    const provider = createOpenAiCompatibleProvider(OPTIONS);
    expect(await collect(provider.stream([], new AbortController().signal))).toEqual(["a", "b"]);
  });

  it("throws ProviderStreamError on a chunk that is not JSON", async () => {
    stubFetch(sseResponse("data: <html>oops</html>\n\n"));
    const provider = createOpenAiCompatibleProvider(OPTIONS);
    await expect(collect(provider.stream([], new AbortController().signal))).rejects.toBeInstanceOf(ProviderStreamError);
  });

  // The whole point of the feature: a picture must leave as an image part, not as a URL
  // buried in the prose, or the model answers "I cannot see the image".
  it("sends image_url parts before the text part when a user turn carries images", async () => {
    const captured = stubFetch(sseResponse(`${chunk("x")}data: [DONE]\n\n`));
    await collect(
      createOpenAiCompatibleProvider(OPTIONS).stream(
        [
          { role: "system", content: "S" },
          {
            role: "user",
            content: "explain",
            images: [{ url: "https://media/a.png", name: "a.png" }, { url: "https://media/b.png" }],
          },
        ],
        new AbortController().signal,
      ),
    );
    expect(JSON.parse(String(captured.init.body))).toEqual({
      model: "m",
      stream: true,
      messages: [
        { role: "system", content: "S" },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "https://media/a.png" } },
            { type: "image_url", image_url: { url: "https://media/b.png" } },
            { type: "text", text: "explain" },
          ],
        },
      ],
    });
  });

  it("keeps content a plain string without images, because some compatible servers reject the array form", async () => {
    const captured = stubFetch(sseResponse(`${chunk("x")}data: [DONE]\n\n`));
    await collect(
      createOpenAiCompatibleProvider(OPTIONS).stream(
        [
          { role: "system", content: "S" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "there", images: [{ url: "https://media/ignored.png" }] },
        ],
        new AbortController().signal,
      ),
    );
    expect(JSON.parse(String(captured.init.body)).messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "there" },
    ]);
  });
});

describe("anthropic provider", () => {
  const event = (type: string, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

  it("yields text_delta text and stops at message_stop", async () => {
    stubFetch(
      sseResponse(
        event("message_start", { message: {} }) +
          event("content_block_delta", { delta: { type: "text_delta", text: "Hel" } }) +
          event("content_block_delta", { delta: { type: "input_json_delta", partial_json: "{" } }) +
          event("content_block_delta", { delta: { type: "text_delta", text: "lo" } }) +
          event("message_stop", {}) +
          event("content_block_delta", { delta: { type: "text_delta", text: "late" } }),
      ),
    );
    const provider = createAnthropicProvider(ANTHROPIC);
    const deltas = await collect(provider.stream([{ role: "user", content: "hi" }], new AbortController().signal));
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("hoists system messages into `system` and merges consecutive same-role turns", async () => {
    const captured = stubFetch(sseResponse(event("message_stop", {})));
    const provider = createAnthropicProvider(ANTHROPIC);
    await collect(
      provider.stream(
        [
          { role: "system", content: "S1" },
          { role: "user", content: "context" },
          { role: "user", content: "question" },
          { role: "assistant", content: "answer" },
          { role: "system", content: "S2" },
          { role: "user", content: "follow-up" },
        ],
        new AbortController().signal,
      ),
    );
    expect(captured.url).toBe("https://example.test/v1/messages");
    const headers = new Headers(captured.init.headers);
    expect(headers.get("x-api-key")).toBe("secret");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(JSON.parse(String(captured.init.body))).toEqual({
      model: "m",
      max_tokens: 4096,
      stream: true,
      system: "S1\n\nS2",
      messages: [
        { role: "user", content: "context\n\nquestion" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "follow-up" },
      ],
    });
  });

  it("omits `system` entirely when there are no system messages", async () => {
    const captured = stubFetch(sseResponse(event("message_stop", {})));
    await collect(createAnthropicProvider(ANTHROPIC).stream([{ role: "user", content: "hi" }], new AbortController().signal));
    expect(JSON.parse(String(captured.init.body))).not.toHaveProperty("system");
  });

  it("puts image blocks before the text block, which is the order Anthropic recommends", async () => {
    const captured = stubFetch(sseResponse(event("message_stop", {})));
    await collect(
      createAnthropicProvider(ANTHROPIC).stream(
        [{ role: "user", content: "explain", images: [{ url: "https://media/a.png", name: "a.png" }] }],
        new AbortController().signal,
      ),
    );
    expect(JSON.parse(String(captured.init.body)).messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: "https://media/a.png" } },
          { type: "text", text: "explain" },
        ],
      },
    ]);
  });

  it("keeps both turns' images when two user turns are merged, instead of dropping the first turn's", async () => {
    const captured = stubFetch(sseResponse(event("message_stop", {})));
    await collect(
      createAnthropicProvider(ANTHROPIC).stream(
        [
          { role: "user", content: "context", images: [{ url: "https://media/a.png" }] },
          { role: "user", content: "question", images: [{ url: "https://media/b.png" }] },
          { role: "assistant", content: "answer", images: [{ url: "https://media/ignored.png" }] },
        ],
        new AbortController().signal,
      ),
    );
    expect(JSON.parse(String(captured.init.body)).messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: "https://media/a.png" } },
          { type: "image", source: { type: "url", url: "https://media/b.png" } },
          { type: "text", text: "context\n\nquestion" },
        ],
      },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("throws ProviderStreamError carrying the server's message on an error event", async () => {
    stubFetch(sseResponse(event("error", { error: { type: "overloaded_error", message: "Overloaded" } })));
    const provider = createAnthropicProvider(ANTHROPIC);
    const error = await collect(provider.stream([], new AbortController().signal)).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProviderStreamError);
    expect((error as Error).message).toBe("Overloaded");
  });

  it("throws ProviderStreamError when the stream ends without message_stop", async () => {
    stubFetch(sseResponse(event("content_block_delta", { delta: { type: "text_delta", text: "partial" } })));
    const provider = createAnthropicProvider(ANTHROPIC);
    await expect(collect(provider.stream([], new AbortController().signal))).rejects.toBeInstanceOf(ProviderStreamError);
  });
});

// The hint is the only way a user learns why a local text-only model started failing the
// moment a screenshot appeared in the channel.
describe("classifyError image hint", () => {
  it("tells the user about the Send images toggle when the body blames the image", () => {
    const out = classifyError(new ProviderHttpError(400, '{"error":{"message":"Invalid content type: image_url"}}'), false);
    expect(out.code).toBe("http");
    expect(out.message).toContain("Invalid content type: image_url");
    expect(out.message).toContain('"Send images"');
  });

  it("stays silent for an unrelated 400 so the advice keeps meaning something", () => {
    const out = classifyError(new ProviderHttpError(400, '{"error":{"message":"temperature must be <= 2"}}'), false);
    expect(out.code).toBe("http");
    expect(out.message).not.toContain("Send images");
  });

  it("does not hijack a cancelled request whose body happened to mention vision", () => {
    expect(classifyError(new ProviderHttpError(400, "vision not supported"), true).code).toBe("aborted");
  });

  it("distinguishes a provider that could not fetch the link from one that refuses images", () => {
    // Same status, opposite remedy: one means "your model has no vision", the other means
    // "your server could not reach Discord's CDN". Measured 2026-09-02: those links are
    // publicly fetchable, so this only happens on a server without internet or one that
    // never fetches URLs.
    const fetchFailure = classifyError(
      new ProviderHttpError(400, '{"error":{"message":"Error while downloading image from url"}}'),
      false,
    );
    expect(fetchFailure.message).toContain("could not fetch the image link");
    expect(fetchFailure.message).not.toContain("may not accept images");

    const refusal = classifyError(new ProviderHttpError(400, '{"error":{"message":"model does not support vision"}}'), false);
    expect(refusal.message).toContain("may not accept images");
    expect(refusal.message).not.toContain("could not fetch the image link");
  });
});
