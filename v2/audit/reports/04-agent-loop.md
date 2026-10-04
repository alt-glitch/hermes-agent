# 04 Agent turn loop

Revision: `origin/main` = `ea81748579`. Reference repos at the SHAs in `inputs/reference-repos.md` (pydantic-ai c68786e, inspect_ai 9f6accd, textual 06dbeef, llm 764dc38, attrs a602f78, httpx b5addb6).

Counting scripts (lab, stdlib AST): `scripts/agt_map.py` (private reach, mixins, callbacks), `scripts/agt_attrs.py` (attributes written on the agent), `scripts/agt_runtime_writers.py` (runtime-identity writers). Compression detail: `notes/04-compression-survey.md`.

## TL;DR

- The turn loop has no owned state. AIAgent carries 371 distinct instance attributes (272 private) written from 57 files, and code outside the class reads its private attributes 1,614 times from 97 files. Every phase, helper, fork and surface reaches into the same flat bag.
- Biggest kill: the phase-calling protocol. That is 21 `*Verdict` dataclasses in 15 files that copy loop locals back by field name, stringly typed `action` values, and `_run_phase` signature reflection. Phases should take one typed `LoopState` and return the next step.
- Biggest simplification: init_agent already groups agent state into five dict tables (_CONTROL_STATE, _TURN_STATE, _SESSION_STATE, _STREAM_STATE, _USAGE_STATE) and then flattens them onto the agent. Promote each table to a dataclass, and add a frozen RuntimeBinding and a SystemPromptCache. This is the pydantic-ai GraphAgentState/GraphAgentDeps split.
- Low-hanging fruit: 6 of 13 findings (AGT-02, AGT-03, AGT-04, AGT-05, AGT-08, AGT-09).
- Seam answer: the loop needs about 6 concepts (TurnRequest, LoopState, RuntimeBinding, SystemPromptCache, AgentSink, TurnResult) and 5 phases. Today it has the phases (turn_*.py) but none of the concepts as types. It sits halfway to pydantic-ai: phases are split out, but state and transitions are untyped and reflective.

## What this area is

Scope: 51 files, 45,197 lines (`wc -l` over the paths below). Entry points: `AIAgent.run_conversation` / `AIAgent.chat` (`agent/turn_facade.py`), called by the CLI (`hermes_cli/cli_chat_turn_mixin.py:356`), gateway (`gateway/run_turn_runner.py:1724`), TUI (`tui_gateway/prompt_turn.py:802`), ACP, cron, delegate_tool, background review and curator. There are 25 `AIAgent(` construction sites in scope.

Paths: `run_agent.py`, `agent/agent_init.py`, `agent/conversation_loop.py`, `agent/turn_*.py (31 files)`, `agent/tool_executor.py`, `agent/inline_tool_executors.py`, `agent/prompt_builder.py`, `agent/system_prompt.py`, `agent/context_compressor.py`, `agent/conversation_compression*.py`, `agent/compression_facade.py`, `agent/moa_loop.py`, `agent/background_review.py`, `agent/agent_runtime_helpers.py`, `agent/client_lifecycle.py`, `agent/stream_delivery.py`, `agent/session_persistence.py`, `agent/display.py`, `agent/curator.py (boundary only)`

| module | lines | owns |
|---|---|---|
| `run_agent.py` | 1586 | AIAgent facade: 14 mixin bases, an 84-parameter __init__ that forwards to init_agent, 71 methods, 32 lazy forwarders, .env load at import |
| `agent/agent_init.py` | 2523 | init_agent: 84 params, 5 state-default tables, client construction, tools, memory, context engine, compression config |
| `agent/conversation_loop.py` | 1835 | run_conversation, _LoopState (53 fields), _run_phase reflection driver, system-prompt restore/build, assorted turn-result builders |
| `agent/turn_*.py` | 12602 | 31 phase siblings: context/preflight/iteration prep/request assembly/API call/error/recovery/response check/tool round/truncation/overflow/final response/finalizer/usage |
| `agent/tool_executor.py` | 1929 | sequential, concurrent and segmented tool execution, middleware, persistence-before-execute |
| `agent/agent_runtime_helpers.py` | 3776 | grab-bag: message repair, trajectory, credential recovery, primary-runtime restore, prompt-cache policy, OpenAI client construction, switch_model, invoke_tool, httpx socket reaping, steer |
| `agent/context_compressor.py` | 5970 | ContextCompressor, the built-in ContextEngine: pruning, boundary selection, summary LLM call, cooldown policy, plus some persistence |
| `agent/conversation_compression.py` | 4615 | compression host: lease, commit fence, attempt generation, timeouts, commit/publish, session rotation |
| `agent/turn_facade.py` | 222 | TurnFacadeMixin.run_conversation: lease admission, relay coordinator, 4 ContextVar tokens, nested finally |
| `agent/background_review.py` | 1364 | review fork: builds a full AIAgent then overwrites about 20 private attributes |
| `agent/moa_loop.py` | 1550 | MoA as a fake OpenAI client (MoAClient) plus reference fan-out |
| `agent/status_output.py` | — | StatusOutputMixin: _vprint/_safe_print/_emit_* (about 206 call sites in agent/) |

Key numbers (how counted):

- `AIAgent` has 14 mixin bases, 71 methods in its own body and 32 `_forward` lazy forwarders. The mixins hold 16 more (`scripts/agt_map.py`).
- `AIAgent.__init__` and `init_agent` each take 84 parameters, 22 of them `*_callback` (AST).
- 371 distinct attributes are written on the agent, 272 of them private, from 57 files (`scripts/agt_attrs.py`: `agent.X =` anywhere in agent/ and run_agent.py, `self.X =` inside AIAgent and its mixins, plus the init tables).
- 1,614 `agent._x` / `parent_agent._x` / `self.agent._x` private reads come from 97 in-scope files: agent/ 1,477, hermes_cli 47, gateway 33, tui_gateway 25, tools 24, acp_adapter 4.
- 634 module-level functions in agent/ take `agent` (or `self`) as their first parameter. They are methods in everything but name.

## How it works end to end

### User types a prompt in the classic CLI and gets an answer (optionally after a tool round)

Trigger: hermes chat, user presses Enter. Inputs that change the path: `admission_blocked` (default False): durable turn lease not admitted (another turn holds the session); `api_mode_codex_app_server` (default False): api_mode == codex_app_server hands the whole turn to a subprocess; `tool_calls_in_reply` (default True): model answers with tool calls instead of final text; `parallel_safe_batch` (default False): more than one tool call and the segment planner marks the batch parallel-safe.

