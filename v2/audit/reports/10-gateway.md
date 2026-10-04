# 10 Messaging gateway runner and platform adapters

Revision: `origin/main` = `ea81748579`. Reference repos per `inputs/reference-repos.md` (SHAs listed there). Bucket data: `notes/gwy-buckets-discord-slack.md`, `notes/gwy-buckets-telegram-feishu-matrix.md`; inventory script `scripts/gwy_ast.py`.

## TL;DR

- The per-chat session engine (busy guard, follow-up queue, batching, debounce, drain, final delivery) is split between BasePlatformAdapter and GatewayRunner, and each reaches into the other's private state; 59 of 319 fix commits on the three files involved since April are busy/queue/race fixes.
- Biggest kill: per-adapter interactive-prompt UI (approval, slash-confirm, clarify, model/choice picker; ~4,000 LOC across five adapters, including the CC-119 _define_discord_view_classes) and 38 out-of-process _standalone_send copies (1,183 LOC) plus 673 lines of hard-coded senders in tools/send_message_senders.py.
- Biggest simplification: one runner-owned ChatLane per session key replaces both message guards and the split queue; BasePlatformAdapter shrinks from a 3,017-line class to a transport protocol plus a capabilities dataclass.
- Low-hanging fruit: 5 findings (GWY-03, GWY-04, GWY-05, GWY-07, GWY-10).
- Seam answer: adapters are 4-7k lines because only 12-30% of each is transport; the rest is UI, access policy, config glue and helpers that every adapter re-implements because the contract is a duck-typed 180-method base class with no typed host, prompt, policy or lifecycle model.

## What this area is

Scope: `gateway/`, `plugins/platforms/`: 149,389 lines in 253 files (gateway/ 95,455 lines / 175 files from `inputs/metrics/areas.json`; plugins/platforms/ 53,934 lines / 78 files by `wc -l`). Entry point: `hermes gateway run` → `gateway/run.py::start_gateway` (run.py:5833) → `GatewayRunner`.

| module | LOC | owns |
|---|---|---|
| `gateway/run.py` | 6,169 | GatewayRunner facade (18 mixins), start_gateway, 191 module helpers that siblings and plugins import back (_profile_runtime_scope, _load_gateway_config, _gateway_runner_ref) |
| `gateway/run_inbound.py` | 2,190 | runner-side inbound: admission, idle/busy command dispatch, active-slot claim, hand-off to the turn |
| `gateway/run_busy.py` | 1,420 | busy-session handler called by the adapter guard; queue/steer/interrupt policy; slash command tables |
| `gateway/run_turn.py` | 4,372 | turn preparation, _run_agent, TurnContext assembly, proxy mode, follow-ups |
| `gateway/run_turn_runner.py` | 2,001 | TurnRunner: per-turn tool-progress callbacks and the run_conversation worker |
| `gateway/run_adapters.py` | 1,935 | adapter creation, wiring callbacks, fatal-error handling, primary and secondary reconnect |
| `gateway/run_startup.py` | 1,846 | start-up phases, restore, home-channel handoff |
| `gateway/run_shutdown.py` | 2,288 | stop/drain/restart, session finalisation |
| `gateway/platforms/base.py` | 4,934 | BasePlatformAdapter (3,017-line class: transport ABC + per-chat session engine + final delivery + TTS + prompts) plus ~1,900 lines of media cache and outbound media-path security |
| `gateway/platforms/api_server.py` | 4,646 | OpenAI-compatible HTTP server; subclasses BasePlatformAdapter but builds its own AIAgent per request |
| `gateway/session_state.py` | 269 | SessionState(turn, conversation, persistent) per session key; half-finished replacement for 19 runner dicts |
| `plugins/platforms/discord/adapter.py` | 7,488 | Discord transport, voice channels, 7 UI view classes, slash registration, history backfill, standalone sender |
| `plugins/platforms/telegram/adapter.py` | 7,422 | Telegram polling/webhook transport, network fallback, topics, inline keyboards, batching overrides |
| `plugins/platforms/slack/adapter.py` | 6,943 | Slack Bolt transport, block kit, draft streaming, assistant threads, model picker |

Objects by lifetime (today): per process one `GatewayRunner` (18 mixins, `SessionStore`, agent cache, `self._sessions` map of `SessionState`); per (profile, platform) one adapter instance in `self.adapters` (launch profile) or `self._profile_adapters[profile]` (run.py:3510), plus a reconnect-queue dict entry when failed; per chat a session key with adapter-side guard/queue/batch state AND a runner-side `SessionState`; per turn a `TurnContext` (70 fields, gateway/turn_context.py:15), a `TurnRunner` (run_turn_runner.py:78) and an `AIAgent` (cached per session).

## How it works end to end

### A Discord user sends a message and gets the agent's reply

Trigger: user posts in a Discord channel the bot serves. Inputs that change the path: `session_busy` (an agent turn is already running for this session key (adapter guard set), default False); `is_bypass_command` (message is /stop, /new, /approve, /deny or another command whose busy_policy bypasses the guard, default False); `is_idle_command` (message is a gateway slash command handled without the agent, default False); `queued_followup` (another message was queued while this turn ran, default False).

