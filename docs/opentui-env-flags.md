# OpenTUI env flags — the consolidated ledger

Every environment variable the OpenTUI TUI reads (grep-verified 2026-06-12),
classified by who should ever touch it. The design rule shipped with this doc:
**regular users see zero diagnostic surface by default; one master switch
(`HERMES_TUI_DIAGNOSTICS=1`) turns all of it on when needed.**

## 1. The master switch

| var | default | effect |
|---|---|---|
| `HERMES_TUI_DIAGNOSTICS` | **off** | Enables the diagnostic slash commands (`/mem`, `/heapdump`). While off they're hidden from `/help` (client-side filter) and invoking them prints the enable hint rather than executing. They never appear in slash *completion* in either state — completion is gateway-driven and these are client-only commands the gateway doesn't know (an adversarial review confirmed there's no bypass path; if a SERVER command named `mem`/`heapdump` is ever added it must be gated gateway-side too — the client gate would shadow but not hide it). Also flips the *default* of `HERMES_TUI_WINDOW_STATS` to on. Not a secret — support flows are "relaunch with `HERMES_TUI_DIAGNOSTICS=1`". |

## 2. User-facing configuration (fine to document publicly)

| var | default | effect |
|---|---|---|
| `HERMES_TUI_ENGINE` | auto (`opentui` if Node≥26.3 + built, else `ink`) | Engine pick; also `display.tui_engine` in config.yaml. |
| `HERMES_TUI_MOUSE` / `HERMES_TUI_MOUSE_TRACKING` / `HERMES_TUI_DISABLE_MOUSE` | on | Mouse support (wheel scroll, selection, click-to-expand). **Defers to Ink's env surface (`logic/env.ts` `resolveMouseEnabled`):** precedence is `HERMES_TUI_MOUSE_TRACKING` (toggle, force knob) > `HERMES_TUI_DISABLE_MOUSE=1` (legacy kill switch) > `HERMES_TUI_MOUSE` (OpenTUI-native alias, kept — also what the launcher sets) > default on. OpenTUI's renderer mouse is a single boolean, so Ink's granular off\|wheel\|buttons\|all collapses to on/off (the granular mode lives in `display.mouse_tracking` config). |
| `HERMES_TUI_SCROLL_SPEED` (alias `CLAUDE_CODE_SCROLL_SPEED`) | native | Wheel-scroll speed multiplier (Ink parity). UNSET → OpenTUI's native scroll acceleration (untouched). A positive value (clamped to (0,20]) installs a constant-multiplier `ScrollAcceleration` on the transcript scrollbox (`view/transcript.tsx`). |
| `HERMES_TUI_NO_CONFIRM` | off | Skip the destructive-action confirm step (`/clear`, `/new`) and run immediately (Ink parity, `NO_CONFIRM_DESTRUCTIVE`). Wired at the `confirm` seam (`entry/main.tsx`). |
| `HERMES_TUI_MAX_MESSAGES` | ceiling | Scrollback rows kept in the TUI. Can LOWER the ceiling, never raise: 3000 with windowing, 1000 with windowing off (handle-table safety). |
| `HERMES_TUI_TOOL_OUTPUT_LINES` | unlimited | Cap expanded tool-output lines (set a number to restore a cap). |
| `HERMES_TUI_TOOL_OUTPUTS` | **on** | Keep rich tool-call OUTPUTS (full result body + raw result/args dicts). `=off` drops both the RENDER and the STORE of those bodies (Ink parity: only a one-line context preview + name/duration/error/diff survive) — the memory lever for the OpenTUI-vs-Ink retention asymmetry, and what the bench launches OpenTUI with for the fair engine-overhead comparison (W3). Diffs (file-edit) are KEPT either way. |
| `HERMES_TUI_HEAP_MB` | cgroup-aware (default 8192) | V8 `--max-old-space-size` (MB) for BOTH engines. Highest precedence (then `display.tui_heap_mb` config, then the cgroup-75% fallback). Set it LOW for a low-mem session (still cgroup-clamped on top so it never exceeds the container); raise it to lift the ceiling. The low-mem opt-in signal that also arms `HERMES_TUI_PROACTIVE_GC` (W1). |
| `HERMES_TUI_PROACTIVE_GC` | = low-`HERMES_TUI_HEAP_MB` (≤4096) | Idle-gated `global.gc()` for the low-mem path. Defaults ON only when a low heap cap is set (so the knobs compose); `=on`/`=off` forces it. Needs `--expose-gc` (the OpenTUI argv now carries it). Never runs mid-stream; tightens cadence above 400MB RSS but stays idle-gated. OpenTUI-only — Ink never GCs proactively (W2). |
| `HERMES_TUI_COMPOSER_ROWS` | default rows | Composer height. |

## 3. Escape hatches & tuning (dev-facing, individually settable)

| var | default | effect |
|---|---|---|
| `HERMES_TUI_WINDOWING` | **on** | `0` = bit-exact pre-windowing renderer (every row mounts; cap clamps back to 1000). The A/B + regression escape hatch. |
| `HERMES_TUI_WINDOW_IDLE_MS` | ~1000 | Idle-measure pulse cadence (the spacer-exactness march). Test knob. |
| `HERMES_TUI_WINDOW_STATS` | = `HERMES_TUI_DIAGNOSTICS` | Exposes live/peak mounted-row counters (`globalThis.__hermesTuiWindowStats`) for tui-bench's live-attach reads. |
| `HERMES_TUI_MEMLOG` | = `HERMES_TUI_DIAGNOSTICS` | In-process 1Hz memory self-sampling (`boundary/memlog.ts`) → `~/.hermes/logs/memwatch/<boot>-<pid>.jsonl` (rss/heap/external + mounted rows; 14-day retention). Fleet view: `node memwatch-report.mjs` from the tui-bench repo (`github.com/NousResearch/tui-bench`). The "monitor all my sessions" answer: one `export HERMES_TUI_DIAGNOSTICS=1` in your shell rc covers every session. |
| `HERMES_TUI_LOG_LEVEL` / `HERMES_TUI_LOG_FILE` | engine defaults | Logging verbosity/destination. `/logs` reads the separate transport-owned, 200-line gateway ring (spawn/readiness/stderr/protocol/RPC error, timeout, and write failures), so it remains useful even when file-log verbosity is low. Deliberately independent of the master switch — support often wants logs without the full diag surface. |
| `HERMES_HEAPDUMP_ON_START` | off | Write one V8 heap snapshot at boot (Ink parity). A deliberate baseline-capture escape hatch that BYPASSES the diagnostics master switch; lands at `$HERMES_HOME/logs/opentui-heap-<ts>.heapsnapshot` and echoes the path as a system line (`entry/main.tsx`). |
| `HERMES_TUI_NOTIFY` | on | Desktop-notification kill switch (`=0`/`false`/`off` silences the "waiting on you" pings). The ping itself goes through the renderer's native `triggerNotification` (protocol detection + tmux/Zellij wrapping); the window title is not gated by this. |

## 4. Internal plumbing (set by the launcher/tui-bench/tests — humans never set these)

| var | set by | effect |
|---|---|---|
| `HERMES_PYTHON`, `HERMES_PYTHON_SRC_ROOT`, `HERMES_CWD`, `TERMINAL_CWD` | launcher / bench | `HERMES_PYTHON` and `HERMES_PYTHON_SRC_ROOT` select the gateway interpreter/runtime. The Python process starts with that runtime as its import cwd; `HERMES_CWD` / `TERMINAL_CWD` separately anchor the user's workspace (including the isolated project worktree created by `-w`). |
| `HERMES_TUI_ACTIVE_SESSION_FILE` | launcher/bench | Session handoff file. |
| `HERMES_TUI_DASHBOARD` | dashboard PTY launcher | Marks the TUI as hosted. Explicit `/quit`/`/exit` and `/update` are refused; idle Ctrl+C or action+D publishes `dashboard.new_session_requested` instead of destroying the PTY. Busy Ctrl+C still only interrupts. This flag is the sole hosted-mode discriminator; `HERMES_TUI_INLINE` is not equivalent. |
| `HERMES_TUI_SIDECAR_URL` | dashboard PTY launcher | Event-publisher WebSocket consumed by the spawned Python `tui_gateway.entry`. The JS engine still uses its stdio Effect boundary; server `_emit` frames (including hosted new-session requests) are mirrored to the dashboard through the existing multiplexed publisher. |
| `HERMES_TUI_RESUME`, `HERMES_TUI_QUERY`, `HERMES_TUI_PROMPT`, `HERMES_TUI_IMAGE`, `HERMES_TUI_FAKE` | launcher/tests | Resume-at-boot; seeded prompt (`--tui "prompt"`: launcher sets `HERMES_TUI_QUERY`, the engine reads QUERY > the `HERMES_TUI_PROMPT` alias > a bare argv tail — `logic/env.ts` `startupPrompt`); seeded image PATH (`--image`: `HERMES_TUI_IMAGE`, `image.attach`ed before the prompt — `startupImage`, attach in `postSessionSetup`); fake-mode. |
| `HERMES_AUTO_HEAPDUMP*` (`_COOLDOWN_MS`/`_MAX_BYTES`), `HERMES_HEAPDUMP_DIR`, `HERMES_HEAPDUMP_MAX_BYTES` | — | **NOT read by the OpenTUI engine (deliberate).** The engine ports Ink's #34095 silent-death early-WARNING (a transcript system line, `boundary/memoryMonitor.ts`) but NOT the auto heap-SNAPSHOT capture — the always-on memlog NDJSON trace is the diagnosis path, and its rss-vs-heap divergence is the better diagnostic for the native-RSS leak class (#15141) a V8 snapshot captures poorly. So the #41948 disk-fill safety set (gate/cooldown/byte-cap/dir) has no consumer here. `HERMES_HEAPDUMP_ON_START` (manual one-shot, §3) is the only heapdump knob the engine honors. |
| `HERMES_TUI_RPC_TIMEOUT_MS`, `HERMES_TUI_STARTUP_TIMEOUT_MS` | tests/CI | Protocol timeouts. |
| (`ui-tui` only) `HERMES_TUI_MEMSAMPLE_FD/MS` | bench | Ink fd-3 node sampler. |

## 5. Ink flags NOT ported — handled natively or out of scope

These exist on the legacy Ink TUI (`ui-tui/`) and are deliberately **not** read
by the OpenTUI engine. Documented so a missing flag reads as a decision, not a gap.

| Ink flag | why not ported |
|---|---|
| `HERMES_TUI_TRUECOLOR` | OpenTUI core does COLORTERM/truecolor detection natively — the Ink force-truecolor hack is a fork workaround we shed. |
| `HERMES_TUI_FORCE_OSC52` | OpenTUI core owns OSC52 clipboard as a primitive; no fallback hint needed. |
| `HERMES_TUI_INLINE` / `HERMES_TUI_TERMUX_MODE` / `HERMES_TUI_TERMUX_FAST_ECHO` | Termux/primary-buffer accommodations. OpenTUI's native FFI floor (Node ≥26.3 + `--experimental-ffi`) is absent on Termux, so those sessions stay on **Ink** — these are correctly N/A for the OpenTUI engine. |
| `HERMES_TUI_FPS` | Ink FPS overlay; the OpenTUI equivalent is the diag/window-stats surface (`HERMES_TUI_WINDOW_STATS`). Not parity-critical. |
| `HERMES_DEV_CREDITS` / `HERMES_DEV_PERF*` | Dev-only throwaway scaffolding (live-spend readout, perf logging) — not user parity. |
| `HERMES_BIN` / `HERMES_TUI_GATEWAY_URL` | External-CLI / remote-gateway-URL overrides. OpenTUI spawns its gateway via the Effect boundary (`liveGateway.ts`) and does not shell out to `hermes` or take an external gateway URL. (`HERMES_TUI_SIDECAR_URL` is supported internal dashboard plumbing; see §4.) |
| `HERMES_VOICE` | Voice mode is tracked on the OpenTUI parity backlog separately, not here. |

## How the pieces compose (the support script)

- Regular user, normal day: zero flags, zero diagnostic commands visible.
- "My TUI feels heavy" support flow: `HERMES_TUI_DIAGNOSTICS=1 hermes` → `/mem`
  for the live numbers, `/heapdump` for a snapshot to attach, window stats
  exposed for tui-bench's `live-attach.sh <pid>` to read.
- Developer profiling: same master switch + the individual knobs
  (`HERMES_TUI_WINDOWING=0` A/B, `WINDOW_IDLE_MS` tuning) as needed.
- Anything in section 4 appearing in a user-facing doc is a bug.

Gating implementation: `logic/env.ts` (`diagnosticsEnabled()`),
`logic/slash.ts` (`DIAGNOSTIC_COMMANDS` — dispatch hint, help + completion
filtering), `view/transcript.tsx` (stats default). Tests:
`slash.test.ts` (gating both states), `utilityCommands.test.ts` (commands
themselves, gate enabled suite-wide).