1. `hermes_cli/cli_chat_turn_mixin.py::_chat_run_agent` (`hermes_cli/cli_chat_turn_mixin.py:356`): calls self.agent.run_conversation with the composer text and history [AGT-05]
2. `agent/turn_facade.py::TurnFacadeMixin.run_conversation` (`agent/turn_facade.py:22`): cancels any background review, admits the durable turn lease, acquires the relay conversation, sets 3 ContextVars [AGT-05]
3. `agent/turn_facade.py::TurnFacadeMixin.run_conversation` (`agent/turn_facade.py:86`): returns the early admission result without running the loop *(only when `admission_blocked` = True)*
4. `agent/conversation_loop.py::_run_conversation_turn` (`agent/conversation_loop.py:1533`): resets per-turn attributes on the agent, then calls build_turn_context with 7 injected module functions [AGT-01]
5. `agent/turn_context.py::build_turn_context` (`agent/turn_context.py:1016`): recovers a rotated session, restores the primary runtime, restores or builds the cached system prompt, creates the DB row, runs turn-start compaction [AGT-09]
6. `agent/conversation_loop.py::_run_conversation_turn` (`agent/conversation_loop.py:1622`): hands the turn to the codex app-server runtime; returns unless fallback activates *(only when `api_mode_codex_app_server` = True)* [AGT-12]
7. `agent/conversation_loop.py::_run_phase` (`agent/conversation_loop.py:1480`): drives each phase: reflects its signature, passes _LoopState fields by name, copies verdict fields back [AGT-02]
8. `agent/turn_request_assembly.py::assemble_api_request` (`agent/turn_request_assembly.py:106`): projects history to wire messages: sanitize, evict images, drop thinking-only, canonicalize, strip surrogates [AGT-08]
9. `agent/conversation_loop.py::_run_api_retry_loop` (`agent/conversation_loop.py:1501`): guard -> build_api_request -> perform_api_call -> check_api_response, with handle_api_error on exceptions [AGT-02]
10. `agent/turn_response_intake.py::normalize_model_response` (`agent/turn_response_intake.py:120`): normalizes the provider response into assistant_message
11. `agent/turn_tool_round.py::run_tool_round` (`agent/turn_tool_round.py:46`): validates and persists the assistant tool-call row, then calls agent._execute_tool_calls *(only when `tool_calls_in_reply` = True)* [AGT-02]
12. `run_agent.py::AIAgent._execute_tool_calls` (`run_agent.py:1330`): plans segments; runs sequential, concurrent or segmented execution *(only when `tool_calls_in_reply` = True)* [AGT-13]
13. `agent/tool_executor.py::execute_tool_calls_concurrent` (`agent/tool_executor.py:1552`): runs the parallel batch; each call resolves its handler through agent_runtime_helpers.invoke_tool *(only when `parallel_safe_batch` = True)* [AGT-13]
14. `agent/turn_final_response.py::finish_text_response` (`agent/turn_final_response.py:55`): runs stop gates and verification on the text answer (312 lines, CC 27) *(only when `tool_calls_in_reply` = False)* [AGT-02]
15. `agent/turn_finalizer.py::finalize_turn` (`agent/turn_finalizer.py:520`): builds the result dict (reflected kwargs from _LoopState), persists, runs post-turn hooks and review spawn [AGT-05]

### Provider returns an error mid-turn and the agent fails over to the fallback model

Trigger: API call raises (429/5xx/auth) during a turn on any surface. Inputs that change the path: `pre_classification_recovered` (default False): credential refresh / encoding / image-strip recovery fixed it before classification; `fallback_configured` (default True): fallback_model chain has another entry.

1. `agent/conversation_loop.py::_run_api_retry_loop` (`agent/conversation_loop.py:1524`): catches the exception and runs handle_api_error through _run_phase [AGT-02]
2. `agent/turn_api_error.py::handle_api_error` (`agent/turn_api_error.py:52`): entry; builds an ApiErrorVerdict mirror of loop locals [AGT-02]
3. `agent/turn_recovery.py::recover_before_classification` (`agent/turn_recovery.py:235`): tries transport/credential repair; may rewrite agent.client, api_mode and _client_kwargs in place [AGT-03]
4. `agent/turn_api_error.py::handle_api_error` (`agent/turn_api_error.py:82`): returns retry when pre-classification recovery worked *(only when `pre_classification_recovered` = True)*
5. `agent/turn_api_error.py::handle_api_error` (`agent/turn_api_error.py:111`): classifies the error (FailoverReason)
6. `agent/turn_recovery.py::recover_after_classification` (`agent/turn_recovery.py:641`): credential-pool rotation, format repairs, welcome-tier handling
7. `agent/turn_api_error.py::settle_unrecovered_error` (`agent/turn_api_error.py:341`): calls agent._try_activate_fallback *(only when `fallback_configured` = True)* [AGT-03]
8. `agent/chat_completion_helpers.py::try_activate_fallback` (`agent/chat_completion_helpers.py:2074`): writes model/provider/base_url/api_mode field by field and swaps the client; rewrites Model:/Provider: lines in the cached system prompt *(only when `fallback_configured` = True)* [AGT-03]
9. `agent/chat_completion_helpers.py::rewrite_prompt_model_identity` (`agent/chat_completion_helpers.py:1764`): regex-edits the last Model:/Provider: lines of agent._cached_system_prompt *(only when `fallback_configured` = True)* [AGT-09]
10. `agent/turn_context.py::build_turn_context` (`agent/turn_context.py:1059`): next turn: agent._restore_primary_runtime() rewrites the runtime fields back (agent_runtime_helpers.restore_primary_runtime) [AGT-03]

## Findings

### AGT-01: AIAgent is a flat bag of 371 attributes that 57 files write and 97 files read privately; the state groups already exist as dicts and are flattened away

- **severity** critical · **effort** L · **kind** boundary · **low-hanging** no · **loc_delta** -600 · **depends on** —
- **evidence**: `agent/agent_init.py:521`, `agent/agent_init.py:528`, `agent/agent_init.py:567`, `agent/agent_init.py:597`, `agent/agent_init.py:638`, `agent/agent_init.py:2330`, `run_agent.py:241`, `agent/conversation_loop.py:1607`

**Problem (today).** Today, agent_init.py::_set_defaults copies five already-grouped tables (_CONTROL_STATE, _TURN_STATE, _SESSION_STATE, _STREAM_STATE, _USAGE_STATE) onto the agent as loose attributes. Other helpers add more attributes ad hoc. By AST count (scripts/agt_attrs.py), 371 distinct attributes are written on the agent (272 private) from 57 files. Outside AIAgent, code reads `agent._x` 1,614 times across 97 files: 1,477 in agent/, 47 in hermes_cli/, 33 in gateway/, 25 in tui_gateway/, 24 in tools/ (scripts/agt_map.py). agent/ code also calls getattr/hasattr on the agent 1,112 times, mostly as defensive reads, because no code can be sure an attribute exists (`object.__new__` test stubs, run_agent.py:1360 comment). Per-turn state is reset by hand at the start of each turn (conversation_loop.py:1565-1613), and a missed reset leaks into the next gateway message. A contributor touching any phase must know which of 371 names are per-turn, per-session or config. Nothing in the code says which.

