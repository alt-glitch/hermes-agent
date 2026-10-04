# 05 Model providers, transports, credentials, model metadata

Revision: `origin/main` = `ea81748579`. Reference SHAs: pydantic-ai c68786e, inspect_ai 9f6accd, llm 764dc38, stamina 7836f46, httpx b5addb6, svcs 5d93cbc.

## TL;DR

- There is no Model interface. The main loop picks the wire with api_mode if-ladders (102 compare sites in 28 files); the auxiliary path, Gemini, ACP and MoA pick it by impersonating the OpenAI SDK's .chat.completions.create. Two polymorphism mechanisms for one concept.
- agent/auxiliary_client.py (8,407 lines) is a second provider stack: its own resolver, client factory, client cache, 401 refresh, error predicates, retry, fallback chain and stream accumulator. The main agent's own client construction routes through it (agent_init.py:853). 645 commits touched it in 6 months, 406 of them fix commits.
- Biggest simplification: finish the April/May 2026 transport + ProviderProfile migration. Give ProviderTransport request()/stream(), build every caller (main, aux, fallback, MoA) on one ResolvedRoute -> ModelAPI path, and let built-in providers use the profile hooks that today only out-of-tree plugins use. Roughly -6k to -8k lines.
- Low-hanging fruit: 6 by the contract rule (S/M effort, high severity): PRV-03 typed ResolvedRoute, PRV-04 descriptor/alias collapse, PRV-05 name-keyed tables into profile hooks, PRV-06 one 401 refresh, PRV-07 one error classifier, PRV-08 one retry policy (its full form needs PRV-01). PRV-09 is an S-sized kill of dead state at medium severity.
- Seam answer: 8 wire paths, 4 provider resolvers, 2 OpenAI client factories, 8 retry/fallback loops, 5 provider descriptor types, 7 alias tables, 6+ model catalogs. They collapse to one ModelAPI ABC per wire (5-6 classes), one resolver, one Provider descriptor with hooks, one retry policy and a FallbackModel wrapper, which is the pydantic-ai Provider/Model/ModelProfile split.

## What this area is

Scope: 137 files, 72,039 lines (`wc -l` over the paths below; includes `agent/agent_runtime_helpers.py` 3,777 lines, of which only client construction is this seam). Entry points: `hermes_cli/runtime_provider.py::resolve_runtime_provider` (every surface that starts an agent), `agent/auxiliary_client.py::call_llm` / `async_call_llm` (23 non-test files import `call_llm`, 6 import `async_call_llm`), `providers.get_provider_profile` (43 call sites), `hermes model` / `/model` (`hermes_cli/model_switch.py`), `hermes auth` (`hermes_cli/auth_commands.py`).

Paths: `agent/auxiliary_client.py`, `agent/auxiliary_*.py`, `agent/aux_accounting.py`, `agent/chat_completion_helpers*.py`, `agent/codex_*.py`, `agent/bedrock_adapter.py`, `agent/anthropic_*.py`, `agent/gemini_*.py`, `agent/transports/`, `agent/relay_runtime.py`, `agent/relay_llm.py`, `agent/client_lifecycle.py`, `agent/credential_pool*.py`, `agent/model_metadata*.py`, `agent/models_dev.py`, `agent/error_classifier.py`, `agent/secret_sources/`, `agent/proxy_sources/`, `agent/usage_pricing.py`, `agent/copilot_acp_client.py`, `agent/vertex_adapter.py`, `agent/azure_identity_adapter.py`, `agent/agent_runtime_helpers.py (client construction part)`, `providers/`, `plugins/model-providers/`, `hermes_cli/models*.py`, `hermes_cli/model_switch*.py`, `hermes_cli/auth*.py`, `hermes_cli/runtime_provider*.py`, `hermes_cli/providers.py`, `hermes_cli/model_normalize.py`, `hermes_cli/codex_models.py`

| module | lines | owns |
|---|---|---|
| `agent/auxiliary_client.py` | 8,407 | side-LLM calls (compression, titles, vision, curator, MoA slots): provider resolution, client construction + cache, OpenAI-shaped adapters for Codex/Anthropic/Bedrock, retry, recovery ladder, fallback chains. Also the resolver the main agent uses at init (resolve_provider_client). |
| `agent/chat_completion_helpers.py` | 4,122 | main-loop wire calls: api_mode dispatch for kwargs build, non-streaming and streaming calls, stream retry, stale-stream watchdogs, fallback activation (try_activate_fallback). |
| `agent/transports/` | 3,592 | ProviderTransport ABC (convert_messages, convert_tools, build_kwargs, normalize_response) + registry keyed by api_mode; 4 registered transports; codex app-server subprocess session. Transports do not send requests. |
| `providers/ (+ plugins/model-providers/, 39 profiles, 2,244 lines)` | 1,064 | ProviderProfile dataclass (declarative fields + ~19 hooks) and lazy, profile-scoped discovery of profile plugins. |
| `hermes_cli/runtime_provider.py (+ _custom, _backends)` | 2,000 | resolve_runtime_provider: 9-rung ladder from requested provider to a runtime dict (provider, api_mode, base_url, api_key, source). 36 call sites. |
| `hermes_cli/auth.py (+ 17 auth_* siblings)` | 10,447 | PROVIDER_REGISTRY (ProviderConfig rows), resolve_provider, OAuth/device-code/PKCE flows and per-provider credential resolvers (nous, codex, xai, qwen, minimax, copilot). |
| `agent/credential_pool.py (+ 3 siblings)` | 3,474 | PooledCredential rows per provider: seeding from env/singleton stores, selection, leases, cooldowns, per-provider OAuth refresh and write-back. |
| `agent/model_metadata.py + agent/models_dev.py` | 3,703 | context length / capability lookup: 13-step ladder over user override, endpoint cache, profile, persistent cache, Bedrock, live /models, Anthropic API, models.dev, OpenRouter, local server, hardcoded defaults. |
| `hermes_cli/models.py (+ models_catalog_static, pricing, validate, local, reasoning_caps)` | 6,100 | picker catalogs: static _PROVIDER_MODELS, CANONICAL_PROVIDERS labels, per-provider live catalog fetchers, pricing fetchers, model validation. |
| `hermes_cli/model_switch.py (+ model_switch_providers)` | 3,232 | /model pipeline: flag parse, alias resolution via hermes_cli.providers, provider resolution, credential resolution, metadata lookup. |
| `agent/error_classifier.py` | 1,495 | classify_api_error -> ClassifiedError(FailoverReason) for the main loop; consulted by profile and plugin hooks. |

Counts used below (all `-g '!tests/**'`, in-scope dirs):

- api_mode literal comparisons: 102 sites in 28 files (`rg -n 'api_mode\s*(==|!=|in)\s'`). Literals: anthropic_messages 59, codex_responses 33, chat_completions 31, bedrock_converse 9, codex_app_server 5.
- provider-name literal comparisons: 348 (`rg -n 'provider[a-z_]*\s*(==|!=)\s*"..."'` plus `in (...)` form). Most compared: nous 42, anthropic 36, custom 31, auto 26, moa 23, openai-codex 19, openrouter 18.
- host-sniffing: 97 `base_url_host_matches(` calls in agent/, hermes_cli/, providers/, plugins/model-providers/.
- `OpenAI(`/`AsyncOpenAI(` constructions: 3 in auxiliary_client.py, 1 in agent_runtime_helpers.py (plus non-chat uses in tools/plugins).
- Churn since 2026-04-04 (path-only `git log`): auxiliary_client.py 645 commits / 406 `fix`; chat_completion_helpers.py 448/282; hermes_cli/models.py 508/225; hermes_cli/auth.py 394/225; model_metadata.py 346/185; model_switch.py 255/167; runtime_provider.py 201/126; credential_pool.py 185/139; error_classifier.py 145/116.

## How it works end to end

### User starts hermes chat and sends a prompt; the main model answers

Trigger: hermes chat, first prompt.

