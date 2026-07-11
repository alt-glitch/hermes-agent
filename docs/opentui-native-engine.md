# OpenTUI native engine — historical PR documentation

**Branch:** `feat/opentui-native-engine` · **Base:** `origin/main` (merged in; HEAD is at `~main`)
**New engine root:** `ui-opentui/` (Node 26 + `@opentui/core` 0.4.1 + `@opentui/solid`, Effect at the boundary)
**Legacy engine root:** `ui-tui/` (React + the `@hermes/ink` fork at `ui-tui/packages/hermes-ink/`)

> This is a historical PR/benchmark snapshot. Its LoC, screenshots, and frozen
> performance results remain useful, but it is **not** the current parity or
> release ledger. Use `docs/opentui-parity-matrix.md` for current status; where
> this document once claimed “full parity,” the canonical ledger wins.

This PR adds a from-scratch native terminal UI built on OpenTUI, intended to
replace the React/Ink TUI **and the Ink fork we maintain alone**. It currently
ships as a parallel engine (Ink untouched, auto-fallback), selected by
`HERMES_TUI_ENGINE` env > `display.tui_engine` config > auto (OpenTUI when the
host is Node ≥ 26.3 with the built bundle, else Ink). **100% parity with the Ink
TUI is the bar.**

---

## 1. Line-of-code reduction (the headline maintenance win)

All counts are **git-tracked files only** (respects `.gitignore`; `dist/` and
`node_modules/` are untracked and excluded). Measured live on this branch at
`~HEAD`. "Code" = `.ts/.tsx/.js/.jsx` only; "total" includes config/json/md.

### What gets *removed* when Ink is retired

| Area | Files | Total lines | Code lines (ts/tsx/js) | Non-blank code |
|---|---:|---:|---:|---:|
| `ui-tui/src/` — Ink **consumer app** (our React/Ink view code) | 204 | 40,422 | 40,422 | 33,550 |
| `ui-tui/packages/hermes-ink/` — **the fork** (`@hermes/ink`) | 148 | 28,167 | 28,113 | 23,718 |
| **`ui-tui/` whole tree (tracked)** | **362** | **69,320** | **68,831** | **57,545** |

The `ui-tui/` whole-tree number (69,320) also folds in a handful of build
scripts, `.prettierrc`, `package.json`, etc. The two rows above it are the
load-bearing split:

- **The fork alone is 28,167 LOC across 148 files** — code we own and can never
  sync from upstream. Upstream Ink v6.8.0 `src/` is ~7,259 LOC, so the fork's
  renderer core is **~3.2× the size of stock Ink**. (Cross-checked against the
  HTML write-up's `ink-fork-analysis.json`: 28,111 LOC / 148 files — the 56-line
  delta is a single tracked JSON the file-level count includes.)
- **The consumer app is another 40,422 LOC** — React components/hooks that only
  exist to drive Ink.

### What gets *added*

| Area | Files | Total lines | Code lines | Non-blank code |
|---|---:|---:|---:|---:|
| `ui-opentui/src/` — new engine (app code **+ its own tests**) | 153 | 28,763 | 28,763 | 26,495 |
| &nbsp;&nbsp;↳ non-test (app code only) | 97 | 16,628 | 16,628 | 15,450 |
| &nbsp;&nbsp;↳ tests (`src/test/`) | 56 | 12,135 | 12,135 | 11,045 |
| Tree-sitter grammars (`python`…`toml`) | 0 | 0 | 0 | 0 |
| **`ui-opentui/` whole tree (tracked)** | **~170** | **~34,800** | **29,614** | **27,283** |

> Tree-sitter grammars carry **zero repo lines**: the engine declares the 10
> extra grammars as remote URLs (`src/boundary/parsers.manifest.json`) and
> OpenTUI fetches+caches each `.wasm`/`.scm` on first use into
> `~/.hermes/cache/opentui-parsers/` (à la opencode, which vendors none). An
> earlier revision vendored them as 37,302 checked-in binary lines (10 `.wasm` +
> 10 `.scm`); that's gone — code lines and total lines now move together.

### The net reduction (code lines, the honest comparison)

