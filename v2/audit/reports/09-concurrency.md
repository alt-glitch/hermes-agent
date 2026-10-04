# 09 Concurrency, lifecycle, shutdown

Checkout `origin/main` = `ea81748579`. Reference SHAs: home-assistant-core 0f3081e, anyio eef3a15, cpython 9d22a53, textual 06dbeef, trio 8f6343f.

## TL;DR

- Nothing owns Hermes's threads, loops or tasks: 246 bare threads (243 daemon, 126 fire-and-forget), ~10 private event loops, 215 create_task calls, 41 atexit hooks; every runtime ends in os._exit because orderly exit cannot be trusted.
- Biggest kill: the per-runtime teardown lists, chained signal handlers, five watchdogs and seven extra sync->async bridges (~1.5k lines) collapse into one hermes_lifecycle module (shutdown stages, owned spawn, one signal owner) plus one hermes_async portal.
- Biggest simplification: gateway stop (2.3k lines, ~15 work counters, two concurrently running teardown sequences) becomes a GatewayRuntime task group with HA-style staged stop (~-1.2k lines).
- Low-hanging (S/M, high+): 4 — shutdown registry CON-01, ContextVar prompt callbacks CON-03, one sync->async bridge CON-04, one signal owner CON-08.
- Structured concurrency deletes the asyncio-side bookkeeping (task sets, stop ordering, counters); it cannot cancel the sync agent core on threads — that needs a per-turn cancel token, then an async turn loop (CON-10).

## What this area is

Cross-cutting: who starts threads, event loops, asyncio tasks and subprocesses, and how each runtime (CLI, one-shot, TUI backend, gateway, cron ticker, dashboard, ACP) stops them. The 20 lifecycle modules below total 14,146 lines (`wc -l`).

Inventory:

- `threading.Thread(`: 246 constructions (AST, `scripts/con_threads.py`); 243 pass `daemon=True`; 126 are fire-and-forget `Thread(...).start()` with no handle kept; 147 sit in files that never call `.join(`; 69 are unnamed.
- Only 35 of the 246 wrap their target in a context helper inside the constructor expression (lower bound: some wrap the target in an earlier statement). `spawn_context_thread(` is called 20 times, `ctx_bound(` 6, `propagate_context_to_thread(` 13, raw `copy_context(` 94 (`rg -c`).
- `threading.Timer(`: 14. `ThreadPoolExecutor(`: 51 (18 as a `with` block). Two custom executors: `tools/daemon_pool.py::DaemonThreadPoolExecutor` (13 call sites), `gateway/turn_executor.py::_UnboundedThreadExecutor`.
- `asyncio.run(`: 43. `new_event_loop(`: 13. `run_forever(`: 4. `run_coroutine_threadsafe(`: 14. `asyncio.TaskGroup`: 8 mentions in the whole in-scope tree.
- `create_task(`/`ensure_future(`: 215. Hand-rolled `set.add(task)` + `add_done_callback(set.discard)` tracking: 31 sites in 21 files. ruff RUF006 (dangling task): 23 (parent metrics).
- `atexit.register`: 41. `signal.signal(`: 27; `loop.add_signal_handler(`: 2. `os._exit(`: 25 sites in 14 files. `faulthandler` stack-dump watchdogs: 3 files.
- `subprocess.Popen(`: 88; `create_subprocess_*`: 7. `asyncio.to_thread(`/`run_in_executor(`: 462.

Counts: `rg -c` over the in-scope set `agent run_agent.py model_tools.py toolsets.py cli.py utils.py mcp_serve.py hermes_cli tools gateway tui_gateway cron plugins pm acp_adapter hermes_platform providers hermes_*.py`; Thread/Timer/pool classification by `scripts/con_threads.py` (output `scripts/con_threads.out.json`). Parent metrics (`inputs/metrics/SUMMARY.md`) count 247 Thread / 37 asyncio.run / 12 run_coroutine_threadsafe with a slightly different file set; same order of magnitude.

| module | lines | owns |
|---|---|---|
| `gateway/run_shutdown.py` | 2289 | GatewayShutdownMixin: drain, restart, scale-to-zero, 8 `_stop_*` phases, ~15 active-work counters |
| `gateway/run_startup.py` | 1846 | GatewayRunner.start: adapter connects, background watchers, reconnect tasks |
| `gateway/run.py::start_gateway/main` | 6170 | process entry: signal handlers, planned-stop watcher thread, cron + housekeeping threads, shutdown tail, os._exit backstop |
| `gateway/shutdown_watchdog.py` | 402 | thread watchdog that dumps stacks and os._exit()s a wedged gateway stop |
| `hermes_startup_watchdog.py` | 513 | thread watchdog that dumps stacks and os._exit()s a wedged startup |
| `hermes_cli/cli_shutdown.py` | 362 | classic CLI exit watchdog + ordered cleanup steps |
| `tui_gateway/session_reaper.py` | 522 | TUI idle reaper, exit flush, chained SIGTERM/SIGINT handlers, heartbeat thread |
| `tui_gateway/entry.py` | — | TUI backend signal handlers, grace timer, os._exit |
| `tools/process_registry.py` | 2898 | background tool subprocesses: spawn, reader threads, heartbeat thread, kill_all |
| `cron/scheduler_thread.py` | 64 | SupervisedTickerThread: respawns a cron ticker thread that died |
| `tools/async_delegation.py` | 1211 | background subagents on a module-level DaemonThreadPoolExecutor; interrupt_all |
| `model_tools.py::_run_async` | — | sync->async bridge for every async tool handler (registry.dispatch) |
| `tools/thread_context.py + agent/memory_provider.py::spawn_context_thread` | 74 | two of the four context-into-thread helpers |
| `tools/daemon_pool.py + gateway/turn_executor.py` | 132 | two custom executors that bypass the stdlib exit join |
| `agent/deadline.py` | 475 | run_bounded_sync/async: Timer/thread-driven deadlines, loop-blocked stack dump |

## How it works end to end

### systemd/launchd sends SIGTERM to a running messaging gateway

Trigger: `hermes gateway stop`, `systemctl stop`, `hermes update`, container stop. Inputs: `planned_stop_marker` (`hermes gateway stop` wrote the planned-stop marker before signalling, default False); `drain_timed_out` (running agents/cron/API runs did not finish inside the drain budget, default False); `executor_worker_live` (a turn or housekeeping thread is still running after the quiesce budget, default False)