Inputs that change the path: `explicit_creds` (bool, default `True`): resolve_runtime_provider returned both api_key and base_url; `api_mode` (enum, default `chat_completions`): chat_completions | anthropic_messages | codex_responses | bedrock_converse | codex_app_server; `streaming` (bool, default `True`): display wants token streaming; `status_401` (bool, default `False`): provider rejects the credential

1. `hermes_cli/cli_agent_setup_mixin.py::_ensure_runtime_credentials` (`hermes_cli/cli_agent_setup_mixin.py:247`): calls resolve_runtime_provider to get the runtime dict — **PRV-03**
2. `hermes_cli/runtime_provider.py::resolve_runtime_provider` (`hermes_cli/runtime_provider.py:982`): walks the 9-rung ladder (shortcuts, named custom, local bypass, auth.resolve_provider, pool, OAuth specs, registry, OpenRouter fallback) and returns Dict[str, Any] — **PRV-03**
3. `hermes_cli/cli_agent_setup_mixin.py::_init_agent` (`hermes_cli/cli_agent_setup_mixin.py:666`): constructs AIAgent with provider/model/api_mode/base_url/api_key from the dict
4. `agent/agent_init.py::_init_openai_client` (`agent/agent_init.py:986`): chooses explicit kwargs or the routed path
5. `agent/agent_init.py::_routed_client_kwargs` (`agent/agent_init.py:853`) *(when `explicit_creds` = `False`)*: asks the AUXILIARY resolver for a client, then scrapes api_key/base_url/_custom_headers back off it (_client_kwargs_from_routed, agent_init.py:1075) — **PRV-02**
6. `agent/agent_runtime_helpers.py::create_openai_client` (`agent/agent_runtime_helpers.py:2015`): main OpenAI client factory: profile create_client hook, Gemini native facade by name set, keepalive transport, max_retries=0 — **PRV-02**
7. `agent/chat_completion_helpers.py::_build_api_kwargs_for_mode` (`agent/chat_completion_helpers.py:1555`): if-ladder on api_mode picks the kwargs builder (anthropic, bedrock, codex, chat) — **PRV-01**
8. `agent/chat_completion_helpers.py::_build_chat_completions_kwargs` (`agent/chat_completion_helpers.py:1470`) *(when `api_mode` = `chat_completions`)*: host-sniffs qwen/openrouter/github/lmstudio, imports _fixed_temperature_for_model from auxiliary_client, then calls the transport's build_kwargs (profile path or legacy flag path) — **PRV-05**
9. `agent/turn_api_call.py::_perform_api_call` (`agent/turn_api_call.py:90`): Codex preflight by api_mode, then streaming or relay_llm.execute non-streaming — **PRV-01**
10. `agent/chat_completion_helpers.py::interruptible_streaming_api_call` (`agent/chat_completion_helpers.py:4105`) *(when `streaming` = `True`)*: if-ladder on api_mode: codex passthrough, _BedrockStream, else _StreamingCall — **PRV-01**
11. `agent/chat_completion_helpers.py::_StreamingCall._call_wire` (`agent/chat_completion_helpers.py:3843`) *(when `streaming` = `True`)*: third api_mode branch: anthropic per-request client vs chat.completions stream — **PRV-01**
12. `agent/chat_completion_helpers.py::_StreamingCall._call` (`agent/chat_completion_helpers.py:3851`) *(when `streaming` = `True`)*: stream retry loop, budget from HERMES_STREAM_RETRIES env var (default 2) — **PRV-08**
13. `agent/turn_recovery.py::_refresh_credentials_after_401` (`agent/turn_recovery.py:391`) *(when `status_401` = `True`)*: 5-branch provider/api_mode ladder calls agent._try_refresh_<provider>_client_credentials and retries once — **PRV-06**
14. `agent/conversation_loop.py::_run_api_retry_loop` (`agent/conversation_loop.py:1506`): outer retry loop (agent.api_max_retries), then try_activate_fallback which again calls auxiliary resolve_provider_client — **PRV-08**

### After the first reply, Hermes generates a session title on the auxiliary model

Trigger: agent/title_generator.py calls call_llm(task='title_generation').

Inputs that change the path: `aux_provider` (string, default `auto`): auxiliary.title_generation.provider in config.yaml; `wire` (enum, default `chat_completions`): the resolved route's api_mode; `first_attempt_fails` (bool, default `False`): provider call raises

1. `agent/title_generator.py::generate_title` (`agent/title_generator.py:514`): calls call_llm with the title task
2. `agent/auxiliary_client.py::_prepare_aux_request` (`agent/auxiliary_client.py:7490`): reads task config (_resolve_task_provider_model) and resolves the client
3. `agent/auxiliary_client.py::_resolve_call_client` (`agent/auxiliary_client.py:7422`): vision chain or cached text client; explicit provider without creds walks the task fallback chain — **PRV-02**
4. `agent/auxiliary_client.py::_get_cached_client` (`agent/auxiliary_client.py:6043`): aux-private client cache keyed by provider/model/base_url/api_mode — **PRV-02**
5. `agent/auxiliary_client.py::resolve_provider_client` (`agent/auxiliary_client.py:5451`): aux resolver: 6-entry _EXPLICIT_PROVIDER_BRANCHES dict, then named custom, azure-foundry, PROVIDER_REGISTRY — **PRV-03**
6. `agent/auxiliary_client.py::_resolve_auto_route` (`agent/auxiliary_client.py:4693`) *(when `aux_provider` = `auto`)*: main provider route, configured fallback chains, then OpenRouter -> Nous -> custom -> Codex -> API-key discovery — **PRV-03**
7. `agent/auxiliary_client.py::_wrap_transport` (`agent/auxiliary_client.py:4950`) *(when `wire` = `codex_responses`)*: wraps the OpenAI client in an OpenAI-shaped facade for Codex Responses or Anthropic Messages — **PRV-01**
8. `agent/auxiliary_client.py::_call_llm_impl` (`agent/auxiliary_client.py:8169`): _primary(): _relay_sync_completion -> _create_with_progress -> client.chat.completions.create, then _validate_llm_response
9. `agent/auxiliary_client.py::_relay_sync_completion` (`agent/auxiliary_client.py:2650`): every physical attempt; emits pre/post_auxiliary_call hooks and the relay scope
10. `agent/auxiliary_client.py::_call_llm_impl (transient retry)` (`agent/auxiliary_client.py:8236`) *(when `first_attempt_fails` = `True`)*: same-provider transient retry with its own exponential backoff (auxiliary.transient_retries) — **PRV-08**
11. `agent/auxiliary_client.py::_is_payment_error (and 16 sibling predicates)` (`agent/auxiliary_client.py:3272`) *(when `first_attempt_fails` = `True`)*: aux-private error predicates decide retry vs fallback; classify_api_error is used only for the telemetry label — **PRV-07**
12. `agent/auxiliary_client.py::_drive_ladder` (`agent/auxiliary_client.py:7992`) *(when `first_attempt_fails` = `True`)*: recovery ladder: parameter rungs, _retry_same_provider_sync (with _refresh_provider_credentials), _call_fallback_candidate_sync — **PRV-08**

## Findings

### PRV-01 — No Model interface: the wire is chosen by api_mode if-ladders on the main path and by OpenAI-SDK impersonation everywhere else

- severity: **critical** · effort: **L** · kind: `restructure` · low_hanging: **false** · loc_delta: -2500 · depends_on: —
- evidence: `agent/transports/base.py:12`, `agent/chat_completion_helpers.py:761`, `agent/chat_completion_helpers.py:1555`, `agent/chat_completion_helpers.py:3843`, `agent/chat_completion_helpers.py:4105`, `agent/turn_api_call.py:90`, `agent/auxiliary_client.py:1418`, `agent/auxiliary_client.py:1644`, `agent/auxiliary_client.py:1724`, `agent/auxiliary_client.py:1858`, `agent/gemini_native_adapter.py:808`, `agent/copilot_acp_client.py:278`, `agent/moa_loop.py:1472`, `agent/relay_llm.py:30`, `agent/transports/__init__.py:44`