| Comparison | Removed (ts/tsx/js) | Added (ts/tsx/js) | Net change |
|---|---:|---:|---:|
| **Incl. fork** — retire all of `ui-tui/` vs add `ui-opentui/src` | −68,831 | +28,763 | **−40,068 LOC (−58%)** |
| **Incl. fork, app-vs-app** (exclude both test suites) | −56,463¹ | +16,628 | **−39,835 LOC (−71%)** |
| **Excl. fork** — only the Ink *consumer app* vs new engine | −40,422 | +28,763 | **−11,659 LOC (−29%)** |
| **The fork in isolation** (the unsyncable liability we shed) | −28,113 | — | **−28,113 code lines deleted outright (28,167 incl. its 1 config file)** |

¹ `ui-tui/src` non-test = 28,350 LOC + fork (≈ all 28,113 code lines are non-test;
it carries only ~54 config lines) = 56,463. (`ui-tui/src` carries 80 test files /
12,072 LOC; the new engine carries 56 test files / 12,135 LOC.)

**Read it this way:**

- **The cleanest single number: ~−40k code lines net** (retire all of `ui-tui/`,
  add `ui-opentui/src`). That is a **~58% reduction in the TUI's
  hand-maintained surface**, and it *includes* the new engine's full 56-file test
  suite.
- **The most important number is the fork: −28,167 LOC of unsyncable engine
  code** disappears. That is the load-bearing maintenance win — it's not just
  fewer lines, it's lines we are the *sole* maintainer of (own reconciler, ANSI
  parser, scrollbox, selection/OSC52, hand-rolled memory eviction, Yoga binding).
- **Even excluding the fork** — i.e. if you imagine upstream Ink were free — the
  app rewrite is still a net reduction (−11,659 LOC) because the new engine
  mounts OpenTUI built-ins instead of hand-building components.

### Caveat on the comparison (keep it honest for review)

- These are **whole-tree retirements vs a single source dir add.** If/when Ink is
  deleted, the `ui-tui/` `package.json`, lockfile, and build scripts go too; the
  table counts `ui-tui/src` + the fork as the apples-to-apples "hand-maintained
  TS" figure.
- **Tree-sitter grammars are NOT vendored.** The 10 extra grammars are declared
  as remote URLs (`src/boundary/parsers.manifest.json`); OpenTUI fetches each
  `.wasm`/`.scm` on first use of a language and caches it under
  `~/.hermes/cache/opentui-parsers/` (profile-aware, set via
  `HERMES_TUI_PARSER_CACHE` by the launcher). Registration does **zero** network;
  the fetch is lazy and off the boot critical path, and an unreachable
  GitHub/air-gapped env degrades that language to plain text — never a throw. This
  replaces an earlier revision that vendored 37k binary lines, so the repo no
  longer grows on disk for syntax highlighting. (Trade-off: first-use-per-language
  needs network to `github.com`/`raw.githubusercontent.com`; pre-seed the cache in
  a Docker build if you need offline highlighting.)
- Python/backend LoC is **not** part of this reduction: `tui_gateway/` (~12k LOC)
  is **shared by both engines** and stays. See §4.

---

## 2. Performance (CPU / latency / memory)

Measured with the `tui-bench` harness driving **both engines on a real PTY
120×40**, fake gateway feeding deterministic events, `/proc`-sampled identically,
each SUT under `systemd-run --scope -p MemoryMax=2G -p MemorySwapMax=0`,
sequential with a load-gate + 10s cooldown. Determinism gate **GREEN**, 71 result
files, 0 cell errors, 3 reps/cell, `@opentui/core` 0.4.1 native-yoga
(`libopentui.so`, no `yoga.wasm`). Every number traces to a `summary.<field>` in
a result dir. Source: `~/projects/opentui-html/bench-numbers.json` (frozen
2026-06-14, build under test `1ddf7a102` + WIP).

### Scorecard

