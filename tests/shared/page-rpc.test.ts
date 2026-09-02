// @vitest-environment jsdom
// Cross-world RPC over CustomEvents: both halves share this jsdom `document`, which is
// exactly the situation in the page (MAIN world server, isolated world client).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContractError, isRecord } from "../../src/core/validate";
import { createRpcClient, createRpcServer, RpcError, RpcTimeoutError, type RpcChannel } from "../../src/shared/page-rpc";

type Methods = {
  echo: { params: { n: number }; result: { doubled: number } };
  fail: { params: Record<string, never>; result: never };
  failPlain: { params: Record<string, never>; result: never };
};

const channel: RpcChannel = { requestEvent: "test:req", responseEvent: "test:res" };
const TIMEOUT_MS = 200;

const disposers: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.useRealTimers();
});

function serve(): void {
  disposers.push(
    createRpcServer<Methods>(channel, {
      echo: ({ n }) => ({ doubled: n * 2 }),
      fail: () => {
        throw new ContractError("fiber.message", "not found");
      },
      failPlain: () => {
        throw new TypeError("boom");
      },
    }),
  );
}

function connect() {
  const client = createRpcClient<Methods>(channel, TIMEOUT_MS);
  disposers.push(() => client.dispose());
  return client;
}

/** Collects every event dispatched on `name` until the test ends. */
function capture(name: string): Event[] {
  const events: Event[] = [];
  const listen = (e: Event): void => {
    events.push(e);
  };
  document.addEventListener(name, listen);
  disposers.push(() => document.removeEventListener(name, listen));
  return events;
}

describe("page-rpc", () => {
  it("resolves a call with the handler's result", async () => {
    serve();
    await expect(connect().call("echo", { n: 21 })).resolves.toEqual({ doubled: 42 });
  });

  it("surfaces a handler ContractError as RpcError with the same name, message and path", async () => {
    serve();
    const err = await connect().call("fail", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ name: "ContractError", message: "fiber.message: not found", path: "fiber.message" });
  });

  it("leaves path undefined when the thrown error had none", async () => {
    serve();
    const err = await connect().call("failPlain", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ name: "TypeError", message: "boom", path: undefined });
  });

  it("rejects an unknown method instead of hanging", async () => {
    serve();
    // A client built for a newer method map than the server implements — the realistic
    // way an unknown method reaches the wire (extension updated, bridge not reloaded).
    const newer = createRpcClient<Methods & { nope: { params: Record<string, never>; result: never } }>(channel, TIMEOUT_MS);
    disposers.push(() => newer.dispose());
    const err = await newer.call("nope", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ name: "RpcMethodError" });
  });

  it("times out with RpcTimeoutError when no server is listening", async () => {
    const pending = connect().call("echo", { n: 1 });
    const settled = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(await settled).toBeInstanceOf(RpcTimeoutError);
  });

  it("rejects pending calls when the client is disposed", async () => {
    const client = createRpcClient<Methods>(channel, TIMEOUT_MS);
    const pending = client.call("echo", { n: 1 });
    client.dispose();
    await expect(pending).rejects.toMatchObject({ name: "RpcDisposed" });
  });

  it("ignores a response whose detail is not a JSON string", async () => {
    const requests = capture(channel.requestEvent);
    const pending = connect().call("echo", { n: 1 });
    const settled = pending.catch((e: unknown) => e);
    const detail: unknown = (requests[0] as CustomEvent<unknown>).detail;
    const envelope: unknown = typeof detail === "string" ? JSON.parse(detail) : null;
    if (!isRecord(envelope) || typeof envelope.id !== "string") throw new Error("request envelope was not a JSON string with an id");
    document.dispatchEvent(new CustomEvent(channel.responseEvent, { detail: { id: envelope.id, ok: true, result: { doubled: 2 } } }));
    // The object-detail response must be dropped, so the call falls through to its timeout.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(await settled).toBeInstanceOf(RpcTimeoutError);
  });

  it("ignores a request whose detail is not a JSON string", async () => {
    serve();
    const responses = capture(channel.responseEvent);
    document.dispatchEvent(new CustomEvent(channel.requestEvent, { detail: { id: "x", method: "echo", params: { n: 1 } } }));
    // A valid request afterwards proves the server is alive and would have answered.
    document.dispatchEvent(new CustomEvent(channel.requestEvent, { detail: JSON.stringify({ id: "y", method: "echo", params: { n: 1 } }) }));
    await vi.runAllTimersAsync();
    expect(responses.map((e) => JSON.parse((e as CustomEvent<string>).detail) as unknown)).toEqual([{ id: "y", ok: true, result: { doubled: 2 } }]);
  });
});
