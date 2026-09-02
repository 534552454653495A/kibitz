/**
 * Request/response RPC over DOM CustomEvents, between the MAIN world and the isolated
 * world of the same page. Both worlds share `document`, so events are the only channel
 * that needs no extension API (the MAIN world has none).
 *
 * `detail` is ALWAYS a JSON string, never an object. Objects created in one world are
 * foreign in the other (Chrome copies them; Firefox wraps them in Xrays and requires
 * `cloneInto`). A string has no identity to leak and behaves identically everywhere.
 *
 * The page itself can observe these events (MAIN world caveat). We only ever move data
 * the page already owns, so this is acceptable; never send settings or keys through here.
 */
import { isRecord } from "../core/validate";

export interface RpcChannel {
  requestEvent: string;
  responseEvent: string;
}

/** Method map shape: `{ name: { params: P; result: R } }`. */
export type RpcMethodMap = Record<string, { params: unknown; result: unknown }>;

export type RpcHandlers<M extends RpcMethodMap> = {
  [K in keyof M]: (params: M[K]["params"]) => M[K]["result"] | Promise<M[K]["result"]>;
};

interface RequestEnvelope {
  id: string;
  method: string;
  params: unknown;
}

type ResponseEnvelope =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { name: string; message: string; path?: string } };

export class RpcError extends Error {
  override readonly name: string;
  constructor(name: string, message: string, readonly path?: string) {
    super(message);
    this.name = name;
  }
}

export class RpcTimeoutError extends Error {
  override readonly name = "RpcTimeoutError";
}

function parseEnvelope(event: Event): unknown {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== "string") return null;
  try {
    return JSON.parse(detail);
  } catch {
    return null;
  }
}

/** Server side (runs in the MAIN world). Returns a disposer. */
export function createRpcServer<M extends RpcMethodMap>(channel: RpcChannel, handlers: RpcHandlers<M>): () => void {
  const onRequest = (event: Event): void => {
    const env = parseEnvelope(event);
    if (!isRecord(env) || typeof env.id !== "string" || typeof env.method !== "string") return;
    const request = env as unknown as RequestEnvelope;
    const respond = (response: ResponseEnvelope): void => {
      document.dispatchEvent(new CustomEvent(channel.responseEvent, { detail: JSON.stringify(response) }));
    };
    const handler = handlers[request.method as keyof M];
    if (!handler) {
      respond({ id: request.id, ok: false, error: { name: "RpcMethodError", message: `unknown method ${request.method}` } });
      return;
    }
    Promise.resolve()
      .then(() => handler(request.params as M[keyof M]["params"]))
      .then(
        (result) => respond({ id: request.id, ok: true, result }),
        (err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          const path = isRecord(err) && typeof err.path === "string" ? err.path : undefined;
          respond({ id: request.id, ok: false, error: { name: e.name, message: e.message, ...(path ? { path } : {}) } });
        },
      );
  };
  document.addEventListener(channel.requestEvent, onRequest);
  return () => document.removeEventListener(channel.requestEvent, onRequest);
}

export interface RpcClient<M extends RpcMethodMap> {
  call<K extends keyof M & string>(method: K, params: M[K]["params"], timeoutMs?: number): Promise<M[K]["result"]>;
  dispose(): void;
}

/** Client side (runs in the isolated world, or in the probe's page context). */
export function createRpcClient<M extends RpcMethodMap>(channel: RpcChannel, defaultTimeoutMs = 5000): RpcClient<M> {
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let seq = 0;

  const onResponse = (event: Event): void => {
    const env = parseEnvelope(event);
    if (!isRecord(env) || typeof env.id !== "string") return;
    const entry = pending.get(env.id);
    if (!entry) return;
    pending.delete(env.id);
    const response = env as unknown as ResponseEnvelope;
    if (response.ok) entry.resolve(response.result);
    else entry.reject(new RpcError(response.error.name, response.error.message, response.error.path));
  };
  document.addEventListener(channel.responseEvent, onResponse);

  return {
    call(method, params, timeoutMs = defaultTimeoutMs) {
      const id = `${Date.now().toString(36)}-${(seq++).toString(36)}`;
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new RpcTimeoutError(`${method} timed out after ${timeoutMs}ms (is the MAIN-world bridge loaded?)`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const envelope: RequestEnvelope = { id, method, params };
      document.dispatchEvent(new CustomEvent(channel.requestEvent, { detail: JSON.stringify(envelope) }));
      return promise as Promise<M[typeof method]["result"]>;
    },
    dispose() {
      document.removeEventListener(channel.responseEvent, onResponse);
      for (const entry of pending.values()) entry.reject(new RpcError("RpcDisposed", "client disposed"));
      pending.clear();
    },
  };
}