| Dimension | Winner | Margin | Source cell |
|---|---|---|---|
| Streaming frame rate | **OpenTUI** | **~3×** (43 vs 14 fps) | `cpu800.frame_pacing` |
| Streaming smoothness (interframe p95) | **OpenTUI** | **40ms vs ~220ms** (no ¼-second stalls) | `cpu800.frame_pacing` |
| Scroll CPU | **OpenTUI** | **~2.7× cheaper** (134–155 vs 403–416 ticks) | `scroll3000.scroll.cpu_ticks` |
| Cold-start floor | **OpenTUI** | ~97–103 vs ~107–109 MB | `startup.vmhwm_kb` |
| Session-create latency | **OpenTUI** | ~151–177 vs ~204–229 ms | `startup.session_create_ms` |
| First-byte paint | Ink | ~93 vs ~122 ms | `startup.first_byte_ms` |
| Memory @ small/typical | Ink | OpenTUI +30–50 MB | `mem50/100/300.vmhwm` |
| Memory @ heavy tool output | **OpenTUI** | **crossover** (258–265 vs 280–290 MB) | `results-fat-mem-*` |
| Layout reflow latency | **Ink** | **~0ms vs ~13ms** (OpenTUI's one honest loss) | `resize3000.resize.reflow_ms` |

### The honest reading

- **OpenTUI wins everything you feel continuously** — frame rate (~3×), scroll
  CPU (~2.7×), and smoothness (no 200ms hitches; p95 40ms vs ~220ms). This is the
  lead. The single most user-perceptible difference is the stall-free stream.
- **Memory: lead with smoothness, not raw RSS.** Ink is lighter at small/typical
  sizes (OpenTUI carries a ~102 MB irreducible Node+V8+`libopentui.so` floor, so
  it sits +30–50 MB above Ink there). But it **crosses over** under heavy tool
  output (mem300: 258–265 MB OpenTUI vs 280–290 MB Ink) because windowing beats
  Ink's mount-every-row. Real-world: 20 memwatch sessions show a flat ~108 MB
  floor and ~0 MB/h on long sessions (one 15h session, 0 MB/h; one 4.4h session
  plateaus flat at ~237 MB with mounted rows pinned at 33).
- **The one outright loss is layout reflow** (~13ms p50 vs Ink's ~0ms; under a
  resize storm OpenTUI degrades to ~14fps/~197ms vs Ink ~26fps/~100ms). Heavier
  native renderables vs Ink's string nodes. This is a real, quantified
  optimization target — **not** a regression vs current behavior, and **not** the
  "halved 0.4.0→0.4.1" delta (we measured the absolute 12–15ms only; do not quote
  "halved" from this run).
- **The memory fix is engine-agnostic** — a rolling display cap
  (`HERMES_TUI_MAX_MESSAGES=3000` default) that is display-only and never touches
  the model's context. Uncapped is a stress config, not real usage (10k msgs
  uncapped: 793 MB; capped sessions are flat MB/h).
- **Gut-check vs upstream/opencode: no bugs.** Exactly one frame callback
  (early-exits cheaply), zero `writeToScrollback` for the transcript (one sticky
  `<scrollbox>` + reactive `<For>`), native `<markdown streaming>` byte-for-byte
  parity with live opencode, no reactive-read-outside-tracking-scope (the #1 Solid
  trap). Source: `docs/plans/opentui-gutcheck-verification.md`.

Full methodology + every cell: see the HTML write-up's benchmark sections and
`docs/plans/opentui-endgame-benchmark-report.md`.

---

## 3. UI parity — and where the two engines genuinely diverge visually

100% *feature* parity is the bar (matrix in §6), but the two engines are **not**
visually identical. The Ink TUI renders the transcript as a **box-drawing tree**;
OpenTUI renders it **flat and marker-based**. This is a deliberate design
divergence, captured in `ui-opentui/src/view/messageLine.tsx`:

> *"the view is a dark room and gold is the single lamp — it sits on the NEWEST
> answer's `⚕` and the user's `❯`, nowhere else (older assistant glyphs demote to
> grey: they merely happened)."*

Real screenshots (saved under `docs/research/opentui-screenshots/`), captured live
on a real PTY 120×40 via the `tmux-pane-screenshot` workflow — **same session
resumed in both engines** where possible.

### Legacy Ink — `docs/research/opentui-screenshots/ink-transcript.png`

![Ink transcript](research/opentui-screenshots/ink-transcript.png)

- **Box-drawing tree layout.** Each turn is a nested structure: `└─ Response`,
  `└─ ▾ Tool calls (1)`, `   └─ ● Terminal("…")` — explicit corner rails and
  disclosure triangles.
- **`┊` dotted quote-bar** prefixes assistant prose.
- **Tool calls collapse by default** behind a `▾ Tool calls (N)` disclosure,
  nested one rail deeper.
- **Whole assistant message tinted gold/amber** (body text is colored, not just
  the marker).
- Right-edge scrollbar: thin `│` track + `┃`/orange thumb.
- Status bar: `─ ready │ opus 4.8 fast high │ 0/1m │ [░░░░░░] 0% │ 25s │ voice off │ 1 session ─ ~`
  — leading dash, pipe-delimited fields, trailing `~`.
- **No top header bar.**

