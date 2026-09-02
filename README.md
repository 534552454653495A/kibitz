# Kibitz

> *kibitzer* (n.) — someone who looks over your shoulder and comments.

A Chrome extension that puts a small **✦** button next to every message on supported sites.
Click it and an in-page panel opens where an AI explains that message and answers your
follow-ups. "Scan related messages" collects the surrounding conversation and summarises it.

You bring your own API key. Nothing is proxied, nothing is collected, there is no server.
MIT licensed. Not affiliated with Discord or any AI vendor.

**Supported now:** Discord web (`discord.com`, `canary.discord.com`, `ptb.discord.com`).
**Next:** YouTube, then Instagram/Facebook. X/Twitter is not planned (Grok already lives there).

---

## ⚠️ Read this before installing

**Discord's Terms of Service prohibit client modifications.** Kibitz injects code into the
Discord web app. Discord has historically not banned users for read-only UI extensions,
but that is Discord's choice, not a guarantee. By installing Kibitz you accept that risk
knowingly. Do not use it on an account you cannot afford to lose.

**Your messages go to your AI provider.** When you click ✦, the message (and, if you scan,
the surrounding messages) is sent from your browser to the API you configured — OpenAI,
Anthropic, OpenRouter, a local Ollama, whatever you chose. Nothing is sent anywhere else.
Read your provider's data policy.

**Your API key is your money.** It is stored in `chrome.storage.local` on this machine only
(never `storage.sync`, so it is never uploaded to your Google account) and is used only by
the extension's background worker. Content scripts running inside Discord never see it.

---

## Install (from source — there is no store listing)

Requirements: Node 22+, Chrome 120+.

```bash
git clone https://github.com/<you>/kibitz
cd kibitz
npm ci
npm run build          # → dist/
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select the `dist/` folder.

`npm run dev` rebuilds on change (reload the extension in `chrome://extensions` afterwards).

### Firefox

Not in the MVP. Firefox 128+ supports everything Kibitz needs (`world: "MAIN"` content
scripts, MV3) but requires `background.scripts` instead of `service_worker` and a
`browser_specific_settings.gecko` block. Contributions welcome; the seam is
`src/shared/ext.ts` and `manifest.jsonc`.

---

## Configure your key (BYO key)

