# Contributing to Kibitz

Thanks for looking. Kibitz is small on purpose, and most of what makes it work is a set of
rules with reasons attached. Those live in [AGENTS.md](AGENTS.md); this page is the short
path through them for a first pull request.

## Before you write code

Read [AGENTS.md](AGENTS.md) once, start to finish. It is the project's constitution and
it is written for humans as much as for the CI agents. Reviewers, human and automated,
hold every change to it. The rules that catch newcomers most often:

| Rule | Why | Where |
| --- | --- | --- |
| No CSS class names, anywhere — not in code, tests, fixtures or the probe | Discord hashes them per build; they change weekly | [§3.1](AGENTS.md#31-no-css-class-names--ever-anywhere) |
| Every Discord selector, prop name and regex lives in `src/adapters/discord/selectors.ts`, with a rationale | One file to fix at 3 a.m. | [§3.6](AGENTS.md#36-one-file-owns-the-discord-contract), [§4](AGENTS.md#4-the-selector-contract) |
| `src/core/` and `src/ui/` never mention Discord or `chrome.` | The second platform must not touch the core | [§3.7](AGENTS.md#37-the-core-is-platform-agnostic) |
| No source-text tests, no "it ran" tests, no echo tests, no prompt-wording tests | They go green while the product is broken | [§6.1](AGENTS.md#61-banned-outright) |
| Prompts are `.md` files rendered by `src/core/prompt.ts`, never string concatenation | Prompt text is reviewed as text | [§9](AGENTS.md#9-code-conventions) |
| Search `src/shared/` and `src/core/` before adding a helper | Two implementations drift | [§5](AGENTS.md#5-reuse-before-writing) |
| Agents (local or CI) never comment on GitHub, never open issues, never commit or push unasked | Notifications are a shared resource | [§8](AGENTS.md#8-github-conduct-for-any-agent-local-or-ci) |

## Set up

```bash
git clone https://github.com/534552454653495A/kibitz.git
cd kibitz
npm ci
npm run check           # typecheck + unit tests + build; must be green before and after your change
npm run dev             # rebuild dist/ on change; reload the extension in chrome://extensions
```

Load `dist/` unpacked in Chrome 120+ (see the [README](README.md#quick-start)). The repo
layout is in [AGENTS.md §2](AGENTS.md#2-map-of-the-repo).

## Making a change

**Tests.** `tests/` mirrors `src/`; Vitest, Node environment, DOM tests opt in with
`// @vitest-environment jsdom`. A test exists to fail when a real consumer would be hurt;
name it after the failure mode (`it("keeps // inside URL strings")`, not `it("works")`).
Good shapes: transformation (`normalize(raw)` → exact fields), boundary (`parseX("bad")`
→ `null`), contract error path (`ContractError.path === "message.author"`), protocol
(an SSE event split across chunks), regression (named after the incident). See
[AGENTS.md §6](AGENTS.md#6-testing-constitution).

**Selector changes** follow the procedure in [AGENTS.md §4.3](AGENTS.md#4-the-selector-contract):
update `selectors.ts` with the new reasoning and the date, update the parsing tests if
the contract changed, run `npm run check`, then `npm run probe:selftest`. If the contract
changed shape, update `probe/fixtures/discord-like.html` too; a fixture that still passes
against an old contract tests nothing. With a throwaway Discord account, also run
`npm run probe` (see [docs/self-repair.md](docs/self-repair.md)).

**Conventions.** TypeScript strict, no `any` (use `unknown` and narrow),
`noUncheckedIndexedAccess` is on. Extensionless imports, `import type` for types. `.md`
and `.css` import as strings. Logging goes through `log` from `src/shared/log.ts`. Bridge
payloads are JSON strings. Every wait that involves the page has a timeout. Comments
record decisions, not restatements. Full list: [AGENTS.md §9](AGENTS.md#9-code-conventions).

**Adding a platform** is a checklist: [AGENTS.md §11](AGENTS.md#11-adding-a-platform-adapter-checklist).
If it requires editing `src/core/` or `src/ui/` beyond adding a `Platform` literal, the
abstraction leaked; fix that first, in its own PR.

## Pull requests

The definition of done is [AGENTS.md §10](AGENTS.md#10-definition-of-done-for-a-pr):

1. `npm run check` is green.
2. Selector changes: `npm run probe:selftest` is green, and the live probe passes on
   Stable and Canary (CI runs both on PRs from this repository; PRs from forks get no
   secrets, so the live probe is skipped there and runs once a maintainer pushes the
   branch to this repository or after merge).
3. New behaviour has a test that names its failure mode; nothing from the banned list.
4. New helper? You searched first and there was none.
5. A lesson learned twice goes into [AGENTS.md §12](AGENTS.md#12-rule-history).
6. A human merges. Always.

Keep a PR to one change. If you find a second thing worth fixing, open a second PR. Small,
reviewable diffs are also what the automated reviewer (`ai-review`, runs on `ai-fix/*`
branches and on PRs labelled `ai-review`) is tuned for.

## Reporting a problem

For "no buttons" or "the panel says *Could not read this message*": include your Chrome
version, the Discord host (`discord.com`, `canary.` or `ptb.`), and the `[kibitz]` lines
from the console (DevTools → context dropdown → **Kibitz** → `KIBITZ_DEBUG = true`). A
`ContractError` message names the exact field that changed; paste it verbatim.

If you keep a throwaway Discord account, `npm run probe -- --branch stable` produces
`probe-out/stable/probe-report.json` and `dom-outline.txt`; attach both. They are what the
fix agent would work from.
