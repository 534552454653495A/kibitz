/**
 * `kibitz-desktop setup`: the desktop's replacement for the extension's options page.
 *
 * A terminal wizard rather than a settings UI inside Discord, because the key must never
 * be typed into (or readable from) Discord's window: the renderer bundle runs in the same
 * realm as Discord's own code (AGENTS.md 3.4). Input is echoed — readline/promises has no
 * hidden-input mode and a hand-rolled one would be the second implementation of a thing
 * Node lacks on purpose; the prompt says so instead.
 */
import * as readline from "node:readline/promises";
import { classifyError } from "../src/background/providers/errors";
import { createProvider } from "../src/background/providers/index";
import {
  AUTO_LANGUAGE,
  LANGUAGE_PRESETS,
  normalizeLanguage,
  parseSettings,
  PROVIDER_IDS,
  PROVIDER_PRESETS,
  type ProviderId,
  type Settings,
} from "../src/core/settings";
import { loadFileSettings, saveFileSettings, settingsPath } from "./settings-store";

const CONNECTION_TEST_TIMEOUT_MS = 30_000;
/** Shown as the default when a key is already saved; a real key never looks like this. */
const KEEP_KEY = "(keep current)";

interface Prompter {
  /** Empty input falls back to `fallback`; a null fallback makes the field required. */
  ask(label: string, fallback: string | null): Promise<string>;
}

async function chooseProvider(prompter: Prompter, current: ProviderId | null): Promise<ProviderId> {
  console.log("Provider:");
  PROVIDER_IDS.forEach((id, i) => console.log(`  ${i + 1}. ${PROVIDER_PRESETS[id].label}`));
  const fallback = String((current === null ? 0 : PROVIDER_IDS.indexOf(current)) + 1);
  for (;;) {
    const answer = await prompter.ask("Choose", fallback);
    const picked = PROVIDER_IDS[Number(answer) - 1];
    if (picked !== undefined) return picked;
    console.log(`  enter a number between 1 and ${PROVIDER_IDS.length}`);
  }
}

/**
 * The answer language, asked as free text instead of a numbered menu: `language` takes any
 * label ("Türkçe", "Türkçe, samimi ton"), so a menu would turn the presets into a whitelist
 * the schema deliberately does not have. They are printed purely as spelling help.
 *
 * Enter keeps whatever is stored — `auto` when nothing is — for the same reason the key and
 * the image policy are carried forward below: someone re-running the wizard to change the
 * model must not find their language silently reset.
 */
async function chooseLanguage(prompter: Prompter, current: string | null): Promise<string> {
  console.log("Answer language:");
  console.log(`  "${AUTO_LANGUAGE}" answers in the language of the message being explained`);
  console.log(`  or any label, e.g. ${LANGUAGE_PRESETS.join(", ")}`);
  return normalizeLanguage(await prompter.ask("Language", current ?? AUTO_LANGUAGE));
}

async function connectionTest(settings: Settings): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTION_TEST_TIMEOUT_MS);
  process.stdout.write("Asking the model to reply with OK… ");
  try {
    let reply = "";
    for await (const text of createProvider(settings).stream([{ role: "user", content: "Reply with the single word OK." }], controller.signal)) {
      reply += text;
    }
    console.log(`reply: ${reply.trim()}`);
  } catch (err) {
    const mapped = classifyError(err, controller.signal.aborted);
    const detail = controller.signal.aborted ? `timed out after ${CONNECTION_TEST_TIMEOUT_MS / 1000}s` : mapped.message;
    console.log(`failed (${mapped.code}): ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function runSetup(file: string = settingsPath()): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompter: Prompter = {
    async ask(label, fallback) {
      const suffix = fallback === null ? "" : ` [${fallback}]`;
      for (;;) {
        const answer = (await rl.question(`${label}${suffix}: `)).trim();
        if (answer.length > 0) return answer;
        if (fallback !== null) return fallback;
        console.log("  required");
      }
    },
  };

  try {
    const existing = await loadFileSettings(file);
    console.log(`Kibitz desktop setup — settings file: ${file}${existing === null ? "" : " (already configured; Enter keeps a value)"}`);
    console.log("");

    const provider = await chooseProvider(prompter, existing?.provider ?? null);
    const preset = PROVIDER_PRESETS[provider];
    const keepPreset = existing !== null && existing.provider === provider;
    console.log(`  ${preset.hint}`);
    const baseUrl = await prompter.ask("Base URL", keepPreset ? existing.baseUrl : preset.baseUrl);
    // The key is never echoed back by us; the terminal echoes what is typed, hence the warning.
    console.log(existing === null ? "API key (typed visibly — clear your terminal afterwards)" : "API key (typed visibly; Enter keeps the saved key)");
    const typedKey = await prompter.ask("Key", existing === null ? null : KEEP_KEY);
    const model = await prompter.ask("Model", keepPreset ? existing.model : preset.model);
    const language = await chooseLanguage(prompter, existing?.language ?? null);

    const apiKey = typedKey === KEEP_KEY && existing !== null ? existing.apiKey : typedKey;
    // The wizard does not ask about images (it is a terminal, and the panel owns that
    // checkbox), so it must carry the stored choice forward instead of re-defaulting it to on.
    // `language` is asked above and already carries the stored value as its Enter default.
    const settings = parseSettings({ provider, baseUrl, apiKey, model, sendImages: existing?.sendImages, language });
    if (settings === null) {
      console.log("These values do not form a usable configuration (is the base URL an http(s) URL?). Nothing saved.");
      process.exitCode = 2;
      return;
    }
    await saveFileSettings(settings, file);
    console.log(`Saved ${file} (mode 600).`);

    const test = await prompter.ask("Test the connection now? (Y/n)", "Y");
    if (/^y/i.test(test)) await connectionTest(settings);
    console.log("Done. Start the companion with `npm run desktop`; reload Discord (Ctrl+R) if it is already attached.");
  } finally {
    rl.close();
  }
}