### New OpenTUI — `docs/research/opentui-screenshots/opentui-transcript.png` (+ `opentui-toolcall.png`)

![OpenTUI transcript](research/opentui-screenshots/opentui-transcript.png)

![OpenTUI tool call](research/opentui-screenshots/opentui-toolcall.png)

- **Flat, marker-based layout.** No tree rails. Assistant = `⚕` (caduceus, gold
  only on the newest answer), user = `❯` (gold chevron + gold text). Older
  assistant glyphs demote to grey.
- **Neutral body text.** Gold is reserved for markers and inline-code accents;
  prose is grey/white (the "single lamp" rule), so the screen reads calmer than
  Ink's all-amber blocks.
- **Tool calls render inline, expanded, on one header line:**
  `⚕ ▶ delegate_task  Run the shell command `…`  (/agents to monitor)  · 41s  (11 lines)`
  — marker, `▶` collapse triangle, bold tool name, grey arg preview, hint,
  `· duration`, `(N lines)` — and the result flows flat directly below (no nesting
  rail). Per-tool renderers exist (`view/tools/registry.tsx`) — bash/file+diff/
  read/search/skill/clarify/todo each render differently, not a uniform dump.
- **Per-block `⧉ copy` affordance** on a quiet footer line under every settled
  assistant block and user prompt (click → copies that block's source).
- **Top header bar:** `⚕ Hermes Agent · opentui · ready` + a gold horizontal rule
  (Ink has none).
- Status bar (real backend): `● claude-fable-5 │ [▒▒▒] 4% │ …/lively-thrush/hermes-agent (feat/opentui-native-engine)`
  — green status dot, model, context/token bar, **right-pinned cwd + branch**.

### Divergence summary table

| Aspect | Ink (legacy) | OpenTUI (new) |
|---|---|---|
| Transcript structure | Box-drawing **tree** (`└─`, rails) | **Flat**, indented, marker-based |
| Assistant marker | `└─ Response` rail + `┊` quote-bar | `⚕` caduceus glyph |
| User marker | (rail) | `❯` gold chevron |
| Assistant body color | Tinted gold/amber | Neutral grey/white (gold = accents only) |
| Tool calls | Collapsed `▾ Tool calls (N)`, nested | Inline expanded header + flat result |
| Per-tool rendering | Largely uniform | Dedicated renderers per tool |
| Copy affordance | `/copy` command | `/copy` **+ per-block `⧉ copy`** |
| Header bar | None | `⚕ Hermes Agent · opentui · ready` + rule |
| Status bar | `─`/`│`-delimited, trailing `~` | dot + bars + right-pinned cwd/branch |

**For review:** the divergence is intentional (a design pass, not an accident),
but it means "drop-in replacement" is true at the *feature* level, not the
*pixel* level. A user switching engines will immediately notice the flatter,
calmer transcript. Worth calling out explicitly so the swap isn't sold as
visually invisible.

---

## 4. Non-core / kitchen-sink change audit (what review should scrutinize)

Full report: **`docs/research/opentui-noncore-change-audit.md`** (file-by-file,
commit-by-commit, with `file:line` evidence). Summary below.

This PR's net footprint vs `origin/main` (two-dot diff = exactly this PR's adds,
no main work re-included):

| Bucket | Files | Net diff |
|---|---:|---:|
| UI (`ui-opentui/`, the engine + tests) | 197 | +36,001 / −1 |
| Docs | 8 | +1,164 / −0 |
| **Other (the review-flag surface)** | **28** | **+3,218 / −204** |

The 28 "other" files are the only place this PR touches shared Hermes core. They
classify as:

### ✅ CORE-OPENTUI-NECESSARY (the engine can't work without these; Ink path provably untouched)

- **`hermes_cli/main.py`** (+382/−5) — dual-engine launcher (engine resolution,
  Node 26 / fnm detection, `_make_opentui_argv`, heap override). Default falls
  back to Ink unless the host is OpenTUI-ready (`main.py:1685`); OpenTUI is
  dispatched *around* the Ink bootstrap, never through it (`main.py:1914-1922`).
- **`scripts/install.sh`** (+78/−1) — `install_opentui` stage, **strictly
  best-effort** (every failure returns 0; falls back to Ink; Windows/Termux
  skipped). Ink install path unchanged.
- **`Dockerfile`** (+21/−11) — Node 22→**26** bump (required by the `node:ffi`
  renderer) + `ui-opentui` build step. Opt-in; Ink build line preserved. **Caveat:
  the Node major bump affects the whole image (Ink + web + Playwright)** — the
  diff self-flags "verify the full image build on Node 26 in CI."
