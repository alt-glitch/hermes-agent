# 13 TUI JSON-RPC backend and cron scheduler

Checkout `origin/main` = `ea81748579`. Reference SHAs per `inputs/reference-repos.md`. Cron facts gathered by a child reader (`notes/13-cron-child.md`); the load-bearing lines were re-opened by the parent.

## TL;DR

- Structural problem that matters most: tui_gateway/method_ctx.py::bind_module rebinds the __globals__ of every function in 45 sibling modules (22,304 lines) onto server.py (3,671 lines), so ~26k lines are one module namespace. Static analysis and IDE navigation are blind to it (~2,700 F821), It exists so the Sep 2026 split could keep handler bodies byte-identical without an import cycle (method_ctx.py:1-6) and so ~2,264 test lines could keep patching `server.X`.
- Biggest kill: method_ctx.py plus the 45 `register()` shims, the `# noqa: F401 (split modules)` imports in server.py and the `from . import (...)`/loop at server.py:3632-3671. Step 1 is a mechanical codemod to explicit `srv.name` reads that keeps every existing test patch working.
- Biggest simplification: one typed MethodContract per RPC that carries execution (inline/pool), profile scope and compute-host route, so `_LONG_HANDLERS`, `MUTATOR_ROUTE_TABLE`, 51 `@_profile_scoped` lines, `_profile_scoped_rpc` and 7 decorator variants collapse into the dispatcher. Profile scope becomes the default instead of an opt-in.
- Low-hanging fruit (S/M effort, high severity): 3. They are TUI-02 (typed LiveSession), TUI-03 (method metadata owned by the contract) and TUI-05 (typed cron JobRecord/FireContext). TUI-01's first PR is also a mechanical, behaviour-preserving codemod.
- Seam answer: (a) yes, and the first step needs no test changes. (b) cron is a scheduler plus five more durable stores and four in-job sub-states. One run's outcome is written to 2-5 stores in separate transactions; it is not a small job model.

## What this area is

Scope: tui_gateway/, cron/, tools/cronjob_tools.py (boundary), hermes_cli/kanban_db_dispatch.py (boundary only). 60,523 lines in 136 files (tui_gateway 42.6k/101, cron 17.9k/35 per `inputs/metrics/SUMMARY.md`).

Entry points: `tui_gateway/entry.py::main` (stdio, spawned by `hermes --tui`), `tui_gateway/ws.py::handle_ws` (Desktop/dashboard WebSocket), `tui_gateway/compute_host.py` (turn-isolation child), the gateway's `SupervisedTickerThread` for cron (`gateway/run.py:5750`), and `python -m cron.scheduler --external-worker-file` (restart-safe worker).

