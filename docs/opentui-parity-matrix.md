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

Current slash tally: **19 Covered, 23 Thinner, 15 Missing, 0 In progress, 1
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
| 20 | `/queue`, `/q` | Thinner | Bare count/preview, enqueue while idle, visible edit/remove/send UX, and reset behavior. |
| 21 | `/steer` | Thinner | Direct live steer; idle must enqueue rather than submit immediately. |
| 22 | `/undo` | Thinner | Rewind visible state and prefill the native composer for editing. |
| 23 | `/retry` | Thinner | Trim the visible last exchange before resubmitting; guard busy/error paths. |
| 24 | `/billing` | Covered | Native billing overlay and RPC logic are present; device verification is tracked separately below. |
| 25 | `/credits` | Thinner | Direct balance/identity/top-up RPCs, confirmation, and safe URL opening. |
| 26 | `/background`, `/bg`, `/btw` | Covered | Direct `prompt.background` and background-task badge tracking. |
| 27 | `/model` | Thinner | Busy guard, refresh, provider onboarding, expensive-model confirm, and session/global persistence choice. |
| 28 | `/sessions`, `/session`, `/switch`, `/resume` | Thinner | Picker/direct resume now use guarded transactional live switching with persisted-vs-ephemeral SID separation, rollback, event buffering/fencing, catalog refresh, and bounded submission drain; add live siblings, `/sessions new`, close/delete, and model-selection flows. |
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
| 40 | `/busy` | Missing | Direct queue/steer/interrupt policy and live composer behavior. |
| 41 | `/verbose` | Missing | Direct live tool-progress/agent verbosity mode and visible state. |
| 42 | `/usage` | Thinner | Use `session.usage` and render structured token/context/compression/credit data. |
| 43 | `/stop` | Thinner | Direct `process.stop` and exact killed-count/error feedback. |
| 44 | `/reload-mcp` | Thinner | Live reload exists; restore busy guard, cache warning/confirmation, aliases, and detailed result copy. |
| 45 | `/reload` | Covered | Decoded direct `reload.env` runs in the live gateway, validates its update count, renders exact singular/plural feedback, and drops superseded results. |
| 46 | `/browser` | Missing | Direct `browser.manage`, progress presentation, and live CDP indicator. |
| 47 | `/rollback` | Thinner | Use structured list/diff/restore RPCs and reconcile visible transcript state. |
| 48 | `/agents`, `/tasks` | Thinner | Dashboard exists; add pause/resume/status/interrupt/history/replay controls. |
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
| Busy queue UX | Missing | Queue/steer/interrupt policy, visible queued rows, edit/remove/send. |
| New/clear session adoption | Covered | `sessionLifecycle` performs decoded create/replace/resume transactions; the store atomically replaces sparse info and every session-owned slice without replaying launch prompt/images, while a bounded transition queue preserves submissions safely. |
| Session event scope | Covered | `eventMayEnterStore` gates reducer and side effects by the active ephemeral SID; resume buffering admits events only into a transaction buffer whose commit/abort filters against the adopted/restored live SID. |
| Session picker/live siblings | Thinner | Cold browse/search/peek/resume works; add active switching/close/delete/new-model flows. |
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
| Gateway crash recovery | Covered | Bounded respawn/backoff re-resumes by persisted SID, clears dead ephemeral tracking before recovery, and respawns a detached gateway so `/new` and `/resume` remain usable; real-child and crash-loop contracts are tested. |
| Launcher engine selection | Thinner | Precedence/fallback works; close Node/npm and freshness rows below. |
| OpenTUI bundle freshness | Missing | Rebuild when source, lockfile, or build inputs are newer; test stale installed bundles. |
| Node/npm pairing | Missing | Invoke npm belonging to the selected Node 26 installation in launcher and installer. |
| Production-env install | Missing | Ensure build dev dependencies install even under caller `NODE_ENV=production`. |
| Dashboard profile selection | Missing | Resolve `display.tui_engine` after applying the requested profile home/config. |
| Dashboard gateway attachment | Missing | Implement Effect-boundary WS transport for `HERMES_TUI_GATEWAY_URL`; do not spawn a second gateway. |
| Docker | Covered | OpenTUI builds/prunes in the reconciled image; add multi-arch start proof. |
| PyPI wheel | Missing | Define platform-aware bundle/native dependency packaging and clean wheel launch test. |
| sdist | Missing | Ship OpenTUI build sources or document an explicit unsupported downstream contract. |
| Nix | Missing | Add native OpenTUI derivation and flake wiring. |
| OpenTUI CI | Missing | Node 26 `npm ci`, `npm run check`, production build, native launch smoke on relevant paths. |
| Packaged runtime matrix | Missing | Linux x64/arm64 clean install and launch; Windows/Termux intentionally fall back to Ink. |
| Release metadata/docs | Missing | Replace experimental/0.0.0/Ink-default claims with accurate v1 support and rollback policy. |
| Startup benchmark | Thinner | Latest same-host three-run current results are 124/125/126 ms first byte (median 125), 175/177/177 ms session-create (median 177), and 102,916/102,988/103,056 KB VmHWM (loop lag ≤2 ms, zero violations); version and retain raw evidence in the release report. |
| Cold hydration benchmark | In progress | Actual `commitSessionSnapshot` path is measured at 100 messages (latest three-run median: 64.88 ms adoption, 207.69 ms through highlight, 177.6 MB RSS; allocation/renderable counts unchanged); pair it with real `session.resume` RPC→stable-paint timing. |
| Warm-switch benchmark | In progress | Same-renderer replacement is measured (latest three-run median: 34.84 ms adoption, 63.70 ms through highlight, 172.6 MB RSS; 847 renderables); add real RPC timing and repeated-switch release proof. |
| Fixture memory/renderables | In progress | The bounded 100-message fixture settles at 903 renderables and 1,367 native allocations after highlight (206.4 MB process RSS); retain raw release evidence and add repeated-cycle leak assertions. |
| History pager fixture | Covered | Realistic `materialize(3000)` is clipped to 244,295 characters; three opens hold 12 renderables, format in 3.4–6.0 ms, open in 45.7–50.0 ms, remount in 205–216 ms, peak at 294,208 KB RSS, and use zero swaps. |
| Resource ceiling | Thinner | Latest full OpenTUI gate: 19.88 s wall, 308% CPU, 1,160,436 KB peak RSS, zero swaps; continue recording every native/release gate sequentially on constrained hosts. |
| Memory architecture docs | Covered | Historical Yoga-WASM results are labeled; the current 0.4.1 native-layout allocator and still-binding handle/windowing constraints are explicit. |
| Upstream alignment docs | Thinner | Dependency/test counts, native-Yoga state, and renderer shim ledger match the f7c9 baseline; establish versioned 0.4.1 mem3000/scroll baselines before treating the historical 0.4.0 figures as an upgrade gate. |
| Env flags docs | Covered | Hosted dashboard and sidecar variables are classified as internal plumbing; unsupported remote-gateway overrides remain explicit and user config stays in `config.yaml`. |

## Verification policy

A row becomes **Covered** only after contract/invariant tests, `npm run check`,
a production build, and a real isolated-home TTY smoke wherever terminal or
process boundaries matter. Security, session, and process-global behavior must
exercise the real gateway child; headless frames alone are insufficient.

Every completed batch gets an external adversarial review and a bounded
performance review. Performance evidence records the target SHA, dirty state,
Node/OpenTUI versions, terminal dimensions, fixture size/effective cap, raw
metrics, duration, CPU, peak RSS, and swap count. Old line-number citations are
not canonical; cite stable file and symbol names.

Release acceptance is zero **Missing** or **In progress** rows on supported
OpenTUI platforms. Any remaining **Thinner** row requires an explicit product
decision; it cannot be silently relabeled as parity.
