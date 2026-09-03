/**
 * Everything about the DevTools port before Puppeteer connects: picking a free port,
 * waiting for Electron to answer on it, and telling Discord's own windows from the rest.
 *
 * Polling `/json/version` (not the WebSocket) is the decision: it is the endpoint every
 * Chromium exposes on that port, it answers as soon as the browser process is up — before
 * any window exists — and a plain fetch needs no Puppeteer session to be torn down on
 * every failed attempt.
 */
import * as net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { HOSTS } from "../src/adapters/discord/selectors";
import { isRecord } from "../src/core/validate";

/** Discord's own updater already takes 6463–6472; 93xx is free on a stock machine. */
export const DEFAULT_PORT_RANGE = { start: 9300, end: 9399 } as const;
const POLL_INTERVAL_MS = 500;
/** One HTTP attempt; Electron either answers instantly or is not listening yet. */
const PROBE_TIMEOUT_MS = 2_000;

export interface CdpVersion {
  Browser: string;
  webSocketDebuggerUrl: string;
}

function canListen(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const server = net.createServer();
  server.once("error", () => resolve(false));
  server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  return promise;
}

export async function findFreePort(rangeStart = DEFAULT_PORT_RANGE.start, rangeEnd = DEFAULT_PORT_RANGE.end): Promise<number> {
  for (let port = rangeStart; port <= rangeEnd; port++) {
    if (await canListen(port)) return port;
  }
  throw new Error(`no free port in ${rangeStart}-${rangeEnd}; pass --port`);
}

/** One attempt: the version document when a DevTools server answers on the port, else null. */
export async function probeCdp(port: number): Promise<CdpVersion | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.Browser !== "string" || typeof body.webSocketDebuggerUrl !== "string") return null;
    return { Browser: body.Browser, webSocketDebuggerUrl: body.webSocketDebuggerUrl };
  } catch {
    return null;
  }
}

/**
 * The port a previous `start` gave Discord, if Discord is still up: a second `start`
 * without --port must re-attach to it rather than pick the next free port and then
 * complain that Discord is "running without the flag". Refused connections return at
 * once on loopback, so probing the whole range in parallel costs milliseconds.
 */
export async function findListeningCdp(rangeStart = DEFAULT_PORT_RANGE.start, rangeEnd = DEFAULT_PORT_RANGE.end): Promise<number | null> {
  const ports = Array.from({ length: rangeEnd - rangeStart + 1 }, (_, i) => rangeStart + i);
  const answers = await Promise.all(ports.map(probeCdp));
  const index = answers.findIndex((version) => version !== null);
  return index === -1 ? null : (ports[index] ?? null);
}

export async function waitForCdp(port: number, timeoutMs: number): Promise<CdpVersion> {
  const deadline = Date.now() + timeoutMs;
  do {
    const version = await probeCdp(port);
    if (version !== null) return version;
    await sleep(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  throw new Error(`nothing answered on http://127.0.0.1:${port}/json/version within ${Math.round(timeoutMs / 1000)}s`);
}

/** Discord's app windows load from the web hosts; the updater splash and DevTools do not. */
export function isDiscordUrl(url: string): boolean {
  try {
    return (HOSTS as readonly string[]).includes(new URL(url).hostname);
  } catch {
    return false;
  }
}
