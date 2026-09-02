/**
 * In-page helper the probe injects after Discord has booted. It exposes the REAL RPC
 * client from src/shared/page-rpc on `window.__kibitzProbe`, so the fiber checks exercise
 * exactly the code path the extension's adapter uses — a hand-written second client would
 * pass while the real one is broken (or vice versa) and tell us nothing.
 *
 * Bundled at runtime by probe/run.ts (esbuild, iife, globalName KibitzProbeHelper) and
 * evaluated in the page's main world, where the bridge server listens.
 */
import { createRpcClient, type RpcClient } from "../src/shared/page-rpc";
import { DISCORD_RPC, type DiscordBridgeMethods } from "../src/adapters/discord/bridge-protocol";

export interface ProbeHelper {
  rpc: RpcClient<DiscordBridgeMethods>;
}

declare global {
  interface Window {
    __kibitzProbe: ProbeHelper | undefined;
  }
}

/** 8s default: Discord on a cold CI runner answers slowly, and a timeout here is a red check, not a retry. */
const RPC_TIMEOUT_MS = 8000;

export function installProbeHelper(): void {
  window.__kibitzProbe = { rpc: createRpcClient<DiscordBridgeMethods>(DISCORD_RPC, RPC_TIMEOUT_MS) };
}
