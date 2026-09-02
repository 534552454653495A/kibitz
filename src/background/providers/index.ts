/**
 * Provider factory: settings.provider → LlmProvider.
 *
 * A Record keyed by ProviderId rather than a switch so that adding a provider is one
 * import and one entry, and the compiler refuses a ProviderId without a constructor.
 */
import type { ProviderId, Settings } from "../../shared/settings";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAiCompatibleProvider } from "./openai-compatible";
import type { LlmProvider } from "./types";

const FACTORIES: Record<ProviderId, (settings: Settings) => LlmProvider> = {
  "openai-compatible": createOpenAiCompatibleProvider,
  anthropic: createAnthropicProvider,
};

export function createProvider(settings: Settings): LlmProvider {
  return FACTORIES[settings.provider](settings);
}

export { ProviderHttpError, ProviderStreamError, type LlmProvider } from "./types";