1. `gateway/run.py::main` (`gateway/run.py:6114`): asyncio.run(start_gateway(config)): the one event loop of the process.
2. `gateway/run.py::start_gateway` (`gateway/run.py:5914`): installs loop.add_signal_handler for SIGINT/SIGTERM/SIGUSR1 and starts the planned-stop-watcher daemon thread (5929). [CON-06]
3. `gateway/run.py::start_gateway` (`gateway/run.py:6009`): via _start_gateway_start_cron_and_housekeeping (run.py:5706) starts the cron ticker (SupervisedTickerThread) and the housekeeping daemon thread; both outlive runner.stop(). [CON-02]
4. `gateway/run.py::_start_gateway_make_shutdown_signal_handler.shutdown_signal_handler` (`gateway/run.py:5366`): classifies the signal (takeover / planned / unexpected) and calls asyncio.create_task(runner.stop()) without keeping the task. [CON-06]
5. `gateway/run_shutdown.py::GatewayShutdownMixin._stop_impl` (`gateway/run_shutdown.py:2228`): arms the thread-based shutdown watchdog (gateway/shutdown_watchdog.py:264) and runs the _stop_* phases in order. [CON-09]
6. `gateway/run_shutdown.py::_stop_drain_active_work` (`gateway/run_shutdown.py:1892`): marks sessions resume_pending, then _drain_active_agents (run_shutdown.py:808) polls four separate counters (agents, cron jobs, API runs, deferred workers) every 0.1 s until all are zero or the drain times out. [CON-06]
7. `gateway/run_shutdown.py::_stop_interrupt_remaining_work` (`gateway/run_shutdown.py:1941`): interrupts agents and kills tool subprocesses off-loop — only when `drain_timed_out` = True.
8. `gateway/run_shutdown.py::_stop_release_runtime_state` (`gateway/run_shutdown.py:2017`): cancels self._background_tasks except _stop_task/_restart_task, flushes pending messages, sets _shutdown_event (2052), then the global tool kill and aux-client reap. [CON-06]
9. `gateway/run.py::_start_gateway_shutdown_tail` (`gateway/run.py:5783`): woken by _shutdown_event while _stop_impl is still running: stops control socket, sets cron_stop, polls cron/housekeeping thread exit, join(timeout=2) on the watcher thread from the loop, shuts MCP down; never awaits runner._stop_task. [CON-06]
10. `gateway/run_shutdown.py::_stop_quiesce_and_close_session_dbs` (`gateway/run_shutdown.py:2069`): joins the two gateway pools under a clamped budget; skips SessionDB close when any worker or any of 4 counters is still live. [CON-06]
11. `gateway/run_shutdown.py::_stop_quiesce_and_close_session_dbs` (`gateway/run_shutdown.py:2091`): leaves state.db open for SQLite WAL recovery on next boot — only when `executor_worker_live` = True. [CON-02]
12. `gateway/run_shutdown.py::_stop_persist_exit_state` (`gateway/run_shutdown.py:2148`): removes PID file, releases runtime lock, writes .clean_shutdown unless the drain timed out, persists gateway_state.
13. `gateway/run.py::_exit_after_graceful_shutdown` (`gateway/run.py:6122`): re-does PID/lock release, stamp_exit and log drain by hand, then os._exit(): atexit handlers and non-daemon joins never run. [CON-01]

### A Telegram message triggers a turn whose model calls an async tool (e.g. Home Assistant, vision)

Trigger: inbound platform message on a running gateway. Inputs: `tool_is_async` (the registered handler is a coroutine function (registry entry is_async), default True); `parallel_batch` (the model returned several parallel-safe tool calls in one reply, default False)