Click the Kibitz toolbar icon (or open the extension's options page) and fill in:

| Field | Notes |
| --- | --- |
| **Provider** | `OpenAI-compatible` covers OpenAI, OpenRouter, Groq, Gemini's OpenAI endpoint, Ollama, LM Studio — anything with `POST {baseUrl}/chat/completions`. `Anthropic` talks to the Messages API directly. |
| **Base URL** | e.g. `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `http://localhost:11434/v1`, `https://api.anthropic.com` |
| **API key** | Stored locally only. For Ollama any non-empty string works. |
| **Model** | e.g. `gpt-4o-mini`, `claude-sonnet-4-5`, `llama3.1` |

When you press **Save**, Chrome asks you to grant the extension access to **that one origin**
(e.g. `https://api.openai.com`). Kibitz ships with zero host permissions; the grant is
scoped to the API you typed. Press **Test** to send a one-line request and confirm the
key, URL and model work together.

Local servers: Ollama needs `OLLAMA_ORIGINS=chrome-extension://*` (or `*`) so it accepts
requests from an extension origin.

---

## Use

1. Open any Discord channel. Every message gets a small ✦ at the end of its text.
2. Click ✦. The panel opens on the right and the AI explains the message.
3. Ask follow-ups in the input at the bottom.
4. **Scan related messages** scrolls back through the channel (up to 200 messages / 45 s),
   restores your scroll position, and asks the AI for a synthesis of the discussion around
   the anchored message.
5. `Esc` or ✕ closes the panel.

### Troubleshooting

- **No ✦ buttons?** Reload the Discord tab after installing or rebuilding — content scripts
  only inject on page load. Chrome must be 120+.
- **Debug logs:** open DevTools on the Discord tab, switch the console's context dropdown
  from `top` to the **Kibitz** entry (the extension's isolated world — the flag is per JS
  world, so setting it in `top` does nothing), then run `KIBITZ_DEBUG = true`. Lines are
  prefixed `[kibitz]`.
- **"no-permission" errors:** open the options page and press **Save** again to re-grant
  the API origin.

---

## How it works (one paragraph)

Two content scripts run on Discord. `discord-bridge.js` lives in the page's own JS world
(`world: "MAIN"`) and reads each message's structured data from React's in-memory props —
not from the DOM text, which loses emoji, mentions, code blocks and embeds. `content.js`
lives in the isolated world, watches Discord's virtualised message list with a
`MutationObserver`, injects the buttons and the Shadow-DOM panel, and talks to the bridge
over `CustomEvent`s carrying JSON strings. The service worker (`background.js`) is the only
component that holds the API key and the only one that makes HTTP calls. The core
(`src/core/`) sees a platform-neutral `UniversalMessage`; the Discord specifics are confined
to `src/adapters/discord/`, with every DOM/React assumption in a single file,
`selectors.ts`. See [AGENTS.md](AGENTS.md) for the reasons behind each of these choices.

---

## Self-repair pipeline (for maintainers)

Discord changes its UI often. Kibitz is built to notice before users do and to draft its own
fix:

```
canary-probe (every 6 h, Stable + Canary)  →  issue labelled auto:broken-selector
        →  ai-fix (Claude Code, edits only src/adapters + tests)  →  PR
        →  ai-review (separate agent, clean context)  →  probe reruns on the PR
        →  green: a human merges · red: another fix round, max 5, then needs-human
```

Agents never comment, never open issues, never merge, never release. The rules and their
reasons are in [AGENTS.md §7](AGENTS.md#7-self-repair-pipeline).

### Secrets to configure (Settings → Secrets and variables → Actions)

| Secret | What |
| --- | --- |
| `DISCORD_PROBE_TOKEN` | Token of a **throwaway** Discord account. Automated use violates Discord's ToS and the account may be terminated — never use a personal one. If Discord challenges the login from GitHub's IPs, the probe files an `auto:probe-session` issue (no agent runs); use a self-hosted runner on a residential IP or a fresh account. |
| `DISCORD_PROBE_CHANNEL` | `<guildId>/<channelId>` of a channel that account can read. |
| `ANTHROPIC_API_KEY` | For the fix/review agents (`claude -p`, budget-capped per run). |
| `AI_FIX_TOKEN` | Fine-grained PAT (or GitHub App token) with **Contents**, **Issues**, **Pull requests** read/write on this repo only. Needed because events created with the default `GITHUB_TOKEN` do not trigger other workflows. |

### The probe channel

Create a private server with the throwaway account and post, in one channel:

- at least **60 messages** (so the initial render does not contain the whole history and
  scroll-back is actually exercised),
- at least one **reply**, one **attachment**, one **embed** (paste a link), one **custom emoji** or mention.

Run it locally with `DISCORD_PROBE_TOKEN=… DISCORD_PROBE_CHANNEL=… npm run probe -- --branch canary`.
Output lands in `probe-out/<branch>/` (`probe-report.json`, and on failure `dom.html`,
`dom-outline.txt`, `screenshot.png`, `console.json`).

---

## Development

```bash
npm run check           # typecheck + unit tests + build
npm test                # vitest
npm run probe:selftest  # real extension + real probe checks against a Discord-shaped fixture page (no account)
npm run probe           # live contract test against Discord (needs the two DISCORD_* env vars)
```

`PROBE_ARTEFACTS=always npm run probe:selftest` also writes `probe-out/fixture/screenshot.png`
so you can eyeball the injected UI without a Discord account. The self-test checks that the
extension's parts agree with each other against a page *we* wrote to match `selectors.ts`;
only `npm run probe` (live, logged in) checks that Discord still matches it.

Layout, invariants, testing rules and the agent conduct rules: [AGENTS.md](AGENTS.md).

## License

MIT — see [LICENSE](LICENSE). The maintenance-pipeline *pattern* is inspired by Vencord's
reporter; Vencord is GPL-3.0 and no code from it is used here.