| module | lines | owns |
|---|---|---|
| `tui_gateway/server.py` | 3,671 | facade: process globals (_sessions, _methods, locks, cfg cache), _profile_scoped, _emit/write_json, _init_session; imports and binds 45 split modules at the bottom (server.py:3632-3671) |
| `tui_gateway/method_ctx.py` | 133 | rebind()/bind_module()/HandlerRegistry: copies split-module functions onto server.py with server.py's globals |
| `tui_gateway/rpc_dispatch.py` | 94 | dispatch (inline vs pool via _LONG_HANDLERS), handle_request, contract param/result checks; itself rebound onto server |
| `tui_gateway/methods_session.py` | 2,610 | session.create/resume/list/branch, pets, billing; largest F821 file (592) |
| `tui_gateway/methods_tools.py` | 2,017 | tools/MCP/plugins RPCs, _profile_scoped_rpc |
| `tui_gateway/methods_prompt.py + prompt_turn.py` | 2,617 | prompt.submit admission and the turn worker (_run_prompt_submit) |
| `tui_gateway/contracts/` | 8,123 | Pydantic Params/Result/Payload per method/event/server request; generator source for the TS client |
| `tui_gateway/compute_host.py + host_supervisor.py + compute_host_bridge.py` | 1,464 | dashboard turn isolation: a child process speaking an untyped line-JSON frame protocol |
| `tui_gateway/ws.py` | 477 | WebSocket transport; handle_ws (CC 30) incl. per-connection teardown |
| `cron/scheduler.py` | 4,460 | facade: in-flight globals, run_one_job, run_job, external worker launch/adoption, tick lock |
| `cron/jobs.py` | 3,495 | jobs.json store, schedule parsing, due scan, claims, mark_job_run |
| `cron/scheduler_delivery.py` | 2,133 | _deliver_result, live adapter / standalone / Bot Chat / worker-queue lanes |
| `cron/executions.py + incidents.py` | 813 | executions.db ledger (run records) and cron_incidents table in the same DB |
| `cron/delivery_queue.py + bot_chat_delivery.py` | 591 | two of the three durable delivery queues (deliveries.db, bot_chat_pending/*.json) |
| `cron/lifecycle_guard.py` | 1,289 | gateway-restart command scanner; 3 of 4 runtime callers are in tools/ |

## How it works end to end

### User submits a prompt in the TUI (or Desktop) and sees the streamed answer

Trigger: hermes --tui, user presses Enter; Ink sends prompt.submit. Inputs: `transport` (enum[stdio,ws], default stdio): stdio for Ink, WebSocket for Desktop/dashboard; `turn_isolation` (bool, default False): dashboard.turn_isolation routes the turn to the compute-host child process; `session_busy` (bool, default False): a turn is already running in this session

1. `tui_gateway/entry.py::main` (`tui_gateway/entry.py:328`): reads one newline-delimited JSON-RPC frame from stdin and calls dispatch (entry.py:347) — when `transport` = stdio
2. `tui_gateway/ws.py::handle_ws` (`tui_gateway/ws.py:295`): WebSocket read loop feeds the same dispatch — when `transport` = ws [TUI-12]
3. `tui_gateway/rpc_dispatch.py::dispatch` (`tui_gateway/rpc_dispatch.py:45`): binds the transport ContextVar; prompt.submit is not in _LONG_HANDLERS so it runs inline [TUI-03]
4. `tui_gateway/rpc_dispatch.py::_handle_admitted_request` (`tui_gateway/rpc_dispatch.py:29`): validates params against the Pydantic contract for unknown keys only, discards the model, calls fn(rid, params) with the raw dict (rpc_dispatch.py:34) [TUI-06]
5. `tui_gateway/methods_prompt.py::prompt.submit handler` (`tui_gateway/methods_prompt.py:657`): handler body; every helper it uses (_sess_nowait, _sessions, _err) resolves through server.py globals because of bind_module [TUI-01]
6. `tui_gateway/server.py::_sess_nowait` (`tui_gateway/server.py:1221`): looks up the untyped session dict in _sessions [TUI-02]
7. `tui_gateway/methods_prompt.py::prompt.submit handler` (`tui_gateway/methods_prompt.py:713`): decides compute-host isolation; when on, sends a turn.start frame to the child via _submit_prompt_to_compute_host (methods_prompt.py:761) and returns — when `turn_isolation` = True [TUI-07]
8. `tui_gateway/methods_prompt.py::prompt.submit handler` (`tui_gateway/methods_prompt.py:787`): starts a raw threading.Thread that waits for the agent build (_run_after_agent_ready, methods_prompt.py:582) and calls _run_prompt_submit (methods_prompt.py:612) — when `turn_isolation` = False
9. `tui_gateway/prompt_turn.py::_run_prompt_submit` (`tui_gateway/prompt_turn.py:1123`): _admit_prompt_turn rejects a busy session; binds _session_profile_runtime_scope (prompt_turn.py:1130) [TUI-03]
10. `tui_gateway/prompt_turn.py::_prepare_turn_input` (`tui_gateway/prompt_turn.py:656`): binds approval/session/profile scopes for the worker, builds run kwargs, probes run_conversation's signature (prompt_turn.py:782)
11. `tui_gateway/prompt_turn.py::_prepare_turn_input (run body)` (`tui_gateway/prompt_turn.py:802`): agent.run_conversation(run_message, **run_kwargs)
12. `tui_gateway/prompt_turn.py::_stream` (`tui_gateway/prompt_turn.py:764`): each delta is emitted as message.delta via server.py::_emit (server.py:699) -> write_json (server.py:673) -> the bound transport
13. `tui_gateway/prompt_turn.py::_run_prompt_submit` (`tui_gateway/prompt_turn.py:1179`): emits message.complete, then _post_turn_housekeeping (prompt_turn.py:1224)

### A recurring cron job fires and its output is delivered to Telegram

Trigger: gateway ticker wakes; a job's next_run_at is due. Inputs: `external_worker` (bool, default False): Linux + systemd-supervised gateway: the fire runs in a restart-safe worker subprocess (tools/process_registry.py:420-426); `no_agent` (bool, default False): job is a script only; no AIAgent; `live_adapter_ready` (bool, default True): the Telegram adapter is connected in this process

1. `gateway/run.py (start_gateway)` (`gateway/run.py:5750`): starts SupervisedTickerThread with the cron provider
2. `cron/scheduler_provider.py::_start_multiplex` (`cron/scheduler_provider.py:575`): one ticker iterates served profiles, each under _profile_cron_scope(home) [TUI-09]
3. `cron/scheduler_tick.py::tick` (`cron/scheduler_tick.py:7`): admission, tick lock, Bot Chat deferred drain; body calls back into the facade 26 times via _sched. [TUI-11]
4. `cron/jobs.py::get_due_jobs` (`cron/jobs.py:2890`): due scan over jobs.json dicts; stamps pending_slot / last_dispatch and _scheduled_instant onto the job dict [TUI-05]
5. `cron/jobs.py::advance_next_runs` (`cron/jobs.py:2700`): advances next_run_at before dispatch (called at scheduler_tick.py:83)
6. `cron/scheduler.py::_submit_with_guard` (`cron/scheduler.py:4341`): try_register_running_job (module globals), create_execution row (scheduler.py:4350), submit to the per-home pool (scheduler.py:4370) [TUI-08]
7. `cron/scheduler.py::_process_due_job` (`cron/scheduler.py:4283`): claim_job_for_fire writes fire_claim into jobs.json, then run_one_job (scheduler.py:4292) [TUI-04]
8. `cron/scheduler.py::run_one_job` (`cron/scheduler.py:2826`): reads env _HERMES_CRON_EXTERNAL_WORKER as the mode flag; otherwise calls _launch_external_cron_worker [TUI-09]
9. `cron/scheduler.py::_launch_external_cron_worker` (`cron/scheduler.py:3722`): returns False for in_process mode; otherwise writes a payload with the whole job dict and spawns `python -m cron.scheduler --external-worker-file`, which re-enters run_one_job — when `external_worker` = True [TUI-05]
10. `cron/scheduler.py::_run_one_job_body` (`cron/scheduler.py:3422`): secret scope, mark_execution_running, run_job [TUI-09]
11. `cron/scheduler.py::run_job` (`cron/scheduler.py:2585`): _prepare_job_prompt; a no_agent job runs its script and returns; else AIAgent under the inactivity watchdog
12. `cron/scheduler.py::_save_compose_deliver` (`cron/scheduler.py:3152`): saves output, upserts/resolves cron_incidents, calls _deliver_result [TUI-04]
13. `cron/scheduler_delivery.py::_deliver_result` (`cron/scheduler_delivery.py:1995`): inside an external worker: enqueue into deliveries.db and wait for the gateway to drain it — when `external_worker` = True [TUI-10]
14. `cron/scheduler_delivery.py::_deliver_result` (`cron/scheduler_delivery.py:2110`): live adapter send through DeliveryRouter; falls back to _deliver_standalone or a reconnect obligation in the gateway delivery ledger — when `live_adapter_ready` = True [TUI-10]
15. `cron/scheduler.py::_finish_completed_run` (`cron/scheduler.py:3216`): mark_job_run writes last_status/last_error/failure_streak into jobs.json, then finish_execution writes status/error/delivery_outcome into executions.db (scheduler.py:3236): two stores, two transactions [TUI-04]

## Findings

### TUI-01 — Globals rebinding makes 45 tui_gateway modules and server.py one 26k-line namespace that static analysis cannot read

- severity: **critical** · effort: L · kind: kill · low_hanging: false · loc_delta: -330 · depends_on: —
- evidence: `tui_gateway/method_ctx.py:16`, `tui_gateway/method_ctx.py:78`, `tui_gateway/server.py:23`, `tui_gateway/server.py:3632`, `tui_gateway/server.py:3660`, `tui_gateway/methods_vault.py:36`, `tui_gateway/session_history.py:267`, `tui_gateway/methods_session.py:1`, `tui_gateway/methods_groups.py:34`, `tui_gateway/server_requests.py:109`, `tui_gateway/compute_host.py:389`
- **problem:** bind_module (method_ctx.py:78) re-creates every function of 45 sibling modules (22,304 lines; count: wc -l over the module list at server.py:3660-3669) with server.py's globals and publishes it onto server.py. Bodies use _ok, _err, _sessions, logger and even os as bare names they never import. Costs, literally: (1) ruff F821 reports ~2,700 undefined names in these files (inputs/metrics/SUMMARY.md), so F821 cannot be enabled and real NameErrors ship (the gist cites a 33-site NameError sweep). (2) Go-to-definition and find-references do not work across the package. (3) server.py keeps imports it does not use, marked `# noqa: F401 (split modules)`; server.py:23-24 says deleting one 'breaks a handler at call time, not import time'. (4) Module-level constants in a sibling are unreachable from its own handlers (methods_vault.py:36-38 keeps error code 5095 as a literal for that reason; session_history.py:267 re-imports inside a function). (5) A runtime collision check (method_ctx.py:122-128) replaces what the import system would give for free. (6) There are five ways to reach server state: bind_module, HandlerRegistry.install, methods_groups.bind_server's `_bound_server` (methods_groups.py:34), server_requests.bind_sinks callbacks (server_requests.py:109), and plain `server._sessions` in compute_host.py:389. The stated reasons (method_ctx.py:1-6, methods_session.py:1-5) are byte-identical bodies during the split, no facade import cycle, and tests that monkeypatch server.X: `rg -c 'monkeypatch.setattr\((server|srv|...)|patch\("tui_gateway\.server\.' tests/` = ~2,264 lines in 218 files over ~236 names. It was added on 2026-09-02 (93fead86dd), so it is one month old.
- **move:** Two PRs. PR 1 (mechanical, no test changes): in each sibling add `from tui_gateway import server as srv` inside functions or via a module-level lazy accessor, and rewrite every name ruff F821 reports to `srv.<name>` (and every `global X` write to `srv.X = ...`). Attribute reads on the module object happen at call time, so every existing `monkeypatch.setattr(server, 'X', ...)` still intercepts. Then delete method_ctx.py (133 lines), the 45 `register()` functions, the `from . import (...)` block and loop (server.py:3632-3671) and the noqa imports; server.py registers handlers by importing the modules, whose `@method` decorator calls register_method directly. Intra-module calls to helpers that tests patch on server must also go through `srv.` (ruff will not flag them; list them by grepping test patch names against each sibling's own defs). Turn F821 on for tui_gateway/. PR 2 (design): replace the `srv` module with a typed `GatewayContext` (attrs/dataclass) holding sessions registry, locks, cfg cache, db, live transports, pool and emit/write; handlers take `(ctx, rid, params)`; tests build a context fixture instead of patching module attributes.
- reference: svcs `.repos/svcs/src/svcs/_core.py:184` — Registry of factories + per-request Container (_core.py:573); handlers ask the container for typed services instead of reading module globals; tests register fakes on the registry
- risk: PR 1: a sibling helper called bare inside its own module that a test patches on server stops being intercepted; find these by intersecting the ~236 patched names with each module's own top-level defs before the codemod. `global` writes must become `srv.X =` or state splits. PR 2 rewrites ~2,264 test patch lines. Behaviour to preserve: handler registration order, the contract completeness check (register_method is still the one seam), and module-level state living in one place.

### TUI-02 — The live session is an untyped dict with 104 keys, built by three hand-written literals that disagree

- severity: **high** · effort: M · kind: boundary · low_hanging: true · loc_delta: -60 · depends_on: TUI-01
- evidence: `tui_gateway/server.py:93`, `tui_gateway/server.py:2754`, `tui_gateway/methods_session.py:424`, `tui_gateway/compute_host.py:389`, `tui_gateway/model_switch.py:159`
- **problem:** `_sessions: dict[str, dict]` (server.py:93). `rg -o 'session(\[|\.get\(|\.setdefault\(|\.pop\()"[a-z_]+"' tui_gateway/` finds 104 distinct keys over 1,022 sites in 31 files. The record is created by three literals with different key sets: server.py:2754 (_init_session) has no agent_ready/agent_error/active_session_lease/close_on_disconnect; methods_session.py:424 (session.create) has them plus 10 more; compute_host.py:389 (fallback) lacks profile_home, auth_user_id and explicit_cwd. Keys are added lazily with setdefault (model_switch.py:159 `session.setdefault("agent_build_lock", threading.Lock())`) and underscore keys (_finalized, _turn_cancel_requested, _submit_user_row) carry turn state. Every reader guards with .get(..., default), and a missing key is a runtime None, not an error. Tests build their own dict literals (~181 lines in 88 files under tests/tui_gateway match `_sessions[...] = {` or `"history_lock":`).
- **move:** Add tui_gateway/session_record.py with `@attrs.define class LiveSession` (fields with defaults for all 104 keys, grouped: identity, agent build, history, transport, turn state) and one factory `LiveSession.new(...)` used by all three creation sites. Move turn-scoped underscore keys into a nested `TurnState`. Keep `__getitem__/get` on the class for one release only if the codemod cannot cover tests in the same PR; prefer converting tests in the same PR (no compat shim, per root AGENTS.md).
- reference: attrs `.repos/attrs/src/attr/_next_gen.py:23` — attrs.define: slotted, typed record with defaults and validators instead of a dict
- risk: compute-host child reconstructs sessions from frames (compute_host.py:380-412); the frame must carry the typed fields. Tests building dicts break and must use the factory. Preserve: history_lock identity per session, transport slot semantics (FanoutTransport membership).

### TUI-03 — Per-method dispatch policy lives in five places; profile scope is opt-in per handler

- severity: **high** · effort: M · kind: collapse · low_hanging: true · loc_delta: -150 · depends_on: —
- evidence: `tui_gateway/server.py:175`, `tui_gateway/methods_connectors.py:440`, `tui_gateway/methods_connectors_account.py:279`, `tui_gateway/methods_bot_relay.py:269`, `tui_gateway/host_supervisor.py:27`, `tui_gateway/server.py:596`, `tui_gateway/methods_tools.py:20`, `tui_gateway/method_ctx.py:60`, `tui_gateway/methods_session.py:189`
- **problem:** For one RPC name, a reader must check: the contract (Params/Result in contracts/), `_LONG_HANDLERS` (server.py:175, a frozenset that three register() functions then replace with a union: methods_connectors.py:440, methods_connectors_account.py:279, methods_bot_relay.py:269), the compute-host `MUTATOR_ROUTE_TABLE` (host_supervisor.py:27), whether the handler carries `@_profile_scoped` (51 sites; `rg -c '@_profile_scoped\b'`), `_profile_scoped_rpc` (methods_tools.py:20) or an inline `with _session_profile_runtime_scope/_profile_build_scope` (49 sites), and which of 7 decorator variants wraps it (_session_method, _pet_method, _room_method, _projects_method, _account_method, _controller_method, plain method; 178 decorated names). Profile scope is the #1 bug class in the gist (366 fix commits); tui_gateway/AGENTS.md tells authors to grep for unscoped handlers by hand.
- **move:** Extend contracts' MethodContract with `execution: Literal['inline','pool']`, `scope: Literal['profile','none']` (default 'profile') and `isolation_route: Literal['turn-path','run-concurrent','idle-gated'] | None`. rpc_dispatch reads them: pool vs inline replaces _LONG_HANDLERS; the dispatcher binds `_session_profile_runtime_scope` from params.profile or the session's profile_home for every scope='profile' method, so @_profile_scoped and HandlerRegistry.profile_scoped are deleted and _profile_scoped_rpc shrinks to its error mapping; host_supervisor reads isolation_route from the contract. A new handler is scoped unless its contract says otherwise, and the contract test asserts it.
- reference: inspect_ai `.repos/inspect_ai/src/inspect_ai/_util/registry.py:127` — registry_add(o, RegistryInfo): metadata is attached to the registered object once and read by the runtime, not kept in side tables
- risk: Some methods must not bind a scope (sessionless profile.list across homes, gateway.ping). Mark them scope='none' explicitly and cover with the A->B->A two-home probe the AGENTS.md prescribes. _session_profile_runtime_scope for the launch profile in a single-profile process must stay a no-op (it is: model_switch.py:134 delegates to _profile_runtime_scope_tokens).

### TUI-04 — Cron writes one run's outcome to 2-5 stores in separate transactions

- severity: **high** · effort: L · kind: collapse · low_hanging: false · loc_delta: -400 · depends_on: TUI-05, 08-state
- evidence: `cron/scheduler.py:3216`, `cron/scheduler.py:3236`, `cron/jobs.py:2383`, `cron/executions.py:56`, `cron/incidents.py:50`, `cron/jobs.py:2354`, `cron/scheduler.py:370`, `cron/scheduler_delivery.py:1290`
- **problem:** Stores per profile home: jobs.json, executions.db (table executions + table cron_incidents, incidents.py:50-61 forces the same file), deliveries.db, bot_chat_pending/*.json, notepad.db, suggestions.json. For one fire, last status and error go to jobs.json via mark_job_run (scheduler.py:3218) and to executions.db via finish_execution (scheduler.py:3236), in two calls. Failure history lives in failure_streak/last_failure (jobs.py:2396-2406) and in cron_incidents first/last_seen. 'Already alerted the user' has two mechanisms: preflight_alerted in jobs.json (jobs.py:2354-2361) and cron_incidents.alerted_at with cooldown (scheduler.py:370-410). Delivery outcome lands in up to five places (jobs.json last_delivery_*, executions.delivery_outcome, deliveries.db, bot_chat_pending, gateway delivery_ledger). A crash between writes leaves them disagreeing, and every reader must know which store wins.
- **move:** Make the executions row the single run record: status, error, delivery_outcome and delivery detail. jobs.json keeps definition + schedule + claims and a `last_execution_id`; `last_status/last_error/last_failure/last_delivery_*` become reads of the latest execution (jobs.py already joins latest_execution for listing). Fold preflight_alerted into cron_incidents. Add `RunOutcome` (dataclass) and one `record_run(outcome)` that advances the schedule and finishes the execution in a defined order.
- reference: home-assistant-core `.repos/home-assistant-core/homeassistant/helpers/event.py:1631` — async_track_time_interval: one object owns one schedule's timing state; the run callback gets only the fire time. Shape lesson only; HA has no persistence
- risk: hermes cron list, the dashboard router and tools/cronjob_tools.py read jobs.json fields directly; those readers move to the execution join. Preserve at-most-once (next_run_at advanced before dispatch) and the 'never drop a slot silently' invariant (cron/AGENTS.md).

### TUI-05 — The cron job is a plain dict that is also the run context and the IPC payload

- severity: **high** · effort: M · kind: boundary · low_hanging: true · loc_delta: -40 · depends_on: —
- evidence: `cron/job_definition.py:13`, `cron/jobs.py:1892`, `cron/scheduler.py:4290`, `cron/scheduler.py:3740`, `cron/scheduler_delivery.py:842`, `cron/bot_chat_delivery.py:137`
- **problem:** There is no Job type: job_definition.py:13-18 is a frozenset of field names. `rg -o '\bjob\.get\(|\bjob\[' cron/ tools/cronjob_tools.py | wc -l` = 512 sites over 49 literal keys. Run-scoped keys (execution_id, _scheduled_instant, _model_unreachable, _quota_hold_seconds, _bot_chat_delivery_receipts, _notification_all_targets_suppressed, _bot_chat_run_id) are written onto the persisted dict (e.g. scheduler.py:4290-4291), the whole dict is serialized into the external-worker payload (scheduler.py:3740) and into Bot Chat deferred records (`dict(job)`, scheduler_delivery.py:842), and delivery results travel back through those keys (bot_chat_delivery.py:137-141). quota_hold.py and unreachable_retry.py add their own keys into the same dict.
- **move:** Add `JobRecord` (TypedDict first, then attrs) in cron/job_definition.py covering authored + scheduler-owned fields, and `FireContext(job, execution_id, scheduled_instant, model_unreachable, quota_hold_s)` passed through run_one_job/run_job/_deliver_result. _deliver_result and _deliver_to_bot_chat return a `DeliveryReport` instead of mutating the job. The worker payload becomes `{job: JobRecord, fire: FireContext}`.
- reference: attrs `.repos/attrs/src/attr/_next_gen.py:23` — typed record with evolve() for per-run copies instead of mutating the stored object
- risk: Old worker payloads in flight during an upgrade carry the dict shape; the worker must accept both for one release (it is a process boundary, not an internal move). Preserve the jobs.json on-disk format.

### TUI-06 — RPC params are validated against Pydantic models twice and then handlers re-parse the raw dict

- severity: **medium** · effort: L · kind: boundary · low_hanging: false · loc_delta: -400 · depends_on: TUI-03
- evidence: `tui_gateway/contracts/registry.py:94`, `tui_gateway/contracts/registry.py:111`, `tui_gateway/rpc_dispatch.py:34`, `tui_gateway/methods_connectors_account.py:30`
- **problem:** Every method has a Params model (contracts/, 8,123 lines). validate_params (registry.py:94-109) runs model_validate only to reject unknown keys and returns the raw dict; check_params_accepted (registry.py:111-119) validates again after the handler. Handlers then re-read the dict: 409 `params.get(` sites plus 48 _str_param/_flag helper sites in tui_gateway/. The docstring (registry.py:95-99) says this is deliberate so handlers keep their domain error codes (4006 missing session_id etc.). methods_connectors_account.py:30 already validates into the model and passes it to the body, a third validation.
- **move:** Validate once in dispatch and hand the handler the Params instance. Keep domain codes by declaring them on the contract (e.g. `Field(..., json_schema_extra={'missing_code': 4006})` or a per-contract `error_codes` map) that the dispatcher uses to translate the first ValidationError. Delete check_params_accepted. Convert handlers module by module; the generator and TS side are unchanged because the models are already the wire.
- reference: jupyter_client `.repos/jupyter_client/jupyter_client/session.py:651` — Session.msg_header/msg: the message is built and parsed once into a typed header + content; handlers receive the parsed message
- risk: Clients branch on specific error codes; the translation table must reproduce them. Coercions handlers do today (str ids sent as ints) need explicit validators.

### TUI-07 — The compute-host child speaks a second, untyped frame protocol outside the contracts

- severity: **medium** · effort: S · kind: boundary · low_hanging: false · loc_delta: 40 · depends_on: TUI-02
- evidence: `tui_gateway/compute_host.py:62`, `tui_gateway/compute_host.py:149`, `tui_gateway/host_supervisor.py:408`, `tui_gateway/compute_host_bridge.py:254`
- **problem:** With dashboard.turn_isolation the parent and a child exchange line-JSON frames (hello, hb, turn.start, turn.error, interrupt, respond, reload_mcp, control, control.error, orphan, shutdown/ack, rpc, error) built as dict literals in host_supervisor.py, compute_host.py and compute_host_bridge.py, dispatched by string (compute_host.py:62 _FRAME_HANDLERS, host_supervisor.py:408). None are in tui_gateway/contracts, which exists precisely to declare wire shapes. The child even reconstructs a session dict from frame fields (compute_host.py:389).
- **move:** Add contracts/compute_host.py with one Pydantic model per frame type and a discriminated union on `type`; both ends parse into the union and dispatch on the class. The frame carries the typed LiveSession fields from TUI-02.
- reference: jupyter_client `.repos/jupyter_client/jupyter_client/session.py:308` — msg_header(): every frame has a typed header with msg_type; one codec for both ends
- risk: Parent and child always come from the same install, so no version skew; preserve heartbeat timing and the orphan detection frame.

### TUI-08 — Twelve module globals describe one in-flight cron run

- severity: **medium** · effort: M · kind: restructure · low_hanging: false · loc_delta: -80 · depends_on: —
- evidence: `cron/scheduler.py:622`, `cron/scheduler.py:641`, `cron/scheduler.py:671`, `cron/scheduler.py:830`, `cron/scheduler.py:860`, `cron/scheduler.py:1069`
- **problem:** _running_job_ids, _running_fire_owners, _restart_safe_waiter_job_ids, _running_worker_pids, _scope_isolated_job_ids, _running_since, _running_allowance_s, _running_futures, _running_registration_owners, _forced_releases, _interrupted_job_ids (scheduler.py:622-671) plus _running_lock. try_register_running_job (830) and release_running_job (860) update 5-7 of them together. Keying rules differ: most use _inflight_key (home key, job id), _interrupted_job_ids uses an execution token. The cron/AGENTS.md invariants 'per-profile process assumptions' and 'a claim is released under the key it was registered with' document bugs that came from these drifting.
- **move:** New cron/inflight.py: `class RunningJobs` holding `dict[InflightKey, InflightRun]` where InflightRun has since, allowance_s, future, registration_owner, worker_pid, scope_isolated, restart_safe_waiter, fire_owners, interrupted_tokens; methods register/release/attach_future/record_worker/mark_interrupted/sweep_stale/snapshot under one lock. scheduler.py keeps the public accessors as one-line delegates. Moves ~450 lines out of scheduler.py.
- reference: textual `.repos/textual/src/textual/worker.py:119` — Worker object owns its own state enum, start time and cancellation; the manager holds a collection of them
- risk: 260 `monkeypatch.setattr(<sched alias>, ...)` sites over 50 names in tests; some patch these globals. Preserve the host-wide union reported by get_running_job_ids for the shutdown drain.

### TUI-09 — Cron records a failed fire three times, enters a profile scope three ways, and uses an env var as the worker-mode flag

- severity: **medium** · effort: S · kind: collapse · low_hanging: false · loc_delta: -80 · depends_on: TUI-05
- evidence: `cron/scheduler.py:2838`, `cron/scheduler.py:3493`, `cron/scheduler_worker_failure.py:4`, `cron/scheduler_provider.py:119`, `cron/scheduler.py:3281`, `cron/scheduler.py:3944`, `cron/scheduler.py:2826`, `cron/scheduler_delivery.py:1995`
- **problem:** Crash notice + mark_job_run(False, owner, ladder_rung) + finish_execution is written in run_one_job's dispatch-failure branch (scheduler.py:2838-2869), _run_one_job_body's crash handler (3493-3545) and record_unknown_worker_outcome (scheduler_worker_failure.py:4-45), each with different fencing. Profile scope is entered by _profile_cron_scope (scheduler_provider.py:119), _install_fire_secret_scope (scheduler.py:3281) and a hand-rolled home override + secret hydrate in the worker (scheduler.py:3942-3960). Whether this process is the external worker for a fire is read from os.environ['_HERMES_CRON_EXTERNAL_WORKER'] in three places (scheduler.py:2826, the mark_execution_running skip near 3371, scheduler_delivery.py:1995).
- **move:** One `record_failed_fire(job, error, *, owner, deliver, outcome_hint)` in a sibling that absorbs scheduler_worker_failure.py. One `profile_fire_scope(home, multiplex)` context manager used by ticker, in-process body and worker. Put `is_external_worker: bool` on the FireContext from TUI-05 and stop reading the env var after process start.
- reference: none applies
- risk: Fencing differences between the three failure paths may be load-bearing (claim lost vs worker unknown); write them down as parameters, do not merge silently.

### TUI-10 — Three durable delivery queues with separate claim/terminal state machines

- severity: **medium** · effort: L · kind: collapse · low_hanging: false · loc_delta: -250 · depends_on: TUI-04, 10-gateway
- evidence: `cron/delivery_queue.py:110`, `cron/bot_chat_delivery.py:24`, `cron/scheduler_delivery.py:1781`, `cron/scheduler_delivery.py:814`, `cron/scheduler_delivery.py:2085`
- **problem:** deliveries.db (worker-to-gateway handoff, delivery_queue.py), bot_chat_pending/*.json (Bot Chat deferral, bot_chat_delivery.py:24-25) and the gateway delivery_ledger (reconnect redelivery, scheduler_delivery.py:1781-1806) each implement claim, terminal states, owner liveness and 'never replay an uncertain send'. The warning-suppression policy is checked in three places (scheduler_delivery.py:814-815, 2085-2089; bot_chat_delivery.py:112-118). _deliver_to_bot_chat (scheduler_delivery.py:773, 225 lines, CC 29) and bot_chat_delivery._drain split one record's status logic across two files.
- **move:** One delivery-obligation store with a `lane` column (worker_handoff, bot_chat_deferred, reconnect), or adopt the gateway delivery_ledger for all three. Delete bot_chat_delivery.py's file store. Check suppression once in _deliver_result before lane dispatch. Write the per-lane idempotency contract first.
- reference: none applies
- risk: High: idempotency keys and do-not-resend semantics differ per lane; duplicate delivery is a review-only bug class in the gist. Needs seam 10 (gateway delivery) agreement.

### TUI-11 — cron's facade split is cosmetic: 9 of 13 scheduler siblings call back into scheduler.py, which is still 4,460 lines

- severity: **medium** · effort: M · kind: restructure · low_hanging: false · loc_delta: 0 · depends_on: TUI-08, TUI-09
- evidence: `cron/scheduler_tick.py:23`, `cron/scheduler_tick.py:83`, `cron/scheduler_delivery.py:2131`, `cron/scheduler_prompt.py:448`, `cron/scheduler.py:3665`
- **problem:** scheduler_tick.py is 121 lines with 26 `_sched.` calls; scheduler_delivery.py, scheduler_script.py, scheduler_preflight.py and scheduler_prompt.py bind `from cron import scheduler as _sched` at the bottom; 14 function-level facade imports in 10 files. The import graph is one cycle and the test seam is the facade namespace (~507 patch sites on cron.scheduler names). This is the same 'patch the facade' design that produced TUI-01, by convention instead of by rebinding. scheduler.py holds 2.2x the 2,000-line gate, including _launch_external_cron_worker (239 lines) and _run_one_job_body (228 lines, CC 29).
- **move:** After TUI-08 and TUI-09: move run_job and its helpers to cron/scheduler_run.py and the worker launch/adopt code (scheduler.py:3559-4017) to cron/scheduler_worker.py; siblings import from the defining module; tests patch the defining module or the RunningJobs/FireContext objects. Split _launch_external_cron_worker along its ten phases (payload write, env build, spawn, ack wait).
- reference: datasette `.repos/datasette/datasette/hookspecs.py:8` — collaborators receive the app object (`startup(datasette)`) instead of reaching into a facade module
- risk: Test seam rewrite (~507 patch sites). Preserve `python -m cron.scheduler --external-worker-file` as the worker entry point.

### TUI-12 — handle_ws hard-codes the teardown of every feature that holds a per-connection resource

- severity: **low** · effort: S · kind: restructure · low_hanging: false · loc_delta: -20 · depends_on: —
- evidence: `tui_gateway/ws.py:295`, `tui_gateway/ws.py:446`, `tui_gateway/ws.py:456`, `tui_gateway/ws.py:465`
- **problem:** handle_ws (183 lines, CC 30) ends by calling browser-controller disconnect, wake-word release and session close/park in sequence, each in its own try/except (ws.py:446-470). Every new per-connection feature adds another block to the transport.
- **move:** Give Transport an `on_close(callback)` list (or an AsyncExitStack per connection). Features register their own cleanup when they attach to the transport; handle_ws runs the stack once.
- reference: anyio `.repos/anyio/src/anyio/_core/_tasks.py:238` — structured lifetime: resources tied to a scope are released by the scope, not by the caller listing them
- risk: Order matters today (controllers before sessions); the stack must preserve LIFO registration order.

### TUI-13 — cron/lifecycle_guard.py is a terminal-command safety scanner stored under cron/

- severity: **low** · effort: S · kind: restructure · low_hanging: false · loc_delta: 0 · depends_on: —
- evidence: `cron/lifecycle_guard.py:1`, `cron/jobs.py:1878`, `tools/terminal_tool_guards.py:205`, `tools/code_execution_tool.py:751`, `tools/approval_detection.py:1518`
- **problem:** 1,289 lines that reject commands which restart or stop the Hermes gateway. 3 of its 4 runtime callers are in tools/; cron uses it only in create_job (jobs.py:1878), and update_job does not call it. The name reads as job lifecycle, which it is not.
- **move:** git mv to tools/gateway_lifecycle_guard.py; update the importers. Decide separately whether update_job should scan a changed prompt/script.
- reference: none applies
- risk: 6 test files import the old path; update them in the same PR.

## Kill list

| target | why | importers/callers | evidence |
|---|---|---|---|
| `tui_gateway/method_ctx.py` | globals rebinding; replaced by explicit srv./context reads (TUI-01) | 45 | `tui_gateway/server.py:3660-3671 (45 modules call register -> bind_module/HandlerRegistry.install)` |
| `45 x `def register(server)` in tui_gateway siblings` | exist only to call bind_module/install | 1 | `tui_gateway/server.py:3670` |
| `tui_gateway/server.py `# noqa: F401 (split modules)` imports` | imported only so rebound sibling bodies can resolve them bare | 0 | `tui_gateway/server.py:8, 19, 21, 25, 36-38, 41, 44, 90` |
| `tui_gateway/server.py::_LONG_HANDLERS and its three union rewrites` | execution policy belongs on the method contract (TUI-03) | 4 | `tui_gateway/server.py:175; methods_connectors.py:440; methods_connectors_account.py:279; methods_bot_relay.py:269` |
| `tui_gateway/host_supervisor.py::MUTATOR_ROUTE_TABLE` | isolation route belongs on the method contract (TUI-03) | 1 | `tui_gateway/host_supervisor.py:27` |
| `tui_gateway/server.py::_profile_scoped + HandlerRegistry.profile_scoped` | dispatcher binds scope by default (TUI-03) | 51 | `tui_gateway/server.py:596; tui_gateway/method_ctx.py:60` |
| `tui_gateway/contracts/registry.py::check_params_accepted` | second validation of the same params once handlers get the model (TUI-06) | 1 | `tui_gateway/rpc_dispatch.py:40` |
| `tui_gateway/prompt_turn.py inspect.signature(agent.run_conversation) probe` | task_id, persist_user_display_kind and persist_user_display_metadata all exist on AIAgent.run_conversation (agent/turn_facade.py:24-27); the probe only serves test doubles | 1 | `tui_gateway/prompt_turn.py:782-790` |
| `cron/jobs.json field preflight_alerted` | duplicates cron_incidents.alerted_at (TUI-04) | 2 | `cron/jobs.py:2354-2361; cron/scheduler.py:1765` |
| `cron/scheduler_worker_failure.py` | third copy of record-failed-fire (TUI-09) | 1 | `cron/scheduler_worker_failure.py:4-45` |
| `cron/suggestions.py VALID_SOURCES 'usage' and 'integration'` | no production producer; only a test creates them | 0 | `cron/suggestions.py:39; tests/cron/test_suggestions.py:110` |

## Simplify list

| what N things | become what 1 thing | lines saved | evidence |
|---|---|---|---|
| tui_gateway/method_ctx.py; bind_module; HandlerRegistry.install; methods_groups.bind_server; server_requests.bind_sinks; compute_host `server._sessions` | one explicit GatewayContext passed to handlers (srv module as step 1) | ~330 | `tui_gateway/method_ctx.py:78; tui_gateway/methods_groups.py:34; tui_gateway/server_requests.py:109; tui_gateway/compute_host.py:389` |
| server.py:2754 _init_session literal; methods_session.py:424 session.create literal; compute_host.py:389 fallback literal | LiveSession.new() on an attrs class | ~60 | `tui_gateway/server.py:2754; tui_gateway/methods_session.py:424; tui_gateway/compute_host.py:389` |
| _LONG_HANDLERS; MUTATOR_ROUTE_TABLE; @_profile_scoped; _profile_scoped_rpc scope part; 49 inline scope entries; 7 decorator variants | MethodContract fields read by rpc_dispatch | ~150 | `tui_gateway/server.py:175; tui_gateway/host_supervisor.py:27; tui_gateway/server.py:596; tui_gateway/methods_tools.py:20` |
| validate_params; check_params_accepted; 409 params.get sites; _account_method model_validate | dispatcher validates once and passes the Params model | ~400 | `tui_gateway/contracts/registry.py:94,111; tui_gateway/methods_connectors_account.py:30` |
| jobs.json last_status/last_error/last_failure/last_delivery_*; executions row; preflight_alerted; cron_incidents.alerted_at | executions row as the run record + RunOutcome/record_run() | ~400 | `cron/scheduler.py:3216-3238; cron/jobs.py:2354-2412` |
| 12 in-flight globals in cron/scheduler.py | cron/inflight.py::RunningJobs | ~80 | `cron/scheduler.py:622-671` |
| run_one_job failure branch; _run_one_job_body crash handler; scheduler_worker_failure.record_unknown_worker_outcome | record_failed_fire() | ~80 | `cron/scheduler.py:2838,3493; cron/scheduler_worker_failure.py:4` |
| cron/delivery_queue.py deliveries.db; cron/bot_chat_delivery.py pending files; gateway delivery_ledger reconnect obligations | one delivery-obligation store with a lane column | ~250 | `cron/delivery_queue.py:110; cron/bot_chat_delivery.py:24; cron/scheduler_delivery.py:1781` |

## Reference patterns to copy

| repo | path | pattern | where it applies here |
|---|---|---|---|
| svcs (5d93cbc) | `.repos/svcs/src/svcs/_core.py:184` | Registry + per-request Container (_core.py:573); typed get() (_core.py:898) | TUI-01 GatewayContext replacing rebound module globals; tests register fakes instead of monkeypatching server.X |
| jupyter_client (978361b) | `.repos/jupyter_client/jupyter_client/session.py:337` | explicit Session object; msg_header/msg (session.py:651-655) build a typed header; serialize/deserialize (696, 1026) in one place | TUI-06 parse once into Params; TUI-07 compute-host frames |
| datasette (cec5e6b) | `.repos/datasette/datasette/hookspecs.py:8` | collaborators receive the app object as an argument (startup(datasette), register_routes(datasette)) | TUI-01 PR 2 and TUI-11: handlers/siblings take the context, not the facade module |
| attrs (a602f78) | `.repos/attrs/src/attr/_next_gen.py:23` | attrs.define typed records with defaults; evolve for per-run copies | TUI-02 LiveSession; TUI-05 JobRecord/FireContext |
| inspect_ai (9f6accd) | `.repos/inspect_ai/src/inspect_ai/_util/registry.py:127` | registry_add(o, RegistryInfo): metadata stored with the registered object | TUI-03 MethodContract carries execution/scope/route |
| textual (06dbeef) | `.repos/textual/src/textual/worker.py:119` | Worker object owns state (WorkerState enum, worker.py:82), start time, cancellation | TUI-08 InflightRun / RunningJobs |
| home-assistant-core (0f3081e) | `.repos/home-assistant-core/homeassistant/helpers/event.py:1631` | async_track_time_interval / async_track_point_in_utc_time (event.py:1499): one object per schedule, cancel handle, callback gets fire time only | TUI-04/TUI-05 shape of schedule state; HA has no persistence so only the shape transfers |

## Answer to the seam question

(a) Yes. tui_gateway can drop method_ctx.bind_module, and the first step needs no test changes. The rebinding exists so tests can monkeypatch server.X (~2,264 patch lines in 218 test files). An explicit `srv.<name>` attribute read on the server module object resolves at call time, so a codemod that rewrites every F821 name to `srv.<name>` keeps every one of those patches working. It deletes method_ctx.py (133 lines), 45 register() shims, the import block and loop at server.py:3632-3671, and the `noqa: F401 (split modules)` imports. It makes ~2,700 F821 diagnostics resolvable, so F821 can be turned on for the package. It also ends the four other ad-hoc ways siblings reach server state (bind_server, bind_sinks, `server._sessions`, HandlerRegistry). The second step replaces the module with a typed GatewayContext (svcs/datasette shape) and moves tests to a context fixture. The profile scope should not be part of the handler's dependencies at all. It belongs on the method contract, and the dispatcher should bind it by default for every method (51 @_profile_scoped + 4 _profile_scoped_rpc + 49 inline scope entries today), with an explicit opt-out. The context object then only needs the resolver. (b) Cron is not a scheduler with a small job model. It is a scheduler (jobs.json + tick + claims) with five more durable stores: executions.db (with cron_incidents in the same file), deliveries.db, bot_chat_pending/*.json, notepad.db and suggestions.json. It also has four in-job sub-states (fire/run claims, pending_slot, unreachable-retry ladder, quota hold) kept as raw dict keys edited by three modules. One fire writes its outcome to 2-5 of these stores in separate transactions. Three delivery queues each have their own claim/terminal state machine. The worker model is binary: in-process by default, and a restart-safe subprocess only on Linux under systemd. That subprocess must round-trip delivery through deliveries.db because it has no live adapters. The minimum model is JobRecord (definition + schedule) + Execution (one row per fire, the only run record) + DeliveryObligation (one queue with lanes), with a typed FireContext passed through the run instead of underscore keys on the job dict.

Relation to the gist: TUI-01 is the structural cause behind ~2,700 of the 2,979 F821 the gist wants blocking. Once it lands, the F821 rule needs no tui_gateway baseline. TUI-03 makes profile scope a dispatcher default, which removes the per-handler class of profile-scope leaks (the gist's #1 class, 366 fix commits) for RPC methods without a lint. TUI-04/TUI-05 remove the 'which store wins' class of cron bugs, which no lint can catch.

## Cross-seam notes

- 09-concurrency: `tui_gateway/methods_prompt.py:787` — prompt.submit starts a raw threading.Thread per turn instead of a supervised executor
- 09-concurrency: `inputs/metrics/SUMMARY.md tui_gateway row; cron/scheduler.py:588` — tui_gateway has 33 raw Thread() and 37 global statements; cron per-home ThreadPoolExecutors are reaped by register_ticked_homes
- 08-state: `cron/executions.py:48; cron/incidents.py:54-60` — cron opens executions.db, deliveries.db and notepad.db with separate open_db calls; incidents.py forces the executions file via override chaining
- 07-config: `tui_gateway/server.py:52-53` — server.py loads .env and captures get_hermes_home() at import (_HERMES_HOME_AT_IMPORT), the import-time home capture the gist's P31-P33 rule targets
- 07-config: `tui_gateway/server.py:112; tui_gateway/server.py:193` — HERMES_TUI_SLASH_TIMEOUT_S, HERMES_TUI_RPC_POOL_WORKERS and HERMES_CRON_TIMEOUT are behavioural env vars, against the root AGENTS.md config rule
- 14-errors-obs: `tui_gateway/server.py:81-82` — server.py installs sys.excepthook and threading.excepthook at import time as a crash logger
- 10-gateway: `cron/scheduler_delivery.py:1484; cron/scheduler_delivery.py:1718; cron/scheduler_delivery.py:922` — cron delivery uses three transports: DeliveryRouter, tools.send_message_tool._send_to_platform, and a `hermes chat -Q` subprocess for Bot Chat
- 06-tools: `tools/terminal_tool_guards.py:205` — cron/lifecycle_guard.py is consumed mainly by tools/ terminal and code-execution guards
- 01-layout: `hermes_cli/kanban_db_dispatch.py:2513` — kanban <-> cron boundary is only shared PYTHONPATH pinning for spawned workers

## UNVERIFIED

- UNVERIFIED: test patch counts (~2,264 lines / 218 files / ~236 names for tui_gateway.server; ~507 for cron.scheduler) are regex counts over common aliases; an AST pass over tests/ for monkeypatch.setattr/patch targets would verify them.
- UNVERIFIED: how many sibling-internal bare calls target helpers that tests patch on server (the TUI-01 PR 1 risk); verify by intersecting patched names with each sibling's own top-level defs.
- UNVERIFIED: which methods must not bind a profile scope under TUI-03's default (e.g. cross-profile list methods); verify by reading every handler not decorated today (`rg -n '^(async )?def ' tui_gateway/methods_*.py | rg -v _profile_scoped`).
- UNVERIFIED: ~240 method contracts (`rg -o 'method\("..."' tui_gateway/contracts/ | sort -u`) vs 178 decorator-registered names; the rest register through loops or helper factories not traced.
- UNVERIFIED: cron delivery_queue.drain / enqueue_and_wait bodies, gateway/delivery_ledger.py and tools/bot_live_delivery.py internals were read by signature only (TUI-10 risk depends on them).
- UNVERIFIED: cron catch-up / fast-forward paths in jobs.py (~3025-3238) and executions.py recovery internals (322-442) were not read end to end.
- UNVERIFIED: readers of cron/usage_audit.jsonl and the mutator of scheduler_preflight.py::_RECONNECTING_WARNED were not traced.
- UNVERIFIED: hosted_room_* (≈2.6k lines) and session_* siblings other than session_lifecycle were not reviewed for findings beyond the rebinding mechanism.
- UNVERIFIED: loc_delta values are estimates from the cited line ranges, not from a prototype.
