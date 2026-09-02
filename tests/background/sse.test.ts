import { describe, expect, it } from "vitest";
import { parseSse, type SseEvent } from "../../src/background/providers/sse";

// Feeds the given string chunks as separate reads, so a chunk boundary lands exactly
// where the test puts it — that is where SSE parsers break in the wild.
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseSse(body)) events.push(event);
  return events;
}

describe("parseSse", () => {
  it("reassembles an event whose data line is split across two chunks", async () => {
    const events = await collect(streamOf('data: {"a":', '1}\n\ndata: second\n\n'));
    expect(events).toEqual([{ data: '{"a":1}' }, { data: "second" }]);
  });

  it("joins multi-line data fields with a newline", async () => {
    const events = await collect(streamOf("data: line one\ndata: line two\n\n"));
    expect(events).toEqual([{ data: "line one\nline two" }]);
  });

  it("parses a CRLF stream into the same events as an LF stream", async () => {
    const lf = await collect(streamOf("event: ping\ndata: x\n\ndata: y\n\n"));
    const crlf = await collect(streamOf("event: ping\r\ndata: x\r\n\r\ndata: y\r\n\r\n"));
    expect(crlf).toEqual(lf);
    expect(crlf).toHaveLength(2);
  });

  it("does not emit a phantom event when a chunk ends between \\r and \\n", async () => {
    const events = await collect(streamOf("data: x\r", "\n\r", "\ndata: y\r\n\r\n"));
    expect(events).toEqual([{ data: "x" }, { data: "y" }]);
  });

  it("ignores comment lines and unknown fields", async () => {
    const events = await collect(streamOf(": keep-alive\nid: 7\nretry: 100\ndata: real\n\n: another\n\n"));
    expect(events).toEqual([{ data: "real" }]);
  });

  it("flushes a trailing event that has no closing blank line", async () => {
    const events = await collect(streamOf("data: first\n\ndata: last"));
    expect(events).toEqual([{ data: "first" }, { data: "last" }]);
  });

  it("propagates the event field and resets it for the next event", async () => {
    const events = await collect(streamOf("event: content_block_delta\ndata: a\n\ndata: b\n\n"));
    expect(events).toEqual([{ event: "content_block_delta", data: "a" }, { data: "b" }]);
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode("data: é\n\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 7));
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    });
    expect(await collect(body)).toEqual([{ data: "é" }]);
  });
});
