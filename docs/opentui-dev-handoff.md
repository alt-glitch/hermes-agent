# Handoff — OpenTUI memory + UX, continuing on the canonical branch

**You are continuing the Hermes OpenTUI engine work.** This is the base operating manual; the
user (glitch) appends specific tasks on top. Read it, then read the repo docs it points to. It
assumes NO prior transcript/memory.

## Where things are

- **Canonical branch: `feat/opentui-native-engine`** (the draft PR to main, #42922).
  `feat/opentui-memory-window` is a synonym at the *same tip* — they were consolidated. Treat
  native-engine as canonical; if you work from memory-window, periodically
  `git push origin HEAD:feat/opentui-native-engine` to keep them in sync, or just use native-engine.
- The native engine source is **`ui-opentui/`**; the legacy Ink engine is `ui-tui/` (shipping
  default, untouched by this campaign). The Python gateway is `tui_gateway/`, launcher
  `hermes_cli/main.py`.
- **A trusted worktree can be the user's LIVE global `hermes` runtime.** The regular
  `~/.local/bin/hermes` launcher selects the current checkout only when its Git common directory
  is in `~/.local/bin/hermes.trusted-roots`; otherwise it uses the managed install. Consequences:
  (1) NEVER leave a trusted worktree half-merged/conflicted — a new `hermes` session would fail to
  build; (2) after source changes, rebuild `dist/main.js`; (3) leave the worktree (or remove its
  common dir from the trust file) to bypass it with the managed install.
- Backups of pre-merge branch states exist as `backup/*` refs (recoverable via `git reset`).

## Runtime, build, gate (Node 26 — NOT Bun; the port is done)

```sh
export PATH="$HOME/.local/share/fnm/node-versions/v26.3.0/installation/bin:$PATH"
cd ui-opentui && node scripts/build.mjs            # → dist/main.js (esbuild + Solid/JSX)
HERMES_TUI_MOUSE=1 node --experimental-ffi --no-warnings dist/main.js   # launch; quit = double Ctrl+C
cd ui-opentui && npm run check                      # THE GATE: prettier+eslint(typed)+vitest (~700). Judge by `echo $?`, never a piped tail.
```

Never run bun here. Never run `hermes update` in the worktree (it flips the branch — recovery is
painful). Never broad-pkill tui_gateway (other live sessions). Host RAM ~15GB, often <5GB free —
run benches SEQUENTIALLY (the harness already wraps SUTs in `systemd-run … MemoryMax=2G`).

## The docs that are the source of truth (read, and KEEP UPDATED as you change things)

- `docs/opentui-memory-story.md` — ELI5 of the whole memory architecture (primitives + every decision).
- `docs/plans/opentui-transcript-windowing.md` — windowing design (S1 spacers, S2 append-time), the
  `correctionIsLegal` zero-jank law, pre-registered gates, SHIPPED status + S3 backlog.
- `docs/opentui-env-flags.md` — the consolidated env-flag ledger (master switch / user / dev / plumbing).
- `docs/opentui-upstream-alignment.md` — forkless invariant, `boundary/` shim ledger, the per-release
  OpenTUI upgrade playbook (native-yoga is coming upstream — re-tune windowing margins when it lands).
- the bench suite (cells, harness, live-attach, memwatch) now lives in its own
  repo: **tui-bench** (`github.com/NousResearch/tui-bench`); see its `README.md`.
- `ui-opentui/README.md` — Node 26 onboarding (fnm setup that doesn't disturb other projects).
- `docs/plans/ink-memory-adversarial-review.md` — Ink's memory weaknesses (F1–F10, the turnabout).
- `docs/plans/gateway-death-forensics.md`, `docs/plans/workorder-2026-06-11-results.md`,
  `docs/plans/rebase-from-main-spec.md` — forensics, the merge-bar verdict, the rebase plan.

## Workflow (this is how the last 60+ commits were produced with ~zero rework)

1. **Subagent-driven** (skill: `subagent-driven-development`): one implementer per task with a TIGHT
   file fence ("you own exactly these files; `git diff --cached --stat` before commit, abort on
   out-of-fence"), a mandatory `opentui` skill read FIRST for any renderable work, and a gate judged
   by exit code. Verify the self-report YOURSELF (re-run the gate, read the riskiest hunks, check the
   commit file-list) — a subagent "✅ done" is a claim, not a fact.
2. **Adversarial review** after a task: a fresh read-only reviewer (Explore-type) with NAMED attack
   surfaces. Then ADJUDICATE in code — reviewers over-flag; ~half of "blockers" don't survive a read.
3. **Parallel implementers are safe ONLY with disjoint file fences.** Read-only recon agents
   parallelize freely.
4. **Live smoke catches what headless can't** — tmux + the `tmux-pane-screenshot` skill for real
   colored frames. The demo: `node scripts/build.mjs scripts/demo.tsx .demo` then
   `DEMO_TOTAL=2000 … node --experimental-ffi --no-warnings ./.demo/demo.js`.
5. Commit format `opentui(v6): …`, **NO attribution lines**. The user's standing instruction is
   "commit + push as you land things" — honor it; otherwise don't push without asking. Edit large
   load-bearing files (the Python launcher, `store.ts`) DIRECTLY, never via subagent.

## Dogfooding (the user works on this FROM the hermes TUI)

`export HERMES_TUI_DIAGNOSTICS=1` in the shell rc turns on, for every session: the `/mem` +
`/heapdump` slash commands, window-stats, and **fleet memory self-logging** to
`~/.hermes/logs/memwatch/<boot>-<pid>.jsonl`. Aggregate all sessions with
`node memwatch-report.mjs` from the **tui-bench** repo
(`github.com/NousResearch/tui-bench`) (per-session baseline/peak/slope + SLOPE/PEAK/MOUNTED anomaly
flags). Chase a flagged session with tui-bench's `live-attach.sh <pid> --heap`. The discipline: live
anomaly → encode as a bench cell → fix → validate against live sessions again.

## Current state (2026-06) + the ranked backlog

Windowing SHIPPED: 2k-msg peak ~300MB (was 686; Ink 234), scroll p99 6ms, cap restored 1000→3000,
determinism digest unchanged, peak mounted ~31 rows. Live sessions peak <200MB. The transcript is no
longer the biggest lever — the ~160MB floor is ≈104MB Node+OpenTUI runtime + **≈55MB tool/skill
catalogs hydrated at boot**. Ranked next levers:

1. **W3 — 1GB V8 heap default** (small, ~free): set the unconstrained default in
   `_resolve_tui_heap_mb`; both engines are Node now so both inherit it. Ink half = separate gated
   commit (shipping engine). Measured −90MB at bench scale.
2. **cg_peak harness fix** (small): the cgroup `memory.peak` field is polluted (shared across runs) —
   reset/scope it before quoting tui-bench's `report.html` again. Trust `vmhwm_kb` + `samples[].rss_kb`.
3. **New bench cells** (before W1, as its baselines): `resume-1900` (real p99 shape: time-to-first-
   paint + post-hydration RSS) and `10MB-tool-output` (the F1 byte-unbounded class). Run BOTH engines.
4. **Catalog lazy-load** (new, promoted by live data): don't hydrate 1,185 tools at boot — fetch on
   picker-open. Attacks the ≈55MB floor; pays on EVERY session (median is 20 msgs). Likely cheaper
   than W1.
5. **W1 thin renderer** (structural, biggest): bodies live in the gateway (SQLite); TUI keeps ~300B
   stubs + fetches bodies for the window only. Design the gateway windowed-read RPC FIRST. WATCH: `/copy`
   and the ⧉ block-copy read store parts — they need a fetch-on-demand fallback or W1 ships a copy regression.
6. **Standing**: when native-yoga OpenTUI ships, run the upgrade playbook (re-bench, re-tune margins,
   audit the shim ledger). Three questions to relay to the OpenTUI maintainer are in the alignment doc.

## What NOT to do
- Don't copy opencode's 100-msg store cap (user's p90 session is 182 msgs — it would truncate normal use).
- Don't reintroduce estimate-correction scroll jank (the user explicitly vetoed it; `correctionIsLegal` forbids it).
- Don't cite the obsolete "~210MB bun renderer / +120MB" memory figures — pre-port, pre-windowing, wrong.
- Don't push/PR without the standing OK; don't commit `.plans/` scratch unless asked.

## Suggested skills
(All available from the Hermes TUI agent too — this is the dogfooding surface. Curated to the load-bearing set, not the full ~40-skill catalog.)
- `opentui-tui-engineering` — the workflow/architecture/pitfalls layer for `ui-opentui/` (just updated).
- `hermes-tui-architecture` — the Hermes-specific TUI facts (launch pipeline, both engines; just updated).
- `opentui` — the offline renderable-API doc set; mandatory `skill_view` before any view/renderable code.
- `subagent-driven-development` — the process spine for parallel/heavy work.
- `tmux-pane-screenshot` — real colored PNG of a tmux pane for visual verification (ported
  into hermes skills 2026-06-13). Use: `bash ~/.hermes/skills/software-development/
  tmux-pane-screenshot/scripts/tshot.sh <session:win.pane> out.png 2`, then Read the PNG.
  `freeze` (~/go/bin) + the resvg rasterizer are shared/system-wide — works as-is.
- `effect-ts` — for the Effect-at-boundary entry/lifecycle code.
- `superpowers:brainstorming` — before committing to a memory-architecture design (e.g. W1's store split).
- `systematic-debugging` — if a gate fails; root-cause before patching.