**Move (proposed).** Turn each table into a typed dataclass held as one attribute: `agent.control: ControlState`, `agent.turn: TurnState` (built fresh by build_turn_context, so per-turn resets disappear), `agent.session_state: SessionState`, `agent.stream: StreamState`, `agent.usage: UsageCounters`. Add `agent.runtime: RuntimeBinding` (AGT-03) and `agent.prompt: SystemPromptCache` (AGT-09). Callbacks become `agent.sink` (AGT-04). init_agent then shrinks to constructing these 8 objects. A new attribute must land in one of them, with a type. Sequence: (1) TurnState, because it deletes the reset block; (2) StreamState and UsageCounters, which are leaf-only; (3) the rest.

**Reference.** pydantic-ai `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/_agent_graph.py:341`: GraphAgentState (per-run mutable state) and GraphAgentDeps (:427, per-run immutable deps) are two typed dataclasses passed to every node; nothing is stored loose on the Agent

**Risk.** Thousands of `agent._x` reads repoint to `agent.turn.x` and similar. Tests that build `object.__new__(AIAgent)` stubs, or patch attributes, must change. Do it one table per PR. Preserve: per-turn reset semantics for cached gateway agents, and thread-safety of the locks now in _CONTROL_STATE (they move intact into ControlState).

### AGT-02: Phases talk to the loop through 21 mirror Verdict dataclasses, string actions, and signature reflection

- **severity** high · **effort** M · **kind** collapse · **low-hanging** yes · **loc_delta** -450 · **depends on** —
- **evidence**: `agent/conversation_loop.py:1385`, `agent/conversation_loop.py:1480`, `agent/conversation_loop.py:1477`, `agent/conversation_loop.py:1684`, `agent/turn_tool_round.py:26`, `agent/turn_tool_round.py:46`, `agent/turn_truncation.py:204`, `agent/turn_overflow.py:74`

**Problem (today).** Today each phase helper (run_tool_round, handle_api_error, finish_text_response, ...) takes 10-17 keyword arguments typed `Any`, named like _LoopState fields. It returns a phase-specific `*Verdict` dataclass that repeats a subset of those fields plus `action: str`. `_run_phase` (conversation_loop.py:1480) reads the helper's signature with `inspect.signature`, passes fields by name, then copies every verdict field back with setattr. One field needs a special latch table (`_LATCHED_VERDICT_FIELDS`, :1477). finalize_turn is called the same reflective way (:1684). Count: 21 Verdict classes in 15 files (`rg -c 'class \w*Verdict' agent/`). Action literals: 34 break, 26 continue, 17 return, 8 fallthrough, 1 ok. Adding one loop variable means editing _LoopState, the helper signature, its Verdict and its `_verdict` closure, which repeats every field (turn_tool_round.py:59-66). A typo in a name raises only at runtime. Commit 31025f210c added _LoopState to shrink run_conversation but left the helpers on their kwargs-and-verdict interface.

**Move (proposed).** Make every phase `def phase(agent, s: LoopState) -> Step`. It mutates `s` directly and returns `Step`, an enum (CONTINUE_ITERATION, NEXT_PHASE, END_TURN, RETRY) or an `End(result)` value. Delete the 21 Verdict classes, the `_verdict` closures, `_run_phase`, `_PHASE_PARAMS`, `_CTX_FIELDS`, `_LATCHED_VERDICT_FIELDS` (the latch becomes `s.overflow_pending |= ...` inside handle_api_error), and the reflective finalize_turn call. Type the LoopState fields instead of `Any`. The while loop in _run_conversation_turn stays as written; only the call shape changes.

**Reference.** pydantic-ai `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/_agent_graph.py:2121`: CallToolsNode.run(ctx) -> ModelRequestNode | End[FinalResult]: a node reads/mutates ctx.state and returns the next node as a typed value; no string actions, no field copy-back

**Risk.** Phase unit tests that call helpers with kwargs and assert on verdict fields must switch to building a LoopState. The order of state mutation must stay identical. Copy-back currently happens after the helper returns; with direct mutation an exception mid-phase leaves partial writes. Check handle_outer_loop_error against that.

### AGT-03: The runtime identity (model, provider, base_url, api_key, api_mode, client) is rewritten field by field from about 19 functions in 7 files

- **severity** high · **effort** M · **kind** boundary · **low-hanging** yes · **loc_delta** -350 · **depends on** —
- **evidence**: `agent/moa_loop.py:1536`, `agent/agent_runtime_helpers.py:1135`, `agent/agent_runtime_helpers.py:2295`, `agent/chat_completion_helpers.py:2074`, `agent/turn_recovery.py:235`, `agent/client_lifecycle.py:951`, `agent/bedrock_adapter.py:424`, `agent/context_compressor.py:2768`

**Problem (today).** Today, functions that write 2 or more of {model, provider, base_url, api_key, api_mode, client, _client_kwargs} on the agent (scripts/agt_runtime_writers.py): agent_init (6 functions), client_lifecycle (6), agent_runtime_helpers (_apply_primary_runtime_fields, _build_switched_client, _swap_switch_runtime), chat_completion_helpers.try_activate_fallback, moa_loop.bind_moa_runtime, bedrock_adapter.bind_bedrock_runtime, turn_recovery.recover_before_classification. There are three snapshot shapes for restoring it: _snapshot_switch_state :2164, _build_primary_runtime_snapshot :2416, run_agent.py::_current_main_runtime :540. ContextCompressor keeps its own copy, synced by update_model (context_compressor.py:2768). bind_moa_runtime's docstring states the hazard: 'Every site that puts an agent onto provider: moa ... must pin the same fields ... or the next dispatch reaches a real wire with a virtual identity'. A half-applied switch leaves the agent with mismatched fields, for example a new model with the old client. The gist counts race/TOCTOU at 245 fix commits.

**Move (proposed).** Add a frozen `RuntimeBinding` (attrs/dataclass: provider, model, base_url, api_key or credential handle, api_mode, client_kwargs, capabilities) and keep `agent.runtime` as the only stored copy. `bind_runtime(agent, binding)` is the single writer: it builds the client and swaps runtime and client under _client_lock in one step. switch_model, fallback activation, primary restore, MoA, Bedrock and credential refresh each compute a new binding (`attrs.evolve`) and call bind_runtime. The primary snapshot becomes `agent.primary_runtime: RuntimeBinding`. The compressor reads `agent.runtime` instead of mirroring it. `agent.model` and similar become read-only properties during migration.

**Reference.** attrs `.repos/attrs/src/attr/_make.py`: frozen classes + evolve(): derive a modified immutable value instead of mutating fields in place

**Risk.** Credential-pool rotation mutates only api_key and base_url today. It must produce a new binding without rebuilding an expensive client when only headers change. The OAuth refresh path (client_lifecycle._try_refresh_*) runs on other threads, so bind_runtime needs the existing _client_lock. Preserve: cache-ttl / prompt-caching re-derivation on switch, and the 'failed switch leaves the old capability map intact' rule (agent_runtime_helpers.py:2544).

### AGT-04: 22 surface callbacks in the constructor (declared 3 times), plus a direct stdout channel; the TUI already reduces them to two primitives