- **`hermes_cli/_parser.py`** (+16/−2) — bare `--resume` → OpenTUI session picker;
  `--resume <id>` unchanged.
- **`tui_gateway/server.py`** (+612/−40) — predominantly opt-in RPCs/fields the
  new engine calls (`session.peek`, `session.list` filters, `startup.catalog`,
  `diff_unified`, window-title, skin keys). Each is gated so **the Ink path is
  byte-for-byte unchanged** (`server.py:3930`, `:4254`, `:10447`). *Note:* this
  file also carries some of the cost-accounting code (below) — separable.

> `tui_gateway/` (~12k LOC Python) is **shared by both engines** and is **not**
> removed when Ink is retired. Only the `ui-tui/` frontend tree goes.

### 🚩 FLAG FOR REVIEW — Category C, separable from an OpenTUI PR

These do **not** need to ship with the engine and a reviewer should ask to split
them out:

1. **Provider-reported-cost accounting** (commits `85546bb9e` + `364b93a4b` +
   `e01b04de4`) — a coherent feature spanning **11 files**: `agent/usage_pricing.py`,
   `plugins/model-providers/openrouter/__init__.py`,
   `agent/transports/chat_completions.py`, `agent/agent_init.py`, `run_agent.py`,
   `agent/conversation_loop.py`, `agent/account_usage.py`, `hermes_state.py`,
   `gateway/slash_commands.py`, the cost half of `cli.py`, and the
   `_get_usage`/`_compact_usage_text` blocks of `tui_gateway/server.py` (+ 5 test
   files). Strongest evidence: commit `85546bb9e` *"gateway: capture real
   provider-reported cost (openrouter usage accounting)"* — a provider-accounting
   rework, not a renderer.
2. **`plugins/model-providers/openrouter/__init__.py`** — sends
   `usage:{include:true}`, a provider request-shape change affecting *all*
   interfaces, not just the TUI (`openrouter/__init__.py:85-90` cites the
   OpenRouter usage-accounting docs).
3. **Worktree lock / dirty-tree preservation** (commit `94765e48f`,
   `cli.py` + `tests/cli/test_worktree.py`, ~145 lines) — git-worktree lifecycle
   safety plumbing with **zero TUI references** (`cli.py:1391-1545`, `:1635-1713`).
4. **`tools/clarify_tool.py`** (+16/−4) — docstring/schema-description-only fix
   (commit `16e408f3f`); applies to every interface, trivially separable.

### ✅ Conversation-loop / role-alternation / prompt-cache correctness verdict: **NO RISK**

Verified: none of `run_agent.py`, `agent/conversation_loop.py`,
`agent/agent_init.py`, `agent/transports/chat_completions.py` touch
message-role alternation or the prompt-cache prefix. The
`conversation_loop.py` added lines grep clean for
`cache_control|alternation|prompt_cach|api_messages`; the cache/alternation
machinery (`:57`, `:660-674`, `:759`) is untouched; the PR's insertion at
`:1809-1879` is purely additive cost bookkeeping after `cost_result`. **Prompt
caching and strict role alternation are preserved.**

---

## 5. What this does and does NOT fix

**Provides native replacements for:** layout, scroll, input, copy, mouse,
markdown, resize, and transcript-memory surfaces. This does **not** mean every
Ink behavior on those surfaces is Covered: live-mode switches, command UX,
packaging, and PTY fidelity are tracked row-by-row in the canonical parity
matrix. Windowing + Solid keyed `<For>` unmount→`destroy()`→`free()` addresses
the mounted-renderable memory class without proving the rest of the renderer
bug class closed.

**Does NOT fix:** the gateway is unchanged — the biggest single hotspot file in
triage is `tui_gateway/server.py`, and whole bug clusters are gateway/Python-side
(WS write-timeout/RPC pool, MCP-failure startup freezes, shell.exec denylist).
The engine swap addresses rendering/input/scroll/memory; **gateway bugs ride
along.** The Effect-boundary hardening does make those failures *visible* (typed
events → system lines instead of a frozen spinner) and the TUI auto-heals
(crash → backoff → respawn → resume, capped 3/60s).

---

## 6. Feature parity status (canonical ledger, not this PR snapshot)

The maintained, surface-by-surface ledger is
**`docs/opentui-parity-matrix.md`**. Do not derive release readiness or totals
from the historical claims that used to live in this section.