1. `plugins/platforms/discord/adapter.py::DiscordAdapter._handle_message` (`plugins/platforms/discord/adapter.py:6000`): mention/channel gating, builds SessionSource via build_source (6142) and the MessageEvent → GWY-10
2. `plugins/platforms/discord/adapter.py::DiscordAdapter._handle_message` (`plugins/platforms/discord/adapter.py:6227`): text goes to base _enqueue_text_event batching, everything else to handle_message
3. `gateway/platforms/base.py::BasePlatformAdapter.handle_message` (`gateway/platforms/base.py:4039`): canonicalises identity, derives the session key, checks the adapter guard _active_sessions → GWY-01
4. `gateway/platforms/base.py::BasePlatformAdapter._handle_message_while_active` (`gateway/platforms/base.py:4081`) *(when session_busy = True)*: bypass commands dispatch inline; clarify replies go to the text intercept; others go to the runner busy handler or the adapter's _pending_messages → GWY-01
5. `gateway/run_busy.py::GatewayBusySessionMixin._handle_active_session_busy_message` (`gateway/run_busy.py:807`) *(when session_busy = True)*: authorises, then queue/steer/interrupt by busy_input_mode; queueing writes into the adapter's private _pending_messages (run_busy.py:382) → GWY-01
6. `gateway/platforms/base.py::BasePlatformAdapter._process_message_background` (`gateway/platforms/base.py:4563`) *(when session_busy = False)*: background task: typing refresh, processing hook, awaits the runner's message handler → GWY-02
7. `gateway/run_inbound.py::GatewayInboundMixin._handle_message` (`gateway/run_inbound.py:1323`) *(when session_busy = False)*: runner entry: _hm_admit_event (auth, identity), e-stop gate, pending-reply intercepts → GWY-06
8. `gateway/run_inbound.py::GatewayInboundMixin._hm_handle_running_session_message` (`gateway/run_inbound.py:731`) *(when session_busy = True)*: second busy decision tree, used when the runner's SessionState says running but the adapter guard was clear → GWY-01
9. `gateway/run_inbound.py::GatewayInboundMixin._hm_dispatch_canonical_command` (`gateway/run_inbound.py:1048`) *(when is_idle_command = True)*: looks the command up in _PLAIN_COMMANDS/_IDLE_COMMANDS tables, else getattr(self, f'_hm_cmd_{name}') → GWY-08
10. `gateway/run_inbound.py::GatewayInboundMixin._handle_message` (`gateway/run_inbound.py:1381`): claims the active-session slot and installs _AGENT_PENDING_SENTINEL in SessionState before any await → GWY-01
11. `gateway/run_turn.py::GatewayTurnMixin._run_agent` (`gateway/run_turn.py:2928`): builds TurnContext (70 fields) and a TurnRunner (3102), runs AIAgent.run_conversation on a worker thread (run_turn_runner.py:1724) → GWY-06
12. `gateway/platforms/base.py::BasePlatformAdapter._send_final_text` (`gateway/platforms/base.py:4411`): final text goes through send_final_ledgered (4379) and _send_with_retry (3649) to the adapter's send() → GWY-02
13. `gateway/platforms/base.py::BasePlatformAdapter._process_message_background` (`gateway/platforms/base.py:4651`) *(when queued_followup = True)*: pops the queued follow-up from _pending_messages, releases the guard, spawns a drain task that repeats from step 6 → GWY-01

### A platform connection dies and the gateway reconnects it

Trigger: adapter transport hits a retryable fatal error (network loss, polling conflict). Inputs that change the path: `secondary_profile` (adapter belongs to a multiplexed secondary profile, not the launch profile, default False); `retryable` (adapter marked the fatal error retryable, default True).

1. `gateway/platforms/base.py::BasePlatformAdapter._notify_fatal_error` (`gateway/platforms/base.py:2228`): calls the runner-installed fatal handler in a detached, shielded task → GWY-07
2. `gateway/run_adapters.py::GatewayAdapterLifecycleMixin._handle_adapter_fatal_error` (`gateway/run_adapters.py:224`) *(when secondary_profile = False)*: primary path: detaches _handle_adapter_fatal_error_detached → GWY-07
3. `gateway/run_adapters.py::GatewayAdapterLifecycleMixin._queue_retryable_fatal_platform` (`gateway/run_adapters.py:250`) *(when retryable = True)*: stores an untyped dict entry (config, attempts, next_retry, claims, dedup) in _failed_platforms → GWY-07
4. `gateway/run_adapters.py::GatewayAdapterLifecycleMixin._reconnect_failed_platform` (`gateway/run_adapters.py:792`) *(when secondary_profile = False)*: watcher pass: credential gate, _create_adapter, _wire_adapter_handlers, connect with timeout, install or back off and dispose → GWY-07
5. `gateway/run_adapters.py::GatewayAdapterLifecycleMixin._wire_adapter_handlers` (`gateway/run_adapters.py:1329`): seven setter calls plus direct writes to adapter private attributes (_busy_text_mode, _busy_text_debounce_seconds, _human_delay_range_ms) → GWY-04
6. `gateway/run_adapters.py::GatewayAdapterLifecycleMixin._handle_profile_adapter_fatal_error` (`gateway/run_adapters.py:1586`) *(when secondary_profile = True)*: secondary path: pops from _profile_adapters, disconnects, schedules a per-profile reconnect task → GWY-07
7. `gateway/run_adapters.py::GatewayAdapterLifecycleMixin._secondary_reconnect_attempt` (`gateway/run_adapters.py:1398`) *(when secondary_profile = True)*: re-implements step 4 under the profile scope: load config, credential gate, create, configure, connect → GWY-07

## Findings

### GWY-01 — The per-chat session engine is split between the adapter base class and the runner, and each mutates the other's private state

severity **critical** · effort **XL** · kind **restructure** · low_hanging **false** · loc_delta -2500 · depends_on GWY-04

**Evidence:** `gateway/platforms/base.py:4073`, `gateway/platforms/base.py:4081`, `gateway/platforms/base.py:4147`, `gateway/platforms/base.py:4651`, `gateway/run_busy.py:375`, `gateway/run_busy.py:382`, `gateway/run_busy.py:807`, `gateway/run_inbound.py:731`, `gateway/session_state.py:49`, `gateway/AGENTS.md:20`

**Problem (today):** Today one chat's state lives in two objects. The adapter holds the busy guard (_active_sessions), the head of the follow-up queue (_pending_messages), text batches, debounce state, session tasks and drain tasks (base.py:1967-2036). The runner holds SessionState with the running agent, the queue overflow (ConversationState.queued_events, documented 'head in adapter', session_state.py:49) and the busy policy. There are two busy decision trees: the adapter's _handle_message_while_active (base.py:4081) calling the runner's _handle_active_session_busy_message (run_busy.py:807), and the runner's own _hm_handle_running_session_message (run_inbound.py:731). The runner writes into the adapter's private queue (run_busy.py:382) and the adapter calls back into the runner to find which adapter holds the event (base.py:4147-4157). gateway/AGENTS.md:20-28 documents the two guards as a rule every new command must satisfy. Cost: every busy/queue change must be reasoned about across two objects and a reconnect that replaces the adapter mid-turn. git log since 2026-04-01 on base.py, run_busy.py and run_inbound.py: 319 fix commits, 59 of them matching queue|pending|busy|guard|drain|follow-up|duplicate|stale|race (e.g. ab86a20aec 'recover busy follow-up from the slot that holds it', c8533b178a 'recover pending event from delivery adapter', 00ee5db3f4 'a busy follow-up queued as the turn ends is no longer left without an owner').

**Move (proposal):** Proposal: create gateway/lanes.py with one ChatLane per session key, owned by the runner (a single dict on a SessionLanes service). A ChatLane is a mailbox: an asyncio.Queue of MessageEvent, the running-turn slot (today SessionState.turn), the interrupt Event, batching/debounce timers, and the busy policy (queue/steer/interrupt) as one method. Adapters call host.ingest(event) and nothing else on inbound. Delete from BasePlatformAdapter: _active_sessions, _pending_messages, _session_tasks, _handle_message_while_active, _process_message_background's queue/drain half, _spawn_drain_task, _requeue_backoff_delay, _heal_stale_session_lock, the busy_session_handler setter. Delete runner-side _hm_handle_running_session_message and fold _handle_active_session_busy_message into ChatLane.on_message_while_busy. The 'two guards' rule in gateway/AGENTS.md:20-28 becomes unnecessary: there is one guard. AGENTS.md states the rule; I argue against it because the rule documents the hazard instead of removing it.

