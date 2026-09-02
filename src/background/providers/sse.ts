/**
 * Server-Sent Events parser over a byte stream. The single canonical SSE parser
 * (AGENTS.md section 5); both providers consume it.
 *
 * Written as a pull-based async generator over the raw body instead of piping through
 * TextDecoderStream + TransformStream because the failure modes we care about are all
 * chunk-boundary bugs: a chunk may end in the middle of a line, or between the `\r` and
 * `\n` of a CRLF terminator. Keeping one buffer and one cursor makes those cases
 * explicit — an unterminated line stays in the buffer, and a trailing `\r` is held back
 * until we know whether an `\n` follows. Comment lines (`:`) and unknown fields are
 * dropped per the spec; a final event without a closing blank line is still delivered,
 * because some servers close the socket right after the last `data:` line.
 */

export interface SseEvent {
  event?: string;
  data: string;
}

// The spec allows CRLF, LF and bare CR as line terminators; a global regex lets us scan
// from a cursor without slicing the buffer for every line.
const LINE_END = /\r\n|\r|\n/g;

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const takeEvent = (): SseEvent | null => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return null;
    }
    const event: SseEvent = eventName === undefined ? { data: dataLines.join("\n") } : { event: eventName, data: dataLines.join("\n") };
    eventName = undefined;
    dataLines = [];
    return event;
  };

  // Returns the completed event when `line` is the blank separator, null otherwise.
  const consumeLine = (line: string): SseEvent | null => {
    if (line.length === 0) return takeEvent();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "event") eventName = value;
    return null;
  };

  // Drains every complete line from the buffer. When `final` is false a trailing `\r`
  // is left in place: it may be the first half of a CRLF split across chunks, and
  // treating it as a bare CR would inject a phantom empty line (= a spurious dispatch).
  async function* drain(final: boolean): AsyncGenerator<SseEvent> {
    let cursor = 0;
    for (;;) {
      LINE_END.lastIndex = cursor;
      const match = LINE_END.exec(buffer);
      if (match === null) break;
      if (!final && match[0] === "\r" && match.index === buffer.length - 1) break;
      const event = consumeLine(buffer.slice(cursor, match.index));
      cursor = match.index + match[0].length;
      if (event !== null) yield event;
    }
    buffer = buffer.slice(cursor);
  }

  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* drain(false);
    }
    finished = true;
    buffer += decoder.decode();
    yield* drain(true);
    if (buffer.length > 0) consumeLine(buffer);
    const trailing = takeEvent();
    if (trailing !== null) yield trailing;
  } finally {
    // The consumer may stop early (abort, [DONE] before EOF); cancelling tells the
    // network layer to drop the connection instead of buffering the rest of the answer.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