The current f7c9 busy-input batch is deliberately recorded as follows until a
real-PTY Ink/OpenTUI comparison passes:

| Surface | State | Current contract / remaining gap |
|---|---|---|
| `/queue`, `/q` | **Thinner** | Count/enqueue, three-row view, edit/remove/send, confirmed `--clear`, and bounded recovery exist; typed queue provenance does not. |
| `/steer` | **Thinner** | Direct live injection and lossless bounded fallback exist; real child/PTY timing and UX still need comparison. |
| `/busy` | **Thinner** | `queue`, `steer`, `interrupt`, and `status`, plus `config.yaml` persistence, immediate local application, and five-second mtime refresh exist; real-PTY parity is pending. |
| `/undo` | **Thinner** | Direct `session.undo`, visible exchange trim, busy/SID/history-mutation guards, and feedback exist. Ink does not prefill `/undo`; the old prefill claim was false. |
| `/retry` | **Thinner** | Captures the last user body, rewinds, trims visible state, resubmits once, and restores rejected input; live PTY validation remains. |
| Busy Queue UX | **Thinner** | Explicit row Enter and double-empty Enter send while Ctrl/Cmd+K remains delete-to-line-end; uncertain delivery halts automatic drain; the queue is capped at 100 rows / 4,194,304 UTF-16 code units, mounts three rows, and limits native edit/history to 16,384 code units. |

The queue's one intentional safety divergence is also a parity gap: every
queued row is currently sent as a model prompt. Ink can reinterpret a drained
`!command` or other syntax; OpenTUI refuses surprising local execution until a
typed prompt/skill/slash/shell queue-item model exists.

Focused evidence for this uncommitted batch is 302 TypeScript tests plus 9
targeted gateway tests. The full `npm run check` total and the real-PTY parity
run are still pending, so none of the rows above is a production-complete or
Covered claim.

---

## 7. Rollout, runtime & risks

- **Runtime:** plain Node 26 (FFI floor 26.3+) — one runtime, no Bun. (Note: the
  upstream OpenTUI docs say "requires Bun"; this engine deliberately runs on Node
  26's experimental `node:ffi` instead — that's the load-bearing runtime decision.)
- **Rollback:** Ink is untouched and remains the fallback; reverting is a launcher
  decision, not a code revert.
- **Default-engine selection:** auto-picks OpenTUI only when the host is genuinely
  set up (Node ≥ 26.3 + built bundle), else Ink; explicit env/config bypasses the
  probe.
- **Known sharp edges:** `libopentui.so` native-lib distribution (P1 upstream:
  copies can fill `/tmp`); the Dockerfile Node major bump needs full-image CI
  verification; tree-sitter grammars are fetched from GitHub on first use and
  cached in `~/.hermes/cache/opentui-parsers/` — air-gapped hosts get plain-text
  highlighting until the cache is pre-seeded (the fetch never blocks boot and
  never throws).

## 8. Try it

```bash
hermes                              # auto-selects OpenTUI when the host supports it
HERMES_TUI_ENGINE=opentui hermes    # force the native engine
HERMES_TUI_ENGINE=ink hermes        # force the legacy Ink engine
# preview standalone (no backend), Node 26:
cd ui-opentui && npm install
node scripts/build.mjs scripts/demo.tsx .demo
DEMO_TOTAL=120 HERMES_TUI_MAX_MESSAGES=80 \
  node --experimental-ffi --no-warnings ./.demo/demo.js   # inside a TTY
```

Requires Node 26.3+. On older Node / Windows / Termux it auto-falls-back to Ink.

---

## Appendix — source-of-truth files in this repo

| Topic | File |
|---|---|
| Non-core change audit (full) | `docs/research/opentui-noncore-change-audit.md` |
| Feature parity matrix (canonical) | `docs/opentui-parity-matrix.md` |
| Benchmark report | `docs/plans/opentui-endgame-benchmark-report.md` |
| Gut-check verification | `docs/plans/opentui-gutcheck-verification.md` |
| Ink↔OpenTUI capture asymmetry | `docs/plans/opentui-ink-asymmetry-note.md` |
| UI screenshots | `docs/research/opentui-screenshots/{ink,opentui}-*.png` |
| PR description (prose) | `docs/pr-description-main-doc.md` |
| Interactive write-up | `~/projects/opentui-perf-writeup/index.html` (out-of-repo) |
