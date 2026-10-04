# 14 Errors, logging, retries, HTTP clients, redaction, observability

Checkout `origin/main` = `ea81748579`. Reference SHAs: structlog 91f44ae, stamina 7836f46,
httpx b5addb6, cpython 9d22a53, blinker c336405. Lab scripts used for every count live in
`scripts/err_*.py`; their outputs sit beside them (`*.out.json`, `*.out.txt`).

## TL;DR

1. Structural problem: failures are turned into strings at every boundary and re-parsed
   downstream. One typed classifier exists (`agent/error_classifier.py::FailoverReason`), but at
   least 9 substring classifiers with 5 vocabularies re-derive "retryable / rate limit / auth"
   from text (ERR-01, ERR-02, ERR-12).
2. Biggest kill: the ~1,800 `try: from <first-party> import …; except Exception` guards and the
   379 `except Exception` wrappers around config reads that already fail open (ERR-11); plus the
   in-tree Langfuse plugin (ERR-10) and the unused `tenacity` core dependency (ERR-03).
3. Biggest simplification: one event bus for telemetry. Shared metrics is fed both by the
   lifecycle hook bus and by 110 direct `hermes_cli.observability.*` imports in 69 core files,
   next to a separate monitoring emitter and the Relay coordinator (ERR-09).
4. Low-hanging (S/M effort, high severity): 7 — ERR-01, ERR-02, ERR-03, ERR-04, ERR-05, ERR-07, ERR-12.
5. Seam answer: one logging pipeline (mostly), one provider error model, but no shared retry
   policy (~95 hand-rolled loops), no shared HTTP client outside provider calls (4 HTTP stacks,
   3 proxy policies), and one redaction engine with ~10 failure policies around it.

## What this area is

Cross-cutting seam. Files read in full or in the relevant ranges:

| module | LOC | owns |
|---|---|---|
| `hermes_logging.py` | 980 | `setup_logging`, queue + `QueueListener`, rotating handlers, multiplex profile routing, session tag |
| `agent/redact.py` | 1,353 | the secret-pattern engine: `redact_sensitive_text`, `redact_for_egress`, `redact_terminal_output`, vault-value scrub, `RedactingFormatter` |
| `agent/error_classifier.py` | 1,495 | provider error taxonomy: `FailoverReason`, `ClassifiedError`, `classify_api_error` (table driven) |
| `agent/error_surface.py` | 234 | maps a failed turn result to a UI "error surface" (layer, code, retryable) |
| `agent/retry_utils.py` | 174 | `jittered_backoff`, `parse_retry_after_seconds`, provider reset-time parsing |
| `hermes_state_errors.py` | 305 | SQLite error predicates and persistence-error classes |
| `tools/bot_failure_reasons.py` | ~150 | a second failure vocabulary for bot-mode retries, regex over error text |
| `agent/process_bootstrap.py::build_keepalive_http_client` | — | the only shared HTTP client (provider SDK calls) |
| `gateway/platforms/base.py` (send/proxy parts) | — | `SendResult`, `classify_send_error`, `_send_with_retry`, gateway proxy resolution |
| `hermes_cli/observability/` | 10,029 / 27 files | Nous "shared metrics" opt-in telemetry: SQLite store, sender, Relay subscriber, consent |
| `agent/monitoring/` | 1,478 / 9 files | gateway/cron health events, own emitter queue + thread, OTLP export |
| `plugins/observability/langfuse/` | 1,044 | third-party tracing plugin on the hook bus |

Seam core: ~18.6k lines in 49 files. The seam's real surface is the call sites: 8,052 broad
except handlers, 210 loop-with-try-and-sleep sites, 101 HTTP client constructors + 113 one-shot
HTTP calls, 97 `redact_sensitive_text` calls, 110 telemetry imports.

Entry points that configure logging: `hermes_cli/main.py:748`, `agent/agent_init.py:719`,
`gateway/run.py:5264`, `cron/scheduler.py:4454`, `hermes_cli/cli_config_load.py:308` (all through
`hermes_logging.setup_logging`); `acp_adapter/entry.py:65` (own redacting stderr handler);
`mcp_serve.py:713`, `hermes_cli/plugin_host_child.py:571`,
`agent/transports/hermes_tools_mcp_server.py:140` (`logging.basicConfig`, no redaction);
`gateway/run_turn.py:54` (own `tool_calls.log` file handler, ERR-07).

## How it works end to end

### Flow 1: a log line from a gateway turn reaches `agent.log`

Inputs: `multiplex_secondary_profile` (the record belongs to a profile other than the launch
profile), `on_tool_worker_thread` (the line is logged from a parallel tool worker),
`redact_secrets` (default true).

1. `agent/turn_context.py::build_turn_context` (`agent/turn_context.py:1055`) calls
   `hermes_logging.set_session_context(agent.session_id)`, which writes a `threading.local`
   (`hermes_logging.py:104`, `:229`). Nothing ever calls `clear_session_context`. (ERR-05)
2. When `on_tool_worker_thread`: `tools/thread_context.py::propagate_context_to_thread`
   (`tools/thread_context.py:43`) copies ContextVars into the worker. The `threading.local` is not
   copied, so the worker's records carry no session tag. (ERR-05)
3. `hermes_logging.py::_install_session_record_factory._session_record_factory`
   (`hermes_logging.py:250`) runs on the caller thread for every record: adds `session_tag` and
   `hermes_home = str(get_hermes_home().resolve())`, an uncached filesystem call per record
   (`hermes_constants.py:121-126` caches resolve for the registry for exactly this reason). (ERR-06)
4. `hermes_logging.py::_NonFormattingQueueHandler.prepare` (`hermes_logging.py:746`) enqueues
   an unformatted copy; formatting and redaction are deferred to the listener thread. (ERR-06)
5. `hermes_logging.py::_start_queue_listener_locked` (`hermes_logging.py:768`): one
   `QueueListener` thread drives every file handler.
6. When `multiplex_secondary_profile`: `_ProfileRoutingFileHandler.emit`
   (`hermes_logging.py:676`) → `_home_for_record` (`:633`) resolves the path again and rechecks
   profile liveness every 2 s (`:604`).