1. `gateway/run_turn.py::_run_agent_start_turn_worker` (`gateway/run_turn.py:3416`): starts a per-turn 'gateway-turn-watchdog' daemon thread and schedules the turn body with asyncio.ensure_future. [CON-02]
2. `gateway/run.py::GatewayRunner._run_in_executor_with_context` (`gateway/run.py:4314`): copy_context() then run_in_executor on the unbounded one-thread-per-turn executor (helper #4 for context; no approval callbacks). [CON-03]
3. `agent/turn_facade.py::TurnFacadeMixin.run_conversation` (`agent/turn_facade.py:22`): the sync agent turn runs on that thread.
4. `agent/tool_executor.py::_run_sequential_tool_execution_middleware` (`agent/tool_executor.py:939`): creates a NEW DaemonThreadPoolExecutor(max_workers=1) per tool call and submits propagate_context_to_thread(_run) (context + 5 thread-local callbacks) — only when `parallel_batch` = False. [CON-03]
5. `agent/tool_executor.py::_ConcurrentBatch.run` (`agent/tool_executor.py:1481`): creates a DaemonThreadPoolExecutor per batch; on deadline it abandons wedged workers instead of joining — only when `parallel_batch` = True. [CON-10]
6. `tools/registry.py::ToolRegistry.dispatch` (`tools/registry.py:905`): for an async handler calls model_tools._run_async(entry.handler(...)) — only when `tool_is_async` = True. [CON-04]
7. `model_tools.py::_run_async` (`model_tools.py:93`): no running loop on a worker thread -> _get_worker_loop() makes a thread-local event loop for this fresh thread and run_until_complete(). [CON-05]
8. `model_tools.py::_get_worker_loop` (`model_tools.py:83`): the loop is stored in threading.local and never closed; it dies with the per-call pool thread, stranding any async client bound to it. [CON-05]
9. `tools/homeassistant_tool.py::_run_async` (`tools/homeassistant_tool.py:140`): a handler that is registered sync bridges again with its own asyncio.run per call (a second, different bridge) — only when `tool_is_async` = False. [CON-04]
10. `gateway/run_shutdown.py::_stop_release_runtime_state._reap_aux_clients` (`gateway/run_shutdown.py:2058`): at gateway stop, sweeps auxiliary clients bound to dead worker-thread loops (the leak step 8 creates; #14210 EMFILE). [CON-05]

## Findings

### CON-01 — No shutdown registry: four runtimes each hand-list the same process-global teardown steps and then os._exit() past atexit

- severity: **critical** · effort: M · kind: collapse · low_hanging: true · loc_delta: -400
- evidence: `hermes_cli/main.py:102`, `hermes_cli/main.py:96`, `hermes_cli/cli_shutdown.py:133`, `cli.py:502`, `gateway/run_shutdown.py:1783`, `gateway/run_shutdown.py:2058`, `gateway/run.py:6122`, `gateway/run.py:6165`, `tui_gateway/entry.py:103`, `tui_gateway/server.py:417`, `hermes_cli/local_runtime/bootstrap.py:37`, `hermes_cli/observability/relay_shared_metrics.py:267`
- depends_on: —

**Problem.** Teardown of process-global subsystems (tool subprocesses, terminal environments, browsers, MCP servers, async delegations, auxiliary clients, managed local runtime, metrics session, SessionDB handles) is listed by hand in each runtime: the one-shot table `_ONESHOT_CLEANUPS` (hermes_cli/main.py:102), the CLI `_run_cleanup` + `cli_shutdown` helpers, the gateway `_stop_kill_tool_subprocesses` and `_stop_release_runtime_state` phases, and the TUI `_shutdown_sessions` / `_hard_exit`. Every runtime then ends in `os._exit()` (25 sites, 14 files) because a wedged daemon or pool thread would hang interpreter finalization; `os._exit` skips all 41 `atexit` registrations, so each runtime re-runs some of them by hand. The lists have already drifted: the one-shot table adds `shutdown_local_runtime` and `relay_shared_metrics.shutdown_runtimes` with the comment that their atexit hooks never run past os._exit (main.py:108-111); the gateway also exits by os._exit (run.py:6165) and lists neither. The gateway calls `cleanup_all_browsers`; CLI and one-shot call `_emergency_cleanup_all_sessions`. Every new subsystem with a teardown must be added to N lists by someone who knows they exist; resource_leak is 43 fix commits in the gist's classification.

**Move.** Add one module `hermes_lifecycle.py` (root, beside `hermes_logging.py`) with `on_shutdown(stage, name, fn, timeout)` and `run_shutdown(reason) -> report`, stages `INTERRUPT -> STOP_WORK -> FINAL_WRITE -> CLOSE` modelled on Home Assistant. Each subsystem registers its own teardown at first use (process_registry on first spawn, browser lifecycle on first session, MCP on first connect, local_runtime in `_stop_at_exit`, metrics in its constructor) instead of calling `atexit.register`. The four runtime lists (`_ONESHOT_CLEANUPS`, `_run_cleanup` steps, `_stop_kill_tool_subprocesses` + the reap/close tail of `_stop_release_runtime_state`, TUI `_shutdown_sessions`) become one call `run_shutdown(...)`; the single `os._exit` backstop stays in the entry point and runs after it. 41 `atexit.register` calls go to 0 outside `hermes_lifecycle` (which registers itself once for the normal-exit path).

**Reference.** `.repos/home-assistant-core/homeassistant/core.py:1042` — async_add_shutdown_job: subsystems register their own teardown; the core runs them in stage 1

**Risk.** Ordering: the gateway kills tool subprocesses BEFORE closing SessionDB and AFTER cron is marked interrupted; that order must be encoded as stages, not lost. Tests that patch `gateway.run.X` names on the shutdown path (run_shutdown.py:1-6 docstring) will need new seams. Profile scope: teardown steps that need a home binding (TUI `_finalize_session`) must register with the scope captured.

### CON-02 — Threads have no owner: 246 bare threads, 243 daemon, 126 fire-and-forget; daemon=True is the shutdown strategy

- severity: **high** · effort: L · kind: restructure · low_hanging: false · loc_delta: -300
- evidence: `agent/memory_provider.py:29`, `tools/AGENTS.md:104`, `tui_gateway/AGENTS.md:67`, `tui_gateway/server.py:408`, `cron/scheduler_thread.py:19`, `gateway/run.py:5929`, `gateway/run.py:5819`, `gateway/run.py:4352`, `tui_gateway/methods_voice.py:72`, `tui_gateway/methods_prompt.py:787`, `tools/process_registry.py:739`
- depends_on: CON-01, CON-03

**Problem.** 246 `threading.Thread(...)` constructions in scope; 243 pass `daemon=True`, 126 call `.start()` on the constructor result and keep no handle, 147 live in files with no `.join(`. Nothing can enumerate, stop, or join them. Consequences visible in the tree: the cron ticker needed a bespoke supervisor class to notice its own thread had died (`SupervisedTickerThread`, #111010); the TUI idle reaper is `while True: sleep` with no stop event (tui_gateway/server.py:408-414); shutdown cannot tell a mid-write worker from an idle one, so it skips the SessionDB close and relies on WAL recovery (run_shutdown.py:2091-2098); the gateway turn pool is unbounded and abandoned turns keep their threads (run.py:4352-4357). Three AGENTS.md files require `spawn_context_thread` for every new thread (tools/AGENTS.md:104, agent/AGENTS.md:133, tui_gateway/AGENTS.md:67); 20 call sites use it. The helper lives in `agent/memory_provider.py`, a memory-plugin ABC module, which is not where a gateway or cron author looks.

**Move.** One primitive in `hermes_lifecycle.py`: `spawn(name, target, *, owner, stop: Event | None, join_timeout)` that always binds the caller's context (CON-03), records the thread in a registry keyed by owner (runtime, session id, subsystem), and registers a bounded join in the owner's stop stage (CON-01). `owner.stop()` sets the stop event and joins with the budget; whatever is still alive is reported by name instead of silently abandoned. `SupervisedTickerThread` becomes a `restart=True` flag on the same primitive. Move `spawn_context_thread` out of `agent/memory_provider.py` and delete it there. A `hermes debug threads` view reads the registry.

**Reference.** `.repos/textual/src/textual/worker_manager.py:24` — WorkerManager: every worker (thread or async) belongs to a DOM node and a group; cancel_all/cancel_node (:134,:158) stop them when the owner goes away

**Risk.** Converting a daemon thread to a joined one can hang exit if its target ignores the stop event; keep daemon=True plus bounded join, and keep the os._exit backstop. Migration is per call site (246); do it per area. Tests that count threads or patch `threading.Thread` will need updates.

### CON-03 — Four context-into-thread helpers with different semantics, plus thread-local prompt callbacks as a second scoping mechanism

- severity: **high** · effort: M · kind: collapse · low_hanging: true · loc_delta: -150
- evidence: `agent/memory_provider.py:21`, `agent/memory_provider.py:29`, `tools/thread_context.py:36`, `tools/thread_context.py:21`, `tools/daemon_pool.py:26`, `gateway/run.py:4314`, `tools/terminal_tool.py:86`, `agent/vault_backends/unlock.py:26`, `agent/tool_executor.py:940`
- depends_on: —

**Problem.** Carrying the profile scope into a thread has four spellings: `ctx_bound`/`spawn_context_thread` (contextvars only, memory_provider.py:21,29), `propagate_context_to_thread` (contextvars + five thread-local prompt callbacks, thread_context.py:36), `DaemonThreadPoolExecutor.submit` (contextvars per task, daemon_pool.py:26) and `GatewayRunner._run_in_executor_with_context` (contextvars only, run.py:4314), plus 94 raw `copy_context()` calls. The split exists because approval, sudo and vault prompt callbacks live in `threading.local()` (terminal_tool.py:86, vault_backends/unlock.py:26), chosen in #13525 so overlapping ACP sessions on separate executor threads do not overwrite each other. A ContextVar gives the same per-session isolation and crosses thread hops with the ordinary copy. Today a worker started with the wrong helper silently loses either the profile (default-profile leak) or the approval callback (GHSA-qg5c-hvr5-hjgr class); `_callback_api()` says a callback missing from its table is silently absent on every worker. Gist: profile-scope leak 366 fix commits, thread_contextvar_lock 52.

**Move.** Make the five prompt callbacks ContextVars (`tools/terminal_tool.py` approval/sudo, `agent/vault_backends/unlock.py` unlock/code/save_login); setters become `ContextVar.set`. Then `propagate_context_to_thread` is `ctx_bound`: delete `tools/thread_context.py` (74 lines) and its `_callback_api` table. Keep exactly one `bind_context(fn)` in `hermes_lifecycle.py`, used by `spawn` (CON-02), the custom executor submit, and the gateway executor helper. The gist's planned 'threads use spawn_context_thread' lint becomes a ban on bare `threading.Thread`/`ThreadPoolExecutor.submit` outside `hermes_lifecycle`.

**Reference.** `.repos/anyio/src/anyio/to_thread.py:27` — to_thread.run_sync copies the caller's context into the worker by default; there is one entry point, not per-feature wrappers

**Risk.** ACP: each session must run its turn inside its own Context (asyncio.to_thread already copies); verify two overlapping ACP sessions keep separate approval callbacks. CLI: prompt_toolkit callbacks set on the main thread must be set before the turn context is copied. Security-sensitive: the fail-closed behaviour (callback None -> deny) must be preserved.

### CON-04 — At least eight hand-written sync-to-async bridges with different loops, timeouts and context handling

- severity: **high** · effort: M · kind: collapse · low_hanging: true · loc_delta: -250
- evidence: `model_tools.py:93`, `tools/homeassistant_tool.py:140`, `tools/browser_cdp_tool.py:91`, `agent/context_references.py:179`, `tui_gateway/methods_complete.py:80`, `cron/scheduler_delivery.py:1750`, `agent/relay_runtime.py:1417`, `agent/relay_runtime.py:81`, `agent/relay_llm.py:955`
- depends_on: CON-03

**Problem.** Running a coroutine from sync code is implemented separately in at least eight places: `model_tools._run_async` (persistent per-thread loops, 300 s timeout, full prompt-callback propagation), `homeassistant_tool._run_async` (asyncio.run per call, 30 s, copy_context only), `browser_cdp_tool._run_async` (asyncio.run, no timeout), `context_references.preprocess_context_references` (asyncio.run or a side pool), `methods_complete._plugin_reference_items` (side pool, no timeout), `scheduler_delivery` standalone send (asyncio.run, retry in a pool on RuntimeError), `relay_runtime._resolve_plugin_awaitable` (asyncio.run on a bare daemon thread with no context copy, relay_runtime.py:81-94) and `relay_llm._run_awaitable` (refuses on a loop thread). `model_tools.py:64-66` states the rule (never asyncio.run per call, or cached async clients hit 'Event loop is closed'); five of the others do exactly that. Each site picks its own timeout and its own answer to 'which profile is this running as'. blocking_in_async is 117 fix commits in the gist; hang issues 476 (20 of 60 sampled had no deadline).

**Move.** One module `hermes_async.py` exposing `run_sync(coro, *, timeout)` and `submit(coro) -> concurrent.futures.Future`, backed by a single process-wide background loop started lazily through `anyio.from_thread.start_blocking_portal` (anyio 4.14.2 is already in uv.lock as an httpx dependency) and stopped in the CLOSE stage of CON-01. `run_sync` binds the caller's context (CON-03). From a running loop it submits to the portal instead of spawning a thread. Delete the seven local copies; `registry.dispatch` calls `hermes_async.run_sync`.

**Reference.** `.repos/anyio/src/anyio/from_thread.py:187` — BlockingPortal / start_blocking_portal (:506): one event loop in one named thread; sync code calls portal.call(coro) / start_task_soon; the portal's task group owns every task and closes them on exit

**Risk.** A single loop serialises CPU-bound coroutine work that today runs on per-thread loops; async handlers that block the loop (sync I/O inside async def) would now stall every other bridge user — find them first (ASYNC rules). Tests that patch `model_tools._run_async` or rely on a fresh loop per call need new seams. Cancellation on timeout must cancel the task inside the portal (anyio does).

### CON-05 — Nine private 'event loop on a daemon thread' services, each with its own start, drain and stop; per-thread tool loops leak clients

- severity: **high** · effort: L · kind: collapse · low_hanging: false · loc_delta: -600
- evidence: `tools/mcp_tool_loop.py:255`, `agent/lsp/manager.py:93`, `tools/computer_use/cua_backend_session.py:38`, `tools/environments/modal.py:107`, `hermes_cli/plugin_host_child.py:143`, `tools/browser_supervisor.py:319`, `plugins/platforms/feishu/adapter.py:1113`, `agent/relay_llm.py:412`, `model_tools.py:83`, `gateway/run_shutdown.py:2058`
- depends_on: CON-04

**Problem.** Long-lived async services each create their own loop on their own thread: MCP (`mcp-event-loop`), LSP (`hermes-lsp-loop`), cua driver, Modal, the plugin host child, one CDP supervisor loop per browser task, the Feishu websocket, the relay LLM stream, and `model_tools` thread-local loops (one per worker thread; with `DaemonThreadPoolExecutor(max_workers=1)` per sequential tool call (agent/tool_executor.py:939) that is a new loop per tool call, never closed). Each service writes its own drain-on-stop code (`mcp_tool_lifecycle._drain_mcp_loop_tasks`, browser_supervisor's pending-task gather at :335, feishu's at :1180). Clients bound to the dead per-thread loops leak transports until EMFILE; the gateway sweeps them at the very end of shutdown (run_shutdown.py:2058-2066, #14210) and a CLI import hook neuters httpx `__del__` (cli.py:353-388). A gateway process therefore runs its main loop plus up to nine more, none of which the gateway's stop sequence knows about except by name.

**Move.** Run these services as tasks on the CON-04 background loop under one `anyio` task group owned by `hermes_lifecycle`: each service exposes `async def serve(ready, stop)`; `hermes_lifecycle.start_service(name, serve)` starts it, and the CLOSE stage cancels the group. Delete the per-service thread + loop + drain code and the thread-local loops in `model_tools.py:69-91`. Per-browser CDP supervisors become tasks, not threads. The aux-client sweep at shutdown and the httpx `__del__` neutering hook become unnecessary once clients are bound to a loop that lives for the whole process.

**Reference.** `.repos/anyio/src/anyio/from_thread.py:187` — BlockingPortal / start_blocking_portal (:506): one event loop in one named thread; sync code calls portal.call(coro) / start_task_soon; the portal's task group owns every task and closes them on exit

**Risk.** Services that block their loop (sync SDK calls inside coroutines) would stall the others; audit each before moving (Feishu's SDK parks in run_until_complete, adapter.py:1084). MCP stdio servers must still be killed on stop (mcp_death_supervisor). Plugin host child is a separate process: its loop stays, but uses the same helper.

### CON-06 — Gateway stop is 2.3k lines of phase ordering and ~15 work counters because work is not submitted through one registry

- severity: **high** · effort: L · kind: restructure · low_hanging: false · loc_delta: -1200
- evidence: `gateway/run.py:5366`, `gateway/run_shutdown.py:2052`, `gateway/run.py:6015`, `gateway/run.py:5810`, `gateway/run.py:5819`, `gateway/run_shutdown.py:2020`, `gateway/run_shutdown.py:191`, `gateway/run_shutdown.py:1526`, `gateway/run_shutdown.py:2091`, `gateway/run_shutdown.py:2112`
- depends_on: CON-01, CON-07

**Problem.** Gateway work runs on at least six carriers (turn executor, housekeeping executor, loop default executor for API runs and deferred hygiene, cron pool, `_background_tasks`, ad-hoc threads), so shutdown asks each one separately: `_active_work_count`, `_running_cron_job_count`, `_active_cron_job_count`, `_active_api_run_count`, `_active_api_worker_count`, `_active_deferred_agent_worker_count`, `_wedged_agent_count`, `_wedged_cron_job_count`, `_restart_safe_cron_count`, `_wedged_chat_agent_count`, `_awaitable_work_count`, `_describe_active_work` (run_shutdown.py:191-318, 1526-1648). Ordering is enforced by comments, not structure: the signal handler fires `asyncio.create_task(runner.stop())` and keeps no reference (run.py:5366); `_stop_release_runtime_state` sets `_shutdown_event` mid-stop (run_shutdown.py:2052), which wakes `start_gateway`'s shutdown tail (run.py:6015-6019) while the kill sweep, executor quiesce, SessionDB close and exit-state persist are still pending in `_stop_impl`; the tail never awaits `runner._stop_task`, blocks the loop with a sync `join(timeout=2)` (run.py:5819), and stops cron only after the drain (run.py:5810). `_background_tasks` cancellation must special-case `_stop_task`/`_restart_task` (run_shutdown.py:2020-2028, #12875). The DB close is skipped when any of four counters is non-zero (run_shutdown.py:2112-2118). race/TOCTOU is 245 fix commits in the gist, the largest class it calls uncheckable.

**Move.** Make `start_gateway` `async with GatewayRuntime(config) as rt:` where `rt` owns one task group and one tracked executor wrapper (`rt.run_blocking(fn, kind=..., writes_state=...)`, mirroring HA `async_add_executor_job` tracking). Turns, API runs, deferred hygiene, cron jobs and adapters' background tasks all go through it, so 'active work' is one query over one registry filtered by kind. `rt.stop(reason)` runs the CON-01 stages with per-stage timeouts and logs the still-running entries by name at each stage. The signal handler only calls `rt.request_stop()`; `start_gateway` returns after `await rt.stopped`. Cron ticker and housekeeping become runtime services stopped in the first stage, before the drain. The ~15 counters, `_StopContext`, the stop/restart-task special cases and `_start_gateway_shutdown_tail` collapse into the stage list.

**Reference.** `.repos/home-assistant-core/homeassistant/core.py:1125` — async_stop: four named stages (shutdown jobs, stop, final write, close), each under its own timeout, logging the tasks still running at each stage

**Risk.** Highest-risk move in the seam: launchd/systemd exit budgets (drain capping, exit 75 for service restart), resume_pending markers before drain, the .clean_shutdown marker, and the #101093 'never close the DB under a live writer' rule must all survive as stage behaviour. Many shutdown tests build bare runners via object.__new__ (getattr guards at run_shutdown.py:1871, 2238, 2271).

### CON-08 — SIGTERM behaviour is a chain of 'prepend' handlers whose order depends on which modules installed first

- severity: **high** · effort: M · kind: restructure · low_hanging: true · loc_delta: -150
- evidence: `tui_gateway/session_reaper.py:151`, `tui_gateway/session_reaper.py:178`, `gateway/host_rendezvous.py:562`, `gateway/host_rendezvous.py:609`, `hermes_cli/stderr_timestamp.py:66`, `tui_gateway/entry.py:150`, `hermes_cli/cli_tui_runtime_mixin.py:414`, `hermes_cli/cli_single_query.py:450`, `tui_gateway/compute_host.py:557`
- depends_on: CON-01

**Problem.** 27 `signal.signal` calls. At least three modules install a handler that saves the previous one and calls it after doing its own work: the TUI exit flush (flush sessions, stop turns, kill foreground commands, then chain; session_reaper.py:151-198), the host rendezvous token cleanup (host_rendezvous.py:562-609), and the stderr timestamp forwarder (stderr_timestamp.py:66-90). uvicorn's `capture_signals()` then saves THAT chain as its 'original' handler (session_reaper.py:180-183 docstring). What happens on SIGTERM is therefore the composition of whichever handlers were installed, in installation order; each handler does real teardown inside a signal frame (SQLite writes, process kills). The gateway uses `loop.add_signal_handler` instead (run.py:5914) plus a marker-polling thread because Windows has no loop signal handlers (run.py:5918-5932).

**Move.** One signal owner per runtime (`hermes_lifecycle.install_signal_handlers(runtime)`), installed by each entry point (`gateway/run.py::start_gateway`, `tui_gateway/entry.py`, `cli.py`, `hermes_cli/main.py` one-shot). The handler only records the signal and calls `request_stop(reason)`; the work that today lives in the chained handlers moves into CON-01 stages (exit flush -> FINAL_WRITE, rendezvous token removal -> CLOSE, foreground kill -> INTERRUPT). Delete `_exit_flush_prev_handlers`, `_prev_signal_handlers` and the forwarding chain.

**Reference.** `.repos/home-assistant-core/homeassistant/core.py:1125` — async_stop: four named stages (shutdown jobs, stop, final write, close), each under its own timeout, logging the tasks still running at each stage

**Risk.** uvicorn (dashboard/TUI WS server) installs its own handlers; the runtime owner must either run uvicorn with handler capture disabled or install after it. Re-raising the original signal for the correct exit status (session_reaper.py:173-177) must be preserved.

### CON-10 — Interrupting work means abandoning threads; the sync agent core cannot be cancelled, so every layer adds an abandon path

- severity: **high** · effort: XL · kind: restructure · low_hanging: false · loc_delta: None
- evidence: `gateway/run.py:4352`, `gateway/run.py:4320`, `agent/tool_executor.py:1489`, `agent/client_lifecycle.py:234`, `tools/daemon_pool.py:1`, `tools/daemon_pool.py:38`, `gateway/turn_executor.py:9`, `gateway/AGENTS.md:110`
- depends_on: CON-02

**Problem.** The turn loop, tool calls and provider requests are synchronous code on threads. A thread cannot be cancelled, so every layer that needs a deadline abandons the thread and keeps going: the gateway turn pool is unbounded because 'turns abandoned by the inactivity timeout' keep their threads (run.py:4352-4357); housekeeping gets a separate bounded pool so abandoned workers cannot grow it (run.py:4320-4329); parallel tool batches detach wedged workers (tool_executor.py:1486-1490); the client layer closes sockets from a 'stranger thread' to unstick a blocked request (`_drain_transports_after_abandonment`, client_lifecycle.py:234); `/login` polls an `attempt.cancelled` flag every second because `task.cancel()` cannot reach a worker (gateway/AGENTS.md:110-112). Two custom executors exist only to keep abandoned workers from blocking exit: `DaemonThreadPoolExecutor` re-implements CPython's private `_adjust_thread_count` with a Python-3.14 branch (daemon_pool.py:38-70) to skip the `_threads_queues` exit join (cpython Lib/concurrent/futures/thread.py:23-37), and `_UnboundedThreadExecutor` fakes `_threads`/`_shutdown` so shutdown can count it. Structured concurrency on the asyncio side (CON-06/07) cannot fix this: TaskGroup cancellation stops at the `run_in_executor` boundary.

**Move.** Two steps. (1) Short term: one `CancelToken` per turn (extend `agent/interrupt_control`) that every blocking call in the turn accepts — provider requests use httpx timeouts derived from the token's deadline, subprocess waits poll it, prompt waits select on it — so abandonment becomes the exception path, and `DaemonThreadPoolExecutor`/`_UnboundedThreadExecutor` are replaced by the CON-02 owned-thread registry with bounded joins. (2) Long term (XL): an async turn loop, as pydantic-ai runs its agent graph (`pydantic_ai_slim/pydantic_ai/_agent_graph.py`), so a turn is a task in the runtime's task group and cancellation reaches the provider stream directly. Sync tools run via `to_thread` with the token.

**Reference.** `.repos/trio/src/trio/_core/_run.py` — cancel scopes: a deadline is an object attached to a scope; every checkpoint inside observes it, so nothing is abandoned

**Risk.** Step 2 touches every provider adapter and the turn loop (seam 04/05). Step 1 is safe incrementally but must not add a second interrupt mechanism alongside the existing interrupt flags; it replaces them.

### CON-07 — Fire-and-forget asyncio tasks are tracked by 31 hand-rolled set+discard copies (and 23 not at all)

- severity: **medium** · effort: S · kind: collapse · low_hanging: false · loc_delta: -120
- evidence: `gateway/platforms/api_server.py:4094`, `gateway/platforms/yuanbao.py:2668`, `gateway/slash_commands.py:814`, `gateway/platforms/webhook.py:577`, `gateway/run.py:3765`, `gateway/platforms/qqbot/adapter.py:497`, `gateway/run.py:5366`
- depends_on: —

**Problem.** `self._background_tasks.add(task); task.add_done_callback(self._background_tasks.discard)` is written out 31 times in 21 files (gateway, adapters, MCP health, PTY sessions), each with its own field name (`_background_tasks`, `_inbound_tasks`, `_lifecycle_ack_tasks`) and its own helper (`_track_task`, `_create_task`, the api_server variant that 'tolerates test doubles'). ruff finds 23 more `create_task` results dropped (RUF006). Adapters' disconnect paths must remember to cancel their own set; the base class does not own it. Gist: task_gc_fire_and_forget 5, cancellederror_baseexception 19.

**Move.** One `TaskTracker` (≈30 lines) in `gateway/platforms/base.py` and `GatewayRunner`: `spawn(coro, name)` + `cancel_all(timeout)`; `BasePlatformAdapter.disconnect` calls `cancel_all` after the subclass hook. Delete the 21 local copies. When CON-06 lands, the tracker is the runtime's task group.

**Reference.** `.repos/home-assistant-core/homeassistant/core.py:839` — async_create_background_task / async_create_task put every task in _tasks or _background_tasks with a remove done-callback; stop cancels background tasks and waits for tracked ones

**Risk.** Adapters that rely on tasks surviving disconnect (reconnect loops) must opt out explicitly.

### CON-09 — Five separate hang watchdogs, each dumping stacks and calling os._exit its own way

- severity: **medium** · effort: S · kind: collapse · low_hanging: false · loc_delta: -500
- evidence: `hermes_startup_watchdog.py:177`, `gateway/shutdown_watchdog.py:264`, `hermes_cli/cli_shutdown.py:57`, `tui_gateway/entry.py:103`, `agent/deadline.py:262`
- depends_on: CON-01

**Problem.** Startup (`hermes_startup_watchdog.py`, 513 lines), gateway stop (`gateway/shutdown_watchdog.py`, 402 lines), CLI exit (`cli_shutdown._arm_exit_watchdog`), TUI exit grace (`entry._hard_exit`) and the loop-blocked dump in `agent/deadline.py` each implement 'arm a timer thread, dump faulthandler stacks, write a record, os._exit'. Each has its own env knob, dump path and pytest guard (`PYTEST_CURRENT_TEST` checks in run_shutdown.py:2245 and cli_shutdown.py:73).

**Move.** One `hermes_lifecycle.Watchdog(name, deadline, snapshot_fn, exit_code)` with `arm/kick/disarm`; startup, shutdown stages (CON-01 gives each stage a deadline) and the per-runtime exit backstop all use it. Delete the four other implementations; keep `hermes_startup_watchdog`'s progress-kick API as methods on the shared class.

**Reference.** `.repos/home-assistant-core/homeassistant/core.py:1125` — async_stop: four named stages (shutdown jobs, stop, final write, close), each under its own timeout, logging the tasks still running at each stage

**Risk.** Startup watchdog runs before config is loaded; the shared class must stay import-light (stdlib only).

### CON-11 — Importing tui_gateway/server.py starts threads, a pool and atexit hooks

- severity: **medium** · effort: S · kind: hygiene · low_hanging: false · loc_delta: 0
- evidence: `tui_gateway/server.py:194`, `tui_gateway/server.py:195`, `tui_gateway/server.py:417`, `tui_gateway/server.py:418`, `tui_gateway/methods_config.py:47`, `cron/scheduler.py:1303`
- depends_on: —

**Problem.** Module import of `tui_gateway/server.py` creates the RPC `ThreadPoolExecutor` (:194), registers two atexit hooks (:195, :417) and starts the idle-reaper thread, an infinite `while True: sleep(300)` loop with no stop event (:408-418). Any process that imports the module for a helper (tests, the dashboard, tooling) gets a reaper thread that touches session state. `methods_config.py:47` and `cron/scheduler.py:1303` register atexit hooks at import as well.

**Move.** Move pool creation, atexit and reaper start into an explicit `server.start(runtime)` called from `tui_gateway/entry.py` (and the WS entry), with the reaper as an owned thread (CON-02) stopped by the runtime.

**Reference.** `.repos/textual/src/textual/worker_manager.py:24` — WorkerManager: every worker (thread or async) belongs to a DOM node and a group; cancel_all/cancel_node (:134,:158) stop them when the owner goes away

**Risk.** Tests that import server.py and expect `_pool` to exist must call start() or use a fixture.

## Kill list

| target | why | importers/callers | evidence |
|---|---|---|---|
| tools/thread_context.py (whole module, `propagate_context_to_thread`, `_callback_api`) | collapses into contextvars once prompt callbacks are ContextVars (CON-03) | 13 | rg -c 'propagate_context_to_thread\(' = 13; tools/thread_context.py:36 |
| agent/memory_provider.py::spawn_context_thread, ctx_bound | thread primitive in a memory-plugin ABC module; replaced by hermes_lifecycle.spawn/bind_context (CON-02/03) | 26 | agent/memory_provider.py:21,29; 20 + 6 call sites |
| tools/daemon_pool.py::DaemonThreadPoolExecutor._adjust_thread_count | copies CPython private internals (with a 3.14 branch) to dodge the exit join; owned threads with bounded joins replace it (CON-10) | 13 | tools/daemon_pool.py:38-70 |
| seven local sync->async bridges | replaced by hermes_async.run_sync (CON-04) | n/a | tools/homeassistant_tool.py:140, tools/browser_cdp_tool.py:91, agent/context_references.py:179, tui_gateway/methods_complete.py:80, cron/scheduler_delivery.py:1750, agent/relay_runtime.py:1417, agent/relay_llm.py:955 |
| model_tools.py::_get_tool_loop, _get_worker_loop, _worker_thread_local | thread-local loops that die unclosed with per-call pool threads (CON-05) | 1 | model_tools.py:69-91 |
| hermes_cli/main.py::_ONESHOT_CLEANUPS and the hand lists in cli_shutdown/run_shutdown/tui server | one shutdown registry (CON-01) | n/a | hermes_cli/main.py:102; gateway/run_shutdown.py:1783; tui_gateway/server.py:417 |
| chained signal handlers (_exit_flush_prev_handlers, _prev_signal_handlers, stderr_timestamp._forward) | one signal owner per runtime (CON-08) | n/a | tui_gateway/session_reaper.py:147; gateway/host_rendezvous.py:609; hermes_cli/stderr_timestamp.py:66 |
| cron/scheduler_thread.py::SupervisedTickerThread | becomes restart=True on the owned-thread primitive (CON-02) | 1 | cron/scheduler_thread.py:19; gateway/run.py:5749 |
| tools/interpreter_shutdown.py + 14 `_interpreter_shutting_down` probes | work keeps being scheduled during finalization because nothing stops the ticker/pools first; staged stop removes the need (CON-01/06) | 14 | tools/interpreter_shutdown.py:19; cron/scheduler.py:1328 |

## Simplify list

| what N things | become what 1 thing | lines saved | evidence |
|---|---|---|---|
| agent/memory_provider.py::ctx_bound; agent/memory_provider.py::spawn_context_thread; tools/thread_context.py::propagate_context_to_thread; tools/daemon_pool.py::DaemonThreadPoolExecutor.submit; gateway/run.py::_run_in_executor_with_context; 94 raw copy_context() | hermes_lifecycle.bind_context + spawn | ~150 | CON-03 |
| model_tools.py::_run_async; tools/homeassistant_tool.py::_run_async; tools/browser_cdp_tool.py::_run_async; agent/context_references.py::preprocess_context_references (bridge half); tui_gateway/methods_complete.py::_plugin_reference_items (bridge half); cron/scheduler_delivery.py standalone send bridge; agent/relay_runtime.py::_resolve_plugin_awaitable; agent/relay_llm.py::_run_awaitable | hermes_async.run_sync over one anyio blocking portal | ~250 | CON-04 |
| tools/mcp_tool_loop.py loop thread; agent/lsp/manager.py loop thread; tools/computer_use/cua_backend_session.py loop thread; tools/environments/modal.py loop thread; tools/browser_supervisor.py per-task loop; plugins/platforms/feishu/adapter.py ws loop; agent/relay_llm.py stream loop; model_tools thread-local loops | services in one task group on the shared background loop | ~600 | CON-05 |
| hermes_cli/main.py::_ONESHOT_CLEANUPS; cli.py::_run_cleanup + hermes_cli/cli_shutdown.py steps; gateway/run_shutdown.py::_stop_kill_tool_subprocesses + reap tail; tui_gateway/server.py::_shutdown_sessions + entry._hard_exit; 41 atexit.register | hermes_lifecycle.on_shutdown registry + run_shutdown(stages) | ~400 | CON-01 |
| ~15 GatewayShutdownMixin work counters; _StopContext; _start_gateway_shutdown_tail; stop/restart task special cases | GatewayRuntime task group + tracked executor + staged stop | ~1200 | CON-06 |
| 31 set.add+add_done_callback(discard) copies in 21 files | TaskTracker on BasePlatformAdapter/GatewayRunner | ~120 | CON-07 |
| hermes_startup_watchdog.py; gateway/shutdown_watchdog.py; cli_shutdown._arm_exit_watchdog; tui_gateway/entry._hard_exit grace; agent/deadline loop-blocked dump | hermes_lifecycle.Watchdog | ~500 | CON-09 |

## Reference patterns to copy

| repo | path | pattern | where it applies here |
|---|---|---|---|
| home-assistant-core | `.repos/home-assistant-core/homeassistant/core.py:1125` | async_stop: four named stages (shutdown jobs, stop, final write, close), each under its own timeout, logging the tasks still running at each stage | CON-01/06/08/09: staged gateway/TUI/CLI stop with per-stage timeouts and still-running reports |
| home-assistant-core | `.repos/home-assistant-core/homeassistant/core.py:1042` | async_add_shutdown_job: subsystems register their own teardown; the core runs them in stage 1 | CON-01: subsystems register their own teardown instead of runtimes listing them |
| home-assistant-core | `.repos/home-assistant-core/homeassistant/core.py:839` | async_create_background_task / async_create_task put every task in _tasks or _background_tasks with a remove done-callback; stop cancels background tasks and waits for tracked ones | CON-07: one tracker for background tasks |
| home-assistant-core | `.repos/home-assistant-core/homeassistant/core.py:871` | async_add_executor_job tracks executor futures in the same task buckets, so shutdown waits on thread work through one registry | CON-06: executor work tracked in the same registry as tasks |
| anyio | `.repos/anyio/src/anyio/from_thread.py:187` | BlockingPortal / start_blocking_portal (:506): one event loop in one named thread; sync code calls portal.call(coro) / start_task_soon; the portal's task group owns every task and closes them on exit | CON-04/05: one background loop for sync->async calls and long-lived async services |
| cpython | `.repos/cpython/Lib/asyncio/taskgroups.py:13` | TaskGroup: tasks cannot outlive the async with block; first failure cancels siblings | CON-06/07: gateway runtime and adapter task ownership |
| cpython | `.repos/cpython/Lib/concurrent/futures/thread.py:23` | _python_exit joins every pool worker registered in _threads_queues at interpreter exit (registered with threading._register_atexit, :37) | CON-10: why DaemonThreadPoolExecutor exists; the exit join it dodges |
| textual | `.repos/textual/src/textual/worker_manager.py:24` | WorkerManager: every worker (thread or async) belongs to a DOM node and a group; cancel_all/cancel_node (:134,:158) stop them when the owner goes away | CON-02/11: threads and tasks belong to an owner that cancels them when it goes away |
| anyio | `.repos/anyio/src/anyio/to_thread.py:27` | to_thread.run_sync carries context, bounded by a capacity limiter | CON-03 |

## Answer to the seam question

Today, ownership is by convention. Each runtime has one main event loop: the gateway's `asyncio.run(start_gateway)` (gateway/run.py:6114), the dashboard's uvicorn loop, the ACP server's loop (acp_adapter/entry.py:220), and none for the classic CLI and TUI backend (their main threads are sync; the TUI runs turns on a bare thread per prompt, tui_gateway/methods_prompt.py:787). Around that main loop the process accumulates up to ~10 more loops, each on its own daemon thread and owned by the module that made it (MCP, LSP, cua, Modal, CDP supervisor per browser task, Feishu, relay LLM, plugin host child, one thread-local loop per tool worker thread in model_tools). Threads are started with `daemon=True` 243 times out of 246; 126 keep no handle. They are stopped in one of four ways: a module-specific stop event (cron, process_registry heartbeat, planned-stop watcher), being abandoned (turn threads, tool workers, housekeeping), a process-global sweep that a runtime remembers to call (`process_registry.kill_all`, `cleanup_all_environments`, `interrupt_all`, `shutdown_mcp_servers`, `shutdown_cached_clients`), or `os._exit`. Subprocesses are owned by `tools/process_registry.py` for tool work (parent-first SIGTERM, tools/AGENTS.md:111) and by ad-hoc Popen sites elsewhere (88). On SIGTERM: the gateway runs eight `_stop_*` phases under a thread watchdog, while `start_gateway`'s shutdown tail runs concurrently after `_shutdown_event`, then `os._exit`; the TUI runs a chained flush/stop-turns/kill handler, then uvicorn's or the default handler, then a 1 s grace `os._exit`; the CLI arms a 30 s exit watchdog and runs `_run_cleanup` from atexit; one-shot mode runs `_ONESHOT_CLEANUPS` then `os._exit`. What structured concurrency would delete: on the asyncio side, the 31 hand-rolled task sets and 23 dropped tasks (one task group per owner), the gateway's ~15 work counters and phase-ordering comments (one tracked registry plus HA-style stages), the stop/restart-task special cases, and the shutdown tail that races `_stop_impl`. With one portal loop (anyio `start_blocking_portal`, already in uv.lock), it also deletes the eight bridges and nine private service loops and the leaked-client sweep. What it does NOT delete: thread abandonment in the turn path. TaskGroup cancellation stops at `run_in_executor`; the sync agent core needs an explicit per-turn cancel token now and an async turn loop later before the custom executors, abandon paths and os._exit backstops can go.

## Cross-seam notes

- 13-tui-cron · `tui_gateway/methods_prompt.py:792` · TUI session state is an untyped dict carrying a live thread handle (`session['_run_thread']`); reaper, flush and lifecycle all key off dict fields
- 13-tui-cron · `cron/AGENTS.md:47` · cron in-flight state is six parallel module dicts keyed by (home, job id); a claim released under the wrong home leaks (cron/AGENTS.md:57-61)
- 04-agent-loop · `gateway/run_turn.py:3470` · per-turn 'gateway-turn-watchdog' daemon thread in addition to the turn thread; interrupt is flags + socket abort, not cancellation
- 05-providers · `agent/client_lifecycle.py:234` · client_lifecycle distinguishes owner-thread close from stranger-thread abort to unstick blocked sync HTTP; a cancel-token deadline on httpx would remove it
- 12-cli · `cli.py:356` · cli.py installs an import hook that neuters async httpx __del__ to hide 'Event loop is closed' from clients bound to dead loops
- 10-gateway · `gateway/run.py:5935` · start_gateway is a long sequential script of _best_effort steps (claim PID, control socket, ledger, keepalive, MCP, start, recover); ordering lives in comments
- 14-errors-obs · `gateway/run_shutdown.py:1774` · _quiet_step / _best_effort / suppress(Exception) wrap every teardown step; a staged stop with per-stage reports would surface failures instead of debug-logging them
- 06-tools · `tools/code_kernel.py:176` · tools/code_kernel.py starts parent-death watchdog threads at import (gated on inherited handles)
- 08-state · `gateway/run_shutdown.py:2091` · gateway shutdown skips SessionDB close when any worker may be mid-write and relies on WAL recovery next boot (#101093, #102198)

## UNVERIFIED

- UNVERIFIED: that `asyncio.run` in gateway/run.py:6114 actually cancels `runner._stop_task` mid-phase when `_start_gateway_shutdown_tail` returns first (CON-06). Verify: live SIGTERM on a gateway with a slow `process_registry.kill_all` and check whether 'Gateway stopped (total teardown' (run_shutdown.py:2209) is logged.
- UNVERIFIED: whether a gateway process ever boots the managed local runtime or opens a relay metrics session, i.e. whether the missing `shutdown_local_runtime`/`relay_shared_metrics.shutdown_runtimes` in the gateway path leaks anything (CON-01). Verify: run a gateway with a local llama model configured, stop it, check for an orphaned llama-server.
- UNVERIFIED: that `agent/relay_runtime.py::_run_on_daemon_thread` (no context copy) runs code that reads profile-scoped state (CON-04). Verify: trace the relay plugin lifecycle awaitables for get_hermes_home()/get_secret calls under multiplex.
- UNVERIFIED: the count of 'private event loops' (~9-10) is from `rg new_event_loop|run_forever` plus reading each site; plugins outside the listed ones may add more.
- UNVERIFIED: 35 of 246 threads context-wrapped is a lower bound from the constructor expression only (`scripts/con_threads.py`); targets wrapped in an earlier statement are not counted.
- UNVERIFIED: line-count savings (loc_delta) are estimates from the sizes of the modules and helpers named, not from a prototype.
- UNVERIFIED: that converting the five prompt callbacks to ContextVars preserves ACP per-session isolation (CON-03). Verify: two concurrent ACP sessions with different approval callbacks after the change.
- UNVERIFIED: dashboard (hermes_cli/web_server*.py) and ACP shutdown paths were inventoried by grep only, not read end to end.
