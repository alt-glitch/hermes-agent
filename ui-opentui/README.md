# ui-opentui — native OpenTUI engine for Hermes

Solid + `@opentui/core@0.4.1` over Node FFI, with Effect 4 only at transport and
resource boundaries. This is the production v1 TUI on supported hosts; Ink
(`ui-tui/`) remains the supported fallback. Current parity lives in
`../docs/opentui-parity-matrix.md`; the final local gate and benchmark record is
`../docs/opentui-release-evidence-f7c9.md`.

## Node 26 setup (required; will not touch your other projects)

This package needs **Node ≥ 26.3** (`--experimental-ffi` floor). Everything
else on this machine/repo can keep whatever Node it already uses — pin 26 to
this directory only:

```sh
# 1. install fnm (skip if you have it; nvm/mise work too — see below)
curl -fsSL https://fnm.vercel.app/install | bash
# add to ~/.zshrc (or bashrc): eval "$(fnm env --use-on-cd --shell zsh)"

# 2. install Node 26 SIDE BY SIDE (does NOT change your default)
fnm install 26

# 3. done — this directory has a .node-version (26.3), so `cd ui-opentui`
#    auto-switches to 26 and leaving switches back. Do NOT run `fnm default 26`.
node -v   # v26.x here; your old version everywhere else
```

No shell integration wanted (CI, scripts, one-off): `fnm exec --using 26 -- node ...`
or invoke the absolute binary (`~/.local/share/fnm/node-versions/v26.*/installation/bin/node`).
mise users: `mise use node@26` in this directory. nvm users: `nvm install 26`,
plus an `.nvmrc` shim (`echo 26 > .nvmrc`) if you rely on auto-switching.

### Gotchas

- **Native modules are ABI-locked.** A `node_modules` installed under Node
  20/22 will not load under 26 (and vice versa) — run `npm ci` (or
  `npm rebuild`) after switching versions. Same applies to the **tui-bench** repo's node-pty (`github.com/NousResearch/tui-bench`).
- **Global npm packages don't follow** between versions (per-version prefix);
  reinstall the few you need, or don't use globals.
- **Editor terminals** (Zed/VS Code) need the `fnm env` line in your shell rc;
  the `.node-version` auto-switch then covers any shell that cd's here.
- **Never run this package with bun** — the FFI seam and the Solid/JSX build
  are Node-path only here.
- `package.json` declares `engines.node >= 26.3`, so a wrong-Node `npm ci`
  warns immediately.

## Build & run

```sh
node scripts/build.mjs
HERMES_TUI_MOUSE=1 node --experimental-ffi --no-warnings dist/main.js
```

### Live PTY smoke with terminal-control

`termctrl --host opentui` is the primary visual/interactive smoke driver. Under
an agent/CI command sandbox, run `termctrl start` from a retained interactive
shell PTY; a one-shot parent may reap the session daemon. Pass launch variables
with `/usr/bin/env` after `--` so the OpenTUI child inherits them.

```sh
termctrl start tui --host opentui --cols 132 --rows 40 --record /tmp/tui.termctrl -- \
  /usr/bin/env HERMES_TUI_ENGINE=opentui HERMES_TUI_MOUSE=1 hermes
termctrl wait --timeout 20000 tui "Type to chat"
termctrl show tui
termctrl resize tui --cols 100 --rows 30
termctrl show tui # inspect the settled post-resize frame before persisting it
termctrl save tui --format png --out /tmp/hermes-opentui.png
termctrl stop tui
```

For a gateway/model-free fixture, build and launch the demo with an explicit
relative path (`./.demo/demo.js`, not `.demo/demo.js`):

```sh
node scripts/build.mjs scripts/demo.tsx .demo
DEMO_TOTAL=200 HERMES_TUI_MAX_MESSAGES=80 \
  termctrl start demo --host opentui --cols 132 --rows 40 -- \
  node --experimental-ffi --no-warnings ./.demo/demo.js
```

Keep focused unit/contract tests and an inline termctrl smoke with each task.
Run `npm run check`, a production build, and one adversarial review over the
combined feature-category diff. Run startup/hydration/RSS/renderable/CPU and
repeated-cycle leak measurements once, at the final parity gate. Memory/perf
benchmarks live in the **tui-bench** repo
(`github.com/NousResearch/tui-bench`; see its README). The retained f7c9 run
filenames, medians, quality gates, and live-smoke caveat are recorded in
`../docs/opentui-release-evidence-f7c9.md`. Transcript windowing is
documented in `../docs/plans/opentui-transcript-windowing.md`.

