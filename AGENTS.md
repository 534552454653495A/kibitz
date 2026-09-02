# AGENTS.md — the Kibitz constitution

This file is the project's institutional memory. It is read by humans and by the AI agents
that maintain the repo (locally and in `.github/workflows/ai-*.yml`). It is not a checklist;
it is a set of rules **with the reason each rule exists**, so that whoever reads it can apply
the reason to situations the rule never anticipated.

How this file grows: when a mistake happens a second time, it becomes a rule here, with the
date and what went wrong (see [Rule history](#12-rule-history)). A rule without a reason is
a bug in this file — fix it or delete it.

Precedence: this file > code comments > your prior habits. If code contradicts this file,
the code is wrong unless the file is amended in the same PR.

---

## 1. What Kibitz is

A browser extension (Chrome, MV3) that puts a small AI button next to every message on
supported sites. Clicking it opens an in-page side panel where an LLM explains that message
and answers follow-ups; "scan related messages" collects the surrounding conversation and
summarises it. Users bring their own API key. MIT licensed, no commercial goal.

MVP platform: Discord web (`discord.com`, `canary.discord.com`, `ptb.discord.com`).
Roadmap: YouTube, then Instagram/Facebook. X/Twitter is out of scope (Grok already exists there).

Terminology used throughout:

| Term | Meaning |
| --- | --- |
| **core** | `src/core/` — platform-agnostic types, prompt building, validation. Knows nothing about Discord. |
| **adapter** | `src/adapters/<platform>/` — everything that knows one site's DOM/internals. Emits `UniversalMessage`. |
| **bridge** | The MAIN-world script of an adapter (`bridge.main.ts`) that reads page internals and answers RPC from the isolated world. |
| **selector contract** | `src/adapters/discord/selectors.ts` — the complete list of assumptions about Discord's DOM and React props. |
| **probe** | `probe/` — Puppeteer script that verifies the selector contract against live Discord. The deterministic signal the fix agent depends on. |
| **fix agent / review agent** | Headless Claude Code runs in CI (`ai-fix.yml`, `ai-review.yml`). Separate, clean contexts. |

---

## 2. Map of the repo

```
manifest.jsonc          Commented source of truth; build strips comments → dist/manifest.json
scripts/build.ts        esbuild: 5 entry points → dist/ (content, discord-bridge, background, options,
                        desktop-renderer); fails if the desktop bundle references chrome.*
src/core/               types.ts (UniversalMessage), adapter.ts (PlatformAdapter), validate.ts,
                        messaging.ts (shell protocol), settings.ts (LLM settings schema), prompt.ts,
                        context.ts, prompts/*.md
src/adapters/discord/   selectors.ts, bridge-protocol.ts, bridge.main.ts, normalize.ts, adapter.ts, scroller.ts
src/shell/              types.ts (Shell), extension.ts (Port to the service worker),
                        desktop.ts + desktop-protocol.ts (CDP binding), replies.ts (reply validation)
src/content/            start.ts (boot shared by hosts), index.ts (extension entry), injector.ts
src/desktop/            renderer.ts (bundle injected into Discord desktop)
src/ui/                 shadow-host.ts (isolated hosts — 3.5), button/, options/ (extension page + grant),
                        panel/ (frame, registry, views/chat, views/settings, state, layout, markdown)
desktop/                kibitz-desktop companion (Node): cli.ts, companion.ts, inject.ts,
                        request-handler.ts, discord-launch.ts, settings-store.ts, setup.ts, cdp.ts
probe/                  run.ts (--fixture, --shell extension|desktop), checks.ts, report.ts, outline.ts,
                        page-helper.ts, discord-session.ts, fixtures/discord-like.html
tests/                  vitest; mirrors src/ layout (+ tests/scripts/*.test.sh run by ci.yml)
.github/workflows/      ci.yml, canary-probe.yml, ai-fix.yml, ai-review.yml
.github/ai/             prompts, output schemas and the path allowlist for the agents
```

---

## 3. Architecture invariants

These were decided by the project owner at founding (2026-09-02) and are not up for
re-litigation in a PR. Each carries its reason so you can extend it correctly.

### 3.1 No CSS class names — ever, anywhere

Bind only to semantic attributes: `id`, `data-*`, ARIA `role`, URL structure.
**Because:** Discord uses CSS Modules. Class names are hashed per build and change on every
deploy (multiple times a week). A selector containing a class name is a time bomb with a
fuse measured in days. This applies to tests and the probe too — the probe's job is to
detect drift, and a class-based probe would just detect itself dying.

The probe's failure artefact `dom-outline.txt` deliberately strips classes so the fix agent
cannot even see them. If you catch yourself wanting a class, find the nearest `id`/`data-*`/
`role` and bind to that; if none exists, bind to structure relative to one that does, and
document the reasoning in `selectors.ts`.

### 3.2 React fiber, not DOM scraping

Message content is read from React's in-memory props via the MAIN-world bridge, never from
`innerText`.
**Because:** DOM text loses structure: emoji become image alt text or nothing, mentions lose
their ids, code blocks lose fences, embeds and reply references are invisible. Discord's
`MessageRecord` has all of it. The bridge lives in `world: "MAIN"` (manifest) because
isolated-world content scripts cannot see page JS objects; it talks to the isolated world
via CustomEvent (`src/shared/page-rpc.ts`).

Consequences: the bridge has **no `chrome.*` access** and must never receive settings or
keys; the page can observe the bridge's events (we only move data the page already owns).

### 3.3 The list is virtualised

Message `<li>`s outside the viewport are removed from the DOM.
**Because:** Discord renders a windowed list. Therefore: never cache message elements;
re-query on every mutation batch; buttons are (re)injected by a `MutationObserver`; bulk
collection ("scan related") is done by programmatic scroll-back in `scroller.ts`, which must
restore the user's viewport when done and honour an `AbortSignal`.

### 3.4 API key security

Settings live in `chrome.storage.local` (never `sync`); all LLM HTTP calls happen in the
service worker; content scripts and the bridge never see the key.
**Because:** `storage.sync` uploads to the user's Google account; a BYO key is the user's
money. A content script shares a tab with a site we do not control — the key must not be
reachable from there. The service worker requests host permission for exactly the API
origin the user configured (`optional_host_permissions` + a one-button grant window), so the
extension has zero host access until a user grants one.

Amendment (2026-09-02, owner's request): settings are edited **inside the panel**, so the
key crosses into the UI layer. What that costs depends on the host, and `Shell.capabilities`
carries the answer: in the extension the panel runs in the isolated world, so the page
cannot read the field or our variables, and the key still travels content script → port →
service worker → `storage.local`, never into the page realm. On the desktop the renderer
*is* Discord's realm, so a key typed there is readable by Discord's own scripts;
`keyIsPageVisible` is true, the settings view says so, and `npm run desktop -- setup`
remains the safer path. A stored key is never sent back to the UI — `SettingsDraft` carries
`hasKey`, not the key.

### 3.5 All injected UI lives in an isolated Shadow DOM host

Buttons and the panel are created **only** through `createShadowHost`
(`src/ui/shadow-host.ts`), never with a bare `attachShadow`.
**Because** two things must be isolated, and only one of them is CSS:

- **Styles** — Discord's global CSS would restyle our UI, and ours would leak into Discord.
- **Events** — Shadow DOM *retargets* events: a keydown in our `<textarea>` reaches
  `document` with `target` = the host `<div>`. Discord's global key handling reads that as
  "the user is typing outside an input", focuses its own message box and takes the
  keystrokes. Measured on Discord Stable (2026-09-02): typing `abc` into our composer left
  it empty and put `abc` in Discord's message box — the chat was unusable from day one.
  `createShadowHost` therefore stops keyboard, clipboard and pointer events at the
  host in the **bubble** phase: our own handlers live inside the shadow tree and have
  already run, while `document` never sees the event. A capture-phase guard on `window`
  also blocks Discord but swallows our handlers too (measured: Enter inserted a newline
  instead of sending), which is why the guard is on the host and not on window.
  `wheel` is deliberately **not** in that list: scroll chaining is not propagation, so a
  wheel guard would not stop Discord's list from scrolling under a pane that hit its end —
  `overscroll-behavior: contain` in `panel.css` does that.

`mode: "open"` (not `closed`) so tests and the probe can drive the UI through
`host.shadowRoot`. The probe's `panel-input` check types into a panel field on live Discord
and fails if the text lands anywhere else — that is the regression guard.

Never serialise settings by hand. `redactSettings` (`src/core/settings.ts`) is the only
sanctioned way to put a configuration into a log, an error, a report or a diagnostic
script: it rebuilds the object instead of pattern-matching text, so no formatting can carry
the key through (see §12, 2026-09-02).

### 3.6 One file owns the Discord contract

`src/adapters/discord/selectors.ts` is the only place Discord DOM selectors, React prop
names, message-type numbers and content-markup regexes may appear.
**Because:** when Discord changes, the fix must be one file, one PR, one release. A selector
hidden in `injector.ts` is a selector nobody will find at 3 a.m.

### 3.7 The core is platform-agnostic

`src/core/` and `src/ui/` consume `UniversalMessage` and `PlatformAdapter` only.
**Because:** the second platform must be added without touching the core. If adding YouTube
requires editing `src/core/`, the abstraction leaked; fix the abstraction, do not special-case.
Lint by grep: `src/core/` must contain no `discord`, no `chrome.`, no `document.` outside
`page-rpc`-style generic DOM plumbing that lives in `src/shared/`.

### 3.8 The UI talks to its host through one seam

Everything the in-page UI needs from its runtime — streaming an answer, asking whether a
key is configured, opening settings — goes through `Shell` (`src/shell/types.ts`). Two hosts
implement it: the Chrome extension (`shell/extension.ts`: a Port to the service worker,
`chrome.storage`) and the Discord desktop companion (`shell/desktop.ts`: a CDP binding to a
Node process that holds the settings file and makes the HTTP calls).
**Because:** the same panel, injector and adapter must run inside Discord's Electron
window, where there is no extension API at all. Desktop support was added without
touching `src/core/`, `src/adapters/` or `src/ui/panel/state.ts` — that is the test of the
seam, and the build enforces it: `dist/desktop-renderer.js` must not reference `chrome.*`.

Consequences: `src/ui/` and `src/content/` never import `shared/ext.ts`; provider code and
error classification (`src/background/providers/`) are Node-safe because the companion
reuses them; the LLM settings schema lives in `src/core/settings.ts` so "configured" means
the same thing in `chrome.storage.local` and in `settings.json`.

Why CDP and not a Vencord-style patcher: a patcher rewrites files inside Discord's install
and dies on every Discord update; the companion changes nothing on disk and survives
updates, at the price of starting Discord with `--remote-debugging-port` and keeping a
process running. The cost that must stay documented: while Discord listens on that port,
any local process can drive it (including reading the session token). The port is bound to
127.0.0.1 and chosen from 9300–9399; there is no authentication in CDP.

---

## 4. The selector contract

1. **Every export in `selectors.ts` states why it is expected to be stable.** A selector
   without a rationale is a guess; the next person cannot tell whether it broke because
   Discord changed or because it was wrong from the start.
2. **Every export is exercised by the probe** (`probe/checks.ts`). Adding a selector without
   a probe check means the pipeline cannot tell you when it dies.
3. **Changing a selector**: update `selectors.ts` (with the new reasoning and the date),
   update `tests/adapters/discord/selectors.test.ts` if the parsing contract changed, run
   `npm run check`, then `npm run probe:selftest` (real extension + real checks against
   `probe/fixtures/discord-like.html`, no account), and — if you have a throwaway Discord
   account — `npm run probe` locally. Update the fixture when the contract changes shape;
   a fixture that still passes against an old contract is a self-test that tests nothing.
4. **The probe is the authority.** A comment in `selectors.ts` is a hypothesis; a green probe
   on Stable and Canary is the fact. Never "fix" a red probe by loosening the check.
5. **Our own UI obeys the same rule.** Tests and the probe find Kibitz elements through
   `src/shared/dom-markers.ts` (`data-kibitz-*` attributes), never through class names or text.

---

## 5. Reuse before writing

Before adding any helper, search for an existing one: `src/shared/`, `src/core/`, and the
module next to your call site. Two implementations of the same thing is a bug **even when
both work**: they drift, one gets a fix the other does not, and the next reader has to
work out which is canonical.

Known canonical homes:

| Need | Use |
| --- | --- |
| Object type guard | `isRecord` from `src/core/validate.ts` |
| Validate a message at a boundary | `assertUniversalMessage` (`src/core/validate.ts`) |
| Cross-world RPC | `createRpcServer` / `createRpcClient` (`src/shared/page-rpc.ts`) |
| Extension API | `ext` from `src/shared/ext.ts` (only inside `src/shell/extension.ts`, `src/shared/`, `src/background/`, `src/ui/options/`; never in `src/ui/panel`, `src/content`, `src/core`, `desktop/`) |
| Host runtime from the UI | `Shell` (`src/shell/types.ts`): `createExtensionShell()` / `createDesktopShell()` |
| Logging | `log` from `src/shared/log.ts` (prefix is what the probe filters on) |
| Settings schema / validation | `parseSettings`, `PROVIDER_PRESETS`, `originPattern` (`src/core/settings.ts`) |
| Panel draft + stored key → settings | `mergeSettingsInput` (`src/core/settings.ts`) — pure, Node-safe; used by `src/background/settings-service.ts` and `desktop/request-handler.ts` |
| Settings persistence | extension: `src/shared/settings.ts` (chrome.storage); desktop: `desktop/settings-store.ts` (settings.json) |
| LLM providers + error → ChatErrorCode | `createProvider` (`src/background/providers/index.ts`), `classifyError` (`providers/errors.ts`) — Node-safe, shared with the companion |
| Prompt text | `.md` files in `src/core/prompts/`, rendered by `src/core/prompt.ts` |
| SSE parsing | `src/background/providers/sse.ts` |
| Inject into a Discord window over CDP | `attachKibitz` / `deliver` (`desktop/inject.ts`) — the probe's desktop mode uses the same functions |
| Any injected UI element | `createShadowHost` (`src/ui/shadow-host.ts`) — never a bare `attachShadow`; it carries the event isolation (3.5) |
| A new panel feature | a `PanelView` (`src/ui/panel/views.ts`) registered in `src/ui/panel/registry.ts`; its buttons get an `ActionName` in `src/shared/dom-markers.ts` and a method on `PanelActions` (`src/ui/panel/actions.ts`) |
| Panel geometry | `src/ui/panel/layout.ts` (`clampLayout`, `layoutStyle`, `installLayoutController`) over `layout-model.ts` values; persisted through `Shell.loadUiState/saveUiState` |
| Rendering model output | `renderMarkdown` (`src/ui/panel/markdown.ts`) — builds Preact nodes; `innerHTML` is never used on model or message text |

Missing capability? Extend the canonical helper; do not fork it locally.

---

## 6. Testing constitution

The purpose of a test is to fail when a real consumer would be hurt. If you cannot say
**what a user or a calling module would observe** if the test went red, do not write it.

### 6.1 Banned outright

- **Source-text assertions.** Reading a source file and asserting on its text:
  `expect(src).toContain("data-list-id")`, `expect(readFileSync("selectors.ts"))…`, snapshotting
  a module's source. This tests how the code *looks*, not what it *does*; it goes green when
  the selector is present but wrong and red when someone renames a variable.
  **Because:** AI-generated tests reach for this pattern constantly — it is cheap to write and
  looks like coverage. It is worse than no test: it creates confidence without evidence.
  The `ai-review` agent is instructed to reject it on sight.
- **"It ran" tests.** `expect(true).toBe(true)`, bare `expect(fn).not.toThrow()`, non-empty
  string checks, `toBeDefined()` on a module export.
- **Echo tests.** Asserting that a constructor stored the value it was given, or that a
  passthrough returned its input.
- **Prompt wording tests.** Asserting that a prompt contains a phrase. Prompts are edited
  freely; test what the renderer does (placeholders substituted, unknown placeholder throws).
- **Tests that require a live network or a Discord session.** Those belong in `probe/`.

### 6.2 What a good test looks like here

- **Transformation:** `normalize(rawFiberMessage)` → exact `UniversalMessage` fields
  (mentions resolved, timestamp ISO, attachment kind from MIME).
- **Boundary / branch:** `parseMessageItemId("chat-messages-1-2")` parses; `"chat-messages-x"`
  returns null; `"message-content-1"` returns null.
- **Contract error path:** `assertUniversalMessage({...author missing})` throws a
  `ContractError` whose `.path === "message.author"` — the probe prints that path.
- **Protocol:** the SSE parser reassembles an event split across two chunks; `[DONE]` ends
  the stream; a CRLF stream parses like an LF stream.
- **Regression:** reproduce the reported failure, assert the corrected observable outcome,
  and name the incident in the test title.

Each `it(...)` title should read as the failure mode: `it("keeps // inside URL strings")`, not
`it("works")`.

### 6.3 Where and how

- `tests/` mirrors `src/`. Vitest, Node environment by default; DOM tests opt in with
  `// @vitest-environment jsdom` at the top of the file.
- No test may import from `dist/`.
- The probe is not a unit test and is not run by `npm test`. It is the integration signal.
  `npm run probe:selftest` (ci.yml) and `npm run probe:selftest:desktop` (same checks, same
  fixture, but plain Chrome + the companion's `attachKibitz` instead of the extension) are
  the account-free half of it and a **wiring**
  regression signal only: the fixture is written by us to satisfy `selectors.ts`, so every
  check passes by construction. A green self-test proves injector → RPC → bridge → adapter
  → panel → scroll-back agree with each other. It proves nothing about Discord: the two DOM
  selectors, `FIBER.messageProp/channelProp`, the walk limits and the `RawDiscord*` field
  names are verified only by the token-backed live probe on Stable and Canary. (First
  live confirmation: the owner ran the built extension on Discord Stable on 2026-09-02 —
  buttons injected, fiber read rendered author/time/content, scan collected 200+ messages
  and streamed a synthesis. That is one data point, not a green probe.)
  `PROBE_ARTEFACTS=always` writes screenshot/DOM/outline on a green run too.

---

## 7. Self-repair pipeline

The biggest risk to this project is not a bug; it is *entropy*: Discord changes, the
extension breaks, the maintainer is tired, the project dies. The pipeline exists to turn
"Discord changed" into "here is a reviewed PR" without a human noticing first.

Pattern reference: Vencord's reporter (scheduled Puppeteer run against Discord Stable and
Canary, results to a step summary). Pattern only — Vencord is GPL-3.0 and this project is
MIT, so **no code was or may be copied from it**. One material difference: Vencord's
reporter is **unauthenticated** — it only needs Discord's webpack modules, which load on the
login page. Kibitz's contract is the message list, which only exists in a logged-in
channel view, so our probe logs a throwaway account in with a token. That buys real
coverage at a real cost: automation violates Discord's ToS, the account can be terminated,
and a login challenge from a datacenter IP turns the probe red for reasons no selector fix
can cure. The pipeline therefore separates *session* failures from *contract* failures
(below) so an auth problem never starts the fix agent.

```
canary-probe.yml   every 6h + on PRs touching src/manifest/probe
  ├─ matrix: stable, canary  (Canary gets Discord changes days before Stable)
  ├─ loads dist/ into Chrome for Testing, logs in with DISCORD_PROBE_TOKEN
  ├─ runs probe/checks.ts in order: list root → items → fiber read → button → click → panel → scroll-back
  └─ on failure: probe-report.json (with failureKind) + dom.html + dom-outline.txt + screenshot + console errors
       → schedule/dispatch: upsert ONE issue (edit in place, never comment):
            failureKind contract → auto:broken-selector  (starts ai-fix)
            failureKind session|setup → auto:probe-session  (human fixes the account; NO agent)
       → PR: red check, nothing else
ai-fix.yml         on that label, or when probe/review fails on an ai-fix/* branch
  ├─ downloads the evidence artefacts, builds .ai-fix/task.md
  ├─ runs the fix agent with NO GitHub token and an edit allowlist
  ├─ verifies: allowlist, diff size cap, npm run check
  └─ commits + pushes + opens/updates the PR (the WORKFLOW does this, not the agent)
ai-review.yml      on PRs from ai-fix/*
  ├─ separate agent, clean context: sees the diff + this file, not the fix transcript
  └─ verdict → job summary + review.json artefact; request_changes ⇒ red check. Zero comments.
loop               probe/review red on ai-fix/* ⇒ another fix round, max 5, then label needs-human
```

**Critical ordering:** probe first, agent second. Without a deterministic red/green signal
the agent wanders and produces plausible-looking useless PRs.

### 7.1 Agent boundaries (non-negotiable, enforced by the workflow, not by prompts)

| Rule | Enforcement |
| --- | --- |
| The agent never opens issues or comments on GitHub. It only produces a diff. | The agent step has no `GITHUB_TOKEN`/`GH_TOKEN` and no `gh`; the workflow opens the PR. |
| The agent never merges. | Branch protection + no token. Humans merge. |
| The agent never tags or releases. | Same. |
| The agent may only touch `src/adapters/**` and `tests/adapters/**`. | Three CLI layers with distinct jobs — `--tools` (which tools *exist*; `--allowedTools` alone removes nothing, it only skips prompts), `--restricted` (file tools confined to the checkout), `--allowedTools "Edit(src/adapters/**)" …` (what passes in `dontAsk` mode) — **and** `.github/scripts/check-allowlist.sh` on the resulting diff, which is the guarantee that survives any CLI change. `probe/` is excluded on purpose: an agent that can edit the check can "fix" the check. |
| Max 5 rounds per issue. | Round = bot commits on the branch (`git log --author`), counted by the workflow; ≥5 ⇒ `needs-human`, stop. |
| Diff size cap. | > 600 changed lines ⇒ `needs-human`. A selector fix is small; a big diff is a wrong turn. |
| If the fix needs the core, the agent stops and says so. | Structured output `status: "needs-human"` with a reason; the workflow labels and exits. |

**Because (history):** oh-my-pi tried an autonomous QA bot that opened issues and commented
on its own repo; it spammed the project and was shut down, and its constitution now reads
"Never comment on GitHub. Never create issues on GitHub." We start from that lesson instead
of re-learning it.

### 7.2 Secrets the pipeline needs

| Secret | Used by | Notes |
| --- | --- | --- |
| `DISCORD_PROBE_TOKEN` | canary-probe | Token of a **throwaway** account. Automation violates Discord ToS; the account may be terminated. Never a personal account. If Discord challenges logins from GitHub's datacenter IPs, the probe reports `failureKind: session` and files `auto:probe-session` (no agent); the remedy is a self-hosted runner on a residential IP or a fresh account, not a code change. |
| `DISCORD_PROBE_CHANNEL` | canary-probe | `<guildId>/<channelId>` of a **text** channel the throwaway account can read, with ≥60 messages including a reply and an attachment. Forum, voice-only and unreadable channels render no message scroller at all, which `list-root` cannot distinguish from a dead selector — its error names both readings. |
| `ANTHROPIC_API_KEY` | ai-fix, ai-review | Claude Code headless. Budget-capped per run via `--max-budget-usd`. |
| `AI_FIX_TOKEN` | canary-probe (issue), ai-fix (push/PR) | Fine-grained PAT or GitHub App token with Contents RW + Issues RW + Pull requests RW on this repo only. |

**Why `AI_FIX_TOKEN` exists:** events created with the default `GITHUB_TOKEN` (an issue
labelled, a PR opened, a push) do **not** trigger other workflows — GitHub's recursion guard,
with `workflow_dispatch`/`repository_dispatch` as the only exceptions. Without a separate
identity the chain probe → fix → review → probe silently stops after the first hop.

---

## 8. GitHub conduct for any agent (local or CI)

- Never create issues. Never comment on issues, PRs or discussions. Never react.
- Never merge. Never push to `main`. Never create tags or releases.
- Never `git commit` unless the task explicitly asks for it. Never `git push` without a
  human saying so in the conversation.
- Never touch files outside the allowlist in an automated fix (see 7.1).
- In CI these are enforced by token scope; locally they are enforced by this file. The
  reasoning is the same: an autonomous agent's mistakes are cheap to make and expensive to
  clean up, and GitHub notifications are a shared resource.

---

## 9. Code conventions

- TypeScript strict; no `any` (use `unknown` and narrow). `noUncheckedIndexedAccess` is on —
  index results are `T | undefined`, handle it.
- Prompts live in `src/core/prompts/*.md` and are rendered by `src/core/prompt.ts`. Never
  build a prompt with string concatenation in code. **Because:** prompt text is edited far
  more often than code and must be reviewable as text.
- Imports: extensionless (`./jsonc`, not `./jsonc.ts`); `import type` for types
  (`verbatimModuleSyntax` is on).
- `.md` and `.css` are imported as strings (`types/assets.d.ts`); esbuild and vitest are
  configured identically for this — keep them in sync.
- Bridge payloads are JSON strings, never objects (see `page-rpc.ts` header for why).
- Logging through `log` from `src/shared/log.ts`; the `[kibitz]` prefix is a contract with
  the probe's console-error filter.
- Timeouts and bounds everywhere the page is involved: fiber walks, RPC calls, scroll-back
  loops. A broken contract must fail loud and fast, not spin.
- Comments explain *why*, not *what*. A comment that restates the code is noise; a comment
  that records a decision is memory.

---

## 10. Definition of done for a PR

1. `npm run check` (typecheck + tests + build) passes.
2. For selector changes: `npm run probe:selftest` is green and the live probe passes on
   Stable **and** Canary (CI runs both on the PR).
3. New behaviour has a test that names its failure mode (section 6). No banned patterns.
4. New helper? You searched first (section 5) and there was none.
5. Any lesson learned twice is recorded in section 12.
6. Humans merge. Always.

---

## 11. Adding a platform adapter (checklist)

1. Create `src/adapters/<platform>/` with `selectors.ts` (rationale per export),
   `normalize.ts` (pure, tested), `adapter.ts` implementing `PlatformAdapter`
   (`src/core/adapter.ts`), and a bridge only if the platform needs MAIN-world access.
2. Add the platform literal to `Platform` in `src/core/types.ts` — the only core change allowed.
3. Register the adapter in `src/content/index.ts` (one line in the adapter list) and add its
   hosts to `manifest.jsonc`.
4. Add `probe/checks.<platform>.ts` and a matrix entry in `canary-probe.yml`.
5. If step 1–4 required editing anything else under `src/core/` or `src/ui/`, stop: the
   abstraction leaked. Fix the abstraction generically in a separate PR first.

---

## 12. Rule history

Format: `date — what happened — rule that resulted`. Append; never rewrite.

- **2026-09-02 — Founding decisions (project owner).** Discord's hashed CSS Modules classes,
  broken `innerText` extraction (emoji/mentions/code/embeds), the virtualised list, BYO key
  exposure, style bleed, scattered selectors and platform-specific cores are the failure
  modes of every prior Discord client mod. → Invariants 3.1–3.7.
- **2026-09-02 — oh-my-pi's autonomous QA bot** opened issues and comments on its own repo
  until it was shut down; their AGENTS.md now forbids agents from commenting or creating
  issues. → Section 7.1 / 8; the fix agent has no GitHub token at all.
- **2026-09-02 — GitHub's `GITHUB_TOKEN` recursion guard** would have silently stopped the
  probe → fix → review chain after the first hop. → `AI_FIX_TOKEN` as the automation identity.
- **2026-09-02 — AI-written tests that read the source file and assert on its text** were
  identified by the owner as the most common fake-coverage pattern. → Section 6.1 ban;
  review agent rejects on sight.
- **2026-09-02 — Cross-world CustomEvent payloads.** Objects crossing content-script/page
  boundaries are copied in Chrome but Xray-wrapped in Firefox (`cloneInto` required);
  a future Firefox port would have broken on day one. → JSON-string `detail` only.
- **2026-09-02 — Vencord's reporter** is the pattern for the probe; Vencord is GPL-3.0.
  → Pattern only, no code, project stays MIT.
- **2026-09-02 — `--json-schema` schemas declared draft 2020-12.** Claude Code validates
  structured-output schemas with JSON Schema draft-07 and rejects newer drafts at startup;
  the agent would never have run, and the review workflow's fail-closed default would have
  turned every PR red for five rounds with nothing in the logs but "no structured output".
  Caught in review before the first run. → Both schemas declare draft-07; the flag's call
  sites in ai-fix.yml/ai-review.yml carry the warning; never regenerate them with a tool
  that defaults to 2020-12 (zod does) without `target: "draft-7"`.
- **2026-09-02 — Vencord's reporter was cited as "logs in with a token secret". It does
  not** (its `generateReport.ts` opens `/login` and only needs webpack modules). The
  authenticated probe is *our* choice, made because our contract lives inside a logged-in
  channel view; its price is account risk and login challenges from datacenter IPs.
  → Section 7 states the difference honestly; `failureKind: session` routes auth failures
  to `auto:probe-session`, which never starts the fix agent.
- **2026-09-02 — The agent's tool sandbox was an inverted deny-list.** The first workflows
  restricted the agent with `--allowedTools` (which only auto-approves; it never limits
  what is *available*) plus `--disallowedTools "WebFetch" "WebSearch"` (a bare name there
  does remove the tool) and `dontAsk` denying the rest. That held, but only as long as
  nobody trimmed the deny-list. → `--tools` now states the available set positively,
  `--restricted` confines file tools to the checkout, `--allowedTools` is only the
  auto-approval list, and the git-diff allowlist stays the guarantee that survives any
  CLI change (7.1).
- **2026-09-02 — Scroll-back stopped after the first screen.** The first `scroller.ts`
  counted "DOM unchanged after a scroll step" as "history exhausted", but a virtualised
  list keeps a buffer of rows around the viewport, so several steps legitimately change
  nothing. The self-test fixture caught it (50 of 120 collected). → Exhaustion is only
  concluded at `scrollTop === 0` after two empty fetch waits; in-buffer steps wait briefly
  and never count.
- **2026-09-02 — `if: ${{ secrets.X != '' }}` on a step made canary-probe fail to load.**
  The `secrets` context is not readable in any `if` (job or step); GitHub then records a
  failed run under the *file path* instead of the workflow name, on every push, with no
  log — easy to misread as a failing step. `yaml.safe_load` cannot catch this; only
  Actions' expression validator can. → Read secrets into a job-level `env:` value and
  gate steps on `env.HAS_PROBE_SECRETS`; a workflow file edit is verified by pushing a
  branch and checking that no file-path-named run appears.
- **2026-09-02 — `.github/scripts/*.sh` were committed as `100644` from Windows.** Git on
  Windows cannot see the exec bit and records new files non-executable; every direct
  invocation on `ubuntu-latest` would have died with "Permission denied", and the first
  casualty would have been `upsert-issue.sh` — a real selector break would have filed
  nothing. → `git update-index --chmod=+x` on the scripts; `.gitattributes` pins LF so
  the shebangs survive Windows checkouts; the same dispatch run also showed that
  `download-artifact` creates no directory for zero matches, which `find` under
  `pipefail` turned into a red report job → the script now handles the missing directory.
  Verification that counts for workflow changes: `gh workflow run … --ref <branch>` and
  read the job conclusions, not a local YAML parse.
- **2026-09-02 — Discord desktop support (owner's request).** Options weighed: a
  Vencord-style patcher (rewrites `resources/app` inside Discord's install, breaks on every
  Discord update, GPL pattern — code off-limits), a BetterDiscord plugin (depends on a
  third-party mod), or a CDP companion. Chosen: the companion — no files touched, survives
  updates, reuses the probe's Puppeteer path — accepting that Discord must be launched with
  `--remote-debugging-port` and that the port is unauthenticated on localhost.
  → Section 3.8; the `Shell` seam; `dist/desktop-renderer.js` must be chrome-free (build
  check); Windows is the only exercised platform, macOS/Linux launch paths are marked
  untested in `desktop/discord-launch.ts`.
- **2026-09-02 — The chat composer never worked, and nothing caught it.** The owner
  reported "I cannot send messages" in the extension and dead buttons on the desktop. Cause:
  Shadow DOM retargets events, so every keystroke in our textarea reached Discord's
  document-level key handling, which focused Discord's own message box and typed there —
  measured: `abc` into our composer left it empty and appeared in Discord's box. The unit
  tests dispatched events at our elements directly (no Discord listeners), and the fixture
  self-test has no Discord key handling, so both stayed green. Second finding: on the
  desktop the only affordance without a key was a button that printed to a terminal the
  user was not watching.
  → `createShadowHost` with bubble-phase isolation (3.5); the probe's `panel-input` check
  types into the panel on live Discord; settings moved into the panel (3.4 amendment).
  Rule that generalises: **a UI regression that only appears inside the host page must be
  caught by a live check, not by a jsdom test** — jsdom has no Discord.

- **2026-09-02 — A diagnostic printed the owner's live API key into a session transcript.**
  A throwaway script `cat`ed `settings.json` through a hand-written redaction regex
  (`"apiKey":"[^"]*"`) that did not match the file's pretty-printed `"apiKey": "…"` spacing,
  so the real OpenAI key was echoed in full — twice — and had to be revoked. The same script
  was about to write a dummy key over that file; it only stopped because an unrelated
  assertion failed first.
  → `redactSettings` (`src/core/settings.ts`) is the only sanctioned formatter for a
  configuration, and it rebuilds the object rather than matching text (§3.4).
  Two rules that generalise: **never point a diagnostic at the user's real config file** —
  copy it aside or run the companion with `--settings <temp>`; and **never assert on a
  secret's value** — `hasKey`/`apiKeyLength` is all a check ever needs.
- **2026-09-02 — Clicking in a virtualised list is a race, and losing it looks like a broken
  button.** On live Discord `scrollIntoView` + `ElementHandle.click()` put the pointer where
  the host *had* been; the list had re-rendered, the click landed on `<html>`, the panel
  never opened, and the run read as a contract failure — a scheduled probe would have filed
  `auto:broken-selector` and set the fix agent on a phantom. Diagnosis cost an hour because
  a synthetic `button.click()` worked while a real click did not.
  → `button-clickable` now samples the click point twice, requires it to hold still and to
  hit-test to our host, and clicks coordinates rather than a stale handle. When a check
  cannot find what an earlier check saw, `assertStillOnChannel` decides whether the view
  simply left the channel (`ProbeSessionError` → `failureKind: session`, no agent) — proven
  live when the owner navigated Discord mid-run.
- **2026-09-02 — `ReferenceError: __name is not defined` inside a probe check.** A named
  inner arrow in a `page.evaluate` callback is compiled by tsx with esbuild's `__name`
  helper, which does not exist in the page; the check failed in a way that read like broken
  UI. → No named inner functions in page callbacks — inline the expression. The same trap
  applies to `\s` inside an evaluate template literal: it resolves to `s`, so
  `.replace(/\s+/g, " ")` silently deletes every "s" from the result.
- **2026-09-02 — The ✦ was unclickable under Discord's hover toolbar, and proving it took
  three wrong measurements.** The toolbar appears exactly when the pointer is over the row,
  i.e. when someone is about to click, so a message whose text reaches the right of the
  column hid the button behind it. Measured on live Discord: the toolbar is `position:
  absolute; z-index: 1`, ~257×34, anchored top-right **inside** the row (not portaled), so
  a static host loses the hit test. Fix: `position: relative; z-index: 2` on the button host
  (same stacking context, so out-stacking is enough), pinned by the `button-under-toolbar`
  probe check, which fails without those two declarations.
  The wrong measurements are the lesson: (1) an element rect is widened by image/embed
  children, so "the text reaches x=1554" was false — measure the end of text with a `Range`
  over its text nodes; (2) `offsetWidth` of a `display:none` toolbar is 0, which placed the
  test button on the toolbar's edge instead of inside it — hover first, then measure;
  (3) box intersection is not coverage, because the hit test happens at one point: the first
  version of the check overlapped by a single pixel, the centre fell below the toolbar, and
  it passed while testing nothing. A check that cannot fail is worse than no check.
- **2026-09-02 — A channel with no message list is usually a voice channel.** A channel the
  probe (and the injector) found empty of `[data-list-id="chat-messages"]` turned out from
  its sidebar entry to be the voice channel the developer was connected to — not a text
  channel with a different list id, so the selector contract has no hole there. The only
  `data-list-id` values in a normal view are `guildsnav`, `private-channels-*` and
  `chat-messages`. → `list-root`'s error names this reading; §7.2 requires a text channel.
- **2026-09-02 — Live verification competes with the developer using Discord.** Five live
  runs were defeated by channel switches, a channel with no chat scroller, and an open
  context menu whose transparent full-viewport backdrop covered every target. Electron
  refuses `Target.createTarget`, so a probe cannot open its own page. → Live checks against
  a shared window prove only what they observe; the scheduled probe (dedicated throwaway
  account, nobody driving) is the authority, and `failureKind` exists so a disturbed run
  never wakes the fix agent.