- **severity** high · **effort** M · **kind** collapse · **low-hanging** yes · **loc_delta** -400 · **depends on** —
- **evidence**: `run_agent.py:278`, `agent/agent_init.py:2376`, `agent/agent_init.py:2400`, `tui_gateway/agent_callbacks.py:141`, `agent/inline_tool_executors.py:254`, `agent/status_output.py:32`, `agent/conversation_compression.py:3515`

**Problem (today).** Today AIAgent.__init__ (run_agent.py:278-304) and init_agent (agent_init.py:2400-2424) each declare 22 `*_callback` parameters, and _CALLBACK_PARAMS (agent_init.py:2376) lists them a third time. tui_gateway/agent_callbacks.py::_agent_cbs maps all of them onto `_emit(event, sid, payload)` (fire-and-forget) or `_ask(method, sid, params, timeout)` (blocking request). Six callbacks (read_terminal, read_preview, drive_preview, read_window_below, tour, tool_result_metadata) are passed only by tui_gateway (`rg` over surfaces). They exist so inline tools can make a client request (inline_tool_executors.py:254-275). A generic `event_callback(name, dict)` already exists, but it is used for one event, session:compress (conversation_compression.py:3515). On top of this, StatusOutputMixin's _vprint/_safe_print/_emit_*/_buffer_* methods are called about 206 times in agent/ and choose between stdout and status_callback internally. Adding a surface event means one new parameter in two 84-parameter signatures, a table entry, wiring in every surface, and a getattr at the call site.

**Move (proposed).** Define `AgentSink` (Protocol) with two methods: `emit(event: AgentEvent) -> None` and `request(req: ClientRequest, timeout: float) -> Any`. AgentEvent is a small union of frozen dataclasses (ToolStarted, ToolCompleted, TextDelta, ReasoningDelta, Status, Notice, NoticeCleared, Reaction, Interim, Step, CompressionCommitted). Pass `sink=` to the agent once. The CLI sink renders events, which replaces most StatusOutputMixin print paths. The TUI sink is `_emit`/`_ask`. The gateway sink maps to its stream consumer. Inline GUI tools call `agent.sink.request(ClientRequest('terminal.read', {...}))`. Delete the 22 parameters, _CALLBACK_PARAMS, and status_output's mode switching.

**Reference.** textual `.repos/textual/src/textual/message_pump.py`: one post_message(Message) channel with typed Message subclasses, dispatched by type, instead of one callback attribute per event kind

**Risk.** Callback threading: some callbacks run on tool worker threads and the stream writer thread. The sink inherits the same contract and must say so. Plugins and external hosts that pass `*_callback=` kwargs need a one-release adapter that wraps the old kwargs into a sink at the AIAgent boundary. That adapter is the only compat code, and it is at a public API boundary, not an internal move. Delegated children (tools/delegate_tool.py) and review forks must propagate or silence the sink explicitly.

### AGT-05: The turn's input and output are untyped: a 14-parameter signature copied through 4 layers and a result dict built in 16 places

- **severity** high · **effort** S · **kind** boundary · **low-hanging** yes · **loc_delta** -150 · **depends on** —
- **evidence**: `agent/turn_facade.py:22`, `agent/conversation_loop.py:1695`, `agent/conversation_loop.py:1533`, `agent/turn_context.py:1016`, `agent/turn_finalizer.py:520`, `agent/conversation_loop.py:1082`

**Problem (today).** Today TurnFacadeMixin.run_conversation, conversation_loop.run_conversation, _run_conversation_turn and build_turn_context each re-declare and forward the same 13-14 turn inputs (user_message, five persist_user_* fields, moa_config, turn_author, title_user_message, ...). build_turn_context adds 7 injected module functions (turn_context.py:1023-1024). The return value is a plain dict: `"final_response":` dict literals appear 16 times in 11 agent/ files (`rg -c`), and surfaces read about 40 distinct keys from it (`rg -o 'result(\.get\(|\[)"…"'` over gateway/run_turn*, tui_gateway/prompt_turn, cli_chat_turn_mixin, acp_adapter, cron). Nothing checks that a new early-return site sets `failed`, `partial`, `turn_exit_reason` or `messages` consistently. conversation_loop.run_conversation exists partly to re-stamp the boundary on every envelope (:1711-1717) for this reason.

**Move (proposed).** Add `TurnRequest` (frozen dataclass: message, persist: PersistedUserMessage | None, moa, author, title_hint, system_message, history, task_id) and `TurnResult` (dataclass with the keys surfaces actually read, plus `to_dict()` for one release). run_conversation(agent, req) returns TurnResult. The 16 literal sites become TurnResult constructors (`TurnResult.failed(...)`, `.partial(...)`, `.interrupted(...)`). The injected-callable parameters of build_turn_context go away under AGT-06.

**Reference.** llm `.repos/llm/llm/models.py`: Prompt and Response are objects with typed attributes; a Conversation holds responses; callers never parse a dict envelope

**Risk.** Every surface reads the dict, and some write into it (gateway adds already_sent, queued_terminal_*). Keep `to_dict()` until gateway, tui_gateway, acp and cron move over, and keep extra surface keys in a `surface_meta` dict. Preserve: export_current_turn_boundary stamping on every exit path.

### AGT-06: Test-patch seams shape production: _ra(), 32 lazy forwarders, injected module functions, and 27 late `from run_agent import`

- **severity** high · **effort** L · **kind** restructure · **low-hanging** no · **loc_delta** -250 · **depends on** AGT-01
- **evidence**: `agent/lazy_forward.py:14`, `run_agent.py:151`, `agent/conversation_loop.py:480`, `agent/turn_context.py:1023`, `agent/conversation_loop.py:1585`, `run_agent.py:122`

**Problem (today).** Today siblings reach run_agent through `_ra()` 71 times in 4 files, and 54 of those calls only fetch `_ra().logger` (`rg -o '_ra\(\)\.[A-Za-z_]+'`). Facade forwarders resolve their targets with importlib on every call 'so patch("<module>.<name>") in tests still intercepts' (lazy_forward.py:3). There are 32 on AIAgent plus 16 more in mixins. build_turn_context takes 7 module functions as parameters 'to avoid an import cycle' (turn_context.py:1029). 24 in-scope files late-import run_agent (27 imports). Root AGENTS.md calls this deliberate ('Patch where production reads'; blind repointing broke 130+ tests). My argument against the rule: production pays an importlib lookup per forwarded call, a cycle-hiding injection protocol, and a logger chosen by test convention, all to keep test patch targets stable. The cost lands on every reader of the loop, not only test authors. The gist's 'patch where production reads' AST lint (Phase 2) would enforce the symptom.

**Move (proposed).** Invert it. Each module imports what it uses at module level, and tests patch the defining module. Once AGT-01 gives a typed state, AIAgent's methods become real methods or the module functions are called directly. Delete agent/lazy_forward.py, the 48 forwarders, `_ra()` in its 4 files (each module uses `logging.getLogger(__name__)`), and the 7 injected callables in build_turn_context. Break the remaining cycles by moving shared constants into leaf modules (see AGT-10 for compression). Run it as a campaign: one test directory per PR, A/B red-check each repointed patch. This makes the gist's 'patch where production reads' lint unnecessary for agent/.