**Problem (today).** Today ProviderTransport (agent/transports/base.py:12) converts messages, builds kwargs and normalizes responses, but never sends a request. Sending is done twice, in two incompatible styles. (1) The main loop branches on the api_mode string: _dispatch_nonstreaming_api_request (chat_completion_helpers.py:761), _build_api_kwargs_for_mode (:1555), interruptible_streaming_api_call (:4105), _StreamingCall._call_wire (:3843), turn_api_call._perform_api_call (turn_api_call.py:90). rg counts 102 `api_mode ==/!=/in` comparisons in 28 files (`rg -n 'api_mode\s*(==|!=|in)\s' -g '!tests/**' agent hermes_cli providers plugins run_agent.py gateway tui_gateway cron`). (2) The auxiliary path, Gemini native, Copilot ACP and MoA make a non-OpenAI wire look like `client.chat.completions.create(**kwargs)`: _CodexCompletionsAdapter (auxiliary_client.py:1418, 224 lines plus the 229-line _CodexStreamGuard), _AnthropicCompletionsAdapter (:1724), _BedrockCompletionsAdapter (:1858), each with a 2-line async subclass, GeminiNativeClient (gemini_native_adapter.py:808), CopilotACPClient (copilot_acp_client.py:278), MoAClient (moa_loop.py:1472). relay_llm keeps a third api_mode table (relay_llm.py:30). registered_api_modes' docstring (transports/__init__.py:44-50) records that a plugin-registered api_mode was silently rewritten to chat_completions because the gates elsewhere are closed literals. Cost: every wire change is made in two styles; the aux Codex adapter once had a private message converter that leaked role=tool into Responses input (issue #5709, comment at auxiliary_client.py:1426-1433); adding a wire means editing every ladder.

**Move (proposed).** Proposed. Extend ProviderTransport into a ModelAPI ABC that owns the call: `request(prepared) -> NormalizedResponse` and `stream(prepared, on_delta) -> NormalizedResponse`, plus the existing convert/build/normalize hooks. One class per wire: ChatCompletionsAPI, AnthropicMessagesAPI, CodexResponsesAPI, BedrockConverseAPI, GeminiNativeAPI; CodexAppServer and ACP stay plugin-supplied through ProviderProfile.create_client returning a ModelAPI. The main loop calls `agent.model_api.stream(...)`; the aux path calls `model_api.request(...)`. Delete _dispatch_nonstreaming_api_request's ladder, the api_mode branches in interruptible_streaming_api_call/_call_wire/_build_api_kwargs_for_mode, the aux facade classes (_ChatShim, _AsyncCompletionsAdapter, _AsyncAuxiliaryClientBase, 3 adapter + 6 client classes, ~850 lines) and relay_llm's api_mode table (the Relay codec becomes a ModelAPI attribute). This deliberately overrides the rule in commit 731f4fbae6 / providers/base.py:7-9 that 'client lifecycle, streaming, auth stay on AIAgent': that rule is why the wire is dispatched in two places.

**Reference.** pydantic-ai `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/models/__init__.py:454`: Model ABC with request() at :633 and request_stream() at :670; one subclass per wire (OpenAIChatModel models/openai.py:964, OpenAIResponsesModel :2006, AnthropicModel, BedrockConverseModel, GoogleModel); InstrumentedModel (models/instrumented.py:333) wraps any Model for tracing the way relay_llm wraps calls.

