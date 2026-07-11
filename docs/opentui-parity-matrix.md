# OpenTUI parity matrix

This is the canonical parity ledger for the native Hermes TUI. It compares the
OpenTUI engine with the Ink UI at upstream commit
`f7c9feb395caa27ec79386b1ed3ae7b4675486a1`. The reconciled fork baseline is
`7a9e0d9d3d23d5642e0c7b4c804329fcfd378119`.

Runtime baseline: Node 26.3, `@opentui/{core,keymap,solid}@0.4.1`, and
`effect@4.0.0-beta.78`. The slash denominator is the exact 58 commands in
`ui-tui/src/app/slash/registry.ts::SLASH_COMMANDS`, not the larger Python
command registry.

Status meanings:

- **Covered** — the Ink behavior contract is implemented and verified.
- **Thinner** — the primary operation works, but some live-state, feedback, or
  interaction contract is absent.
- **Missing** — the live contract is absent or runs in an isolated process and
  cannot affect the active TUI/session correctly.
- **In progress** — actively being implemented; never counts as shipped.
- **Intentional skip** — an explicit supported-platform/product decision.

Current slash tally: **19 Covered, 24 Thinner, 14 Missing, 0 In progress, 1
Intentional skip**.

## Slash commands

| # | Command | Status | Contract still required / evidence |
|---:|---|---|---|
| 1 | `/help` | Covered | Effect-decoded catalog caching renders Ink categories, skill count, discovery warnings, TUI-only rows, platform-aware implemented hotkeys, and the skin `helpHeader`; malformed/offline fallback and stale-flight fencing are tested. |
| 2 | `/quit`, `/exit` | Covered | Local shutdown runs renderer/Effect finalizers; hosted dashboard chat returns Ink's exact refusal. Idle Ctrl+C/action+D instead publishes the sidecar new-session event, while overlays retain input ownership. |
| 3 | `/update` | Covered | Local mode reports the handoff and exits cleanly with code 42 for the unchanged Python launcher; hosted mode returns Ink's exact managed-environment refusal. |
| 4 | `/mouse`, `/scroll` | Missing | Hot-swap renderer tracking modes and persist them; launch-time mouse config alone is insufficient. |
| 5 | `/clear`, `/new [title]` | Covered | Busy guard and Ink-equivalent confirmation feed a transactional `setup.status → session.close → session.create`; adoption resets all session-owned state, preserves process-global presentation, supports titles, fences old live SIDs, and safely drains submissions queued during the switch. |
| 6 | `/redraw` | Covered | Public frame buffers are invalidated and the terminal is repainted without suspend/resume; slash redraw preserves selection while action+L clears it, a same-stdin-chunk regression proves later key bytes survive, and real PTY smoke passes. |
| 7 | `/status` | Covered | Decoded direct `session.status` uses the active SID, always pages the authoritative live snapshot, and drops late old-SID or superseded same-SID replies. |
| 8 | `/title` | Covered | Decoded direct query/rename preserves pending/error feedback, refreshes title chrome immediately, and fences late responses by SID plus slash flight. |
| 9 | `/compact` | Covered | `logic/slash.ts::compactCmd` updates live display state and persistence. |
| 10 | `/details`, `/detail` | Thinner | Global modes work; add per-section thinking/tools/subagents/activity modes. |
| 11 | `/fortune` | Covered | Ink's corpus, random mode, SID+local-date deterministic daily aliases, help row, and live `/f` completion are local and tested. |
| 12 | `/copy [n]` | Thinner | Prefer current terminal selection, then match Ink response indexing and feedback. |
| 13 | `/paste` | Missing | Route through the existing clipboard-image and `image.attach` boundary. |
| 14 | `/prompt`, `/compose` | Missing | Suspend the renderer, edit the draft in `$EDITOR`, and restore safely on success/failure/signals. |
| 15 | `/terminal-setup` | Missing | Port the external terminal-keybinding setup handoff. |
| 16 | `/logs [n]` | Covered | Reads the real transport-owned 200-line ring (spawn/readiness/stderr/protocol/RPC error, timeout, and write failures), clamps 1..80, marks 4,096-character truncation, and renders the requested tail in the native pager. |
| 17 | `/history [preview]` | Thinner | Live rows, Ink labels/tool fallback, and latest-800-row semantics are covered, but production safety deliberately caps previews at 4,000 characters and the pager at 512 Ki. Approve this exception or add a lazy/chunked viewer that exposes every byte without OOM risk. |
| 18 | `/save` | Covered | Decoded direct `session.save` exports uncapped gateway history, preserves Ink's no-conversation/no-SID UX, reports the path/errors, and fences late replies. |
| 19 | `/statusbar`, `/sb` | Missing | Live off/top/bottom/toggle state plus persistence and responsive frame tests. |
| 20 | `/queue`, `/q` | Thinner | Count/preview, bounded enqueue, three-row native view, edit/remove/send, confirmed clear, transition recovery, and reset behavior exist. Real-child termctrl proves FIFO drain, crash retention, and recovery. Settle typed provenance for shell/slash-like rows and explicitly approve the 100-row/4-Mi-character safety ceiling versus Ink's unbounded string queue. |
| 21 | `/steer` | Thinner | Direct live injection uses upstream's in-memory `session.steer`; rejection or a definite RPC error retains the body in the local queue. Timeout/transport ambiguity retains the body, halts automatic drain, and requires an explicit retry. Real-child termctrl proves mid-turn delivery, fallback, and crash recovery; the remaining divergence is that an ACK is best-effort process admission rather than durable delivery. |
| 22 | `/undo` | Thinner | Upstream `session.undo`, visible exchange trim, busy/SID/history-mutation guards, and feedback exist; final real-child validation remains. The mutation is process-local, not a new durable DB contract, and Ink intentionally does not prefill `/undo`. |
| 23 | `/retry` | Thinner | Matches Ink's client sequence: remember the last user text, call `session.undo`, trim the visible exchange, then submit once; the non-parity `session.retry` RPC/lease path is gone. Complete real-child one-resubmission/error-restoration validation. |
| 24 | `/billing` | Covered | Native billing overlay and RPC logic are present; device verification is tracked separately below. |
| 25 | `/credits` | Thinner | Direct balance/identity/top-up RPCs, confirmation, and safe URL opening. |
| 26 | `/background`, `/bg`, `/btw` | Covered | Direct `prompt.background` and background-task badge tracking. |
| 27 | `/model` | Thinner | Busy guard, refresh, provider onboarding, expensive-model confirm, and session/global persistence choice. |
| 28 | `/sessions`, `/session`, `/switch`, `/resume` | Thinner | Paged/searchable picker and direct resume use guarded transactional switching with persisted-vs-ephemeral SID separation, rollback, event fencing, catalog refresh, bounded drain, and skin-aware animated list/load-more/preview loading. Termctrl proves scoped loading and live resume; add live siblings, `/sessions new`, close/delete, and model-selection flows. |
| 29 | `/image` | Missing | Reuse direct `image.attach` and preserve any remainder text for the composer. |
| 30 | `/personality` | Covered | The live gateway mirror applies personality without a detached-only mutation. |
| 31 | `/compress` | Thinner | Gateway compression works; replace the visible snapshot/info/usage afterward. |
| 32 | `/branch`, `/fork` | Missing | Direct `session.branch`, close/adopt the returned SID, reset chrome, and fence old events. |
| 33 | `/voice` | Missing | Direct toggle/status/TTS, record key, reducer/view state, and real audio smoke. |
| 34 | `/pet` | Intentional skip | Novelty surface remains available through Ink; do not displace production blockers. |
| 35 | `/skin` | Covered | `skin.changed` drives the reactive OpenTUI theme. |
| 36 | `/indicator` | Missing | Direct config RPC and immediate busy-indicator update. |
| 37 | `/yolo` | Covered | Gateway-process mirror changes the active session approval mode. |
| 38 | `/reasoning` | Thinner | Full/clamp is local; effort/show/hide must use direct live RPC and section state. |
| 39 | `/fast` | Thinner | Direct status/config path, model-support validation, request overrides, and exact feedback. |
| 40 | `/busy` | Thinner | Queue/steer/interrupt policy, `config.yaml` persistence, immediate local application, and transition-gated five-second refresh of `display.busy_input_mode` exist. Termctrl proves an external mtime change during `/tools` settles without a competing reload or deadlock; make bare/status query authoritative `config.get` like Ink instead of cached local state. |
| 41 | `/verbose` | Missing | Direct live tool-progress/agent verbosity mode and visible state. |
| 42 | `/usage` | Thinner | Use `session.usage` and render structured token/context/compression/credit data. |
| 43 | `/stop` | Thinner | Direct `process.stop` and exact killed-count/error feedback. |
| 44 | `/reload-mcp` | Thinner | Live reload, process-global idle admission, responsive prompt rejection, and RPC cache warning/confirmation exist. The slash mirror intentionally treats the typed command as consent; restore aliases, align that confirmation UX, and add detailed result copy. |
| 45 | `/reload` | Covered | Decoded direct `reload.env` runs in the live gateway, validates its update count, renders exact singular/plural feedback, and drops superseded results. |
| 46 | `/browser` | Missing | Direct `browser.manage`, progress presentation, and live CDP indicator. |
| 47 | `/rollback` | Thinner | Use structured list/diff/restore RPCs and reconcile visible transcript state. |
| 48 | `/agents`, `/tasks` | Thinner | Live events, running-agent status chip, tray handoff, and a native master/detail trace dashboard work. Add pause/resume/status, kill-one/subtree, completed-turn history, replay/diff integration, sort/filter, timeline/tree metrics, and the parked-subagent resume hint. |
| 49 | `/journey`, `/learning`, `/memory-graph` | Missing | Target gateway `learning.*` exists; port the timeline/detail/edit/delete overlay. |
| 50 | `/replay` | Thinner | Disk list/load pager exists; add in-memory history/navigation and dashboard integration. |
| 51 | `/replay-diff` | Missing | Add pair selection, diff state, and native dashboard view. |
| 52 | `/reload-skills` | Covered | Decoded direct `skills.reload` removes confirmed-deleted names immediately, refreshes `commands.catalog` aliases/canonical names, preserves dynamically learned plugin commands, reports refresh failure, and is SID/flight fenced. |
| 53 | `/skills` | Thinner | List/inspect picker works; preserve explicit search/install/browse/manage subcommands. |
| 54 | `/plugins` | Thinner | Text worker path exists; port the bare interactive user/bundled enable/disable hub. |
| 55 | `/tools` | Covered | List/status retains Ink's worker presentation; enable/disable uses decoded live `tools.configure`, busy/transition guards, atomic gateway mutation/close coordination, same-SID state replacement, catalog/model refresh, nullable detached feedback, and bounded post-reset submission drain. |
| 56 | `/setup` | Missing | Suspend OpenTUI, run the full external setup wizard, and restore the renderer. |
| 57 | `/heapdump` | Thinner | Native snapshot works but is diagnostics-gated and lacks Ink's diagnostics sidecar contract. |
| 58 | `/mem` | Thinner | Native panel adds renderable count but is diagnostics-gated; settle the shipping visibility policy. |