7. When `multiplex_secondary_profile`: the router re-binds the record's profile with
   `set_hermes_home_override` (`hermes_logging.py:685-690`) because redaction policy is
   per profile and the profile scope is gone on the listener thread. (ERR-06)
8. `_ManagedRotatingFileHandler.emit` (`hermes_logging.py:506`) stats the file for external
   rotation, then writes.
9. `agent/redact.py::RedactingFormatter.format` (`agent/redact.py:1352`) →
   `redact_sensitive_text` (`:880`).
10. `agent/redact.py::_redact_enabled` (`:107`): under a home override and with no live secret
    scope (the listener thread), it reads the profile's `.env` and `config.yaml` once and caches
    it (`:121-128`).

### Flow 2: the gateway sends a reply and the platform API fails

Inputs: `failure` ∈ {network, rate_limit, timeout, format}; `retry_after_over_60s`;
`partial_delivery`.

1. `gateway/platforms/base.py::BasePlatformAdapter._send_with_retry` (`base.py:3649`).
2. The adapter's `send` returns `SendResult` (`base.py:1703-1718`): `error: str`,
   `retryable: bool`, `retry_after`, `error_kind: str`. Three overlapping failure signals.
3. `base.py:3675` `_is_rate_limited_error(error_str)` → `classify_send_error` (`:1769`), a
   substring match on the flattened text. (ERR-02)
4. `base.py:3676-3681`: "is network" is the OR of `result.retryable`, the rate-limit substring
   match, `retry_after`, and `_is_retryable_error` (`:3567`, substrings from `:1854`). `error_kind`
   is not read. (ERR-02)
5. When `failure = timeout`: `_is_timeout_error` substring (`:3583`) → return without retry.
6. When `retry_after_over_60s`: return the typed failure for the delivery ledger (`:3692-3701`).
7. `base.py:3688-3706`: a hand-rolled backoff loop (`base_delay * 2**n + uniform(0,1)`). (ERR-03)
8. `base.py:3727-3733`: each attempt re-runs the substring classification. (ERR-02)
9. Retries exhausted: send a delivery-failure notice (`:3750-3756`).
10. When `failure = format` and not `partial_delivery`: plain-text fallback (`:3766`).

### Flow 3: a bot-mode turn fails at the provider; the supervisor decides whether to retry

Inputs: `lane` ∈ {in_process, child_process}.

1. `agent/error_classifier.py::classify_api_error` (`:965`) returns `ClassifiedError` with a
   typed `FailoverReason` (`:34`) and `retryable / should_fallback / should_compress` (`:70-84`).
2. `agent/error_surface.py::build_error_surface_from_exception` (`:222`) flattens it into a
   dict: `{"error": message, "failure_reason": reason.value}`. (ERR-01)
3. `agent/error_surface.py::build_error_surface_from_result` (`:155-200`) reads five ad-hoc
   keys back: `failure_reason`, `failure_retryable`, `failure_resets_at`, `billing_block`,
   `free_tier`. (ERR-01)
4. When `lane = in_process`: `tools/bot_failure_reasons.py::result_retry_action` (`:107`) joins
   `error` and `failure_reason` into text (`:119`). (ERR-01)
5. When `lane = child_process`: `tools/bot_mode_dm.py:440` rebuilds the same text from
   `proc.stdout` + `proc.stderr`.
6. `tools/bot_failure_reasons.py::classify_agent_error` (`:122`) regex-matches that text into a
   second vocabulary (`PROVIDER_RATE_LIMIT`, `CONTEXT_OVERFLOW`, … `:35-41`). (ERR-01)
7. `tools/bot_failure_reasons.py::retry_action` (`:61`) maps that vocabulary to
   resume / compress-then-resume / none.

## Findings

### ERR-01 — Failures are flattened to strings and re-classified by 9+ substring classifiers with 5 vocabularies
- severity: high · effort: M · kind: collapse · low_hanging: true
- evidence: `agent/error_classifier.py:34`, `agent/error_classifier.py:70`,
  `agent/error_surface.py:165`, `agent/error_surface.py:222`, `tools/bot_failure_reasons.py:35`,
  `tools/bot_failure_reasons.py:107`, `tools/bot_failure_reasons.py:122`,
  `agent/monitoring/cron_health.py:46`, `agent/monitoring/gateway_health.py:53`,
  `gateway/platforms/base.py:1769`, `gateway/dead_targets.py:31`, `hermes_state_errors.py:272`
- problem: The provider path has a good typed model (`FailoverReason` + `ClassifiedError` with
  recovery hints). It is lost at the first boundary: `error_surface` writes `reason.value` into a
  dict key, and later code parses text again. `tools/bot_failure_reasons.py` keeps a second
  vocabulary (14 codes) and regex-classifies `error + failure_reason` text even when the typed
  reason is in the same dict (`:119`). `classify_cron_error` and `classify_gateway_error` are two
  more substring tables with their own labels ("auth_failed", "rate_limited", …). The gateway
  rule `_contains_any("auth", "token", …)` (`gateway_health.py:53`) labels any message that
  contains "token" as `auth_failed`. 30+ hand-written `_is_transient_* / _is_retryable_* /
  _looks_like_*` predicates (`rg 'def _?(is|looks_like)_\w*(rate_limit|retryable|transient|timeout|network)'`)
  do the same job per module. Every new provider message or platform error string means editing
  several tables that drift, and a wrong classification decides whether a turn is re-run.
- move: Create `agent/failure.py` with one frozen `Failure` value type: `kind: FailureKind`
  (extend `FailoverReason` with the non-provider kinds the other tables invent: `disk_full`,
  `network`, `delivery_timeout`, `cancelled`, `runtime_offline`, `missing_config`), `retryable`,
  `retry_after`, `resets_at`, `message`, `to_dict()/from_dict()`. Turn results carry
  `result["failure"] = Failure.to_dict()` instead of five loose keys; child processes print one
  JSON line `HERMES_FAILURE {...}` on stderr. `retry_action`, `error_surface`, `cron_health`,
  `gateway_health` become `dict[FailureKind, X]` lookups. `classify_agent_error`,
  `classify_cron_error`, `classify_gateway_error` stay only as the fallback for legacy text and
  merge into one function in `agent/failure.py`.