**Reference.** httpx `.repos/httpx/httpx/_client.py`: plain module-level imports, collaborators passed as constructor arguments (transport=), tests inject a MockTransport instead of patching module globals

**Risk.** Very high test churn: hundreds of `patch("run_agent.X")` targets must change, and an unchanged one passes silently while intercepting nothing. Requires an A/B (revert, confirm red) pass per file. Import-time cost: _ra() also keeps heavy modules off the run_agent import path, so verify `hermes` startup time before and after.

### AGT-08: The history-to-wire projection is implemented twice and kept byte-identical by comments

- **severity** high · **effort** S · **kind** collapse · **low-hanging** yes · **loc_delta** -60 · **depends on** —
- **evidence**: `agent/turn_request_assembly.py:157`, `agent/turn_request_assembly.py:197`, `agent/chat_completion_helpers.py:2210`, `agent/chat_completion_helpers.py:2274`, `agent/chat_completion_helpers.py:2342`

**Problem (today).** Today assemble_api_request runs: context-engine selection, rejected-thinking suppression, sanitize_api_messages, evict_stale_outbound_tool_images, heal notice, drop_thinking_only_and_merge_users, strip, _canonicalize_api_tool_calls, _sanitize_messages_surrogates (turn_request_assembly.py:140-197). chat_completion_helpers::_iteration_summary_api_messages (:2210-2287) re-runs the same chain by hand. Its comments say why: 'mirroring the main loop's api_messages build', 'Same send-path vision eviction as the main loop', 'Same closing normalization as assemble_api_request so the summary's prefix stays bit-identical to the main loop's'. The two chains already differ: the summary path does not pass drop_codex_reasoning_items or drop_nudge_marker, and it runs an extra underscore-key sweep. If they drift further, the summary call misses the prefix cache. The gist cites 333 cache-loss issues (#104442: 75-85% cache loss).

**Move (proposed).** Extract `project_to_wire(agent, messages, *, system: str, prefill, policy: WirePolicy) -> list[dict]` into `agent/wire_projection.py`. Both callers use it, and the summary path passes its policy differences explicitly. The gist's Phase 5 prompt-prefix stability test then targets one function.

**Reference.** pydantic-ai `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/_agent_graph.py:1313`: ModelRequestNode is the single place a request is prepared from message_history before Model.request; there is no second hand-built request path

**Risk.** The ordering of passes matters for byte-identity: copy the main path's order exactly, and diff wire bytes for both callers on recorded fixtures. The policy differences named above must be preserved as explicit flags, not unified silently.

### AGT-09: The byte-stable system prompt has no owner: _cached_system_prompt is written at 13 sites in 9 files, including gateway and TUI

- **severity** high · **effort** M · **kind** boundary · **low-hanging** yes · **loc_delta** -40 · **depends on** AGT-01
- **evidence**: `agent/conversation_loop.py:745`, `agent/conversation_compression.py:3206`, `agent/chat_completion_helpers.py:1764`, `agent/agent_runtime_helpers.py:2543`, `agent/system_prompt.py:824`, `agent/background_review.py:1037`, `gateway/run.py:511`, `tui_gateway/server.py:1787`

**Problem (today).** Today the prompt-cache invariant (root AGENTS.md: 'system prompt is byte-stable for the life of a conversation; the ONE exception is context compression') depends on `agent._cached_system_prompt`. `rg '_cached_system_prompt\s*='` finds 13 assignments in 9 files: restore-or-build (conversation_loop.py:785/801/849), compression boundary (conversation_compression.py:1705/3206/3210), fallback regex rewrite (chat_completion_helpers.py:1780), switch_model invalidation (agent_runtime_helpers.py:2543), system_prompt invalidation (:824), review fork copy (background_review.py:1037), gateway hygiene seed (gateway/run.py:511), TUI live rebuild (tui_gateway/server.py:1787) and a stub (tui_gateway/synthetic_turn.py:48). Companion flags live beside it: _cached_system_prompt_static, _retain_seeded_system_prompt, _frozen_workspace_snapshot, _auto_load_skills_resolved/_result (agent_init.py:606-617). Each write is individually justified, but no single place can answer 'who may change the prompt, and why'. The gist counts 333 cache-break issues and 44 fix commits.

**Move (proposed).** Add `SystemPromptCache` (agent/system_prompt.py) owning the bytes, the static prefix, the frozen workspace snapshot and the auto-load result. Its methods: `current()`, `seed(stored: str, retain: bool)`, `invalidate(reason: RebuildReason)`, `rebuild(builder)`, `fork()`, `patch_identity(model, provider)`. RebuildReason is an enum {COMPRESSION, MODEL_SWITCH, FALLBACK, SESSION_RESUME, LIVE_TOOLSET_NOW}. Every rebuild then emits record_prompt_rebuild with a reason, and a test can assert that within one conversation only COMPRESSION rebuilds the prompt. gateway/run.py and tui_gateway/server.py call `seed`/`rebuild` instead of assigning the attribute.

**Reference.** pydantic-ai `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/_agent_graph.py:427`: instructions come from one deps callable (get_instructions) evaluated in one place per request, not an attribute assigned from many modules

**Risk.** Each of the 13 sites encodes a real edge case (hygiene must not rebuild without the live environment, routed forks must not inherit, fallback labels are not persisted). Port them one by one as named methods, without merging their behaviour. Preserve: the DB row is created only after the prompt is built (turn_context.py:1029-1031).

### AGT-10: Two compression modules (10.6k lines): keep both, but the engine/host boundary leaks both ways through an import cycle

- **severity** high · **effort** L · **kind** boundary · **low-hanging** no · **loc_delta** -200 · **depends on** —
- **evidence**: `agent/conversation_compression.py:420`, `agent/context_compressor.py:3534`, `agent/conversation_compression.py:1914`, `agent/context_compressor.py:4785`, `agent/conversation_compression.py:2267`, `agent/conversation_compression.py:4088`, `agent/conversation_compression.py:1162`

**Problem (today).** Today context_compressor.py (ContextCompressor, the built-in ContextEngine) never touches agent private state. conversation_compression.py (the host: lease, fence, attempts, commit, rotation) touches it 95 times. But the host also reaches into compressor privates at least 38 times (_compression_attempt_generation, _record_compression_failure_cooldown, _last_summary_error, ...), and it type-checks `isinstance(compressor, ContextCompressor)` and reads `vars(compressor)['_session_db']` (CONV:418-423), so a plugin engine gets degraded behaviour. In the other direction, the engine commits to SessionDB itself (`session_db.archive_and_compact`, CC:3534-3543) and imports host attempt checks (_raise_if_stale_attempt at 4 sites). There are about 30 deferred cross-imports, and the cycle is named at CONV:1914. Five 'real user turn' predicates exist (CC:4785 says the CONV one at :2267 is stronger). The host's main functions take 12-14 parameters (compress_context :4088, run_compress_context_with_progress_timeout :1162, _commit_compaction :3713) even though an `_Attempt` dataclass already exists (CONV:3996). Details: notes/04-compression-survey.md.