Extension commands are separate from the 58-command denominator. Skill and
quick-command discovery/dispatch are covered through `complete.slash`,
`commands.catalog`, `dispatchSlash`, `handleDispatchResult`, and `SkillLine`.

## UX, protocol, and release ledger

| Surface | Status | Contract / close condition |
|---|---|---|
| Effect 4 protocol boundary | Covered | Decode once with `Schema`, keep transport/lifecycle in Effect, and keep Solid views/store plain. Do not introduce Effect 3 APIs. |
| Native OpenTUI view | Covered | Use Solid/native renderables and public APIs; renderer quirks stay isolated in `boundary/`. |
| Upstream gateway foundation | Covered | Target merge supplies isolated slash workers, expanded long handlers, PTY reconnect, resume sanitation/paging, title refresh, learning RPCs, and MoA relay. |
| Ordered live transcript | Covered | `Message.parts` preserves chronological reasoning/tool/text blocks. |
| Rich tool rendering | Covered | Registry-backed specialized cards plus safe structured fallback and collapse. |
| Markdown/code/diff | Covered | Streaming Markdown and native code/diff renderables; keep parser and live fenced-code gates. |
| Deferred resume tool output | Covered | `with_tool_output` survives the default deferred resume and has a gateway regression test. |
| Resume tool grouping | Thinner | Canonical tool-before-final history must attach tools to the following assistant rather than create an extra row. |
| Final response/reasoning reconciliation | Thinner | Treat `message.complete` text/reasoning as authoritative and honor reasoning visibility. |
| Transcript windowing | Covered | Exact-height spacers, append/resume adjudication, bounded mounted set, and native scrollbar. |
| Resize cache invalidation | Thinner | Invalidate off-window height cache on width/detail changes without visible correction jank. |
| Composer editing/completion/history | Covered | Native textarea, cursor-aware slash/`@`, shell `!`, paste, and per-directory history. |
| Composer external editor | Missing | Ctrl+G and `/prompt` suspend/restore `$EDITOR` lifecycle. |
| Busy queue UX | Thinner | Queue/steer/interrupt policy, visible edit/remove/send rows, double-empty Enter, draft/unsent-queue crash retention, and an explicit-retry drain halt for uncertain delivery exist; Ctrl/Cmd+K remains the stock delete-to-line-end edit binding. Real-child termctrl covers FIFO drain and crash recovery. Settle typed provenance for shell/slash-like rows and explicitly approve the bounded ceiling divergence. |
| New/clear session adoption | Covered | `sessionLifecycle` performs decoded create/replace/resume transactions; the store atomically replaces sparse info and every session-owned slice without replaying launch prompt/images, while a bounded transition queue preserves submissions safely. |
| Session event scope | Covered | `eventMayEnterStore` gates reducer and side effects by the active ephemeral SID; resume buffering admits events only into a transaction buffer whose commit/abort filters against the adopted/restored live SID. |
| Session picker/live siblings | Thinner | Paged cold browse/search/peek/resume, cwd grouping, and skin-aware animated list/load-more/preview states are termctrl-verified; add active switching, close/delete, and new/model flows. |
| Large history transport | Covered | Ordinary/corrupt frames remain capped at 32 MiB; only canonical pending `session.resume`/`session.history` responses receive the heap-derived bounded allowance. A real 36,156,260-byte resume hydrated 3,000 rows under termctrl. |
| Startup tool catalog | Covered | Agent readiness timeout is explicit pending state with a bounded retry; permanent failure is visible and non-retrying. Termctrl proves pending `0 tools` refreshes to the authoritative catalog without holding shutdown. |
| Live config synchronization | Thinner | A scoped five-second mtime tracker defers MCP reload while busy or transitioning, while a registry-transition lock serializes reload against agent construction and `/tools` without blocking prompt admission. External-edit propagation is termctrl-proven; port Ink's remaining display fan-out for bell, voice key, compact, details/sections, indicator, inline diffs, mouse, paste thresholds, reasoning, status bar, and streaming. |
| Approval permanence security | Covered | Effect Schema preserves explicit `allow_permanent=false`; store/view remove the option and the response seam fail-closes any stale/invalid `always` choice to `deny`. |
| Clarify/confirm polish | Thinner | Add numeric quick-picks, wrapped long commands, and Esc-back from custom input. |
| Masked sudo/secret editing | Thinner | Use native full editing/paste/grapheme behavior rather than append-only input. |
| Billing overlay | Covered | Buy/auto-reload/limits and error funnels are native. |
| Billing verification event | Covered | `billing.step_up.verification` is decoded, committed only after transactional SID filtering, rendered with code/link, and opened through the http(s)-only external-URL boundary. |
| MoA events | Missing | Decode/render `moa.reference` and aggregating/progress state. |
| Voice events | Missing | Consume listening/transcribing/transcript events and expose status/record key. |
| Browser progress | Missing | Consume progress events and show current CDP state. |
| Notifications/status/subagents | Covered | Sticky/TTL notices, background completion, review summary, tray/dashboard traces. |
| Status core/profile/MCP | Covered | Model/context/cost/duration/cwd/branch/profile/MCP are present and responsive. |
| Status voice/browser/live sessions | Missing | Add only after their underlying live state is real. |
| Theme/skins and terminal chrome | Covered | Reactive skins, OSC title, and native notifications; require live repaint smoke. |
| Local help/history/logs UX | Covered | Client-local commands use current store/transport state; categorized help, bounded one-renderable history, transport diagnostics, pager keyboard behavior, and real PTY presentation are verified. |
| Hosted dashboard exit contract | Covered | `HERMES_TUI_DASHBOARD` refuses destructive slash exits/updates, keeps raw SIGINT alive, clears drafts before idle exit, and mirrors `dashboard.new_session_requested` through the existing Python publisher; overlays retain Ctrl+C/action+D. |
| Gateway crash recovery | Covered | Generation-isolated teardown and bounded respawn/backoff preserve the draft and unsent queue, re-resume persisted history, explicitly retain uncertain in-flight delivery without auto-replay, and replace empty lazy sessions safely. Crash-loop exhaustion contracts and direct Python-child kill termctrl smoke pass. |
| Launcher engine selection | Covered | Config/env precedence, supported-host selection, explicit-engine errors, and automatic Ink fallback share the production runtime resolver. |
| OpenTUI bundle freshness | Covered | Source/lock/build fingerprints, immutable packaged-seed stamps, transactional off-tree rebuild, atomic promotion, and stale-installed-bundle recovery are contract-tested. |
| Node/npm pairing | Covered | Launcher and installer probe Node identity and invoke the npm paired with the selected Node 26 installation. |
| Production-env install | Covered | Runtime and installer force the build-time dev dependency graph even when the caller exports `NODE_ENV=production`. |
| Dashboard profile selection | Covered | Dashboard applies the requested profile home/config before resolving `display.tui_engine`; profile-unification contracts pass. |
| Dashboard gateway attachment | Missing | Implement Effect-boundary WS transport for `HERMES_TUI_GATEWAY_URL`; do not spawn a second gateway. |
| Docker | Thinner | The image builds and prunes OpenTUI, but the inherited integration test still asserts Ink while automatic selection now chooses OpenTUI; split the engine assertions and prove the native bundle/library starts under a real PTY on Linux x64 and arm64. |
| PyPI wheel | Thinner | The universal wheel carries a verified portable seed and clean-venv native hydration/launch passes on Linux x64. Cold OpenTUI activation still needs Node 26 plus npm registry access, and the four-host remote matrix has not run; strict Ink-like offline parity would require platform artifacts or bundled tarballs. |
| sdist | Covered | The exact sdist ships the explicit OpenTUI build source/lock/bundle payload, excludes native/runtime junk, and matches the source contract. |
| Nix | Intentional skip | Explicitly removed from this parity campaign; supported OpenTUI release paths are installer/PyPI and Ink remains available to Nix users. |
| OpenTUI CI | Thinner | Release CI builds the Node-26 seed and runs exact-wheel native hydration, but there is no standalone OpenTUI check job and the remote matrix has not yet executed on this branch. |
| Packaged runtime matrix | Thinner | Exact-wheel verification is wired for Linux x64/arm64 and macOS x64/arm64; local Linux x64 passes, remote host jobs remain unproven, and Windows/Termux intentionally fall back to Ink. |
| Release metadata/docs | Missing | Replace experimental/0.0.0/Ink-default claims with accurate v1 support and rollback policy. |
| Startup benchmark | Thinner | Latest same-host three-run current results are 124/125/126 ms first byte (median 125), 175/177/177 ms session-create (median 177), and 102,916/102,988/103,056 KB VmHWM (loop lag ≤2 ms, zero violations); version and retain raw evidence in the release report. |
| Cold hydration benchmark | In progress | Actual `commitSessionSnapshot` path is measured at 100 messages (latest three-run median: 64.88 ms adoption, 207.69 ms through highlight, 177.6 MB RSS; allocation/renderable counts unchanged); pair it with real `session.resume` RPC→stable-paint timing. |
| Warm-switch benchmark | In progress | Same-renderer replacement is measured (latest three-run median: 34.84 ms adoption, 63.70 ms through highlight, 172.6 MB RSS; 847 renderables); add real RPC timing and repeated-switch release proof. |
| Fixture memory/renderables | In progress | The bounded 100-message fixture settles at 903 renderables and 1,367 native allocations after highlight (206.4 MB process RSS); retain raw release evidence and add repeated-cycle leak assertions. |
| History pager fixture | Covered | Realistic `materialize(3000)` is clipped to 244,295 characters; three opens hold 12 renderables, format in 3.4–6.0 ms, open in 45.7–50.0 ms, remount in 205–216 ms, peak at 294,208 KB RSS, and use zero swaps. |
| Resource ceiling | Thinner | Latest full OpenTUI gate: 1,115 tests, 19.87 s wall, 323% CPU, 1,232,344 KiB peak RSS, zero swaps. This is retained evidence, not the final campaign; final startup/hydration/renderable/CPU measurement runs only after feature parity closes. |
| Memory architecture docs | Covered | Historical Yoga-WASM results are labeled; the current 0.4.1 native-layout allocator and still-binding handle/windowing constraints are explicit. |
| Upstream alignment docs | Thinner | Dependency/test counts, native-Yoga state, and renderer shim ledger match the f7c9 baseline; establish versioned 0.4.1 mem3000/scroll baselines before treating the historical 0.4.0 figures as an upgrade gate. |
| Env flags docs | Covered | Hosted dashboard and sidecar variables are classified as internal plumbing; unsupported remote-gateway overrides remain explicit and user config stays in `config.yaml`. |

## Verification policy

Each task keeps focused unit/contract coverage and an inline isolated-home
`termctrl --host opentui` smoke whenever behavior is visible or crosses a
terminal/process boundary; tmux PNG capture is the fallback. Headless frames
alone are insufficient for security, session, and process-global claims.

After the integrated contracts for a feature category pass, review the combined
category diff adversarially once. Run startup, hydration, renderer/native
allocation memory, CPU, and repeated-cycle leak measurements as one final
campaign after feature parity closes. Final performance evidence records the
target SHA, dirty state, versions, dimensions, fixture/effective cap, raw
metrics, duration, CPU, peak RSS, and swap count.

Release acceptance is zero **Missing** or **In progress** rows on supported
OpenTUI platforms. Any remaining **Thinner** row requires an explicit product
decision; it cannot be silently relabeled as parity.
