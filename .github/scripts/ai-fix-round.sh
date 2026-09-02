#!/usr/bin/env bash
# Prints the number of fix rounds already spent on the current branch: commits reachable
# from HEAD but not from the base, authored by the bot identity ai-fix.yml commits with.
# Counting commits (not workflow runs) makes the cap survive re-runs, reverts and manual
# pushes — the branch itself is the ledger (AGENTS.md 7.1 "Max 5 rounds").
set -euo pipefail

base="${1:-origin/main}"
# -F: the author name contains "[bot]", which is a character class to a regex.
git rev-list --count -F --author='kibitz-ai-fix[bot]' "$base..HEAD"