- reference: stamina `src/stamina/_core.py:119` (`retry_context(on=...)`: retry policy keyed on a
  typed exception/predicate, never on text).
- loc_delta: -350
- risk: Bot relay, desktop error cards and cron incident labels change wording if a mapping is
  wrong. Preserve: the `RETRY_*` decisions for every existing reason; `failure_resets_at` card
  text (#98852); billing/free-tier surfaces.
- depends_on: []

### ERR-02 — Gateway send retry decides "retryable" by OR-ing four signals, two of them substring parses; `error_kind` is ignored
- severity: high · effort: M · kind: boundary · low_hanging: true
- evidence: `gateway/platforms/base.py:1703`, `gateway/platforms/base.py:1718`,
  `gateway/platforms/base.py:1854`, `gateway/platforms/base.py:3567`,
  `gateway/platforms/base.py:3675`, `gateway/platforms/base.py:3727`,
  `plugins/platforms/photon/adapter.py:1386`
- problem: The adapter holds the typed exception (Telegram `RetryAfter`, aiohttp
  `ClientConnectorError`) in its `except`. It writes `str(exc)` into `SendResult.error`, and only
  sometimes sets `retryable=True` or `error_kind`. `_send_with_retry` then re-derives the decision from
  `error.lower()` substrings ("network", "eoferror", "timed out") on every attempt. Adapters
  override `_is_retryable_error` with more substrings (Photon checks for the literal text
  `"retryable=false"`). 55 adapter sites set `retryable=True` or override the predicate. A
  library that rewords its exception message changes retry behaviour without anyone noticing.
  The timeout rule (never retry, the message may already be delivered) is a substring check.
- move: Make `SendResult` failures go through one constructor
  `SendResult.failed(exc, *, kind=None, retry_after=None)` that runs `classify_send_error` once
  at the adapter's except site (with the exception object, not text) and stores `error_kind`.
  `_send_with_retry` branches only on `error_kind` (`rate_limited`, `transient`, `timeout`,
  `format`, …) and `retry_after`. Delete `retryable`, `_is_retryable_error`,
  `_is_rate_limited_error`, `_is_timeout_error` and the per-adapter overrides.
- reference: stamina `src/stamina/_core.py:730` (`retry(on=...)` with a typed predicate).
- loc_delta: -150
- risk: Per-platform retry semantics (Photon sidecar markers, Telegram FloodWait). Preserve:
  no retry on timeouts; the 60 s inline-wait cap (#91969); no notice inside a flood penalty;
  partial-delivery resume.
- depends_on: [ERR-01]

### ERR-03 — No retry primitive: ~95 hand-rolled retry loops, a 174-line backoff helper, and `tenacity` pinned in core with zero importers
- severity: high · effort: M · kind: collapse · low_hanging: true
- evidence: `pyproject.toml:53`, `pyproject.toml:858`, `agent/retry_utils.py:121`,
  `gateway/platforms/base.py:3688`, `pm/install.py:230`, `pm/store.py:419`,
  `hermes_cli/kanban_db_connect.py:1169`, `tools/environments/file_sync.py:321`,
  `tools/skills_hub_github.py:459`, `tools/fal_common.py:146`, `tools/microsoft_graph_client.py:128`
- problem: `scripts/err_retry_loops.py` finds 210 `for/while` loops whose body has a `try` plus
  a sleep/backoff call or an `attempt`-named counter (plugins 50, gateway 48, hermes_cli 41,
  tools 31, root 16, agent 11, pm 7). A seeded sample of 22 had 10 real retry loops and 12
  pollers/watchdogs, so there are about 95 retry loops. Each one picks its own attempts, delay
  curve, jitter, exception set and logging. Only 9 call `agent.retry_utils.jittered_backoff`.
  `tenacity==9.1.4` is a pinned core dependency (`pyproject.toml:53`) and nothing in scope
  imports it (`rg tenacity` hits only the untracked `tinker-atropos/`). Tests need an autouse stub
  to zero `jittered_backoff` and a marker to opt out (`pyproject.toml:858`); a loop that calls
  `time.sleep` directly cannot be stubbed that way.
- move: Adopt `stamina` (a thin layer over the already-shipped `tenacity`) as the one retry
  primitive: `for attempt in stamina.retry_context(on=is_transient, attempts=N, timeout=T)`.
  `on=` takes the typed predicates from ERR-01/ERR-02/`hermes_state_errors.is_sqlite_lock_error`.
  `stamina.set_testing(True)` replaces the autouse stub. Keep `retry_utils.parse_retry_after_seconds`
  and the provider reset-time parsing; delete `jittered_backoff`. If stamina is rejected, drop `tenacity`
  from core dependencies instead (it ships unused today).
- reference: stamina `src/stamina/_core.py:119` (`retry_context`), `src/stamina/_config.py:174`
  (`set_testing`).
- loc_delta: -600
- risk: Changes timing of retries users see (Telegram polling reconnect, SQLite busy).
  Preserve: server `Retry-After` beats backoff; inline-wait caps; `KeyboardInterrupt` /
  `CancelledError` never retried; the agent loop's credential rotation (not a plain retry —
  leave it in the agent loop).
- depends_on: [ERR-01]

### ERR-04 — One redaction engine, ~10 failure policies: 16 guarded call sites, two fail open, and 42 `force=True` egress calls bypass `redact_for_egress`
- severity: high · effort: M · kind: collapse · low_hanging: true
- evidence: `agent/redact.py:880`, `agent/redact.py:1151`,
  `plugins/observability/langfuse/__init__.py:137`, `cron/incidents.py:119`,
  `tools/delegation_live_log.py:71`, `tui_gateway/tool_progress.py:36`,
  `tools/browser_supervisor.py:42`, `cron/scheduler_delivery.py:177`,
  `tools/mcp_tool_common.py:72`, `tools/send_message_senders.py:47`,
  `agent/monitoring/redaction.py:25`, `hermes_cli/debug_redaction.py:7`
- problem: `redact_sensitive_text` takes five boolean modes (`force`, `code_file`, `file_read`,
  `secret_file`, `redact_url_credentials`). `redact_for_egress` (`:1151`) calls itself "the one
  scrub for text leaving the process" and fails closed; it has 4 callers, while 42 call sites pass
  `force=True` directly and skip its bearer sweep. 16 sites wrap `from agent.redact import …` in
  `try/except Exception` (`scripts/err_redact_guards.py`) and each invents a fallback:
  `"[line withheld: redaction unavailable]"`, `"<error redacted>"`, `"[REDACTED - redaction failed]"`,
  `"<unredactable>"`, `""`, the exception type name. Two of them return the raw input: the
  Langfuse exporter (`langfuse/__init__.py:143`, content sent to an external service) and cron
  incidents (`cron/incidents.py:126`, persisted to disk). `tools/mcp_tool_common.py:72` keeps a
  private credential regex; `send_message_senders.py:41-50` layers two more; monitoring and
  support redaction each add an e-mail regex, and `debug_redaction.py` imports private names
  (`_SENSITIVE_QUERY_PARAMS`, `_canonical_url_param_name`). The gist counts 145
  `secret_leak_redaction` fix commits.
- move: Replace the flags with `redact(text, purpose: Purpose)` where
  `Purpose = MODEL | FILE_READ | TERMINAL | LOG | DISK | EGRESS | EXPORT | SUPPORT`; each purpose
  is a row in one table (which passes run, mask style, whether the user toggle applies). The
  function fails closed with `REDACTION_UNAVAILABLE` itself. Delete the 16 try-wrappers, the MCP
  regex, the send_message extras, and the two PII copies (move PII into `EXPORT`/`SUPPORT` rows).
- reference: structlog `src/structlog/_config.py:202` (`configure(processors=…)`: one ordered
  processor chain per output, configured once, instead of flags at every call).
- loc_delta: -250
- risk: Over-redaction in tool output if a purpose maps to the wrong passes (#35519 write-back,
  #43025 env dumps, #34029 URLs). Preserve every existing per-call behaviour by mapping each
  current flag combination to exactly one purpose first, then deleting flags.
- depends_on: []

### ERR-05 — The log session tag is a `threading.local` that is never cleared and never reaches tool worker threads
- severity: high · effort: S · kind: boundary · low_hanging: true
- evidence: `hermes_logging.py:104`, `hermes_logging.py:229`, `hermes_logging.py:250`,
  `agent/turn_context.py:1055`, `tools/thread_context.py:43`,
  `agent/conversation_compression.py:1650`, `agent/compression_facade.py:208`,
  `gateway/session_context.py:34`, `hermes_cli/logs.py:119`
- problem: `hermes logs --session <id>` (root `AGENTS.md:249`) filters lines by the
  `[session]` tag. The tag comes from a `threading.local` set at turn start
  (`turn_context.py:1055`). `clear_session_context` has zero callers, so a pooled gateway executor
  thread keeps tagging later, unrelated records with the previous session's id. Parallel tool
  workers get ContextVars copied (`thread_context.py:43`) but not the `threading.local`, so tool
  log lines, the ones a user greps for, carry no tag. Compression needed explicit rebind calls
  (`conversation_compression.py:1650-1660`, `compression_facade.py:208`) to paper over the same
  gap. The process already has the right primitive: `gateway/session_context.py` binds
  `HERMES_SESSION_ID` as a ContextVar for every turn, and every thread hop copies it.
- move: Move the session ContextVars out of `gateway/` into a neutral leaf module
  (`hermes_context.py`, importable by `hermes_logging`). The record factory reads that ContextVar.
  Delete `set_session_context`, `clear_session_context`, `_session_context`, and the three call
  sites.
- reference: structlog `src/structlog/contextvars.py:82` (`merge_contextvars`: log context is
  read from ContextVars at emit time, so it follows `copy_context()` across threads and tasks).
- loc_delta: -30
- risk: CLI and cron paths that never call `set_session_vars` must still tag (bind the id there).
  Preserve: `hermes logs --session` matching; `HERMES_SESSION_ID` subprocess env semantics.
- depends_on: [CFG-01]

### ERR-06 — Multiplex log routing is built into the handler stack because formatting was moved off the caller's thread
- severity: medium · effort: M · kind: restructure · low_hanging: false
- evidence: `hermes_logging.py:257`, `hermes_logging.py:607`, `hermes_logging.py:633`,
  `hermes_logging.py:685`, `hermes_logging.py:737`, `hermes_logging.py:824`,
  `hermes_logging.py:853`, `agent/redact.py:121`
- problem: `_NonFormattingQueueHandler` (`:737`) skips the stdlib `prepare()` step that
  formats on the emitting thread, so formatting and redaction run on the listener thread, where
  the record's profile scope is gone. That single choice forces: a per-record
  `get_hermes_home().resolve()` on the caller (`:257`); `_ProfileRoutingFileHandler` re-resolving
  the home per record and probing liveness every 2 s (`:633-648`); re-binding
  `set_hermes_home_override` per record so `RedactingFormatter` uses that profile's policy
  (`:685-690`); and `_redact_enabled` reading `.env`/`config.yaml` from the listener thread when no
  secret scope exists (`redact.py:121-125`). About 400 of the module's 980 lines are routing and
  queue lifecycle (`_ProfileRoutingFileHandler`, `enable_profile_log_routing`,
  `release_profile_log_handlers`, `_adopt_secondary_home`, `_known_log_homes`).
- move: Format and redact on the emitting thread (use the stdlib `QueueHandler.prepare`, which
  formats once and drops `args/exc_info`), and stamp `record.hermes_home_key =
  hermes_home_key()` (already cached, `hermes_constants.py:121-126`). The listener then routes a
  pre-rendered string to `files[key]`. Delete the home-override re-binding, the listener-thread
  policy fallback in `_redact_enabled`, and the per-record resolves.
- reference: cpython `Lib/logging/handlers.py:1522` (`QueueHandler.prepare` formats on the
  producer side); structlog `src/structlog/stdlib.py:1012` (`ProcessorFormatter`: render in the
  producer's context, ship strings).
- loc_delta: -200
- risk: Redaction CPU moves to the caller thread (regexes are gated by substring checks;
  measure). No file uses a different format today (all use `_LOG_FORMAT`). Preserve:
  deleted-profile release (#103777, Windows lock files), managed 0660 perms, external-rotation
  reopen.
- depends_on: [ERR-05]

### ERR-07 — `tool_calls.log` is a second, unqueued file-logging pipeline that writes every profile's tool calls into the launch profile's log
- severity: high · effort: S · kind: collapse · low_hanging: true
- evidence: `gateway/run_turn.py:54`, `gateway/run_turn.py:63`, `gateway/run.py:1577`,
  `gateway/run_turn.py:3200`, `gateway/run_turn.py:3009`, `hermes_logging.py:75`,
  `hermes_logging.py:720`
- problem: With `display.tool_progress: log` (`run_turn.py:3009`) the gateway writes tool calls
  through its own stdlib `RotatingFileHandler` on `gateway.run._hermes_home / "logs"`, where
  `_hermes_home = get_process_hermes_home()` is captured at import (`run.py:1577`). Under a
  multiplexed gateway a secondary profile's tool calls (redacted, but still commands and paths)
  land in the launch profile's `tool_calls.log`. That is the profile-scope leak class the gist
  ranks first (366 fix commits). The handler bypasses everything `hermes_logging` exists for: the
  queue (writes happen on the asyncio loop, `run_turn.py:3200-3212`), the Windows rollover lock
  (`hermes_logging.py:75-101`, #44873), managed perms and profile routing. The drain coroutine
  polls a queue every 0.3 s per turn.
- move: Add `("tool_calls.log", INFO, 5 MB, 3, "tool_calls")` to `setup_logging`'s
  `handler_specs` with a component filter on the `hermes.tool_calls` logger, exclude that logger
  from `agent.log`, and have the producer call `logging.getLogger("hermes.tool_calls").info(...)`
  directly (the root queue makes it non-blocking). Delete `_tool_call_logger`,
  `_tool_call_logger_lock`, `_run_agent_write_tool_log` and the per-turn `log_queue`.
- reference: cpython `Lib/logging/handlers.py:1567` (`QueueListener`: one consumer thread for
  all file handlers).
- loc_delta: -45
- risk: Line format of `tool_calls.log` (`"%(message)s"`) must stay; agent.log must not double
  the lines. Preserve redaction.
- depends_on: []

### ERR-08 — Network policy is decided per call site: 4 HTTP stacks, 101 client constructors, 3 proxy policies
- severity: high · effort: L · kind: boundary · low_hanging: false
- evidence: `agent/process_bootstrap.py:268`, `agent/process_bootstrap.py:176`,
  `gateway/platforms/base.py:279`, `gateway/platforms/base.py:327`,
  `tools/mcp_tool_transport.py:44`, `tools/microsoft_graph_client.py:136`,
  `hermes_cli/auth_nous.py:714`, `hermes_cli/auth_codex.py:411`, `pyproject.toml:51`,
  `pyproject.toml:57`
- problem: `scripts/err_http_ast.py` counts 33 `httpx.Client`, 36 `httpx.AsyncClient`,
  29 `aiohttp.ClientSession`, 2 `requests.Session` constructions, plus 41 `httpx.*`, 23
  `requests.*` and 49 `urlopen` one-shot calls. Files importing each stack: httpx 86, aiohttp 34,
  requests 25, urllib.request 6. Only provider SDK calls share a client
  (`build_keepalive_http_client`), and that one deliberately uses env-only proxies and ignores the
  macOS system proxy (`process_bootstrap.py:270-279`). Gateway adapters do the opposite: they shell
  out to `scutil --proxy` and use the macOS proxy when `gateway.trust_env` is on (`base.py:279-368`).
  MCP has a third resolver (`mcp_tool_transport.py:44`). The remaining ~200 sites get library
  defaults (httpx `trust_env`, urllib `getproxies()` which reads the macOS proxy). For a user
  behind a corporate proxy, provider calls, platform adapters, MCP, OAuth and skills-hub
  downloads each behave differently. Clients built inside retry loops
  (`microsoft_graph_client.py:136`) redo the TLS handshake on every attempt.
- move: One `hermes_platform/net.py` owning `NetPolicy` (proxy-for-URL with one NO_PROXY
  matcher, CA/verify, default `httpx.Timeout`/`Limits`, user agent), resolved per profile.
  `http_client(purpose)` / `async_http_client(purpose)` return long-lived httpx clients with
  request/response event hooks for redacted debug logging. Migrate `requests` and `urlopen` call
  sites to it; ban new `requests`/`urllib.request` imports outside the module with the existing
  TID251 mechanism. aiohttp stays only where an SDK requires it (discord.py, slack-bolt).
- reference: httpx `httpx/_config.py:72` (`Timeout`), `httpx/_config.py:159` (`Limits`),
  `httpx/_client.py:199` (`event_hooks`).
- loc_delta: -400
- risk: Proxy behaviour changes for a user whose setup only works by accident today. Pick the
  policy once (`gateway.trust_env` semantics) and document it. Preserve: provider shared transport pooling,
  happy-eyeballs for Codex, SOCKS for Telegram, `url_safety` SSRF checks.
- depends_on: []

### ERR-09 — Telemetry is fed by two mechanisms and 110 direct imports from core into `hermes_cli.observability`; three in-process event pipelines coexist
- severity: high · effort: L · kind: restructure · low_hanging: false
- evidence: `hermes_cli/lifecycle.py:11`, `hermes_cli/lifecycle.py:26`,
  `hermes_cli/observability/__init__.py:11`, `hermes_cli/observability/relay_shared_metrics.py:1363`,
  `hermes_cli/observability/relay_shared_metrics.py:1397`, `tools/file_tools.py:1329`,
  `agent/tool_executor.py:60`, `agent/tool_executor.py:1079`, `agent/turn_api_request.py:16`,
  `agent/monitoring/emitter.py:20`, `agent/relay_runtime.py:1`,
  `hermes_cli/observability/shared_metrics_send_config.py:15`
- problem: Shared metrics is Nous's opt-in usage telemetry (consent module; sender posts to
  `telemetry.nousresearch.com`, `shared_metrics_send_config.py:15`). It receives lifecycle events
  through `hermes_cli/lifecycle.py::invoke_hook`, which calls it as a special "first-party
  observer" before plugins (`lifecycle.py:11-29`, `_HOOK_HANDLERS` at
  `relay_shared_metrics.py:1397`). It is also called directly: 110 import lines in 69 files
  (agent 15, tools 9, gateway 10, tui_gateway 6, cron 3, acp 2, hermes_cli 22, root 2) import
  `record_*`, `observe_*`, `note_*` functions from 15+ submodules. Tool handlers run their work
  inside telemetry wrappers (`file_tools.py:1329` runs `write_file` inside `record_file_edit`).
  The agent core and tools import `hermes_cli` to do this, against the dependency chain in root
  `AGENTS.md:251-252`. Next to it, `agent/monitoring/emitter.py` runs its own bounded queue +
  dispatcher thread for health events, and `agent/relay_runtime.py` (1,440 lines) its own scope
  coordinator. Each telemetry change touches core files; each pipeline has its own thread, queue,
  atexit hook and failure policy.
- move: One typed in-process event bus owned by `agent/` (`agent/events.py`: frozen event
  dataclasses, `emit(event)` that never raises, subscribers registered at startup). Core and tools
  emit events only. Shared metrics, monitoring/OTLP and plugins (Langfuse) become subscribers.
  Move `hermes_cli/observability/` to a top-level `telemetry/` package that imports `agent`, never
  the reverse. The 110 direct imports become ~20 `emit(...)` calls at existing hook points.
- reference: blinker `src/blinker/base.py` (named signals, sender/receiver decoupling);
  structlog `src/structlog/_config.py:202` (configure the pipeline once, call sites only emit).
- loc_delta: null
- risk: Telemetry schema (`hermes.metrics.event.v3`) and consent gating must not change.
  Event ordering between metric scopes (model call vs task run). Preserve: the opted-out hot path
  does no work (`relay_shared_metrics.py:1319`).
- depends_on: [ERR-01]

### ERR-10 — Kill the in-tree Langfuse plugin: a third-party product plugin that fails open on export redaction and configures via non-secret env vars
- severity: medium · effort: S · kind: kill · low_hanging: false
- evidence: `plugins/observability/langfuse/__init__.py:1`,
  `plugins/observability/langfuse/__init__.py:137`, `hermes_cli/tools_config_post_setup.py:180`,
  `pm/extras.py:27`, `AGENTS.md:97`, `AGENTS.md:80`
- problem: Root `AGENTS.md:97-102` says observability backends do not land under `plugins/`.
  This one did (`git log`: `42cc905c13 feat(plugins): add bundled observability/langfuse
  plugin`). Its redaction wrapper returns the raw value on failure for content exported to an
  external service (`:137-144`). It is configured by non-secret `HERMES_LANGFUSE_BASE_URL / ENV /
  RELEASE / SAMPLE_RATE / MAX_CHARS / MAX_DEPTH / DEBUG / CAPTURE` env vars (`:1-8`), against
  `AGENTS.md:80-83`. Core carries special cases for it (`tools_config_post_setup.py:180`,
  `pm/extras.py:27`). The gist (`0-plan.md` §5) lists `observability` as an unsettled
  contradiction.
- move: Publish it as a standalone plugin repo; delete `plugins/observability/` and the two core
  touchpoints.
- reference: null
- loc_delta: -1100
- risk: Users with `plugins.enabled: [langfuse]` lose traces until they install the external
  package. Ship a one-line notice in `hermes plugins` for that id.
- depends_on: []

### ERR-11 — Most broad excepts have two structural causes: first-party import guards and config reads that already fail open
- severity: high · effort: L · kind: kill · low_hanging: false
- evidence: `hermes_cli/config_read_errors.py:1`, `agent/error_surface.py:122`,
  `hermes_cli/process_identity.py:139`, `gateway/run.py:1896`, `agent/moa_loop.py:1530`,
  `hermes_cli/status.py:206`, `gateway/run_voice.py:123`, `hermes_cli/mcp_startup.py:168`,
  `agent/display.py:101`, `tui_gateway/methods_profiles.py:146`
- problem: `scripts/err_except_shapes.py` buckets all 8,052 broad handlers by shape: logs 2,839;
  silent (no call, no raise) 1,986; import-only try 1,429; other 933; re-raise 486; config read
  379. `scripts/err_import_guard.py`: 1,795 of 1,933 import-guard tries guard only first-party
  modules (`hermes_cli` 771, `tools` 308, `agent` 295, `gateway` 190). A first-party import can
  only fail on a broken install or a real bug (NameError/ImportError inside the module); the guard
  turns both into silent default behaviour. Config readers already fail open by design
  (`config_read_errors.py:1-7`), so the 379 wrappers catch `AttributeError`/`TypeError` from
  walking an untyped dict. A seeded sample of 40 (`scripts/err_except_sample.out.txt`): 15
  legitimate boundary, 9 should be a narrow except, 12 hide a bug (5 config reads, 3 first-party
  import guards, 4 others), 4 log-and-continue. The gist's top static fix class is swallowed
  exceptions (106 strict / 669 by diff shape).
- move: (1) Delete `try/except Exception` around first-party imports; a broken install fails at
  the entry point and `hermes doctor` reports it. (2) Typed config accessors (CFG-02) remove the
  config-read wrappers. (3) Name the legitimate boundaries (tool handler, JSON-RPC method,
  platform callback, plugin hook, thread/task top) and give each one decorator
  (`@tool_boundary`, `@rpc_boundary`, …) that logs with `exc_info` and converts to that boundary's
  error type. `except Exception` anywhere else needs a reason comment. With these, the gist's
  swallowed-except rule only has to police the remainder.
- reference: structlog `src/structlog/processors.py:374` (`ExceptionRenderer`: exceptions are
  rendered once at the boundary, not stringified at every catch).
- loc_delta: -4000
- risk: Removing a guard can crash a path that relied on it for an optional extra (138 import
  guards are third-party: keep those, narrowed to `ImportError`). Preserve plugin isolation at
  the plugin-hook boundary.
- depends_on: [CFG-02]

### ERR-12 — JSON-RPC errors are 89 magic numbers reused across meanings; clients decide by regex on message text
- severity: high · effort: S · kind: boundary · low_hanging: true
- evidence: `tui_gateway/server.py:877`, `tui_gateway/methods_session_control.py:248`,
  `tui_gateway/methods_vault.py:57`, `tui_gateway/server_requests.py:100`,
  `ui-tui/src/app/userMessages.ts:14`, `ui-tui/src/app/userMessages.ts:127`,
  `ui-tui/src/app/userMessages.ts:192`
- problem: `_err(rid, code: int, msg)` is called at 349 sites with 89 distinct integer
  literals (`rg -o "_err\(\w+, *(\d+)"`); two codes have names. The TUI documents that 4001 "is
  reused by the backend for unrelated refusals" so it matches the message text
  (`userMessages.ts:127-129`). It decides whether to re-dispatch a slash command that may mutate
  state by a regex on the 4018 message (`:192-196`). Rewording a backend string changes client
  control flow. Messages are `str(e)`, sent to a client that may be on another machine, with no
  redaction at the boundary.
- move: `tui_gateway/errors.py` with `class RpcError(IntEnum)`, one member per meaning (split the
  reused 4001/4018), `_err(rid, RpcError.X, msg)`; the existing contract generator emits the TS
  enum into `apps/shared/src/gateway-contract.generated.ts`. Clients branch on the code only.
  `_err` routes `msg` through `redact(…, Purpose.EGRESS)` (ERR-04).
- reference: null
- loc_delta: 50
- risk: Old clients that match the current numbers. Keep numeric values for unchanged meanings;
  new codes only for the split cases.
- depends_on: [ERR-04]

## Kill list

| target | why | importers/callers | evidence |
|---|---|---|---|
| `tenacity` in core `dependencies` | pinned, zero in-scope importers (adopt via stamina in ERR-03 or delete) | 0 | `pyproject.toml:53`; `rg tenacity` |
| `hermes_logging.py::set_session_context` / `clear_session_context` / `_session_context` | wrong primitive (ERR-05); `clear_session_context` has 0 callers | 3 / 0 | `hermes_logging.py:104`, `:229-236` |
| 16 `try: from agent.redact import …; except Exception` wrappers | importing redaction cannot fail; each invents a failure policy (ERR-04) | 16 sites | `scripts/err_redact_guards.out.txt` |
| `tools/mcp_tool_common.py::_CREDENTIAL_PATTERN` / `_sanitize_error` | private second secret list | 11 calls | `tools/mcp_tool_common.py:72-87` |
| `BasePlatformAdapter._is_retryable_error` / `_is_rate_limited_error` / `_is_timeout_error`, `SendResult.retryable` | substring re-classification (ERR-02) | 55 adapter sites | `gateway/platforms/base.py:3566-3586` |
| `gateway/run_turn.py::_tool_call_logger`, `_run_agent_write_tool_log` | second file-logging pipeline (ERR-07) | 1 | `gateway/run_turn.py:54-75`, `:3200` |
| `plugins/observability/langfuse/` + `tools_config_post_setup.py::_post_setup_langfuse` + `pm/extras.py` entry | third-party product in tree (ERR-10) | plugin system only | `plugins/observability/langfuse/__init__.py:1` |
| ~1,795 first-party import guards | hide broken installs and real bugs (ERR-11) | n/a | `scripts/err_import_guard.py` |
| duplicate `PtyUnavailableError` (3 definitions) | one class, three modules | 5 | `hermes_cli/pty_bridge.py:59`, `hermes_cli/win_pty_bridge.py:39`, `hermes_cli/web_server_chat.py:41` |

## Simplify list

| what N things | become what 1 thing | lines saved | evidence |
|---|---|---|---|
| `FailoverReason`, `bot_failure_reasons` codes, `classify_cron_error`, `classify_gateway_error`, `classify_send_error`, 30+ `_is_transient_*` predicates | `agent/failure.py::Failure` + one table | ~350 | ERR-01 |
| ~95 retry loops + `jittered_backoff` + test autouse stub | `stamina.retry_context(on=…)` | ~600 | ERR-03 |
| 5 redaction flags + `redact_for_egress` + `redact_for_export` + `debug_redaction` + 16 wrappers | `redact(text, purpose)` | ~250 | ERR-04 |
| `threading.local` session tag + `gateway/session_context` ContextVars | one ContextVar read by the record factory | ~30 | ERR-05 |
| `_ProfileRoutingFileHandler` home override dance + listener-side policy reads | format on producer, route strings by key | ~200 | ERR-06 |
| `tool_calls.log` handler + `hermes_logging` handlers | one `handler_specs` row | ~45 | ERR-07 |
| 3 proxy resolvers + ~200 per-site HTTP client/one-shot choices | `hermes_platform/net.py::NetPolicy` + `http_client(purpose)` | ~400 | ERR-08 |
| lifecycle hooks + 110 direct telemetry imports + monitoring emitter queue | `agent/events.py` bus with subscribers | unknown | ERR-09 |

## Reference patterns to copy

| repo | path | pattern | where it applies here |
|---|---|---|---|
| stamina | `src/stamina/_core.py:119` | `retry_context(on=, attempts=, timeout=)`; typed `on=` | ERR-03 replaces ~95 loops; ERR-02 retry decision |
| stamina | `src/stamina/_config.py:174` | `set_testing()` global test switch | replaces the `jittered_backoff` autouse stub (`pyproject.toml:858`) |
| structlog | `src/structlog/contextvars.py:82` | `merge_contextvars`: log context from ContextVars at emit time | ERR-05 session tag |
| structlog | `src/structlog/_config.py:202` | configure the processor chain once | ERR-04 redaction purposes, ERR-09 bus |
| structlog | `src/structlog/stdlib.py:1012` | `ProcessorFormatter`: render in producer context | ERR-06 |
| cpython | `Lib/logging/handlers.py:1522` | `QueueHandler.prepare` formats on the producer thread | ERR-06 |
| cpython | `Lib/logging/handlers.py:1567` | one `QueueListener` for all file handlers | ERR-07 |
| httpx | `httpx/_config.py:72`, `:159` | `Timeout` / `Limits` as typed objects | ERR-08 `NetPolicy` |
| httpx | `httpx/_client.py:199` | `event_hooks` on a long-lived client | ERR-08 redacted request logging |
| blinker | `src/blinker/base.py` | named signals, decoupled receivers | ERR-09 |

## Answer to the seam question

Is there one error model, one logging pipeline, one retry policy and one HTTP-client lifecycle?

- **Logging:** yes, mostly. `hermes_logging.setup_logging` feeds one queue and one listener for
  every entry point. The exceptions are the gateway's `tool_calls.log` (ERR-07) and three
  `basicConfig` entry points without redaction (`mcp_serve.py:713`,
  `hermes_cli/plugin_host_child.py:571`, `agent/transports/hermes_tools_mcp_server.py:140`). The
  session context uses the wrong primitive (ERR-05), and multiplex routing costs ~400 lines (ERR-06).
- **Error model:** one good typed model for provider calls (`FailoverReason`). It is lost at the
  first boundary, and nine or more string classifiers with five vocabularies do the rest (ERR-01,
  ERR-02, ERR-12). There is no common exception root: 308 custom exception classes, 113 of them
  subclass `RuntimeError` directly (`scripts/err_exc_classes.py`).
- **Retry policy:** none. About 95 hand-rolled loops, a backoff helper used 9 times, and an unused
  `tenacity` (ERR-03).
- **HTTP:** one shared client for provider SDK calls. Everything else builds its own across four
  stacks with three proxy policies (ERR-08).

**What structlog + stamina + a shared httpx client would delete:**

- structlog's contextvars model deletes the `threading.local` session tag and its rebind calls,
  and its processor chain is the shape for the redaction purposes (ERR-04). A full swap from
  stdlib logging to structlog is not needed; the queue design is sound.
- stamina deletes ~95 retry loops, `jittered_backoff` and the test stub. It builds on `tenacity`,
  which already ships unused.
- A shared httpx client per purpose deletes three proxy resolvers and takes `requests`/`urlopen`
  off core paths.

**Is the observability package needed, and whose is it?** `hermes_cli/observability/` (10k lines)
is Nous's own opt-in telemetry (consent, `telemetry.nousresearch.com`). It is first-party and
gated, so it stays. It should be a subscriber on one event bus outside `hermes_cli`, not 110
imports from agent/tools/gateway into the CLI package (ERR-09). The Langfuse plugin is someone
else's product and should leave the tree (ERR-10).

## Cross-seam notes

- 08-state — `hermes_cli/kanban_db_connect.py:1156-1176` has its own SQLite busy retry
  (`_BUSY_MAX_RETRIES`, `random.uniform`) beside `hermes_state_errors.py:49::is_sqlite_lock_error`;
  17 files match "database is locked|SQLITE_BUSY" handling.
- 07-config — 379 broad excepts wrap config reads that already fail open
  (`hermes_cli/config_read_errors.py:1-7`); typed config (CFG-02) deletes them.
- 07-config — `agent/redact.py:97` snapshots `HERMES_REDACT_SECRETS` at import time and
  `_redact_enabled` (`:107-136`) re-reads `.env`/config per profile: an env var bridged from
  `security.redact_secrets` in three entry points (`redact.py:92-96`).
- 13-tui-cron — RPC error codes reused across meanings and matched by text in `ui-tui`
  (`ui-tui/src/app/userMessages.ts:127-129`, `:192-196`); see ERR-12.
- 01-layout — `agent/error_classifier.py:977` and `:1003` import `hermes_cli.anon_auth` and
  `hermes_cli.route_identity`; `agent/` and `tools/` import `hermes_cli.observability` in 24 files
  (ERR-09).
- 10-gateway — `gateway/platforms/base.py:279-368` shells out to `scutil --proxy` with a TTL cache
  inside the adapter base class; proxy policy belongs in `hermes_platform` (ERR-08).
- 11-plugins — `hermes_cli/lifecycle.py:11-29` hard-codes shared metrics as a privileged
  observer ahead of plugin hooks.
- 06-tools — `tools/file_tools.py:1329` and `:1339` wrap tool execution in telemetry closures
  (`record_file_edit`).

## UNVERIFIED

- UNVERIFIED: the ~95 real retry loops figure is extrapolated from a seeded 22-site sample of the
  210 heuristic hits (10/22 real). Verify by hand-classifying all 210 sites in
  `scripts/err_retry_loops.out.json`.
- UNVERIFIED: ERR-07's cross-profile write needs a live multiplex run with
  `display.tool_progress: log` for a secondary profile. Verify with two homes (A→B→A) and inspect
  both `logs/tool_calls.log`.
- UNVERIFIED: ERR-05's stale tag on pooled gateway threads assumes agent turns run on reused
  executor threads. Verify by logging `threading.get_ident()` and the tag across two sessions in
  one gateway.
- UNVERIFIED: ERR-06's claim that formatting on the producer thread is cheap enough has no
  measurement. Verify with a microbenchmark of `RedactingFormatter.format` on typical records.
- UNVERIFIED: whether any `_err(rid, …, str(e))` message in `tui_gateway` can carry a secret
  today (ERR-12). Verify by auditing exception sources for the 5095/5031 sites.
- UNVERIFIED: whether removing `requests` from core breaks a transitive user (another core
  dependency that requires `requests`). Verify with `uv tree --invert --package requests` in a
  lab copy.
- UNVERIFIED: `classify_gateway_error` false positives ("token" ⇒ `auth_failed`) are inferred from
  the rule table (`agent/monitoring/gateway_health.py:53`), not observed on real gateway errors.
- UNVERIFIED: the -4,000 `loc_delta` for ERR-11 assumes ~1,800 import guards at ~2 lines each.
  It is an estimate.
- UNVERIFIED: `scripts/err_http_ast.py` reports 0 one-shot HTTP calls without `timeout=`. Its
  check accepts `**kwargs` as "has timeout", so the true number may be higher.