The universal wheel ships a portable source/bundle/lock seed, not native
`node_modules`. A cold OpenTUI activation therefore needs Node 26 and npm
registry access; strict offline parity with the prebundled Ink engine requires
platform-specific artifacts or bundled npm tarballs.

## Support and rollback policy

- OpenTUI is supported on Linux and macOS, x64 and arm64, with Node 26.3 or
  newer. Hermes selects it automatically when its verified runtime is present.
- Windows and Termux remain supported through Ink because the required Node FFI
  runtime is unavailable there. Ink is also the recovery path on any host:
  `HERMES_TUI_ENGINE=ink hermes` for one launch, or set
  `display.tui_engine: ink` in `~/.hermes/config.yaml` persistently.
- Both engines use the same Python gateway and session store. Rolling back the
  renderer does not migrate, rewrite, or discard conversation history.
- To return to OpenTUI, remove the persistent override (or set it to
  `opentui`) and run `hermes`; runtime validation/build failures fail clearly
  and leave Ink available for recovery.

## Local UX contracts

- `/help`, `/quit`/`/exit`, `/update`, `/redraw`, `/history`, `/fortune`, and
  `/logs` run in the client from live state rather than a detached slash worker.
  The parity matrix records the deliberate `/history` safety divergence below.
- `/history` retains Ink's latest-800-row view, clips each preview to
  80–4,000 characters (400 default), and caps the native pager source at
  512 Ki UTF-16 code units with explicit truncation notices. The pager is one
  native text renderable, not one handle tree per line.
- `/logs [n]` reads a bounded gateway-transport ring with lifecycle, stderr,
  protocol, and RPC error/timeout/write diagnostics; oversized lines carry a
  truncation marker.
- Width/detail changes invalidate off-window height generations while preserving
  byte-stable visible corrections. External config refresh revision-fences
  compact/details/section changes; bell, inline-diff, paste-threshold, and
  streaming fan-out remain explicit product decisions.
- Hosted dashboard mode is internal launcher plumbing
  (`HERMES_TUI_DASHBOARD=1`): exits/updates are refused and idle Ctrl+C or
  action+D requests a fresh browser chat through the existing event sidecar.

## Busy input and queue contracts

- Configure `display.busy_input_mode: queue|steer|interrupt` in
  `~/.hermes/config.yaml`. The full-screen TUI defaults to `queue`; `/busy`
  persists and applies a mode immediately. An Effect-scoped watcher checks the
  config mtime every five seconds and rehydrates the mode from `config.get full`
  after external edits.
- `queue` parks the message for the next turn. `steer` asks the live agent to
  inject it after the next tool call and falls back without dropping the body.
  `interrupt` parks first, then interrupts, so the body survives the settle.
- A steer ACK is best-effort admission into the live process, not durability.
  Rejection or a definite RPC error returns the body to the bounded
  local queue. After a child crash, unsent queue rows and the draft survive,
  but an uncertain in-flight prompt/steer is reported and never auto-replayed.
- `/queue` (alias `/q`) reports or appends; `/steer <prompt>` injects directly;
  `/undo` rewinds the last exchange; `/retry` rewinds and resubmits it. These
  commands serialize history mutation and preserve rejected bodies. Use
  `/queue --clear` for a confirmed bulk discard.
- Up/Down selects one of the queued rows; Enter edits/sends, Ctrl+X deletes, and
  Esc cancels. Ctrl/Cmd+K keeps OpenTUI's stock delete-to-line-end behavior. Two
  empty Enter presses within 450 ms stop the current turn or force the next row
  while idle.
- The queue holds at most **100 messages** and **4,194,304 UTF-16 code units**.
  Only three preview rows mount. Bodies above **16,384 code units** stay
  sendable/deletable but do not enter the native textarea, and local composer
  history uses the same 16 Ki ceiling. Reproduce the queue-specific retained
  memory, native-allocation, renderable, and edit-latency measurements with
  `node scripts/build.mjs scripts/queue-bench.tsx .bench`, then
  `node --experimental-ffi --expose-gc --no-warnings .bench/queue-bench.js`.

Parity status is intentionally **Thinner** for `/queue`, `/steer`, and the
aggregate Busy Queue UX because their bounded/provenance and delivery-admission
divergences are accepted production decisions. Queued entries are currently always sent as model
prompts: unlike Ink,
the engine will not reinterpret a queued `!command`, slash-like string, or
flattened skill body as executable local syntax until the queue has typed
provenance. See `../docs/opentui-parity-matrix.md` for the canonical ledger.
