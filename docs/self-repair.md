# Operating the self-repair pipeline

For maintainers. The README says what the pipeline is; [AGENTS.md §7](../AGENTS.md#7-self-repair-pipeline)
says why it is shaped the way it is; this page says how to set it up, run it and read it.

## What runs when

| Workflow | Trigger | Does | Needs |
| --- | --- | --- | --- |
| `ci` | every push to `main`, every PR | `npm run check` (typecheck, unit tests, build), then `npm run probe:selftest` (the built extension driven by the real probe checks against `probe/fixtures/discord-like.html`) | nothing; runs on fork PRs too |
| `canary-probe` | every 6 h; PRs touching `src/`, `manifest.jsonc`, `scripts/`, `probe/`, `package*.json`; manual (`branch: both/stable/canary`) | loads `dist/` into Chrome, logs the throwaway account in, runs the checks on Discord Stable and Canary; on a scheduled or manual failure, files or updates **one** issue | `DISCORD_PROBE_TOKEN`, `DISCORD_PROBE_CHANNEL`; `AI_FIX_TOKEN` for the issue |
| `ai-fix` | an issue labelled `auto:broken-selector`; `canary-probe` or `ai-review` failing on an `ai-fix/issue-N` branch; manual (`issue_number`) | runs the fix agent on the evidence, verifies its diff (allowlist, size cap, `npm run check`), commits, pushes `ai-fix/issue-N`, opens or updates the PR | `ANTHROPIC_API_KEY`, `AI_FIX_TOKEN` |
| `ai-review` | PRs from `ai-fix/*` branches, or any PR labelled `ai-review` | a second agent with a clean context reviews the diff against AGENTS.md; verdict in the job summary and a `review` artefact; `request_changes` makes the check red | `ANTHROPIC_API_KEY` |

Without the two Discord secrets the live probe step is skipped with a notice and the run
stays green, so a fresh fork does not turn red every six hours.

## Secrets

The four secrets and what each is for are listed in the
[README](../README.md#secrets-to-configure). Notes that do not fit a table:

- **`AI_FIX_TOKEN`** must be a *separate identity* from the default `GITHUB_TOKEN`. Events
  created with `GITHUB_TOKEN` (an issue labelled, a PR opened, a push) never trigger other
  workflows; that recursion guard would silently stop the chain after the first hop. A
  fine-grained personal access token scoped to this repository with **Contents**,
  **Issues** and **Pull requests** read/write (plus the implied Metadata read) is enough. A
  GitHub App installation token works the same way.
- The fix and review agents receive **only** `ANTHROPIC_API_KEY`. `GITHUB_TOKEN` and
  `GH_TOKEN` are blanked in their environment and the checkout is made with
  `persist-credentials: false`, so no token sits in `.git/config` for the agent to read.
- Per-run budgets: fix agent `--max-budget-usd 5`, 80 turns; review agent
  `--max-budget-usd 3`, 40 turns. A run that exhausts either produces no structured output
  and is treated as `needs-human` (fix) or `request_changes` (review).

## The probe account and channel

The probe logs in with a token because the selector contract only exists in a logged-in
channel view. Automation violates Discord's Terms of Service, so:

- use a **throwaway account** created for this purpose, never a personal one; assume it
  may be terminated;
- create a private server with it and post, in one channel, at least **60 messages** (so
  the first render does not already contain the whole history and scroll-back is really
  exercised), including at least one **reply** and one **attachment**. An **embed** (paste
  a link) and a **custom emoji or mention** are not required by any check, but they make
  the fiber read exercise more of the contract;
- set `DISCORD_PROBE_CHANNEL` to `<guildId>/<channelId>` (both appear in the channel URL)
  and `DISCORD_PROBE_TOKEN` to that account's token.

If Discord challenges logins from GitHub's datacenter IPs, every run fails with
`failureKind: session` and an `auto:probe-session` issue. No agent runs on that label; the
remedy is a self-hosted runner on a residential IP or a fresh account, not a code change.

## Running the probe yourself

```bash
npm run build
DISCORD_PROBE_TOKEN=… DISCORD_PROBE_CHANNEL=<guildId>/<channelId> npm run probe -- --branch canary
```

`--branch` is `stable` (default), `canary` or `ptb`; `DISCORD_BRANCH` is the env
equivalent. `KIBITZ_DIST` points the probe at another build directory. Output lands in
`probe-out/<branch>/`:

| File | When | What |
| --- | --- | --- |
| `probe-report.json` | always | the machine-readable result: `ok`, `failureKind`, one entry per check with `detail`, console errors, the `[kibitz]`-prefixed subset |
| `dom-outline.txt` | on failure (or `PROBE_ARTEFACTS=always`) | the DOM with only `id`, `role`, `aria-*`, `data-*` and landmark tags; class names deliberately stripped. This is the only DOM view the fix agent gets |
| `dom.html` | same | the full DOM, for humans |
| `screenshot.png` | same | the viewport at the moment of failure |
| `console.json` | same | the last console errors and page errors |

The checks run in order and the probe stops at the first failure, because each one
depends on the previous:

| Check | Fails when | Usually means |
| --- | --- | --- |
| `list-root` | `[data-list-id="chat-messages"]` never appears, or the page navigates away from the channel URL | navigating away = token rejected or channel unreadable (`session`); staying put = Discord renamed the list attribute (`contract`) |
| `message-items` | rendered `<li>`s do not match `MESSAGE_ITEM` or their ids do not parse to this channel | the `chat-messages-<channelId>-<messageId>` id scheme changed |
| `fiber-read` | the bridge does not answer `ping`, or `readMessage`/`readMessages` return something `assertUniversalMessage` rejects | React fiber key, `message`/`channel` prop names or a `MessageRecord` field changed; the `ContractError` path names the field |
| `button-injected` | rendered items have no `data-kibitz-button` host with a non-zero box | the button anchor (`message-content-<id>` / `role="article"`) changed |
| `button-clickable` | the last button is obscured or a click on it does not register | layout or overlay changes |
| `panel-opens` | the panel host never reaches `data-kibitz-state="ready"` for the clicked message | the read-on-open path; `data-kibitz-error` carries the reason |
| `scroll-back` | a scan collects no more than what was rendered before it | the scroll container was not found, or the list stopped loading history |

`npm run probe:selftest` runs the same checks against `probe/fixtures/discord-like.html`,
served at a real `discord.com` channel URL through request interception, without an
account. It proves the extension's parts agree with each other; it proves nothing about
Discord.

## Reading a red run

`upsert-issue.sh` turns the artefacts of a scheduled or manual run into exactly one open
issue, edited in place on every later run (never commented on):

| `failureKind` | Label | Who acts |
| --- | --- | --- |
| `contract` on any branch | `auto:broken-selector` | the fix agent, automatically |
| `session` or `setup` only | `auto:probe-session` | a human: fix the token, the channel or the runner |

The issue body carries, per branch, the first failed check and its detail, the checks that
passed before it, and the first console errors. The artefacts themselves are attached to
the workflow run (`probe-stable`, `probe-canary`, 14-day retention). On pull requests the
probe is only a red check; no issue is filed.

## The fix loop

1. `auto:broken-selector` starts `ai-fix`. It downloads the latest failed probe run's
   artefacts, assembles `.ai-fix/task.md` (issue text, reports, evidence paths, the
   allowlist, the output schema) and runs the agent with `Read/Glob/Grep/Edit/Write/Bash`
   only, confined to the checkout, with edits auto-approved only under `src/adapters/**`
   and `tests/adapters/**`.
2. The workflow, not the agent, then checks the diff against
   `.github/ai/allowed-paths.txt`, rejects more than 600 changed lines, runs
   `npm run check`, commits as `kibitz-ai-fix[bot]`, pushes `ai-fix/issue-N` and opens or
   updates the PR (`ai-fix` label, body from `.github/ai/pr-body.md`).
3. The PR triggers `ai-review` and `canary-probe`. If either fails, `ai-fix` runs another
   round on the same branch with the review findings added to the task.
4. Rounds are counted as bot-authored commits on the branch. Once **5** exist, the next
   trigger labels the issue `needs-human` and stops. The same label is applied, and the
   agent's tree discarded, when the agent produces no structured output or reports
   `needs-human` itself (no hypothesis in the outline, a fix that would need `src/core/`,
   the only anchor being a class name), when its diff touches a file outside the
   allowlist, exceeds 600 changed lines or fails `npm run check`, or when it reports
   `fixed` with an unchanged tree.
5. A human reviews and merges. Nothing in the pipeline can merge.

`needs-human` is sticky by design. After you have fixed the underlying problem (or the
account), remove the label and, if you want the agent to try again, dispatch `ai-fix`
manually with the issue number.

## Manual controls

```bash
gh workflow run canary-probe.yml -f branch=canary        # probe one branch now
gh workflow run ai-fix.yml -f issue_number=17            # start (or resume) a fix round
gh pr edit 23 --add-label ai-review                      # ask the review agent to look at a human PR
gh run download <run-id> -D evidence                     # pull a run's artefacts
```

Labels the pipeline creates on first use: `auto:broken-selector`, `auto:probe-session`,
`ai-fix`, `needs-human`.

## Changing the workflows

Actions' expression validator only runs on GitHub. A workflow file that parses as YAML
can still fail to load (the run then appears under the file path instead of the workflow
name, with no log). Verify a workflow change by pushing a branch and dispatching the
workflow with `--ref <branch>`, then reading the job conclusions; a local YAML parse is
not verification. `canary-probe` also runs on PRs that touch `src/`, `manifest.jsonc`,
`scripts/`, `probe/` and the package files, so a contract change is probed before merge.

The shell scripts under `.github/scripts/` need the executable bit; Git on Windows cannot
set it, so use `git update-index --chmod=+x <file>` when adding one.