**Move (proposed).** Do not merge; one 10.6k-line file would hide the only real seam. Instead: (1) create the leaf module `agent/compaction_messages.py` (user-turn predicate, message text, summary classification, todo/skill markers, _DB_PERSISTED_MARKER). That deletes the cycle and the 30 deferred imports, and the five predicates become one. (2) The engine stops writing SessionDB: prune and commit return a `CompactionOutcome` and the host commits it. (3) The host talks to the engine only through ContextEngine methods plus an explicit `AttemptContext` (cancel check, stale check) passed into compress(), which replaces the attribute side channel. The engine owns rollback of its own cooldown state. (4) Thread one `_Attempt` object through the 12-14-parameter chains. (5) Move image helpers (CC:1458-1660, CONV:4435-4615) and the codex native-compaction path (CONV:4325-4435) out of both files.

**Reference.** inspect_ai `.repos/inspect_ai/src/inspect_ai/agent/_react.py:248`: the loop calls an injected `compact` strategy and `_handle_overflow(state, overflow, compact)`; the strategy returns new messages and never persists or reaches into loop internals

**Risk.** Compression is the sanctioned cache break and carries the lease/fence correctness (sibling-race issues #93057, #38727 cited in background_review.py:913). Every move must keep the commit fence and attempt-generation checks at the same points. About 1,300 lines move rather than delete. Plugin context engines see a widened compress() signature, so add it as an optional kwarg.

### AGT-07: agent_runtime_helpers.py is a 3,776-line grab-bag of at least 9 unrelated topics

- **severity** medium · **effort** S · **kind** restructure · **low-hanging** no · **loc_delta** 0 · **depends on** —
- **evidence**: `agent/agent_runtime_helpers.py:1`, `agent/agent_runtime_helpers.py:168`, `agent/agent_runtime_helpers.py:764`, `agent/agent_runtime_helpers.py:1005`, `agent/agent_runtime_helpers.py:1426`, `agent/agent_runtime_helpers.py:1814`, `agent/agent_runtime_helpers.py:2493`, `agent/agent_runtime_helpers.py:2576`, `agent/agent_runtime_helpers.py:3575`

**Problem (today).** Today its docstring lists the contents as 'Assorted AIAgent runtime helpers': trajectory conversion (:109-196), message-sequence repair (:197-845, :2736-3240), credential-pool recovery (:857-1134), primary-runtime restore (:1135-1540), prompt-cache policy (:1645-1927), OpenAI client construction (:1928-2127), switch_model (:2128-2559), invoke_tool (:2560-2735), httpx socket reaping (:3425-3590, :3736-3776), error-context extraction (:3591-3677), steer injection (:3678-3735). It is the third-largest private-state reader (117 `agent._x`) and has 95 lazy imports (SUMMARY.md). The name tells a reader nothing about what lives there, so new helpers keep landing in it.

**Move (proposed).** Split by topic into named modules and delete the file: `agent/message_repair.py` (repair_message_sequence, sanitize_api_messages and the 12 `_drop_*/_pair_*/_dedupe_*` passes, drop_thinking_only_and_merge_users); `agent/runtime_switch.py` (switch_model, restore_primary_runtime, try_recover_primary_transport; collapses into bind_runtime under AGT-03); `agent/credential_recovery.py`; `agent/prompt_cache_policy.py`; `agent/http_socket_reaper.py`; move invoke_tool into tool_executor (AGT-13); move trajectory conversion next to agent/trajectory.py. No behaviour change.

**Reference.** none applies

**Risk.** Pure moves, but tests patch `agent.agent_runtime_helpers.X`. Repoint them in the same PR, which needs the same A/B check as AGT-06. Update docs that cite the old path.

### AGT-11: Forks and children are made by constructing a full AIAgent and then overwriting its private attributes

- **severity** medium · **effort** M · **kind** restructure · **low-hanging** no · **loc_delta** -150 · **depends on** AGT-01, AGT-03, AGT-09
- **evidence**: `agent/background_review.py:1006`, `agent/background_review.py:1021`, `agent/background_review.py:974`, `tools/delegate_tool.py:291`, `agent/curator.py:1105`, `agent/curator.py:1122`

**Problem (today).** Today build_cache_parity_fork runs the 84-parameter constructor (which loads config, builds a client, loads tools and memory), then assigns about 20 private attributes: _persist_disabled, _session_db=None, session_id, _cached_system_prompt, _inherited_cache_scope, _cached_conversation_root, tools, _tool_snapshot_generation=2**31-1, and others (background_review.py:1006-1063). delegate_tool sets 12 `child._x` (tools/delegate_tool.py:148-444), and curator does the same (curator.py:1105-1127). Each fork must know which internals keep cache parity and persistence isolation. A missed one has caused a real regression: background_review.py:1016-1019 names the 'curator-takeover root cause'. 25 call sites construct AIAgent (`rg 'AIAgent\('`).

**Move (proposed).** Add `AIAgent.fork(spec: ForkSpec) -> AIAgent`, owned by agent/. It copies `runtime` (AGT-03), `prompt.fork()` (AGT-09) and the tool snapshot, and builds detached SessionState and TurnState. ForkSpec holds persist: bool, tools: Frozen | Live, sink: AgentSink | None, max_iterations, write_origin, cache_tag. background_review, /btw, curator and delegate_tool call fork(). No caller writes a private attribute.

**Reference.** pydantic-ai `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/_agent_graph.py:427`: a run is (immutable deps, fresh state); reusing deps with fresh state is the fork, no attribute surgery

**Risk.** The cache-parity rules (same tools[] bytes, same system prompt bytes, inherited cache scope, frozen tool snapshot generation) must move into fork() exactly. Re-measure the review fork's cache-read ratio before and after (#25322 measured about 26% cost).

### AGT-12: Model-call strategies (MoA, codex app-server, api_mode variants) are branched inside the loop instead of chosen once

- **severity** medium · **effort** M · **kind** restructure · **low-hanging** no · **loc_delta** -200 · **depends on** AGT-02, AGT-03
- **evidence**: `agent/moa_loop.py:1472`, `agent/conversation_loop.py:253`, `agent/conversation_loop.py:1622`, `agent/conversation_loop.py:1443`, `agent/turn_request_assembly.py:106`

**Problem (today).** Today MoA is installed as a fake OpenAI client (MoAClient, moa_loop.py:1472) so the loop can treat it as one. The loop still knows about it: 'moa' appears 223 times (case-insensitive, including comments) in 14 loop and helper files, with 45 in turn_request_assembly.py and 35 in conversation_loop.py. _LoopState has three MoA fields (moa_config, pending_moa_prepared_request, _moa_prepared_request). The codex app-server runtime takes over the turn with an inline branch (conversation_loop.py:1622-1634), and loop phases branch on api_mode 41 times (`rg -c 'api_mode ==|!=|in'`). The client impersonation did not keep MoA out of the loop. It only hid the branch point.

**Move (proposed).** Choose a `ModelCaller` per turn in build_turn_context: StandardCaller (transport by api_mode), MoACaller (fan-out plus aggregator), CodexAppServerCaller (whole-turn delegate). The loop calls `caller.prepare(s)` / `caller.request(s)` / `caller.account(s)`. MoA fields move from LoopState into MoACaller, and the fake client goes away. Provider adapter internals stay with seam 05.

**Reference.** pydantic-ai `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/models/__init__.py`: one Model ABC with request()/request_stream(); FallbackModel and other composites are Model implementations, so the graph never branches on model kind

**Risk.** MoA reuses the main loop's cache policy and role-alternation repair (moa_alternation). The aggregator's request must keep the prefix-cache markers it has today. Fallback from codex app-server to the generic loop mid-turn (conversation_loop.py:1631) must keep its accounting.

### AGT-13: Tool handler resolution exists twice, sequential and concurrent, with different precedence orders

- **severity** medium · **effort** S · **kind** collapse · **low-hanging** no · **loc_delta** -80 · **depends on** —
- **evidence**: `agent/tool_executor.py:1648`, `agent/agent_runtime_helpers.py:2576`, `agent/inline_tool_executors.py:293`, `agent/inline_tool_executors.py:299`, `agent/inline_tool_executors.py:236`

**Problem (today).** Today the sequential path resolves a call as inline tools (except delegate_task), then delegate_task, then context-engine tools, then memory-provider tools, then the registry (tool_executor.py:1648-1712). The concurrent path (agent_runtime_helpers.py::invoke_tool, :2576) resolves todo_list/session_search/memory, then memory-provider tools, then the other inline tools (except message_agent), then the registry (inline_tool_executors.py:299-312), and has no context-engine branch. Middleware, pre-tool block and post-hook handling are written separately in each, and comments hold the two in line ('Order is the historical if/elif order of execute_tool_calls_sequential', inline_tool_executors.py:236; INVOKE_TOOL_PRE_MEMORY_MANAGER_NAMES :293). A new tool kind must be added to both, in the right relative position.

**Move (proposed).** Add one `resolve_tool_handler(agent, name) -> ToolHandler` (callable plus display policy plus error mapping), used by both paths, with a single precedence list. Move invoke_tool into tool_executor.py next to the sequential path. Whether context-engine tools can ever be parallel becomes a property of the handler, not of which path ran.

**Reference.** pydantic-ai `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/toolsets/`: a combined toolset resolves a name to one tool regardless of whether calls run sequentially or concurrently

**Risk.** The precedence differences may be load-bearing (memory-provider tools shadowing inline names; message_agent only injected on the sequential schema). Write a parity test over every inline, context-engine and memory tool name before collapsing. Seam 06 owns the registry side.

## Kill list

| target | why | importers/callers | evidence |
|---|---|---|---|
| `agent/conversation_loop.py::_run_phase, _PHASE_PARAMS, _CTX_FIELDS, _LATCHED_VERDICT_FIELDS` | reflection-based state copying replaced by phases taking LoopState (AGT-02) | 1 | agent/conversation_loop.py:1468-1498; only called inside conversation_loop.py |
| `21 *Verdict dataclasses in agent/turn_*.py and their _verdict closures` | mirror loop locals; AGT-02 | 15 | rg -c 'class \w*Verdict' agent/ = 21 in 15 files |
| `agent/lazy_forward.py` | per-call importlib forwarding that exists only to keep test patch targets; AGT-06 | 6 | run_agent.py:151, agent/turn_facade.py, client_lifecycle.py, session_persistence.py, reasoning_params.py, vision_message_prep.py |
| `_ra() defined in agent/conversation_loop.py, agent_runtime_helpers.py, chat_completion_helpers.py, tool_executor.py` | 54 of 71 uses fetch run_agent.logger; AGT-06 | 71 | rg -o '_ra\(\)\.[A-Za-z_]+' agent/*.py |
| `agent/agent_init.py::_CALLBACK_PARAMS and the 22 *_callback params on AIAgent.__init__/init_agent` | replaced by one AgentSink; AGT-04 | 25 | agent/agent_init.py:2376, run_agent.py:278-304; 25 AIAgent( construction sites |
| `run_agent.py::AIAgent.__init__ tool_delay parameter` | documented as 'deprecated: accepted for compatibility, ignored'; no in-scope caller passes it | 0 | run_agent.py:269, rg tool_delay outside tests shows only run_agent.py; 25 test references UNVERIFIED as callers vs assertions |
| `agent/agent_runtime_helpers.py (as a module name)` | grab-bag; split by topic (AGT-07) | — | agent/agent_runtime_helpers.py:1 |
| `agent/moa_loop.py::MoAClient / MoAChatCompletions client impersonation` | replaced by MoACaller strategy (AGT-12) | — | agent/moa_loop.py:1043, 1472, 1536 |

## Simplify list

| what N things | become what 1 thing | lines saved (est.) | evidence |
|---|---|---|---|
| _CONTROL_STATE; _TURN_STATE; _SESSION_STATE; _STREAM_STATE; _USAGE_STATE; per-turn reset block conversation_loop.py:1565-1613 | 5 typed state dataclasses on the agent | 600 | agent/agent_init.py:528-662, 2330 |
| 21 Verdict classes; _run_phase; kwargs-per-phase signatures | phase(agent, s: LoopState) -> Step | 450 | agent/conversation_loop.py:1480; agent/turn_tool_round.py:26-66 |
| ~19 runtime-writing functions; 3 runtime snapshot shapes; ContextCompressor.update_model mirror | RuntimeBinding + bind_runtime() | 350 | scripts/agt_runtime_writers.py output; agent/agent_runtime_helpers.py:2164, 2416; run_agent.py:540 |
| 22 *_callback params x 3 declarations; event_callback; StatusOutputMixin print paths | AgentSink.emit/request | 400 | run_agent.py:278; agent/agent_init.py:2376; tui_gateway/agent_callbacks.py:141 |
| assemble_api_request projection chain; _iteration_summary_api_messages chain | agent/wire_projection.py::project_to_wire | 60 | agent/turn_request_assembly.py:140-197; agent/chat_completion_helpers.py:2210-2287 |
| _resolve_sequential_dispatch; invoke_tool + resolve_invoke_tool_executor | resolve_tool_handler | 80 | agent/tool_executor.py:1648; agent/agent_runtime_helpers.py:2576; agent/inline_tool_executors.py:299 |
| 5 real-user-turn predicates across context_compressor.py and conversation_compression.py | agent/compaction_messages.py::is_real_user_turn | 60 | agent/context_compressor.py:4422, 4498, 4785, 5968; agent/conversation_compression.py:2267 |
| 16 literal turn-result dicts in 11 files | TurnResult constructors | 100 | rg -c '"final_response":' agent/ |

## Reference patterns to copy

| repo | path | pattern | where it applies here |
|---|---|---|---|
| pydantic-ai | `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/_agent_graph.py:341` | GraphAgentState: per-run mutable state as one dataclass | AGT-01 TurnState/LoopState |
| pydantic-ai | `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/_agent_graph.py:427` | GraphAgentDeps: per-run immutable dependencies, incl. model and get_instructions | AGT-03 RuntimeBinding, AGT-09 SystemPromptCache, AGT-11 fork |
| pydantic-ai | `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/_agent_graph.py:2121` | node.run(ctx) returns the next node or End; typed transitions | AGT-02 phase protocol |
| inspect_ai | `.repos/inspect_ai/src/inspect_ai/agent/_react.py:248` | plain while-loop: generate -> overflow handler -> execute_tools -> submission check over one AgentState | AGT-02 (proof that the loop body can stay a readable while-loop), AGT-10 compact strategy |
| inspect_ai | `.repos/inspect_ai/src/inspect_ai/agent/_agent.py:36` | AgentState: messages + output, nothing else | AGT-05 TurnResult |
| textual | `.repos/textual/src/textual/message_pump.py` | typed Message objects through one post_message channel | AGT-04 AgentSink |
| llm | `.repos/llm/llm/models.py` | Prompt/Response/Conversation objects instead of dict envelopes | AGT-05 |
| attrs | `.repos/attrs/src/attr/_make.py` | frozen + evolve for atomic derived values | AGT-03 |
| httpx | `.repos/httpx/httpx/_client.py` | collaborators injected via constructor (transport=), tests use MockTransport not module patching | AGT-06 |

## Answer to the seam question

The loop needs six concepts and five phases. Concepts: TurnRequest (immutable input), RuntimeBinding (which model/provider/client, swapped atomically), SystemPromptCache (the byte-stable prefix with a closed set of rebuild reasons), LoopState (per-turn mutable state: messages, counters, pending flags), AgentSink (typed events out, typed client requests in), and TurnResult (typed output). Phases: prepare-turn, prepare-request (projection plus preflight compaction), call-model (with retry/recovery/fallback), handle-response (tool round or final text with stop gates), finalize. Today's code has the phases: the turn_*.py siblings map onto them, and the while-loop in conversation_loop.py:1636-1681 is already short and readable. It has none of the concepts as types. State is 371 loose attributes on AIAgent plus a 53-field `Any`-typed _LoopState. Transitions are strings copied back by reflection through 21 mirror dataclasses. The runtime is rewritten field by field from 7 files, the system prompt is assigned from 9 files, surfaces plug in through 22 callbacks, and the turn returns a dict. So the distance to pydantic-ai's graph is not the control flow. inspect_ai's react loop shows a plain while-loop is fine. The distance is that nothing is typed or owned. The order that closes it with the least churn: AGT-02 (phase protocol, M), AGT-05 (TurnRequest/TurnResult, S), AGT-03 (RuntimeBinding, M), AGT-08 (one wire projection, S), then AGT-01 one table at a time, AGT-09, AGT-04, and AGT-06 last because it moves the test seams. Invariants: every move keeps the prompt byte-stable, because SystemPromptCache makes COMPRESSION the only rebuild reason inside a conversation and the wire projection becomes one function. Role alternation is unaffected because no move changes what is appended to messages, only who holds the list.

Relation to the ratchet plan (`inputs/gist/0-plan.md`): AGT-02, AGT-07 and AGT-10 remove most of this seam's CC>20 and PLR0913 hits (`finish_text_response` CC 27, `finalize_turn` 278 lines, `compress_context` 235 lines, 21 PLR0913 in conversation_compression.py) by changing the interface, not by extraction. AGT-08 and AGT-09 give the Phase 5 prompt-prefix stability test a single function and a single class to target. AGT-06, if adopted, makes the Phase 2 'patch where production reads' lint unnecessary for agent/.

## Cross-seam notes

- **05-providers** `agent/turn_recovery.py:355`: 41 api_mode branches inside loop phases; provider-specific recovery (codex reasoning replay, anthropic 401 diagnostics, welcome tier) lives in agent/turn_recovery.py
- **05-providers** `agent/chat_completion_helpers.py:2074`: chat_completion_helpers.py (4,122 lines) holds try_activate_fallback, the iteration-summary call and _call_chat_completions (CC 37); half loop, half transport
- **06-tools** `agent/inline_tool_executors.py:237`: INLINE_TOOL_EXECUTORS lets GUI-only tools (read_terminal, drive_preview, tour) reach the client through agent callbacks; tool registry cannot see them
- **06-tools** `agent/AGENTS.md:72`: model_tools._last_resolved_tool_names is a process global saved/restored around subagents
- **10-gateway** `gateway/run.py:511`: gateway seeds the agent's private system prompt directly for hygiene runs
- **13-tui-cron** `tui_gateway/server.py:1787`: TUI rebuilds and persists agent._cached_system_prompt from an RPC thread
- **07-config** `run_agent.py:122`: run_agent.py loads .env at import time and freezes _hermes_home at import (read by agent_init via _ra()._hermes_home)
- **07-config** `agent/agent_init.py:683`: init_agent calls load_config_readonly at least twice per construction (prompt cache config and the main section)
- **09-concurrency** `agent/turn_facade.py:188`: Agent holds 7 locks/Events in _CONTROL_STATE plus stream writer lock/TLS; the turn facade manually sets/resets 3 ContextVar tokens in nested finally blocks instead of an ExitStack
- **14-errors-obs** `run_agent.py:176`: run_agent._quietly swallows every exception in teardown steps; 39 _quietly/_call_engine_hook uses
- **12-cli** `agent/display.py:1`: agent/display.py is CLI presentation (spinners, kawaii faces) imported by the loop's tool executor

## UNVERIFIED

- UNVERIFIED: that the sequential/concurrent precedence difference (AGT-13) never produces a different handler for the same name in practice. Verify with a parity test over all inline, context-engine and memory-provider tool names.
- UNVERIFIED: loc_delta figures are estimates from line spans, not measured diffs.
- UNVERIFIED: whether any external (pip/user) plugin passes *_callback kwargs to AIAgent or reads agent private attributes. In-tree plugins/ has 0 `agent._x` reads. Verify with a plugin catalog grep.
- UNVERIFIED: whether any third-party ContextEngine exists in the wild. plugins/context_engine/ ships only __init__.py.
- UNVERIFIED: the 25 tool_delay references under tests/ were not classified as callers or assertions.
- UNVERIFIED: the startup-time effect of removing lazy_forward/_ra (AGT-06). Verify with `python -X importtime -c 'import run_agent'` before and after.
- UNVERIFIED: the 'moa' count of 223 includes comments and identifiers such as `_moa_*`. It measures coupling surface, not executable branches.
- UNVERIFIED: the compression survey (notes/04-compression-survey.md) was produced by a subagent. I spot-checked CONV:415-425, CC:3532-3545, CONV:1914 and CC:4785-4792; all other line citations in it are the subagent's.