**Risk.** Streaming watchdogs, interrupt/abort semantics (request-local clients registered with abort machinery, #67142), the cron/subagent inline path (should_use_direct_api_call) and the MoA facade's prepare() contract must survive. Many tests patch agent._anthropic_messages_create / _run_codex_stream on AIAgent; those seams move. Prompt-cache bytes must be identical before and after (kwargs builders move, they do not change).

### PRV-02 — auxiliary_client.py is a second provider stack (8.4k lines), and the main agent's client construction routes through it

- severity: **critical** · effort: **L** · kind: `collapse` · low_hanging: **false** · loc_delta: -5000 · depends_on: PRV-01, PRV-03
- evidence: `agent/auxiliary_client.py:181`, `agent/agent_runtime_helpers.py:2015`, `agent/agent_init.py:853`, `agent/agent_init.py:1075`, `agent/chat_completion_helpers.py:2097`, `agent/chat_completion_helpers.py:1484`, `agent/client_lifecycle.py:946`, `agent/auxiliary_client.py:6043`, `agent/auxiliary_client.py:7222`, `agent/chat_completion_helpers.py:2789`, `agent/chat_completion_helpers_relay.py:31`, `agent/agent_runtime_helpers.py:2101`, `agent/auxiliary_client.py:187`

**Problem (today).** Today auxiliary_client.py is 8,407 lines and 354 top-level defs (AST census, notes/05-providers-aux-anatomy.md). 44% of it (~3,700 lines) is provider/credential resolution, ~1,600 is retry/recovery, ~1,800 is wire adaptation. Each of these exists again on the main path: two OpenAI client factories (auxiliary_client.py:181 vs agent_runtime_helpers.py:2015) with different header, keepalive and retry policy; two client caches (aux _get_cached_client :6043 vs client_lifecycle request-client slots); two 401 refresh dispatchers (PRV-06); two error classifiers (PRV-07); two fallback chains (aux :4417 vs chat_completion_helpers.py:2074); three stream accumulators (aux :7222, chat_completion_helpers.py:2789, chat_completion_helpers_relay.py:31). The direction of dependency is inverted: the main agent imports from the side path for client construction (agent_init.py:853 builds an OpenAI client via resolve_provider_client, then _client_kwargs_from_routed at :1075 reads api_key, base_url and the SDK-private _custom_headers back off it to construct a second client), for fallback (chat_completion_helpers.py:2097), for temperature (chat_completion_helpers.py:1484 imports _fixed_temperature_for_model) and for headers (client_lifecycle.py:946). 43 of the 61 names other modules import from it are underscore-private. The two factories' comments contradict each other: agent_runtime_helpers.py:2101 says 'auxiliary_client keeps SDK retries'; auxiliary_client.py:187-195 sets max_retries=0. Churn: 645 commits touched the file since 2026-04-04, 406 subject lines start with 'fix' (`git log --oneline --since=2026-04-04 -- agent/auxiliary_client.py`); 183 repo-wide commits are `fix(aux...)`.

**Move (proposed).** Proposed. After PRV-01 and PRV-03, auxiliary_client.py keeps only what is specific to side tasks: per-task config (auxiliary.<task>.*, today group O, ~430 lines), task-level fallback policy expressed as a FallbackModel over ModelAPIs, interrupt protection and progress hooks, and response validation for aux tasks. Resolution moves to the single resolver (PRV-03), construction to ModelAPI (PRV-01), caching to one ClientPool keyed by ResolvedRoute (used by both paths), refresh to PRV-06, classification to PRV-07, retry to PRV-08. agent_init calls the resolver directly; _client_kwargs_from_routed is deleted. Target: auxiliary_client.py plus siblings under ~2,000 lines.

**Reference.** pydantic-ai `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/models/fallback.py:90`: FallbackModel is itself a Model wrapping an ordered list of Models with a typed fallback_on condition; side tasks and the main agent use the same Model objects.

**Risk.** Aux behaviour that main does not have must be kept on purpose: max_retries=0 + same-provider transient retry, interrupt protection for atomic tasks (compression), the 'auto' route that follows the live main runtime per context (set_runtime_main contextvar), vision backend selection, Nous free-tier pinning, pre/post_auxiliary_call hooks that must not fire main-loop pre/post_api_request (#79733). ~59 importing files, many tests patch aux privates.

### PRV-03 — Four provider resolvers returning three different shapes; the runtime is an untyped Dict[str, Any]

- severity: **high** · effort: **M** · kind: `collapse` · low_hanging: **true** · loc_delta: -1200 · depends_on: —
- evidence: `hermes_cli/runtime_provider.py:982`, `agent/auxiliary_client.py:5441`, `agent/auxiliary_client.py:5451`, `agent/auxiliary_client.py:4693`, `hermes_cli/providers.py:533`, `hermes_cli/model_switch.py:357`, `hermes_cli/auth.py:1633`, `agent/agent_init.py:853`

**Problem (today).** Today the question 'which endpoint, credential and wire serve provider P, model M' has four answers. resolve_runtime_provider (runtime_provider.py:982) walks a 9-rung ladder and returns Dict[str, Any]; 36 non-test call sites in 26 files. resolve_provider_client (auxiliary_client.py:5451) has its own branch table (_EXPLICIT_PROVIDER_BRANCHES :5441: auto, openrouter, nous, openai-codex, xai-oauth, custom) then named custom, azure-foundry and PROVIDER_REGISTRY, plus the auto chain (_resolve_auto_route :4693), and returns (client, model); it calls resolve_runtime_provider only for custom and fallback destinations (notes/05-providers-aux-anatomy.md). resolve_provider_full (providers.py:533) resolves for /model through hermes_cli.providers aliases. resolve_startup_model_route (model_switch.py:357) is a fourth entry. Both main ladders call the same leaf credential resolvers in hermes_cli.auth, so the duplication is the ordering and policy, which is where they drift (e.g. runtime_provider.py:1002 comment: 'Same alias expansion the auxiliary client applies, so provider: openai means one thing on every path'). Count: `rg -n 'resolve_runtime_provider\(' -g '!tests/**'` and `rg -n 'resolve_provider_client\('`.

**Move (proposed).** Proposed. One `resolve_route(RouteRequest) -> ResolvedRoute` in hermes_cli/runtime_provider.py. ResolvedRoute is a frozen dataclass: provider_id, model, base_url, api_mode (typed), credential (a handle from the pool, not a raw string), source, requested_provider. The aux auto chain becomes a list of RouteRequests fed to the same function. /model and startup route call it with allow_network flags. resolve_provider_client's branch table and _resolve_*_branch functions (auxiliary_client.py group K, ~830 lines) are deleted; aux wraps the route in a ModelAPI (PRV-01). The Dict[str, Any] runtime dict and its 36 readers move to attribute access.

**Reference.** pydantic-ai `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/models/__init__.py:1746`: infer_model(name, provider_factory=infer_provider) resolves a string to one Model built from one Provider (providers/__init__.py:304); every caller gets the same typed object.

**Risk.** Ladder order is behaviour (runtime_provider.py:984-996 docstring). The codex_app_server overlay must stay applied once after the ladder (#115169). The 'auto' route semantics differ on purpose between main and aux (aux auto follows the live main runtime); keep that as a RouteRequest field, not a second resolver. Requires an A->B->A profile E2E per root AGENTS.md.

### PRV-04 — Provider identity is declared in five descriptor types and seven alias tables that disagree

- severity: **high** · effort: **M** · kind: `collapse` · low_hanging: **true** · loc_delta: -800 · depends_on: —
- evidence: `providers/base.py:42`, `hermes_cli/auth.py:149`, `hermes_cli/auth.py:173`, `hermes_cli/providers.py:17`, `hermes_cli/providers.py:115`, `hermes_cli/providers.py:156`, `hermes_cli/models_catalog_static.py:324`, `hermes_cli/models_catalog_static.py:483`, `hermes_cli/auth.py:1448`, `agent/models_dev.py:110`, `agent/auxiliary_client.py:534`, `agent/auxiliary_client.py:6621`, `agent/usage_pricing.py:380`, `providers/__init__.py:97`, `plugins/model-providers/README.md:60`, `plugins/model-providers/deepseek/__init__.py:49`, `hermes_cli/auth.py:225`, `agent/model_metadata.py:449`

**Problem (today).** Today a provider is described by: ProviderProfile (providers/base.py:42, 39 plugin dirs), ProviderConfig rows in PROVIDER_REGISTRY (auth.py:149, rows :173-252, with base_url, env vars, auth_type), HermesOverlay/ProviderDef (providers.py:17, :98, with its own transport vocabulary 'openai_chat' mapped by TRANSPORT_TO_API_MODE :156), ProviderEntry in CANONICAL_PROVIDERS (models_catalog_static.py:318/324, label and description again), and PROVIDER_TO_MODELS_DEV (models_dev.py:110). Alias tables: auth._PROVIDER_ALIASES (auth.py:1448), models_catalog_static._PROVIDER_ALIASES (:483), providers._ALIAS_GROUPS/ALIASES (providers.py:115-139), ProviderProfile.aliases, aux _LOCAL_SERVER_ALIASES (auxiliary_client.py:534), _GEMINI_NATIVE_PROVIDER_NAMES (:6621), usage_pricing._SNAPSHOT_PROVIDER_ALIASES (usage_pricing.py:380). They disagree: providers.py maps 'openai' to 'openrouter' and 'kimi' to 'kimi-for-coding'; auth.py maps 'kimi' to 'kimi-coding'; runtime_provider expands 'openai' to custom + OpenAI endpoint (runtime_provider_custom.py:467). DeepSeek's base URL is written in the profile (deepseek/__init__.py:49), the auth row (auth.py:225) and the host table (model_metadata.py:449), and its host again in proxy_sources/iron_proxy.py:50, billing_links.py:49 and message_sanitization.py:637. The README promise 'Nothing else needs to change' (plugins/model-providers/README.md:60) is false. The duplicate snapshots need a sys.modules mirror to stay in sync with late plugin registration (providers/__init__.py:97, bug #102123).

**Move (proposed).** Proposed. ProviderProfile is the only descriptor. Move every built-in ProviderConfig row's fields into its profile (auth_type, portal/client_id/scope for OAuth rows go into a typed OAuthSpec field). PROVIDER_REGISTRY, CANONICAL_PROVIDERS, HERMES_OVERLAYS, ALIASES and _URL_TO_PROVIDER become functions over list_providers() (or are deleted where a caller can ask the profile). One alias namespace: Hermes provider ids; the models.dev id is a profile field (models_dev_id). Delete _sync_auth_registry, sync_plugin_provider_registry, sync_plugin_provider_catalog, TRANSPORT_TO_API_MODE and HermesOverlay.transport.

**Reference.** inspect_ai `.repos/inspect_ai/src/inspect_ai/model/_providers/providers.py:34`: @modelapi(name=...) registers one entry per provider (registry in model/_registry.py:30); there is no second table of provider names, labels or aliases.

**Risk.** Resolution order of api_key rows is behaviour (auth.py:170-172 'resolve_provider() scans api_key rows in this order'): the profile list needs an explicit priority. models.dev ids differ from Hermes ids on purpose for catalog lookups; keep the mapping as data on the profile. The alias conflicts are user-visible; picking one canonical answer changes routing for 'openai' and 'kimi' on some path, which needs a release note.

### PRV-05 — Built-in providers bypass the ProviderProfile hooks: per-provider behaviour lives in core name-keyed tables and 348 provider-name literal comparisons

- severity: **high** · effort: **M** · kind: `restructure` · low_hanging: **true** · loc_delta: -1500 · depends_on: PRV-04
- evidence: `hermes_cli/models.py:1546`, `hermes_cli/models_pricing.py:633`, `agent/auxiliary_client.py:3909`, `agent/auxiliary_client.py:819`, `agent/auxiliary_client.py:847`, `agent/usage_pricing.py:457`, `providers/base.py:74`, `providers/base.py:257`, `providers/base.py:261`, `agent/transports/chat_completions.py:486`, `agent/chat_completion_helpers.py:1475`, `agent/credential_pool.py:1`

**Problem (today).** Today ProviderProfile already has hooks for model listing (fetch_models), usage cost (get_usage_cost), context length (get_model_context_length), credential refresh (refresh_credential), error classification (classify_api_error), auth commands (auth_handler), aux and vision defaults. Out-of-tree plugins use them (hermes_cli/auth_oauth_pkce_plugin.py:8). Built-ins mostly do not: in plugins/model-providers/ there are 0 overrides of get_model_context_length, get_usage_cost, refresh_credential, classify_api_error, auth_handler (`rg -l` per hook name). Instead core keeps name-keyed tables: _PROVIDER_CATALOG_FETCHERS (models.py:1546, 16 providers), _PRICING_FETCHERS (models_pricing.py:633, 6), _CREDENTIAL_REFRESHERS (auxiliary_client.py:3909, 6), _API_KEY_PROVIDER_AUX_MODELS_FALLBACK (:819) beside ProviderProfile.default_aux_model, _PROVIDER_VISION_MODELS (:847) beside default_vision_model, _MODEL_NORMALIZERS (usage_pricing.py:457). The chat_completions transport still has a legacy flag path (is_kimi, is_lmstudio, chat_completions.py:486-557) beside the profile path, and the main kwargs builder host-sniffs qwen/openrouter/github/lmstudio (chat_completion_helpers.py:1475-1479). Provider identity is tested by name literal 348 times in in-scope code (`rg -n 'provider[a-z_]*\s*(==|!=)\s*"[a-z0-9.-]+"|provider[a-z_]*\s+(not )?in\s*[\(\{\[]\s*"[a-z]'`; top: credential_pool.py 40, auxiliary_client.py 40, runtime_provider.py 33; a few hits are TTS/STT providers) and by host match 97 times (`rg -n 'base_url_host_matches\('`). Cost: adding or changing a built-in provider edits core tables; plugin providers get a different (hook) path that the built-ins never exercise.

**Move (proposed).** Proposed. Built-ins use the hooks they define. Move each entry of _PROVIDER_CATALOG_FETCHERS, _PRICING_FETCHERS, _CREDENTIAL_REFRESHERS, the aux/vision default dicts and the Bedrock/Anthropic/Codex steps of get_model_context_length into the matching plugins/model-providers/<name>/__init__.py override; delete the tables. Replace name-literal and host-sniff checks with declared profile capabilities (e.g. requires_stream, supports_prompt_cache_key already exists at providers/base.py:98). Delete the legacy flag path in ChatCompletionsTransport.build_kwargs once lmstudio and tencent-tokenhub have profiles (commit 20a4f79ed1 left them on the legacy path).

**Reference.** llm `.repos/llm/llm/default_plugins/openai_models.py:40`: the built-in OpenAI models register through the same register_models hook (llm/hookspecs.py:13) as third-party plugins; core has no per-provider tables.

**Risk.** Profile hooks run on hot paths and must not do I/O on first call (providers/base.py:302-304 contract). Import cycles: profile modules importing hermes_cli catalog helpers is the reason some tables stayed in core (plugin discovery runs while hermes_cli.config/auth import, plugins/AGENTS.md:101). Tests that monkeypatch the core dicts move to the profiles.

### PRV-06 — 401 credential refresh is dispatched three times for the same six providers

- severity: **high** · effort: **M** · kind: `collapse` · low_hanging: **true** · loc_delta: -500 · depends_on: PRV-01, PRV-05
- evidence: `agent/auxiliary_client.py:3851`, `agent/auxiliary_client.py:3909`, `agent/turn_recovery.py:391`, `agent/client_lifecycle.py:570`, `agent/client_lifecycle.py:607`, `agent/client_lifecycle.py:788`, `agent/client_lifecycle.py:813`, `agent/client_lifecycle.py:877`, `agent/turn_retry_state.py:18`, `providers/base.py:75`

**Problem (today).** Today a 401 on the main path goes through _refresh_credentials_after_401 (turn_recovery.py:391), a 5-branch ladder keyed on provider and api_mode, which calls six AIAgent methods _try_refresh_{codex,nous,env,vertex,copilot,anthropic}_client_credentials (client_lifecycle.py:570-877) and sets one boolean per provider on TurnRetryState (turn_retry_state.py:18-30). A 401 on the aux path goes through _CREDENTIAL_REFRESHERS (auxiliary_client.py:3909) and six _refresh_*_credentials functions (:3851-3906), one of which says it 'mirrors run_agent's Vertex refresh' (:3901). The credential pool has its own per-provider refresh (credential_pool.py _refresh_anthropic, _refresh_entry_impl, _sync_nous_entry_from_auth_store). Plugin providers use a fourth route, ProviderProfile.refresh_credential (providers/base.py:75), consumed by agent/credential_pool_plugin.py. All of them end in the same hermes_cli.auth / copilot_auth / anthropic_credentials leaves.

**Move (proposed).** Proposed. The credential pool owns refresh: `CredentialPool.refresh(entry, reason='401') -> PooledCredential | None`, which dispatches to profile.refresh_credential (built-ins gain one override each). The ModelAPI from PRV-01 retries once on 401 after calling it, for every caller. Delete the aux refresher table, the six client_lifecycle methods, the turn_recovery ladder and the five per-provider flags (one `auth_retry_attempted` remains).

**Reference.** httpx `.repos/httpx/httpx/_auth.py:38`: an Auth flow object owns 'send, see 401, refresh, resend' (auth_flow generator) so the client and every caller share it.

**Risk.** Anthropic refresh must not spend an ambient Claude Code login's rotation for another request's key (auxiliary_client.py:3880-3883); Nous paid-entitlement refresh (turn_recovery.py:104) and the user-facing 401 diagnostics (_print_nous_401_diagnostics) must stay. Single-use refresh tokens need the pool's lock (credential_pool _claude_code_credentials_lock).

### PRV-07 — Two error classifiers: aux decides with 17 private predicates and logs with classify_api_error

- severity: **high** · effort: **S** · kind: `collapse` · low_hanging: **true** · loc_delta: -300 · depends_on: —
- evidence: `agent/error_classifier.py:965`, `agent/auxiliary_client.py:27`, `agent/auxiliary_client.py:3254`, `agent/auxiliary_client.py:3272`, `agent/auxiliary_client.py:3545`, `agent/auxiliary_call_outcome.py:47`, `providers/base.py:76`

**Problem (today).** Today the main loop classifies failures with classify_api_error (error_classifier.py:965), which also consults the profile's classify_api_error hook and the transform_api_error_classification plugin hook. The aux path makes its retry/fallback decisions with 17 private predicates (_is_payment_error :3272 through _is_statusless_structured_provider_error :3545, ~330 lines), importing only pattern constants from the classifier (auxiliary_client.py:27-33). auxiliary_call_outcome.error_class (auxiliary_call_outcome.py:47) runs classify_api_error on the same exception for telemetry only. So the reason logged for an aux failure and the decision taken can differ, and plugin/profile classifiers do not affect aux decisions. The drift has already shipped once: OpenRouter 'Budget limit exceeded' 403s were billing on the main loop but not on the aux ladder, so aux fallback never fired (#107166, comment at :3254).

**Move (proposed).** Proposed. Aux decisions consume ClassifiedError: retry-same-provider when reason in {timeout, overloaded, server_error, connection}, fallback when in {billing, rate_limit, model_not_found, auth after refresh}. The aux-only phrasings (daily quota, RESOURCE_EXHAUSTED) move into the classifier's pattern tables. Delete the 17 predicates. The gist's 'swallowed exceptions' ratchet does not apply here; this removes a drift class.

**Reference.** inspect_ai `.repos/inspect_ai/src/inspect_ai/model/_model.py:566`: ModelAPI.should_retry(ex) -> bool | RetryDecision: one classifier per provider API, consumed by the single retry controller.

**Risk.** Some aux predicates are deliberately broader than the main classifier (structured-output rejection, max_tokens rejection with client context, invalid aux response). Each needs a ClassifiedError reason or hint flag before deletion. Aux tests assert on predicate functions directly.

### PRV-08 — Eight retry/fallback loops for model calls, with the SDK-retry policy described three contradictory ways

- severity: **high** · effort: **M** · kind: `collapse` · low_hanging: **true** · loc_delta: -700 · depends_on: PRV-01, PRV-07
- evidence: `agent/conversation_loop.py:1506`, `agent/chat_completion_helpers.py:3851`, `agent/codex_runtime.py:1300`, `agent/auxiliary_client.py:8236`, `agent/auxiliary_client.py:3828`, `agent/auxiliary_client.py:7992`, `agent/auxiliary_client.py:4417`, `agent/chat_completion_helpers.py:2074`, `agent/agent_runtime_helpers.py:2101`, `agent/auxiliary_client.py:187`, `hermes_cli/config_defaults.py:133`

**Problem (today).** Today a model call can be retried by: the outer API retry loop (conversation_loop.py:1506, agent.api_max_retries), the stream retry loop (chat_completion_helpers.py:3851, budget from the HERMES_STREAM_RETRIES env var), the Codex stream retry (codex_runtime.py:1300), the aux transient retry with its own backoff (auxiliary_client.py:8236), the aux same-provider retry (_retry_same_provider_sync/_async :3828/:3837), the aux parameter-rung recovery ladder (_drive_ladder :7992 + auxiliary_fallback_recovery.py), the aux fallback chains (:4417) and the main fallback activation (chat_completion_helpers.py:2074). Each has its own budget, backoff and stop condition. The OpenAI SDK's own retries are described three ways: agent_runtime_helpers.py:2101 says aux keeps SDK retries; auxiliary_client.py:187-195 sets max_retries=0; config_defaults.py:133 tells users the SDK retries twice. tenacity is a declared dependency (pyproject.toml:53) and no in-scope code uses it for model calls (`rg -n 'stamina|tenacity|backoff\b' agent hermes_cli`).

**Move (proposed).** Proposed. One RetryPolicy value (attempts, backoff, retry_on: ClassifiedError reasons, honour Retry-After) applied by the ModelAPI for transport-level retries (stream reconnect, transient 5xx), and one FallbackModel wrapper for provider/model fallback, used by both main and aux. The main loop keeps only turn-level recovery (compression, role repair). Move HERMES_STREAM_RETRIES into config.yaml (root AGENTS.md: no new HERMES_* env vars for non-secret config). Correct or delete the three comments.

**Reference.** stamina `.repos/stamina/src/stamina/_core.py:119`: retry_context(on=...) yields Attempt objects: one typed retry policy with one 'on' predicate, used as a decorator or a loop, with a global testing switch.

**Risk.** Retry budgets are user-tuned (agent.api_max_retries, auxiliary.transient_retries); defaults must map 1:1. The main loop's retry interleaves with interrupt checks, Nous rate-limit guard and credential-pool rotation (mark_exhausted_and_rotate); those become retry_on hooks, not separate loops. Codex app-server retries are turn-level and may not fit.

### PRV-09 — Dead and test-only process globals in auxiliary_client: auxiliary_is_nous and the _RUNTIME_MAIN_* legacy mirrors

- severity: **medium** · effort: **S** · kind: `kill` · low_hanging: **false** · loc_delta: -70 · depends_on: —
- evidence: `agent/auxiliary_client.py:954`, `agent/auxiliary_client.py:2426`, `agent/auxiliary_client.py:4701`, `agent/auxiliary_client.py:5761`, `agent/auxiliary_client.py:2556`, `agent/auxiliary_client.py:2744`, `agent/auxiliary_client.py:2755`

**Problem (today).** Today auxiliary_is_nous is a module global (auxiliary_client.py:954) written on every auto-route resolution from any thread (:2426-2431, :4701-4702). Its only reader is get_auxiliary_extra_body (:5761), which has zero non-test callers (`rg -n 'get_auxiliary_extra_body' -g '!tests/**' .` returns only the definition; no getattr/importlib reference). Separately, six _RUNTIME_MAIN_* globals (:2556-2561), _RUNTIME_MAIN_COMPAT_SNAPSHOT and a lock are kept in sync by _publish_runtime_main_mirrors (:2744) so that _compat_runtime_main (:2755) can detect a test that patched a global directly; only two test files reference them (`rg -l '_RUNTIME_MAIN_(PROVIDER|...)' tests`), and no non-test code outside auxiliary_client.py does. The contextvar _RUNTIME_MAIN_CONTEXT is the real mechanism. Cost: readers must understand a write-only global and a test-compat layer in production code.

**Move (proposed).** Proposed. Delete auxiliary_is_nous, its four writes and get_auxiliary_extra_body. Delete the six mirror globals, the snapshot, the lock, _publish_runtime_main_mirrors and _compat_runtime_main; _runtime_main_value reads only the contextvar. Convert the two tests to set_runtime_main().

**Reference.** svcs `.repos/svcs/src/svcs/_core.py`: state lives in an explicit container/context, not in module globals with test mirrors.

**Risk.** A user plugin could read auxiliary_client.auxiliary_is_nous or patch _RUNTIME_MAIN_*; internal names are not API per root AGENTS.md ('No re-export shims for internal moves').

### PRV-10 — Model metadata has six-plus catalogs and a 13-step context-length ladder with provider branches inline

- severity: **medium** · effort: **M** · kind: `restructure` · low_hanging: **false** · loc_delta: -400 · depends_on: PRV-05
- evidence: `agent/model_metadata.py:2245`, `agent/model_metadata.py:290`, `agent/model_metadata.py:1695`, `agent/model_metadata.py:442`, `agent/models_dev.py:637`, `hermes_cli/models_catalog_static.py:170`, `hermes_cli/codex_models.py:22`, `providers/base.py:119`, `providers/base.py:144`

**Problem (today).** Today 'what is model M on provider P' (context window, output cap, vision, reasoning) is answered from: DEFAULT_CONTEXT_LENGTHS (model_metadata.py:290), _CODEX_OAUTH_CONTEXT_FALLBACK and two 'verified above advertised' tables (:1695-1713), _URL_TO_PROVIDER host map (:442), models_dev._BUILTIN_MODEL_METADATA (models_dev.py:637) plus the fetched models.dev registry, ProviderProfile.model_capabilities and fallback_models (providers/base.py:119, :144), the static picker lists _PROVIDER_MODELS (models_catalog_static.py:170), DEFAULT_CODEX_MODELS (codex_models.py:22), and per-provider live fetchers. get_model_context_length (model_metadata.py:2245-2360) is a numbered ladder (steps 0 through 9 with 0b/0c/1b) that inlines Bedrock, Anthropic /v1/models, Codex OAuth and LM Studio branches. Picker lists and metadata are separate sources, so AGENTS.md has to ask for a relationship test ('every catalog model has a context-length entry').

**Move (proposed).** Proposed. One ModelCatalog with ordered sources: user override -> profile.get_model_context_length / model_capabilities -> endpoint probe cache -> models.dev -> builtin defaults. Provider-specific steps move into the provider's profile hook (PRV-05). Static picker lists become profile.fallback_models only; _PROVIDER_MODELS and DEFAULT_CODEX_MODELS are derived or deleted.

**Reference.** pydantic-ai `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/providers/__init__.py:98`: Provider.model_profile(model_name) returns a ModelProfile (profiles/__init__.py:54); provider-specific capability rules live with the provider, and infer_model_profile (models/__init__.py:1699) merges them with defaults in one place.

**Risk.** Step order encodes real incidents (OpenRouter 32K underreport guard, endpoint-scoped metadata ahead of persistent cache, Codex proxy URLs #116191). Each move needs the incident's regression test kept. Context length feeds compression thresholds and the cache-sacred system prompt indirectly; values must not change.

### PRV-11 — ProviderProfile's contract is stale and untyped: it says it owns no client, rotation or streaming, then carries hooks for all three

- severity: **medium** · effort: **S** · kind: `boundary` · low_hanging: **false** · loc_delta: 0 · depends_on: PRV-01
- evidence: `providers/base.py:7`, `providers/base.py:47`, `providers/base.py:56`, `providers/base.py:74`, `providers/base.py:308`, `agent/transports/__init__.py:44`

**Problem (today).** Today the module docstring says profiles 'do NOT own client construction, credential rotation, or streaming. Those stay on AIAgent' (providers/base.py:7-9). The class has create_client (:308), refresh_credential and auth_handler and classify_api_error as `Callable[..., Any] | None` fields (:74-76), fetch_models with network I/O, and fetch_account_usage. api_mode is a free str (:47) validated elsewhere by closed literals (transports/__init__.py:44-50); aliases/env_vars/fallback_models are bare `tuple` (:48, :56, :119). A plugin author cannot tell from the type what is data and what is behaviour, or which api_mode strings are valid.

**Move (proposed).** Proposed. Split the type the way it is used: ProviderProfile (frozen data: name, aliases: tuple[str, ...], env_vars, base_url, api_mode: ApiMode, capabilities) and a Provider protocol for behaviour (create_model_api, refresh_credential, fetch_models, classify_error), with a default implementation for OpenAI-compatible providers. ApiMode is an enum or a registry-validated NewType checked at registration. Rewrite the docstring to the new contract.

**Reference.** pydantic-ai `.repos/pydantic-ai/pydantic_ai_slim/pydantic_ai/providers/__init__.py:42`: Provider ABC owns name, base_url, client and model_profile; ModelProfile is a TypedDict of pure data.

**Risk.** Profiles are a documented plugin surface (website model-provider-plugin guide). The split must keep `ProviderProfile(...)` construction working for existing out-of-tree plugins for one release, or ship with a migration note.

## Kill list

| target | why | importers/callers | evidence |
|---|---|---|---|
| `agent/auxiliary_client.py::auxiliary_is_nous + get_auxiliary_extra_body` | global written on every auto resolution, read only by a function nobody calls | 0 | auxiliary_client.py:954, :2426, :4701, :5761; rg -g '!tests/**' finds no caller of get_auxiliary_extra_body |
| `agent/auxiliary_client.py::_RUNTIME_MAIN_{PROVIDER,MODEL,BASE_URL,API_KEY,API_MODE,AUTH_MODE}, _RUNTIME_MAIN_COMPAT_SNAPSHOT, _RUNTIME_MAIN_COMPAT_LOCK, _publish_runtime_main_mirrors, _compat_runtime_main` | test-compat mirrors of the contextvar; no production reader outside the file | 0 | auxiliary_client.py:2556-2775; 2 test files reference the globals |
| `agent/agent_init.py::_client_kwargs_from_routed` | builds a client to read its kwargs back off (incl. SDK-private _custom_headers) to build a second client; gone once agent_init calls the resolver (PRV-03) | 2 | agent_init.py:861, :902, :1075 |
| `agent/auxiliary_client.py OpenAI-facade classes: _ChatShim, _AsyncCompletionsAdapter, _AsyncAuxiliaryClientBase, _CodexCompletionsAdapter, _AnthropicCompletionsAdapter, _BedrockCompletionsAdapter, Codex/Anthropic/Bedrock(Async)AuxiliaryClient` | exist only to make non-OpenAI wires answer .chat.completions.create; replaced by ModelAPI.request (PRV-01) | 1 | auxiliary_client.py:1418-1914; one off-path importer evals/provider_wire/issue_104282.py:67 |
| `providers/__init__.py::_sync_auth_registry + hermes_cli/auth.py::sync_plugin_provider_registry + hermes_cli/models_catalog_static.py::sync_plugin_provider_catalog` | keep duplicate snapshots of the profile registry in sync; unnecessary once those views are derived (PRV-04) | 4 | providers/__init__.py:97-118, :142, :282, :597; auth.py:266-268; models_catalog_static.py:382 |
| `hermes_cli/providers.py::TRANSPORT_TO_API_MODE and HermesOverlay.transport` | a second vocabulary for api_mode ('openai_chat'); 3 internal uses | 3 | providers.py:156, :239, :384 |
| `agent/auxiliary_client.py error predicates _is_payment_error .. _is_statusless_structured_provider_error` | parallel classifier; drift already shipped (#107166); replaced by ClassifiedError (PRV-07) | 24 | auxiliary_client.py:3272-3545; 24 call sites in agent/ |
| `agent/transports/chat_completions.py legacy flag path in build_kwargs` | second kwargs path for unregistered providers (is_kimi, is_lmstudio); retire once lmstudio/tencent-tokenhub have profiles | 1 | chat_completions.py:486-557; commit 20a4f79ed1 message |
| `HERMES_STREAM_RETRIES env var` | non-secret behaviour config in env (root AGENTS.md rubric); locales say default 3, code default 2 | 1 | chat_completion_helpers.py:3852; locales/*.yaml t367 |

## Simplify list

| what N things | become what 1 thing | lines saved (est.) | evidence |
|---|---|---|---|
| chat_completion_helpers.py api_mode ladders (:761, :1555, :3843, :4105); turn_api_call.py:90; aux facade adapters (auxiliary_client.py:1418-1914); gemini_native_adapter.py::GeminiNativeClient; copilot_acp_client.py::CopilotACPClient; relay_llm.py:30 table | one ModelAPI ABC (request/stream) with one subclass per wire in agent/transports/ | 2500 | PRV-01 |
| hermes_cli/runtime_provider.py::resolve_runtime_provider; agent/auxiliary_client.py::resolve_provider_client + _resolve_*_branch (group K); hermes_cli/providers.py::resolve_provider_full; hermes_cli/model_switch.py::resolve_startup_model_route | resolve_route(RouteRequest) -> ResolvedRoute (frozen dataclass) | 1200 | PRV-03 |
| ProviderProfile; auth.ProviderConfig/PROVIDER_REGISTRY; providers.HermesOverlay/ProviderDef; models_catalog_static.ProviderEntry/CANONICAL_PROVIDERS; models_dev.PROVIDER_TO_MODELS_DEV; 7 alias tables | ProviderProfile only; other views derived from list_providers() | 800 | PRV-04 |
| aux _CREDENTIAL_REFRESHERS + 6 refreshers; turn_recovery._refresh_credentials_after_401 + 6 client_lifecycle._try_refresh_* + 5 TurnRetryState flags; credential_pool per-provider refresh | CredentialPool.refresh(entry) dispatching to profile.refresh_credential; ModelAPI retries once on 401 | 500 | PRV-06 |
| error_classifier.classify_api_error; 17 aux _is_* predicates | classify_api_error only | 300 | PRV-07 |
| 8 retry/fallback loops | RetryPolicy inside ModelAPI + FallbackModel wrapper + turn-level recovery in the loop | 700 | PRV-08 |
| agent_runtime_helpers.create_openai_client; auxiliary_client._create_openai_client | one client factory owned by ChatCompletionsAPI/CodexResponsesAPI | 150 | agent_runtime_helpers.py:2015; auxiliary_client.py:181 |
| aux _ChatStreamAccumulator; chat_completion_helpers._ToolCallAccumulator; chat_completion_helpers_relay.RelayChatAccumulator | one chat-stream accumulator in agent/transports/chat_completions.py | 150 | auxiliary_client.py:7222; chat_completion_helpers.py:2789; chat_completion_helpers_relay.py:31 |

## Reference patterns to copy

| repo | path | pattern | where it applies here |
|---|---|---|---|
| pydantic-ai (c68786e) | `pydantic_ai_slim/pydantic_ai/models/__init__.py:454` | Model ABC: request() :633, request_stream() :670, profile :1055; one subclass per wire | PRV-01: ProviderTransport becomes ModelAPI that sends |
| pydantic-ai (c68786e) | `pydantic_ai_slim/pydantic_ai/providers/__init__.py:42` | Provider ABC (name, base_url, client, model_profile) separate from Model (wire) and ModelProfile (data, profiles/__init__.py:54) | PRV-04, PRV-11: one provider descriptor; split data from behaviour |
| pydantic-ai (c68786e) | `pydantic_ai_slim/pydantic_ai/models/fallback.py:90` | FallbackModel wraps Models with typed fallback_on | PRV-02, PRV-08: aux and main fallback chains |
| pydantic-ai (c68786e) | `pydantic_ai_slim/pydantic_ai/models/instrumented.py:333` | InstrumentedModel(WrapperModel) adds tracing around any Model | relay_llm / auxiliary_hooks wrapping |
| pydantic-ai (c68786e) | `pydantic_ai_slim/pydantic_ai/models/__init__.py:1746` | infer_model(name, provider_factory) -> one Model | PRV-03: one resolver |
| inspect_ai (9f6accd) | `src/inspect_ai/model/_model.py:275` | ModelAPI ABC: generate() :428, should_retry() -> RetryDecision :566, connection_key :535 | PRV-01, PRV-07: one per-API classifier consumed by one retry controller |
| inspect_ai (9f6accd) | `src/inspect_ai/model/_providers/providers.py:34` | @modelapi(name=...) registry, lazy import per provider | PRV-04, PRV-05: providers registered once |
| llm (764dc38) | `llm/default_plugins/openai_models.py:40` | built-in models register through the same register_models hookspec (llm/hookspecs.py:13) as plugins | PRV-05: built-ins use profile hooks |
| llm (764dc38) | `llm/models.py:3390` | KeyModel with needs_key/key_env_var (:3205-3207): credential lookup declared on the model class | PRV-04: env vars declared once on the profile |
| stamina (7836f46) | `src/stamina/_core.py:119` | retry_context(on=...) one typed retry policy | PRV-08 |
| httpx (b5addb6) | `httpx/_client.py:594` | one long-lived Client with mounts (:652) and explicit close/ClientState (:125) | PRV-02: one ClientPool keyed by ResolvedRoute instead of aux cache + client_lifecycle slots |

## Answer to the seam question

Today Hermes talks to model providers in 8 distinct wire paths: OpenAI Chat Completions, OpenAI Responses (Codex), Anthropic Messages, Bedrock Converse, Gemini native REST, the Codex app-server subprocess, ACP subprocesses, and the MoA virtual provider. NeMo Relay wraps these for tracing; it is not a wire. The main loop selects among them with api_mode if-ladders (102 comparison sites). The auxiliary path, Gemini, ACP and MoA select by impersonating the OpenAI SDK's .chat.completions.create. Routes are resolved by 4 resolvers (resolve_runtime_provider, resolve_provider_client, resolve_provider_full, resolve_startup_model_route). Clients are built by 2 OpenAI factories, 1 Anthropic builder, the Gemini/Bedrock/Azure adapters and the profile create_client hook. Model calls are retried in 8 loops. Providers are described by 5 descriptor types and 7 alias tables. Model metadata comes from 6+ catalogs. 'Auxiliary' is a second provider stack, not a thin side channel: about 44% of its 8,407 lines are provider and credential resolution, and the main agent's own client construction and fallback call into it. All of this can collapse behind one Model interface. The repo already started that migration: the transport ABC landed in April 2026 (731f4fbae6) and ProviderProfile in May 2026 (20a4f79ed1). Both commits explicitly left sending, streaming, client lifecycle and credentials on AIAgent, and that exclusion is the reason the dispatch is duplicated. The target is the pydantic-ai split: a Provider (one descriptor per provider with credentials, client and hooks, used by built-ins and plugins alike), a ModelAPI per wire that owns request() and stream() (5–6 classes), a ModelProfile of capability data, one resolver that returns a typed ResolvedRoute, one RetryPolicy and a FallbackModel wrapper. The main loop and the auxiliary tasks become two callers of the same objects. Codex app-server and ACP are turn-level subprocess protocols and may only fit as plugin-supplied ModelAPIs with a reduced contract (UNVERIFIED).

Relation to the ratchet plan (`inputs/gist/0-plan.md`): none of these findings is a lint rule. PRV-07 removes a drift class (#107166) that no linter would catch. PRV-04/PRV-05 remove the 'parallel_registry_drift' class (10 fix commits in `inputs/gist/C-fix-commit-classes.md`) at its source. PRV-01/PRV-02 are the structural route to the gist's file-size cap for the largest in-scope file: splitting `auxiliary_client.py` along `<stem>_<topic>` without PRV-01..03 would spread a duplicate stack over more files. The existing siblings already import back into the monolith (`auxiliary_health.py`, `auxiliary_fallback_recovery.py`), so they are fragments, not modules.

## Cross-seam notes

- **04-agent-loop** `agent/turn_recovery.py:391; agent/turn_retry_state.py:18`: 401 refresh ladder and five per-provider retry flags live in the turn loop; they should leave it with PRV-06
- **04-agent-loop** `agent/chat_completion_helpers.py:1484; agent/chat_completion_helpers.py:2097`: main loop imports the aux path for temperature and fallback client construction
- **07-config** `agent/chat_completion_helpers.py:3852`: HERMES_STREAM_RETRIES is non-secret config in env; locales document default 3, code uses 2
- **07-config** `agent/auxiliary_client.py:3869`: HERMES_NOUS_TIMEOUT_SECONDS read in the aux Nous refresher
- **07-config** `hermes_cli/config_defaults.py:133`: config_defaults comment says the OpenAI SDK retries twice; both client factories set max_retries=0
- **09-concurrency** `agent/auxiliary_client.py:2426; agent/models_dev.py:355`: module globals mutated per call from worker threads: auxiliary_is_nous; models_dev has 8 global statements over its cache
- **14-errors-obs** `agent/auxiliary_call_outcome.py:47; agent/auxiliary_client.py:3272`: aux telemetry label (classify_api_error) and aux decision (private predicates) can disagree
- **11-plugins** `providers/__init__.py:97; plugins/AGENTS.md:63`: model-provider plugins are discovered by providers/__init__.py, not PluginManager, and mirror into hermes_cli via sys.modules lookups
- **01-layout** `providers/base.py:35; providers/base.py:395`: providers/ is a top-level 2-file package whose plugins live in plugins/model-providers/; agent and hermes_cli both import it; it late-imports hermes_cli
- **15-kill** `evals/provider_wire/issue_104282.py:67`: an eval imports a private aux adapter class
- **12-cli** `hermes_cli/model_switch.py:22-23`: model_switch re-exports a sibling symbol so tests can patch it (shim the root AGENTS.md forbids)

## UNVERIFIED

- UNVERIFIED: the user-visible effect of hermes_cli/providers.py ALIASES mapping 'openai' to 'openrouter' on the /model path. Verify with a live `/model --provider openai` against a temp HERMES_HOME and compare with resolve_runtime_provider('openai').
- UNVERIFIED: that the two OpenAI client factories (agent_runtime_helpers.py:2015, auxiliary_client.py:181) produce identical headers for every provider. Verify by diffing client._custom_headers for each profile through both factories.
- UNVERIFIED: that codex_app_server and ACP subprocess protocols can implement a request/stream ModelAPI contract. They are turn-level, not request-level. Verify by reading agent/transports/codex_app_server_session.py and agent/copilot_acp_client.py end to end.
- UNVERIFIED: every loc_delta is a rough estimate from line spans in notes/05-providers-aux-anatomy.md and wc -l, not a prototype.
- UNVERIFIED: the number of tests that patch the seams PRV-01/02/06 would move. Verify with `rg -n "patch\(.*(auxiliary_client|_try_refresh_|_anthropic_messages_create|_run_codex_stream)" tests | wc -l`.
- UNVERIFIED: that no out-of-tree plugin reads auxiliary_client.auxiliary_is_nous or patches _RUNTIME_MAIN_*. The repo cannot show this; plugin-catalog search would.
- UNVERIFIED: the per-file fix-commit counts use path-only git log without --follow; files created by the Sep 2026 decomposition (chat_completion_helpers.py, credential_pool siblings) undercount history.
- UNVERIFIED: hermes_cli/models.py, model_switch.py and auth_nous.py were read at function-list depth only, not line by line.