**Reference:** `.repos/textual/src/textual/message_pump.py:562` — one MessagePump per widget owns its queue and processes messages sequentially (_process_messages, _dispatch_message at :707); senders only post_message (:860)

**Risk:** Highest-risk change in the seam. Must preserve: bypass commands (/stop, /new, /approve, /deny) dispatch inline while a turn is blocked; clarify text intercept; photo-burst merge into one turn; FIFO for text/voice follow-ups (#114363, #28503); steer delivered into the running agent and its subagents; queue during drain; adapter replacement mid-turn on reconnect; at-least-once admission receipts (_gateway_accepted). Large test surface in tests/gateway/ patches the adapter and runner private dicts; those tests move with the state.

### GWY-02 — BasePlatformAdapter is a 3,017-line session engine and media-security module, not a transport contract

severity **high** · effort **L** · kind **restructure** · low_hanging **false** · loc_delta -300 · depends_on GWY-01, GWY-04

**Evidence:** `gateway/platforms/base.py:1918`, `gateway/platforms/base.py:1967`, `gateway/platforms/base.py:4563`, `gateway/platforms/base.py:1168`, `gateway/platforms/base.py:1127`, `gateway/platforms/base.py:4239`, `gateway/platforms/api_server.py:4638`

**Problem (today):** base.py is 4,934 lines. The BasePlatformAdapter class (base.py:1918) is 3,017 lines and ~180 methods (gwy_ast.py base). Its __init__ sets ~38 attributes, most of them session-engine state rather than transport (base.py:1967-2036). The module also holds ~1,900 lines of unrelated helpers: the media cache (cache_image_from_bytes etc., base.py:678-784), outbound media-path security with Docker volume translation and kanban roots (base.py:837-1238, validate_media_delivery_path at 1168), media-tag parsing, ExecApprovalPrompt/SendResult types. Final delivery, auto-TTS and attachment fan-out run inside _process_message_background (base.py:4563-4686). Telegram-specific logic sits in the base (base.py:4065, 4239). APIServerAdapter inherits all of it and stubs send() (api_server.py:4638-4642). Cost: a new adapter author faces a 180-method parent with no line between 'implement this' and 'never touch this'; a fix to delivery security lands in the same file as Discord's typing indicator.

**Move (proposal):** Proposal: split base.py along its real seams. (1) gateway/platforms/transport.py: an ABC/Protocol with connect, disconnect, send, edit_message, delete_message, send_media(kind, path, caption), send_typing/stop_typing, get_chat_info, format_message, plus a frozen PlatformCapabilities dataclass (GWY-04); target under 500 lines. (2) gateway/media/cache.py and gateway/media/delivery_policy.py for the module-level helpers. (3) gateway/delivery.py (exists, 334 lines) takes final-text/attachment/TTS delivery out of _process_message_background. (4) The session half goes to ChatLane (GWY-01). base.py disappears as a concept; event.py already holds MessageEvent.

**Reference:** `.repos/httpx/httpx/_transports/base.py:65` — AsyncBaseTransport is two methods (handle_async_request :77, aclose :85); pooling, retries and redirects live in the client, not the transport

**Risk:** Plugin adapters outside the tree subclass BasePlatformAdapter and override private hooks (_keep_typing per ADDING_A_PLATFORM.md, _flush_text_batch, _enqueue_text_event). Keep BasePlatformAdapter as the documented base during the move and provide the hooks plugins actually use; tests that construct bare adapters with object.__new__ need fixtures.

### GWY-03 — Every adapter re-implements the same five interactive prompts, and two reach into a private dict in tools/

severity **high** · effort **M** · kind **collapse** · low_hanging **true** · loc_delta -2500 · depends_on —

**Evidence:** `plugins/platforms/discord/adapter.py:6320`, `plugins/platforms/discord/adapter.py:6896`, `plugins/platforms/telegram/adapter.py:4953`, `plugins/platforms/slack/adapter.py:5618`, `plugins/platforms/slack/adapter.py:5217`, `plugins/platforms/discord/adapter.py:6243`, `plugins/platforms/slack/adapter.py:5458`, `gateway/platforms/base.py:2913`, `gateway/platforms/base.py:2941`

**Problem (today):** Exec approval, slash confirm, clarify, model picker and choice picker are each rendered and resolved per adapter. Interactive-UI code by adapter (bucket U, notes/gwy-buckets-*.md): discord 1,471 LOC, slack 986, telegram 894, feishu 319, matrix 313. The base exposes only hooks (_send_exec_approval_prompt returns 'not supported' at base.py:2913; send_clarify text template at 2941), so every adapter copies the resolve step: Discord ExecApprovalView._resolve (discord:6447) and Slack _handle_approval_action (slack:5618) both call tools.approval.resolve_gateway_approval with the same expired-count handling. Discord (discord:6896) and Telegram (telegram:4953) import the private tools.clarify_gateway._entries to round-trip choice text. Click authorisation is implemented twice with different semantics: Discord reads env, roles and PairingStore (discord:6243), Slack calls the injected runner check (slack:5458). The copies drift: only Discord has the expensive-model confirmation in its model picker (combined_selection_warning call at discord:6666); Telegram drops the base multi-select hint (base.py:2953). _define_discord_view_classes (discord:6320, 612 lines, CC 119, the worst function in the tree) exists to define seven discord.ui.View classes after a lazy install (docstring 6321-6322).

**Move (proposal):** Proposal: gateway/interactions.py owns a typed Prompt (id, session_key, kind, title, body, choices: list[Choice], allow_other, multi_select, expires_at) and a PromptRegistry with resolve(prompt_id, choice, actor) that runs the click authorisation once (through the runner's authz) and dispatches to the approval, slash_confirm, clarify or model-switch resolver. Adapters implement two primitives: render_prompt(chat, prompt) -> message_ref and finalize_prompt(message_ref, decided_text); a click calls host.resolve_prompt(prompt_id, choice_index, actor_id). Discord's seven view classes become one generic PromptView built from a Prompt, defined in a discord/views.py imported only after discord is available, which deletes _define_discord_view_classes. tools.clarify_gateway exposes a public lookup and _entries stays private.

**Reference:** `.repos/home-assistant-core/homeassistant/helpers/dispatcher.py:172` — async_dispatcher_send routes a keyed signal to whichever handler registered for it; producers never import the consumer's internals

**Risk:** Per-platform limits must survive: Discord 25-option selects, Slack block limits, Telegram callback_data 64-byte cap and UTF-16 budget, Matrix reaction pickers without paging. Approval security: only authorised users may approve; a unified authorisation must match the strictest current behaviour (Discord admin gate at discord:6302).

### GWY-04 — The adapter contract is duck-typed: 113 getattr/hasattr probes, private-attribute pokes, a runner back-reference, and 132 core modules imported by platform plugins

severity **high** · effort **M** · kind **boundary** · low_hanging **true** · loc_delta -200 · depends_on —

**Evidence:** `gateway/run_adapters.py:1337`, `gateway/run_adapters.py:1350`, `gateway/run_adapters.py:1860`, `gateway/run_busy.py:382`, `gateway/platforms/base.py:4042`, `plugins/platforms/discord/adapter.py:4170`, `plugins/platforms/telegram/adapter.py:7284`, `plugins/platforms/feishu/feishu_comment.py:449`, `gateway/platforms/ADDING_A_PLATFORM.md:11`

**Problem (today):** Runner and adapter talk through implicit attributes. Count: `rg -n 'hasattr\(adapter|getattr\(adapter, "' gateway/*.py` = 113; probed names include private state (_pending_messages 10, _active_sessions 4, _session_tasks 2, _bot 2) and capabilities (supports_status_text, splits_long_messages, send_or_update_status, join_voice_channel). _wire_adapter_handlers makes seven setter calls and then writes adapter._busy_text_mode, _busy_text_debounce_seconds, _busy_text_hard_cap_seconds and _human_delay_range_ms directly (run_adapters.py:1337-1355); it also sets adapter.gateway_runner = self (run_adapters.py:1860). MessageEvent carries runner-adapter receipts as ad-hoc private attributes (_gateway_accepted 10 sites, _turn_marker_handoff, _hermes_run_generation). Platform plugins import from 132 distinct core modules (`rg -o '^\s*from (gateway|hermes_cli|agent|tools|...)[a-z_.]* import' plugins/platforms | sort -u`), including private gateway.run helpers (_async_profile_runtime_scope discord:4170, cfg_get telegram:7284, _resolve_gateway_model feishu_comment.py:449). ADDING_A_PLATFORM.md:11 promises 'zero changes to core Hermes code'; the real contract is whatever the big adapters happen to import.

**Move (proposal):** Proposal: (1) a frozen PlatformCapabilities dataclass returned by adapter.capabilities, replacing the class-attribute flags at base.py:1923-1962 and every hasattr probe. (2) An AdapterHost Protocol passed to the adapter constructor (ingest, authorize, resolve_prompt, profile_scope, session_store, settings) replacing the seven setters, the gateway_runner back-reference and the private-attribute writes; busy timing moves to the host. (3) A typed AdmissionReceipt returned by host.ingest instead of event._gateway_accepted. (4) gateway/platforms/sdk.py as the only module plugins may import from core, enforced by an import-linter contract (gist Phase 4 already plans import-linter; this gives it a target).

**Reference:** `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/profiles/__init__.py:54` — ModelProfile is one typed capability record per model (supports_tools :62, supports_json_schema_output :75); callers read the profile, never probe the model with hasattr

**Risk:** Third-party plugin adapters call the setters and may read gateway_runner; keep the setters as thin adapters over AdapterHost for one release. Tests use MagicMock adapters whose auto-created attributes make hasattr true (gateway/AGENTS.md:56-57 already warns about this); a typed capabilities record removes that trap.

### GWY-05 — Core gateway code branches on platform identity 97 times and reads self.adapters[Platform.DISCORD] directly

severity **high** · effort **M** · kind **restructure** · low_hanging **true** · loc_delta -400 · depends_on GWY-04

**Evidence:** `gateway/platforms/base.py:4065`, `gateway/run_turn.py:3072`, `gateway/run_turn_runner.py:776`, `gateway/run_agent_cache.py:604`, `gateway/run_voice.py:209`, `gateway/run_topics.py:278`, `gateway/run_busy.py:489`, `gateway/AGENTS.md:157`

**Problem (today):** Count: `rg -noE 'Platform\.[A-Z_]+ *(==|!=|in)|(==|!=|is) *Platform\.[A-Z_]+' gateway/*.py` = 97 comparisons; by name Discord 33, Telegram 29, Slack 28, Matrix 19 occurrences. Examples: Telegram DM-topic recovery inside the base adapter (base.py:4065), Telegram reply-anchor choice in the busy path (run_busy.py:489-492), Discord-only voice-channel orchestration in the runner (run_voice.py, 397 lines; adapters.get(Platform.DISCORD) at 209, 254), Discord thread handling in run_topics.py:278-344, Slack sethome wording in run_turn.py:1456. Nine sites read adapters.get(Platform.X) directly (run_turn.py:3073, run_turn_runner.py:776, run_agent_cache.py:604), which gateway/AGENTS.md:157 forbids ('Never read self.adapters[platform] for a source') because it picks the wrong bot under multiplexing. Cost: platform behaviour is spread over the runner, and the plugin model ('zero core changes') is false for the three biggest platforms.

**Move (proposal):** Proposal: replace each comparison with a capability on PlatformCapabilities (GWY-04) or an optional sub-protocol the adapter implements: VoiceChannelCapable (join/leave/is_in_voice_channel, moves run_voice.py into plugins/platforms/discord), TopicThreads (Telegram DM topics and Discord threads share one 'thread binding' hook), reply_anchor_policy, caption_limit. Route every adapter lookup through _delivery_adapter_for(source). Target: zero Platform.<NAME> comparisons outside gateway/config.py.

**Reference:** `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/profiles/__init__.py:54` — provider differences expressed as profile fields read by generic code, not if provider == X branches

**Risk:** Each branch encodes a live incident (Telegram 1024-char caption, Slack ignored channels, Discord voice). Move one platform at a time with its tests; keep the multiplex delivery matrix (tests/gateway/test_multiplex_transport_matrix.py) green.

### GWY-06 — GatewayRunner is one object built from 18 mixins with 959 methods, and its siblings import 296 names back from the facade

severity **high** · effort **L** · kind **restructure** · low_hanging **false** · loc_delta -1000 · depends_on —

**Evidence:** `gateway/run.py:3389`, `gateway/run.py:3421`, `gateway/run.py:3114`, `gateway/run.py:1824`, `gateway/run_turn_runner.py:81`, `gateway/platforms/api_server.py:1333`, `gateway/relay/egress.py:198`

**Problem (today):** GatewayRunner (run.py:3389) inherits 18 mixins. AST count over gateway/run*.py, slash_commands*.py, authz_mixin.py, kanban_watchers.py (Gateway* classes): 959 methods, 23,087 lines inside methods, 133 distinct self attributes assigned. Every mixin can read and write every attribute, so the facade + siblings split moved text into files without creating modules with narrow interfaces (parent-facts item 11). `rg 'from gateway.run import' gateway` = 296 late imports from the facade; 79 more from outside gateway/run*. The most imported are private helpers that are really public services: _load_gateway_config (35), _profile_runtime_scope (25), _AGENT_PENDING_SENTINEL (25), _async_profile_runtime_scope (18). A module-global weakref _gateway_runner_ref (run.py:3114) lets api_server.py (1333, 2194, 4064) and relay/egress.py (198, 292) reach the whole runner. run.py still holds 191 module-level functions. Cost: no part of the runner can be read, tested or replaced alone; tests build runners with object.__new__ and class-level defaults exist 'so partial construction in tests doesn't blow up' (run.py:3397).

**Move (proposal):** Proposal: compose the runner from services with explicit dependencies instead of mixins: AdapterManager (GWY-07), SessionLanes (GWY-01), CommandRouter (GWY-08), TurnExecutor (run_turn.py + run_turn_runner.py + run_agent_cache.py; TurnRunner already takes (runner, ctx) and uses 15 runner attributes, run_turn_runner.py:81), Notifications (run_notifications.py, run_watchers.py), Lifecycle (run_startup.py, run_shutdown.py). GatewayRunner keeps only construction and start/stop. Move _profile_runtime_scope and _async_profile_runtime_scope to a public gateway/profile_scope.py and _load_gateway_config to gateway/config_loader.py (exists). Replace _gateway_runner_ref with the service the caller needs, passed at construction.

**Reference:** `.repos/svcs/src/svcs/_core.py:573` — a Container hands each consumer the typed service it asks for (get at :898); no consumer holds the whole application object

**Risk:** The test suite patches facade bindings ('patch where production reads', root AGENTS.md:267-270); every moved helper changes patch targets for many tests. Do it service by service, each with its own PR, starting with the leaf services (Notifications, CommandRouter).

### GWY-07 — Adapter lifecycle has no state model: primary and secondary profiles have two reconnect implementations over untyped dicts

severity **high** · effort **M** · kind **collapse** · low_hanging **true** · loc_delta -600 · depends_on —

**Evidence:** `gateway/run_adapters.py:237`, `gateway/run_adapters.py:708`, `gateway/run_adapters.py:792`, `gateway/run_adapters.py:1398`, `gateway/run_adapters.py:1440`, `gateway/run_adapters.py:1586`, `gateway/run.py:3415`, `gateway/platforms/base.py:2177`

**Problem (today):** A launch-profile adapter lives in self.adapters and, when it fails, in self._failed_platforms as a dict with string keys config/attempts/next_retry/queued_at/credential_claim/listener_claim/inbound_dedup/paused (run_adapters.py:237-249), retried by _platform_reconnect_watcher (708) and _reconnect_failed_platform (792). A secondary-profile adapter lives in self._profile_adapters (run.py:3510) and is retried by a separate per-profile task chain (_handle_profile_adapter_fatal_error 1586, _run_secondary_profile_reconnect 1440, _secondary_reconnect_attempt 1398) stored in _profile_failed_platforms (run.py:3415). Both re-implement: credential gate, create, wire, connect with timeout, dispose on failure. State is reported as strings (platform_state='fatal') through _update_platform_runtime_status, while the adapter keeps its own flags (_mark_connected/_mark_degraded/_set_fatal_error, base.py:2177-2210). Cost: a reconnect fix must be applied twice (the fd-leak dispose comments at run_adapters.py:843-866 exist only on the primary path), and no single place answers 'what state is Telegram for profile X in'.

**Move (proposal):** Proposal: gateway/platform_entries.py with a PlatformEntry per (profile, platform) and a PlatformState enum (NOT_LOADED, SETUP_IN_PROGRESS, LOADED, SETUP_RETRY, SETUP_ERROR, UNLOAD_IN_PROGRESS, PAUSED). Methods: setup(), unload(), reload(), schedule_retry(). One retry scheduler over all entries. The launch profile is just profile 'default'. Runtime status (gateway_state.json) is written from entry.state transitions only. Deletes _failed_platforms, _profile_failed_platforms, the secondary reconnect chain and the dict-shaped queue entry.

**Reference:** `.repos/home-assistant-core/homeassistant/config_entries.py:151` — ConfigEntryState enum with SETUP_RETRY/SETUP_ERROR/NOT_LOADED; ConfigEntry.async_setup (:714) moves state and schedules retries, async_unload (:1075), manager async_reload (:2621)

**Risk:** Preserve: secondary adapters connect under their own profile scope and secret scope; inbound dedup caches carry across reconnects (carry_inbound_dedup); claims prevent two profiles using one credential; a non-retryable error stops retries; pause/resume via /platform. Seam 09 owns the task-tracking side; coordinate.

### GWY-10 — Shared helpers exist but the big adapters re-implement them: access policy, status reactions, dedup, config readers, retries

severity **high** · effort **M** · kind **collapse** · low_hanging **true** · loc_delta -1200 · depends_on GWY-04

**Evidence:** `gateway/platforms/access_policy_mixin.py:23`, `plugins/platforms/discord/adapter.py:3951`, `plugins/platforms/discord/adapter.py:2994`, `plugins/platforms/slack/adapter.py:3255`, `plugins/platforms/telegram/adapter.py:7212`, `plugins/platforms/feishu/adapter.py:3593`, `gateway/platforms/helpers.py:20`, `plugins/platforms/telegram/adapter.py:3578`, `gateway/platforms/base.py:3649`

**Problem (today):** Access/identity is 10-17% of each big adapter (discord 1,270 LOC, telegram 1,254, slack 983). OwnAccessPolicyMixin (access_policy_mixin.py:23) is used only by Weixin, WeCom, QQBot, WhatsApp and Yuanbao; 25 adapter files read <PLATFORM>_ALLOWED_USERS / ALLOW_ALL_USERS themselves (`rg -l '_ALLOWED_USERS|ALLOW_ALL_USERS'`), and require_mention is parsed in 16 files. Discord's _is_allowed_user (discord:3951, 58 lines) and click check differ from Slack's, which defers to the runner. The same applies to other helpers: the processing-status reaction swap exists five times (telegram:7212, feishu:2523, matrix:2449, discord:2994, slack:3255); MessageDeduplicator (helpers.py:20) is ignored by feishu (3593) and matrix (946); three retry engines exist (base _send_with_retry 3649, telegram _send_chunk_with_retries 3578, feishu _feishu_send_with_retry 3925); bool/CSV extra readers are copied (telegram:5839 vs matrix:959). Cost: authorisation drift between platforms is a security-relevant inconsistency, and every policy fix is applied N times.

**Move (proposal):** Proposal: (1) an IntakePolicy dataclass (allowlist, allow_all, require_mention, free_response_channels, allow_bots, ignored_channels, dm/group policy) parsed once by core from PlatformConfig + scoped env; adapters supply facts (is_mention, is_bot, channel_id, thread_id) and call host.admit(facts). Delete per-adapter allowlist parsing and OwnAccessPolicyMixin's env plumbing. (2) Base StatusReactions template with two hooks (_add_reaction, _remove_reaction). (3) Make MessageDeduplicator and a single extra_bool/extra_set reader in _shared the only implementations. (4) Telegram and Feishu retries become retry policies passed to base _send_with_retry.

**Reference:** `.repos/stamina/src/stamina/_core.py:730` — retry behaviour defined once as a typed policy and applied by decorator/context manager, not re-written per call site

**Risk:** Authorisation semantics differ today on purpose in places (Discord roles, Slack workspace scoping, pairing). The IntakePolicy must model roles and pairing as inputs, and the change must be checked with the multi-profile fail-closed rules in gateway/AGENTS.md:185-201 (scoped env, never os.environ under multiplex).

### GWY-08 — Gateway slash-command dispatch is spread over five tables resolved by string-built method names

severity **medium** · effort **M** · kind **collapse** · low_hanging **false** · loc_delta -150 · depends_on GWY-06

**Evidence:** `gateway/run_busy.py:910`, `gateway/run_busy.py:916`, `gateway/run_busy.py:924`, `gateway/run_busy.py:952`, `gateway/run_inbound.py:1044`, `gateway/run_inbound.py:1062`, `gateway/platforms/base.py:4093`

**Problem (today):** A gateway command's behaviour is decided in five places: CommandDef.busy_policy in hermes_cli/commands.py (read by the adapter at base.py:4093 to decide bypass), _PLAIN_COMMANDS and _IDLE_COMMANDS tuples (run_busy.py:910, 916) resolved by getattr(self, f'_handle_{name}_command') with an alias dict (run_busy.py:908, 924), _BUSY_SPECIAL_HANDLERS resolved to _busy_<key>_command (run_busy.py:952), and _HM_CANONICAL_COMMANDS resolved by getattr(self, f'_hm_cmd_{canonical}') (run_inbound.py:1044, 1062). Handlers are spread over run_busy.py, run_inbound.py and five slash_commands_*.py mixins. Adding or renaming a command means editing tuples whose names are checked only at call time; static analysis cannot find the handler from the name.

**Move (proposal):** Proposal: one GatewayCommand record per command (name, busy_policy, idle_handler, busy_handler, scope) registered by a decorator in the module that implements it, collected into one CommandRouter (GWY-06). The adapter's bypass check and the runner's idle/busy dispatch both read the same record. Deletes the four tuples, the alias dict and the getattr string building.

**Reference:** `.repos/inspect_ai/src/inspect_ai/_util/registry.py:127` — registry_add/registry_lookup (:262) keyed by name with typed RegistryInfo; decorators register at definition time

**Risk:** busy_policy semantics must stay identical (dispatch, interrupt_then_dispatch, queue); Discord/Slack/Telegram native slash registration reads the same CommandDef registry in hermes_cli (seam 12 owns that registry).

### GWY-09 — Each platform has a second, out-of-process transport: 38 _standalone_* functions plus a hard-coded sender module

severity **medium** · effort **M** · kind **kill** · low_hanging **false** · loc_delta -1500 · depends_on GWY-02

**Evidence:** `plugins/platforms/discord/adapter.py:7074`, `plugins/platforms/slack/adapter.py:6729`, `plugins/platforms/whatsapp/adapter.py:1038`, `plugins/platforms/feishu/adapter.py:4313`, `tools/send_message_senders.py:259`, `tools/send_message_senders.py:445`, `gateway/platform_registry.py:110`

**Problem (today):** Cron jobs and send_message running without a live gateway deliver through standalone_sender_fn (platform_registry.py:110). AST count over plugins/platforms/*/*.py of functions named _standalone*: 38 functions, 1,183 LOC in 20 plugins (discord 144 LOC at 7074 plus bounded body readers, whatsapp 85, slack 64 + 71 for media). tools/send_message_senders.py (673 lines) adds hand-written senders for Telegram (259), Signal (445), Matrix (522), Weixin, QQBot, Yuanbao. Each copy has its own chunking, retry and error handling, separate from the adapter's send(). The bucket notes record drift: Discord caps chunk count, Slack does not. Feishu shows the alternative already works: its standalone sender constructs a FeishuAdapter and calls adapter.send / send_image_file (feishu/adapter.py:4313-4345).

**Move (proposal):** Proposal: one base classmethod BasePlatformAdapter.send_once(config, chat_id, message, media, thread_id) whose default opens the adapter in send-only mode (a new open_for_send() hook that defaults to building the API client without starting polling or sockets), calls send/send_media, and closes. Delete the per-plugin _standalone_send functions and the platform functions in tools/send_message_senders.py; platform_registry keeps standalone_sender_fn only as an override for platforms whose send needs a live session (WhatsApp bridge).

**Reference:** none applies

**Risk:** Adapters whose __init__ or connect() start background work (Telegram polling, Discord gateway websocket) need open_for_send to build only the REST client. Discord REST send without a gateway connection must keep working. Out-of-process senders run under the cron worker's profile scope; preserve that binding.

### GWY-11 — The API server is a second agent host filed as a platform adapter

severity **medium** · effort **L** · kind **restructure** · low_hanging **false** · loc_delta -800 · depends_on GWY-06

**Evidence:** `gateway/platforms/api_server.py:1199`, `gateway/platforms/api_server.py:4638`, `gateway/platforms/api_server.py:2364`, `gateway/platforms/api_server.py:2439`, `gateway/platforms/api_server_memory_sessions.py:31`, `gateway/AGENTS.md:213`

**Problem (today):** APIServerAdapter(OpenAICompatRoutesMixin, BasePlatformAdapter) (api_server.py:1199) is a 3,448-line class plus 2,700 lines of route/run/idempotency siblings. It inherits the chat session engine but uses none of it: send() returns 'API server uses HTTP request/response, not send()' (4638-4642). It builds AIAgent itself (_create_agent 2364, AIAgent(**agent_kwargs) 2439), bypasses TurnRunner and the agent cache (gateway/AGENTS.md:213-219), and therefore needed its own memory-provider parking (api_server_memory_sessions.py) to fix a lost-recall bug (#120116). It imports runner internals lazily (_resolve_runtime_agent_kwargs_for_provider 2246, _resolve_gateway_model 2480, _gateway_runner_ref 1333). Cost: turn-setup fixes in run_turn.py do not reach HTTP clients, and the reverse.

**Move (proposal):** Proposal: move api_server*.py to gateway/api_server/ as a peer front-end that implements only the lifecycle part of the platform protocol (start/stop/status) and executes turns through the same TurnExecutor service as messaging (GWY-06). Delete its inheritance from BasePlatformAdapter and the per-request agent assembly; api_server_memory_sessions.py becomes unnecessary if TurnExecutor's agent cache serves it.

**Reference:** `.repos/datasette/datasette/hookspecs.py:8` — the app object owns startup/shutdown hooks; HTTP is one front-end over shared app services, not a subclass of another front-end

**Risk:** The API server deliberately rebuilds the agent per request (per-request callbacks, model route, ephemeral prompt). TurnExecutor must accept those per-request overrides without the messaging session key semantics. tui_gateway is a third agent host (seam 13).

### GWY-12 — The SessionState migration is half done: 19 legacy_dict_property views keep the old runner dicts alive

severity **medium** · effort **M** · kind **kill** · low_hanging **false** · loc_delta -150 · depends_on —

**Evidence:** `gateway/run.py:3420`, `gateway/run.py:3441`, `gateway/run.py:3397`, `gateway/session_state.py:1`

**Problem (today):** session_state.py:1-4 says SessionState replaces ~19 session-key dicts on GatewayRunner that 'bred boundary drift and wholesale-reset races'. run.py:3420-3441 keeps those dicts as live views via legacy_dict_property / legacy_lease_token_property, and the comment says new code should use _session_state(key). Old names are still read: `rg -w` over in-scope code: _running_agents 41, _session_model_overrides 11, _queued_events 6, _pending_approvals 5. Class-level defaults on GatewayRunner exist for half-constructed test runners (run.py:3397). Two access paths to the same state keep the drift the migration was meant to end.

**Move (proposal):** Proposal: finish the migration: replace each legacy name with _session_state(key).<scope>.<field>, then delete legacy_dict_property, legacy_lease_token_property and the 19 class attributes. This folds into GWY-01 if done first.

**Reference:** none applies

**Risk:** Tests read and patch the legacy dict names; they need updating in the same PRs.

## Kill list

| target | why | importers/callers | evidence |
|---|---|---|---|
| `plugins/platforms/discord/adapter.py::_define_discord_view_classes` | 612 lines, CC 119; defines 7 discord.ui.View classes in a function only to survive a lazy install; 4 of 6 public views repeat one gate-finalize-resolve body | 2 | plugins/platforms/discord/adapter.py:6320; called at import (6933) and from check_discord_requirements (628-654) |
| `38 plugins/platforms/*/adapter.py::_standalone_send* functions` | second per-platform transport for out-of-process sends; replaceable by constructing the adapter (feishu already does) | 1 | gateway/platform_registry.py:110 standalone_sender_fn; plugins/platforms/feishu/adapter.py:4313 |
| `tools/send_message_senders.py platform senders (_send_telegram, _send_signal, _send_matrix_via_adapter, _send_weixin, _send_bluebubbles, _send_qqbot, _send_yuanbao)` | hard-coded per-platform send paths duplicating adapter send() | 1 | tools/send_message_senders.py:259, 445, 522, 585, 598, 620, 661 |
| `gateway/run.py legacy_dict_property attributes (19) + legacy_lease_token_property` | second access path to SessionState | 41 | gateway/run.py:3420-3441 |
| `gateway/platforms/base.py busy/queue half (_handle_message_while_active, _pending_messages, _active_sessions, _spawn_drain_task, _requeue_backoff_delay, _heal_stale_session_lock)` | duplicate guard and queue owned by the transport layer; moves into ChatLane | 0 | gateway/platforms/base.py:4081, 4651-4759, 3936 |
| `gateway/run_inbound.py::_hm_handle_running_session_message` | second busy decision tree beside run_busy.py::_handle_active_session_busy_message | 1 | gateway/run_inbound.py:731, 1357 |
| `gateway/run_adapters.py secondary reconnect chain (_secondary_reconnect_attempt, _run_secondary_profile_reconnect, _schedule_secondary_profile_reconnect)` | re-implements the primary reconnect path | 3 | gateway/run_adapters.py:1398, 1440, 1563 |
| `gateway/platforms/api_server_memory_sessions.py` | exists only because the API server bypasses the shared agent cache | 1 | gateway/AGENTS.md:213-219 |

## Simplify list

| what N things | become what 1 thing | lines saved | evidence |
|---|---|---|---|
| gateway/platforms/base.py (session half); gateway/run_busy.py busy handler; gateway/run_inbound.py running-session path; gateway/session_state.py queued_events | gateway/lanes.py ChatLane per session key | ~2500 | gateway/platforms/base.py:4081; gateway/run_busy.py:807; gateway/run_inbound.py:731 |
| discord views (6 classes); slack _handle_*_action (approval/slash/clarify/model); telegram _handle_*_callback; feishu card actions; matrix reaction pickers | gateway/interactions.py Prompt + PromptRegistry; adapters implement render_prompt/finalize_prompt | ~2500 | plugins/platforms/discord/adapter.py:6320; plugins/platforms/slack/adapter.py:5217-5673; plugins/platforms/telegram/adapter.py:4622-4964 |
| self.adapters + _failed_platforms (primary); _profile_adapters + _profile_failed_platforms (secondary) | PlatformEntry per (profile, platform) with PlatformState enum | ~600 | gateway/run_adapters.py:237, 792, 1398, 1440 |
| _PLAIN_COMMANDS; _IDLE_COMMANDS; _BUSY_SPECIAL_HANDLERS; _HM_CANONICAL_COMMANDS; _COMMAND_HANDLER_ALIASES | one GatewayCommand registry | ~150 | gateway/run_busy.py:908-953; gateway/run_inbound.py:1044 |
| 38 _standalone_send* functions; tools/send_message_senders.py platform senders | BasePlatformAdapter.send_once + open_for_send hook | ~1500 | plugins/platforms/feishu/adapter.py:4313 |
| 5 status-reaction copies; 25 allowlist readers; 3 retry engines; 2 dedup implementations | IntakePolicy + StatusReactions + one retry policy + MessageDeduplicator | ~1200 | gateway/platforms/access_policy_mixin.py:23; gateway/platforms/helpers.py:20 |

## Reference patterns to copy

| repo | path | pattern | where it applies here |
|---|---|---|---|
| home-assistant-core | `.repos/home-assistant-core/homeassistant/config_entries.py:151` | ConfigEntryState enum + async_setup (:714) / async_unload (:1075) / async_reload (:2621) per integration entry | GWY-07 adapter lifecycle per (profile, platform) |
| textual | `.repos/textual/src/textual/message_pump.py:562` | one mailbox per component processes messages sequentially; senders only post | GWY-01 ChatLane per session key |
| httpx | `.repos/httpx/httpx/_transports/base.py:65` | transport ABC of two methods; policy lives in the client | GWY-02 narrow transport contract |
| pydantic-ai | `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/profiles/__init__.py:54` | typed capability profile read by generic code | GWY-04/GWY-05 PlatformCapabilities |
| svcs | `.repos/svcs/src/svcs/_core.py:573` | container hands each consumer a typed service | GWY-06 runner composed of services |
| home-assistant-core | `.repos/home-assistant-core/homeassistant/helpers/dispatcher.py:172` | keyed dispatch between producer and consumer | GWY-03 prompt resolution |
| inspect_ai | `.repos/inspect_ai/src/inspect_ai/_util/registry.py:127` | decorator registry keyed by name with typed info | GWY-08 command registry |
| datasette | `.repos/datasette/datasette/hookspecs.py:8` | app-owned startup/shutdown; HTTP is a front-end over app services | GWY-11 API server as a peer front-end |

## Answer to the seam question

Today the adapter contract is BasePlatformAdapter: an ABC with three abstract methods (connect, disconnect, send at base.py:2726-2738) inside a 3,017-line class of ~180 methods that also runs the per-chat session engine, final delivery, TTS and prompt templates, plus seven runner-installed callbacks, private attributes the runner writes, a gateway_runner back-reference and 113 hasattr/getattr probes. Adapters are 4-7k lines because transport is only 12-30% of each (discord 14%, slack 13%, telegram 26% + 11% network fallback, feishu 22%, matrix 30%; notes/gwy-buckets-*.md). The rest is interactive UI (13-20%), access policy (10-17%), config/setup glue (5-16%), history backfill, out-of-process senders and helpers, and almost all of it is re-implemented per adapter because the base offers hooks, not models: no typed Prompt, no IntakePolicy, no capabilities record, no send-only mode. The session/busy logic is the one thing adapters do not re-implement (S bucket 1.5-9.6%), because the base owns it, and that is the piece that should leave the adapter for the runner. Move into shared layers: prompts (GWY-03), intake policy, status reactions, dedup and retries (GWY-10), standalone send (GWY-09), and platform branches as capabilities (GWY-05). The adapter then shrinks to transport + rendering + platform UI primitives behind an AdapterHost protocol (GWY-04). The runner should own one ChatLane per session key (GWY-01) and one PlatformEntry per (profile, platform) with an explicit state enum and setup/unload/reload (GWY-07), composed from services instead of 18 mixins (GWY-06).

Relation to the ratchet plan (`inputs/gist/0-plan.md`): the CC/file caps would flag `_define_discord_view_classes`, base.py and the three big adapters, but splitting them by line count keeps the duplication. GWY-03 removes the CC-119 function outright. GWY-04's `gateway/platforms/sdk.py` gives the planned import-linter (Phase 4) and the 'adapter override signatures match base.py' rule a concrete target; with a typed `AdapterHost` and `PlatformCapabilities` that signature rule mostly stops being needed. GWY-01 targets the race/TOCTOU class (245 fix commits repo-wide) that the gist lists as review-only.

## Cross-seam notes

- **09-concurrency** `gateway/platforms/base.py:2228`: Fatal-error handling detaches shielded tasks on both sides (adapter and runner) to survive cancellation of the adapter's own polling task; lifecycle ownership of these tasks belongs in PlatformEntry.
- **09-concurrency** `gateway/platforms/base.py:4688`: Busy re-queue uses a back-off sleep with a fixed 1s cap because nothing wakes the drain task; a lane mailbox removes the poll.
- **01-layout** `gateway/run.py:3389`: Facade + siblings in gateway produced one 18-mixin class and 296 late imports back into gateway.run; evidence that the decomposition moved text without creating modules.
- **13-tui-cron** `gateway/platforms/api_server.py:2364`: Three agent hosts assemble turns separately: gateway TurnRunner, API server _create_agent, tui_gateway; cron also has its own delivery path via standalone senders.
- **06-tools** `tools/send_message_senders.py:259`: tools/send_message_senders.py hard-codes platform senders and tools/clarify_gateway._entries is imported privately by adapters.
- **11-plugins** `plugins/platforms/discord/adapter.py:4170`: Platform plugins import 132 distinct core modules including private gateway.run helpers; the plugin contract for platforms is not a narrow SDK.
- **12-cli** `gateway/platforms/base.py:4093`: Command busy_policy lives in hermes_cli/commands.py CommandDef and is read by the gateway adapter base; the registry is shared across CLI and gateway.
- **14-errors-obs** `gateway/platforms/base.py:4104`: BLE001 leaders in this seam: discord adapter 127, telegram adapter 96, gateway/run.py 95 (SUMMARY.md); many guard runner<->adapter hasattr probes that a typed contract would remove.

## UNVERIFIED

- UNVERIFIED: bucket percentages for telegram/feishu/matrix are ~70% regex-assigned and ±2 points (child classifier); verify by re-running notes/gwy-buckets-work/classify.py with hand review.
- UNVERIFIED: loc_delta figures are estimates from bucket sizes and function lengths, not from a prototype.
- UNVERIFIED: the 59/319 fix-commit share is a keyword grep over commit subjects since 2026-04-01; it was not checked commit by commit that each fix was caused by the adapter/runner split.
- UNVERIFIED: Telegram's send_clarify dropping the multi-select hint (base.py:2953) is a behaviour gap; verify with a live multi-select clarify on Telegram.
- UNVERIFIED: why 8 adapters (signal, weixin, yuanbao, qqbot, bluebubbles, whatsapp_cloud, webhook, msgraph_webhook) still live in gateway/platforms while 22 are plugins; check git log -S for the plugin migration.
- UNVERIFIED: whether Discord and Telegram REST sends work without a gateway/polling connection (a precondition for GWY-09 send-only mode); verify against discord.py and python-telegram-bot docs.
- UNVERIFIED: the 113 getattr/hasattr count matches only probes on variables named `adapter`; probes through other names (a, delivery_adapter, self.adapters[...]) are not counted.
