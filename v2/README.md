# v2: Sid's rewrite branch

Branched from `NousResearch/hermes-agent` `main` at `8b66a51036` (2026-10-04). Experiments branch off
`v2` as `v2/<topic>` (for example `v2/restructure`, `v2/settings`), and land back on `v2` when they hold up.

## Rules for this branch

- No backwards compatibility inside v2: no shims, no old and new paths side by side. Convert every
  caller in the same change and delete what was replaced.
- Mechanical changes are codemods checked into `v2/codemods/` and re-runnable on a fresh `main`, so a
  vector can be replayed instead of rebased.
- Every change moves at least one count in `v2/idioms/SUMMARY.md` down and none up. Re-run the sweep
  (`v2/idioms/ruff.sh && uv run --no-project python v2/idioms/sweep.py`) and commit the summary.
- Do not run the test suite or CI locally (Sid's standing rule); static analysis is fine.

## Pushing

v2 lives on Sid's public fork: remote `alt` = `alt-glitch/hermes-agent`, branch `v2`. Always push with
an explicit destination: `git push alt v2/<topic>:refs/heads/v2/<topic>`. This checkout sets
`push.default = upstream`, and a branch created from `origin/main` tracks `main`, so a bare
`git push -u alt <branch>` updates the fork's `main` instead (it happened once while seeding v2 and
was reverted).

## What is here

| Path | What |
|---|---|
| `v2/ARCHITECTURE.md` | current architecture, proposed end state, restructure-vs-rewrite, attack vectors |
| `v2/PRINCIPLES.md` | the idioms (PY-01 … PY-27) with reasons, reference files and today's counts |
| `v2/idioms/` | the sweep that counts mechanical idioms; `SUMMARY.md` is the current table |
| `v2/lab/` | the trace lab: record what real Hermes runs execute, then analyze it |
| `v2/audit/` | the code-health audit this branch starts from: 15 area reports (md + json), verification notes, the interactive HTML map, the video script and frame table |
| `.repos/` | reference projects (symlink to the main checkout's `.repos/`, gitignored) |

The walkthrough video lives outside the repo:
`~/main-quests/nous-research/hermes-agent/.scratch/code-health-audit/videos/hermes-code-health-walkthrough/renders/hermes-code-health-walkthrough.mp4`.
