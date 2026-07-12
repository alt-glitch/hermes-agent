# OpenTUI parity matrix

This is the canonical parity ledger for the native Hermes TUI. It compares the
OpenTUI engine with the Ink UI at upstream commit
`f7c9feb395caa27ec79386b1ed3ae7b4675486a1`. The reconciled fork baseline is
`7a9e0d9d3d23d5642e0c7b4c804329fcfd378119`.

The final local gate and benchmark record is
[`opentui-release-evidence-f7c9.md`](opentui-release-evidence-f7c9.md).

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
- **Intentional skip** — explicitly excluded from this parity campaign by the
  product owner; it is not a release blocker.

Current slash tally: **50 Covered, 3 Thinner, 0 Missing, 0 In progress, 5
Intentional skip**.

## Slash commands

| # | Command | Status | Contract still required / evidence |
|---:|---|---|---|
| 1 | `/help` | Covered | Effect-decoded catalog caching renders Ink categories, skill count, discovery warnings, TUI-only rows, platform-aware implemented hotkeys, and the skin `helpHeader`; malformed/offline fallback and stale-flight fencing are tested. |
| 2 | `/quit`, `/exit` | Covered | Local shutdown runs renderer/Effect finalizers; hosted dashboard chat returns Ink's exact refusal. Idle Ctrl+C/action+D instead publishes the sidecar new-session event, while overlays retain input ownership. |
| 3 | `/update` | Covered | Local mode reports the handoff and exits cleanly with code 42 for the unchanged Python launcher; hosted mode returns Ink's exact managed-environment refusal. |
| 4 | `/mouse`, `/scroll` | Intentional skip | Explicitly excluded from this campaign; launch-time OpenTUI mouse configuration remains supported. |
| 5 | `/clear`, `/new [title]` | Covered | Busy guard and Ink-equivalent confirmation feed a transactional `setup.status → session.close → session.create`; adoption resets all session-owned state, preserves process-global presentation, supports titles, fences old live SIDs, and safely drains submissions queued during the switch. |
| 6 | `/redraw` | Covered | Public frame buffers are invalidated and the terminal is repainted without suspend/resume; slash redraw preserves selection while action+L clears it, a same-stdin-chunk regression proves later key bytes survive, and real PTY smoke passes. |
| 7 | `/status` | Covered | Decoded direct `session.status` uses the active SID, always pages the authoritative live snapshot, and drops late old-SID or superseded same-SID replies. |
| 8 | `/title` | Covered | Decoded direct query/rename preserves pending/error feedback, refreshes title chrome immediately, and fences late responses by SID plus slash flight. |
| 9 | `/compact` | Covered | `logic/slash.ts::compactCmd` updates live display state and persistence. |
| 10 | `/details`, `/detail` | Covered | Global hidden/collapsed/expanded/cycle modes, authoritative status, and independent thinking/tools/subagents/activity overrides/reset are persisted and applied to the native transcript. |
| 11 | `/fortune` | Covered | Ink's corpus, random mode, SID+local-date deterministic daily aliases, help row, and live `/f` completion are local and tested. |
| 12 | `/copy [n]` | Covered | Prefers the current terminal selection, then matches Ink's indexed assistant-response fallback and visible success/failure feedback. |
| 13 | `/paste` | Covered | Clipboard image capture uses the existing `image.attach` boundary and preserves visible failure feedback. |
| 14 | `/prompt`, `/compose` | Covered | The renderer suspends around `$EDITOR`, restores safely, and returns the edited draft to the composer; Ctrl/Alt+G uses the same lifecycle. |
| 15 | `/terminal-setup` | Covered | Native handoff supports auto-detection plus VS Code, Cursor, and Windsurf keybinding setup with explicit result feedback. |
| 16 | `/logs [n]` | Covered | Reads the real transport-owned 200-line ring (spawn/readiness/stderr/protocol/RPC error, timeout, and write failures), clamps 1..80, marks 4,096-character truncation, and renders the requested tail in the native pager. |
| 17 | `/history [preview]` | Thinner | Live rows, Ink labels/tool fallback, and latest-800-row semantics are covered. The explicitly accepted production-safety divergence caps previews at 4,000 characters and the pager at 512 Ki rather than exposing unbounded text to native rendering. |
| 18 | `/save` | Covered | Decoded direct `session.save` exports uncapped gateway history, preserves Ink's no-conversation/no-SID UX, reports the path/errors, and fences late replies. |
| 19 | `/statusbar`, `/sb` | Intentional skip | Explicitly excluded from this campaign; the responsive native status surface remains enabled. |
| 20 | `/queue`, `/q` | Thinner | Count/preview, bounded enqueue, three-row native view, edit/remove/send, confirmed clear, transition recovery, and reset behavior are covered. Real-child termctrl proves FIFO drain, crash retention, and recovery. The accepted production divergences are typed provenance for shell/slash-like rows and the 100-row/4-Mi-character ceiling versus Ink's unbounded string queue. |
| 21 | `/steer` | Thinner | Direct live injection uses upstream's in-memory `session.steer`; rejection or a definite RPC error retains the body in the local queue. Timeout/transport ambiguity retains the body, halts automatic drain, and requires an explicit retry. Real-child termctrl proves mid-turn delivery, fallback, and crash recovery; best-effort process admission rather than durable delivery is an explicitly accepted production divergence. |
| 22 | `/undo` | Covered | Upstream `session.undo`, visible exchange trim, busy/SID/history-mutation guards, and exact feedback are contract-tested and proven against a real child with termctrl. The mutation remains intentionally process-local, and Ink intentionally does not prefill `/undo`. |
| 23 | `/retry` | Covered | Matches Ink’s client sequence: remember the last user text, call `session.undo`, trim the visible exchange, then submit exactly once. Success, one-resubmission, and error restoration are contract- and termctrl-verified; the non-parity `session.retry` RPC/lease path is absent. |
| 24 | `/billing` | Covered | Native billing overlay and RPC logic are present; device verification is tracked separately below. |
| 25 | `/credits` | Covered | Effect-decoded balance/identity/top-up data renders locally; an explicit native confirmation gates the http(s)-only top-up URL opener. |
| 26 | `/background`, `/bg`, `/btw` | Covered | Direct `prompt.background` and background-task badge tracking. |
| 27 | `/model` | Covered | Busy guard, prefetched/refreshed provider-grouped picker, provider onboarding hints, expensive-model confirmation, and decoded live session/global switching are covered. |
| 28 | `/sessions`, `/session`, `/switch`, `/resume` | Covered | The unified orchestrator pins +new above attachable live siblings and durable-key-deduped resumable history; decoded transactional activate/resume preserves ephemeral routing versus persisted identity, in-flight turns, rollback/event fencing, catalog refresh, and bounded drain. `/sessions new`, live close with safe fallback, historical delete confirmation, direct resume, and prompt-plus-Tab-model creation are covered. Termctrl exercised create/switch/close/resume flows and responsive rendering at 132×40 and 40×24. |
| 29 | `/image` | Covered | Direct `image.attach` accepts a path/URL and preserves any returned remainder text in the composer. |
| 30 | `/personality` | Covered | The live gateway mirror applies personality without a detached-only mutation. |
| 31 | `/compress` | Covered | Decoded direct `session.compress` replaces the visible snapshot/info/usage atomically, accepts the gateway’s raw OpenAI history rows, correlates tool calls/results, adopts a rotated durable key, and preserves sparse/no-op feedback. |
| 32 | `/branch`, `/fork` | Covered | Decoded direct `session.branch` transactionally closes/adopts the returned live SID, resets session-owned chrome/state, fences old events, refreshes the catalog, and safely preserves queued submissions. |
| 33 | `/voice` | Covered | Decoded toggle/status/TTS and push-to-talk recording use the configured record key; listening/transcribing/transcript state is reduced into native chrome and transcripts submit through the live session. |
| 34 | `/pet` | Covered | `/pet list` opens the bounded native searchable gallery, ranks active/installed/curated pets, and adopts through Effect-decoded `pet.select`; bare and other arguments retain worker behavior. |
| 35 | `/skin` | Covered | `skin.changed` drives the reactive OpenTUI theme. |
| 36 | `/indicator` | Intentional skip | Explicitly excluded from this campaign; the native running-state presentation remains unchanged. |
| 37 | `/yolo` | Covered | Gateway-process mirror changes the active session approval mode. |
| 38 | `/reasoning` | Covered | Full/clamp plus effort/show/hide use decoded live configuration, update section state immediately, reconcile authoritative final reasoning, and preserve the setting across finalization. |
| 39 | `/fast` | Covered | Effect-decoded status/set/toggle uses the live config path, validates support in the gateway, and applies request overrides with exact feedback. |
| 40 | `/busy` | Covered | Queue/steer/interrupt policy, `config.yaml` persistence, immediate local application, authoritative `config.get` status, and transition-gated external-config refresh are covered; termctrl proves the refresh does not race `/tools`. |
| 41 | `/verbose` | Covered | Effect-decoded `config.set` cycles or selects live tool-progress detail and reports the authoritative mode. |
| 42 | `/usage` | Covered | Effect-decoded `session.usage` renders model, calls, token/context/compression/cost, and credit data in the native pager. |
| 43 | `/stop` | Covered | Direct `process.stop` validates the response and reports the exact killed-process count or visible error. |
| 44 | `/reload-mcp` | Covered | Live process-global reload is idle-admitted, confirmation-gated, Effect-decoded, and reports the detailed server/tool result; aliases retain the same path. |
| 45 | `/reload` | Covered | Decoded direct `reload.env` runs in the live gateway, validates its update count, renders exact singular/plural feedback, and drops superseded results. |
| 46 | `/browser` | Covered | Effect-decoded `browser.manage` connect/disconnect/status controls commit authoritative CDP state, while decoded progress events update the visible lifecycle. |
| 47 | `/rollback` | Covered | Effect-decoded list/diff/restore RPCs use the native pager, confirm destructive restore, and reconcile the visible transcript after gateway history removal. |
| 48 | `/agents`, `/tasks` | Covered | Live events feed the responsive master/detail dashboard, running-agent chip, tray handoff, sort/filter, tree/timeline metrics, completed-turn history, replay/diff views, and parked-subagent resume hint. `/agents status`, pause/resume, and per-agent or subtree kill use decoded live controls. Termctrl exercised wide/narrow dashboards and a real background delegation through completion, automatic parent resume, and replay. |
| 49 | `/journey`, `/learning`, `/memory-graph` | Covered | Effect-decoded `learning.*` data powers native timeline/detail/edit/delete flows with a responsive narrow-terminal fallback. |
| 50 | `/replay` | Covered | In-memory completed-turn replay and disk list/load paths open the native agents dashboard/pager with indexed navigation. |
| 51 | `/replay-diff` | Covered | Two indexed in-memory spawn trees resolve into the native dashboard diff state with validated arity/range feedback. |
| 52 | `/reload-skills` | Covered | Decoded direct `skills.reload` removes confirmed-deleted names immediately, refreshes `commands.catalog` aliases/canonical names, preserves dynamically learned plugin commands, reports refresh failure, and is SID/flight fenced. |
| 53 | `/skills` | Covered | Native list/inspect picker works, while explicit search/install/browse/manage subcommands retain their upstream worker behavior and output. |
| 54 | `/plugins` | Covered | Bare `/plugins` opens the bounded native user/bundled hub with scope switching and async enable/disable; argument forms preserve worker output in the pager. |
| 55 | `/tools` | Covered | List/status retains Ink's worker presentation; enable/disable uses decoded live `tools.configure`, busy/transition guards, atomic gateway mutation/close coordination, same-SID state replacement, catalog/model refresh, nullable detached feedback, and bounded post-reset submission drain. |
| 56 | `/setup` | Covered | OpenTUI suspends around the full external Hermes setup wizard and restores the renderer with explicit exit/error feedback. |
| 57 | `/heapdump` | Intentional skip | Explicitly excluded from this campaign; the existing diagnostics-gated native snapshot remains available. |
| 58 | `/mem` | Intentional skip | Explicitly excluded from this campaign; the existing diagnostics-gated renderer/process report remains available. |

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
| Rich tool rendering | Covered | Registry-backed specialized cards plus safe structured fallback and collapse; start/progress/complete preserve authoritative status, summaries, arguments, results, and terminal-state semantics. |
| Markdown/code/diff | Covered | Streaming Markdown and native code/diff renderables; keep parser and live fenced-code gates. |
| Deferred resume tool output | Covered | `with_tool_output` survives the default deferred resume and has a gateway regression test. |
| Resume tool grouping | Covered | Canonical tool-before-final history attaches tool activity to the following assistant response without creating an extra transcript row. |
| Final response/reasoning reconciliation | Covered | `message.complete` text and reasoning are authoritative, ordered parts are reconciled without duplication, and the live reasoning visibility setting survives finalization. |
| Transcript windowing | Covered | Exact-height spacers, append/resume adjudication, bounded mounted set, and native scrollbar. |
| Resize cache invalidation | Covered | Width/detail changes advance a stale-height generation, invalidate off-window estimates, and preserve a byte-stable visible correction path without correction jank. |
| Composer editing/completion/history | Covered | Native textarea, cursor-aware slash/`@`, shell `!`, paste, and per-directory history. |
| Composer external editor | Covered | Ctrl/Alt+G and `/prompt`/`/compose` share the renderer-safe external-editor lifecycle, restore the terminal on exit/error, and return the edited text to the composer. |
| Busy queue UX | Thinner | Queue/steer/interrupt policy, visible edit/remove/send rows, double-empty Enter, draft/unsent-queue crash retention, and an explicit-retry drain halt for uncertain delivery are covered; Ctrl/Cmd+K remains the stock delete-to-line-end edit binding. Real-child termctrl covers FIFO drain and crash recovery. Typed provenance and the bounded ceiling are explicitly accepted production divergences. |
| New/clear session adoption | Covered | `sessionLifecycle` performs decoded create/replace/resume transactions; the store atomically replaces sparse info and every session-owned slice without replaying launch prompt/images, while a bounded transition queue preserves submissions safely. |
| Session event scope | Covered | `eventMayEnterStore` gates reducer and side effects by the active ephemeral SID; resume buffering admits events only into a transaction buffer whose commit/abort filters against the adopted/restored live SID. |
| Session picker/live siblings | Covered | One animated, skin-aware orchestrator merges +new, attachable live siblings, and durable-key-deduped resumable history. Transactional activate/resume, live close/fallback, historical delete, prompt/model creation, selection re-anchoring, and narrow 40×24 rendering are contract- and termctrl-verified. |
| Large history transport | Covered | Ordinary/corrupt frames remain capped at 32 MiB; only canonical pending `session.resume`/`session.history` responses receive the heap-derived bounded allowance. A real 36,156,260-byte resume hydrated 3,000 rows under termctrl. |
| Startup tool catalog | Covered | Agent readiness timeout is explicit pending state with a bounded retry; permanent failure is visible and non-retrying. Termctrl proves pending `0 tools` refreshes to the authoritative catalog without holding shutdown. |
| Live config synchronization | Thinner | The scoped five-second mtime tracker defers MCP reload while busy or transitioning, and a registry-transition lock serializes reload against agent construction and `/tools`. Busy-input, voice key, and revision-fenced compact/details/section changes rehydrate from Effect-decoded full config. Bell, inline-diff, paste-threshold, and streaming fan-out remain explicit product decisions rather than release blockers. |
| Approval permanence security | Covered | Effect Schema preserves explicit `allow_permanent=false`; store/view remove the option and the response seam fail-closes any stale/invalid `always` choice to `deny`. |
| Clarify/confirm polish | Covered | Response ownership remains mounted until an acknowledged reply; pending input is visibly disabled, failed acknowledgements expose retry/cancel state, confirm cancellation unblocks the gateway, and numeric quick-picks, wrapped commands, plus Esc-back from custom input are covered. |
| Masked sudo/secret editing | Covered | Native full editing, cursor movement, deletion, paste, and grapheme behavior replace the append-only path without exposing masked content. |
| Billing overlay | Covered | Buy/auto-reload/limits and error funnels are native. |
| Billing verification event | Covered | `billing.step_up.verification` is decoded, committed only after transactional SID filtering, rendered with code/link, and opened through the http(s)-only external-URL boundary. |
| MoA events | Covered | Decoded `moa.reference`, aggregation, progress, and completion events preserve active-SID fencing and feed ordered transcript/status state. |
| Voice events | Covered | Listening, transcribing, and transcript events are Effect-decoded and session-fenced; reducer/view chrome uses the configured record key, and accepted transcripts submit through the live composer path. |
| Browser progress | Covered | Decoded browser-progress events preserve active-SID fencing and update visible progress/CDP state; `/browser` connect/disconnect/status shares the authoritative `browser.manage` state. |
| Notifications/status/subagents | Covered | Sticky/TTL notices, background completion, review summary, MoA/subagent progress, and tray/dashboard traces use authoritative event status and terminal-state semantics. |
| Status core/profile/MCP | Covered | Model/context/cost/duration/cwd/branch/profile/MCP are present and responsive. |
| Status voice/browser/live sessions | Covered | Responsive chrome reflects authoritative voice and browser state, while live siblings are exposed through the session orchestrator and running-agent/session indicators. |
| Theme/skins and terminal chrome | Covered | Reactive skins, OSC title, and native notifications; require live repaint smoke. |
| Local help/history/logs UX | Covered | Client-local commands use current store/transport state; categorized help, bounded one-renderable history, transport diagnostics, pager keyboard behavior, and real PTY presentation are verified. |
| Hosted dashboard exit contract | Covered | `HERMES_TUI_DASHBOARD` refuses destructive slash exits/updates, keeps raw SIGINT alive, clears drafts before idle exit, and mirrors `dashboard.new_session_requested` through the existing Python publisher; overlays retain Ctrl+C/action+D. |
| Gateway crash recovery | Covered | Generation-isolated teardown and bounded respawn/backoff preserve the draft and unsent queue, re-resume persisted history, explicitly retain uncertain in-flight delivery without auto-replay, and replace empty lazy sessions safely. Crash-loop exhaustion contracts and direct Python-child kill termctrl smoke pass. |
| Launcher engine selection | Covered | Config/env precedence, supported-host selection, explicit-engine errors, and automatic Ink fallback share the production runtime resolver. |
| OpenTUI bundle freshness | Covered | Source/lock/build fingerprints, immutable packaged-seed stamps, transactional off-tree rebuild, atomic promotion, and stale-installed-bundle recovery are contract-tested. |
| Node/npm pairing | Covered | Launcher and installer probe Node identity and invoke the npm paired with the selected Node 26 installation. |
| Production-env install | Covered | Runtime and installer force the build-time dev dependency graph even when the caller exports `NODE_ENV=production`. |
| Dashboard profile selection | Covered | Dashboard applies the requested profile home/config before resolving `display.tui_engine`; profile-unification contracts pass. |
| Dashboard gateway attachment | Covered | `HERMES_TUI_GATEWAY_URL` selects credential-redacted JSON-RPC WebSocket attachment instead of spawning Python; text/binary events, RPC responses, URL rotation, close ordering, restart, and typed transport-down recovery are contract-tested at the Effect boundary. |
| Docker | Thinner | Static and image integration contracts now cover both built engines, automatic OpenTUI selection, the Ink prebuilt fallback, pruned native Linux x64/arm64 libraries, and production argv. Real-PTY starts on published Linux x64 and arm64 images remain release evidence to collect. |
| PyPI wheel | Thinner | The universal wheel carries a verified portable seed and clean-venv native hydration/launch passes on Linux x64. Cold OpenTUI activation still needs Node 26 plus npm registry access, and the four-host remote matrix has not run; strict Ink-like offline parity would require platform artifacts or bundled tarballs. |
| sdist | Covered | The exact sdist ships the explicit OpenTUI build source/lock/bundle payload, excludes native/runtime junk, and matches the source contract. |
| Nix | Intentional skip | Explicitly removed from this parity campaign; supported OpenTUI release paths are installer/PyPI and Ink remains available to Nix users. |
| OpenTUI CI | Thinner | Release CI builds the Node-26 seed and runs exact-wheel native hydration, but there is no standalone OpenTUI check job and the remote matrix has not yet executed on this branch. |
| Packaged runtime matrix | Thinner | Exact-wheel verification is wired for Linux x64/arm64 and macOS x64/arm64; local Linux x64 passes, remote host jobs remain unproven, and Windows/Termux intentionally fall back to Ink. |
| Release metadata/docs | Covered | Package metadata follows the root Hermes version, identifies OpenTUI as the production v1 engine on supported hosts, and documents the supported-host matrix, shared-session invariant, and one-shot/persistent Ink rollback paths. |
| Startup benchmark | Covered | Three runs: 126/130/135 ms first byte (median 130), 175/177/179 ms session-create (median 177), and 111,056/111,200/111,252 KB VmHWM (median 111,200); lag <=1 ms with zero violations. Raw files and target metadata are retained in the [release evidence](opentui-release-evidence-f7c9.md). |
| Cold hydration benchmark | Covered | The real 100-message snapshot path measured 83.11 ms median adoption, 227.65 ms median total, 202.7 MB median RSS, 1,257 renderables, and 2,795 native allocations across three runs. See the [release evidence](opentui-release-evidence-f7c9.md). |
| Warm-switch benchmark | Covered | Same-renderer 100-message replacement measured 41.46 ms median adoption, 86.94 ms median total, 192.0 MB median RSS, 1,092 renderables, and 2,112 native allocations. Ten repeated replacements passed the zero-tolerance retained-state gate. |
| Fixture memory/renderables | Covered | The live 100-message component fixture measured 270.5 MB median RSS, 1,257 renderables, and 1,346 native allocations; the real PTY fixture's three final RSS values were 223,604/226,812/212,536 KB. Raw evidence is retained in the [release report](opentui-release-evidence-f7c9.md). |
| History pager fixture | Covered | Realistic `materialize(3000)` is clipped to 244,295 characters; three opens hold 12 renderables, format in 3.4–6.0 ms, open in 45.7–50.0 ms, remount in 205–216 ms, peak at 294,208 KB RSS, and use zero swaps. |
| Resource ceiling | Covered | Final one-worker OpenTUI gate: 101 files, 1,430 tests, 40.72 s. Static/type/build are green; lint has zero errors and 16 baseline warnings. The test runner did not capture OS peak RSS, so no peak value is inferred; separately measured PTY/component memory ceilings are retained in the [release evidence](opentui-release-evidence-f7c9.md). |
| Memory architecture docs | Covered | Historical Yoga-WASM results are labeled; the current 0.4.1 native-layout allocator and still-binding handle/windowing constraints are explicit. |
| Upstream alignment docs | Covered | Dependency versions, native-Yoga state, renderer shim ledger, and the current 1,430-test gate match the f7c9 release record; versioned 0.4.1 startup, hydration, real-PTY, and repeated-cycle measurements supersede the historical 0.4.0 figures. |
| Env flags docs | Covered | Hosted dashboard, sidecar, and remote-gateway attachment variables are classified as internal plumbing, while user-facing behavior remains in `config.yaml`. |

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

Release acceptance is zero **Missing** or **In progress** in supported-platform
feature rows. Final local performance evidence is covered. Remaining **Thinner**
rows record either accepted production-safety divergences or external host/CI
evidence still required; they are not silently relabeled as parity.
