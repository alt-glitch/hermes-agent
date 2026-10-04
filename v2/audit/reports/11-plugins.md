# 11 Plugin system and extension points

Checkout `origin/main` = `ea81748579`. Reference repos: pluggy 7aa82ed, llm 764dc38, datasette cec5e6b,
inspect_ai 9f6accd, jupyter_client 978361b, home-assistant-core 0f3081e. Working notes with the full
per-kind and per-hook tables: `notes/11-sub-kinds.md`, `notes/11-sub-hooks.md`, `notes/11-sub-intree.md`
(child surveys; claims used here were re-opened by me unless listed under UNVERIFIED).

## TL;DR

- The structural problem: Hermes has **7 separate systems that find and import plugin code**, each with its own directory walk, import-by-path, entry-point scan, host-isolation branch and precedence rule (4 different rules). `PluginManager` is only one of them.
- Biggest simplification: one kind table (`kind → base class, registry, selector key, precedence`) on one loader. The pieces exist already (`_SCOPED_PROVIDER_REGISTRARS`, `ProviderRegistry`, `plugin_loader.py`); memory, context engine, cron, model providers, dashboard plugins and gateway hooks never joined them. Est. −1,500 lines.
- Biggest kill: the gateway `HOOK.yaml` hook bus (`gateway/hooks.py`), a second event vocabulary that fires next to the plugin hook for the same event and bypasses plugin-host isolation. Also 4 in-tree vendor plugins (spotify, google_meet, teams_pipeline, observability/langfuse, ~5.6k LOC with core glue) that the repo's own rule says belong out of tree.
- Low-hanging (S/M and high+): 3 — PLG-02 (isolation by copy, gateway hooks bypass it), PLG-03 (two hook vocabularies), PLG-04 (registrars outside the unload ledger; context references are process-global).
- Seam answer: 7 code-loading discovery systems, 2 entry-point groups, ~31 registries, 7 dispatch channels. pluggy would replace hook dispatch and entry-point loading (~400 lines), not the hard parts (per-profile managers, lease-based unload, isolation host, timeouts). Collapse discovery and registries first; pluggy is optional after that.

## What this area is

Scope covered (LOC by `wc -l`):

| part | files | LOC |
|---|---|---|
| `hermes_cli/plugins*.py`, `hermes_cli/plugin_*.py`, `agent_plugins.py`, `middleware.py`, `lifecycle.py` | 44 | 16,634 |
| `plugins/` excluding `plugins/platforms/` | 148 | 27,511 |
| registries + hook adapters (`agent/*_registry.py`, `provider_registry.py`, `provider_base.py`, `memory_provider.py`, `memory_manager.py`, `context_engine.py`, `shell_hooks.py`, `outbound_webhooks.py`, `plugin_stream_hooks.py`, `auxiliary_hooks.py`, `providers/__init__.py`, `gateway/hooks.py`, `gateway/platform_registry.py`, `hermes_cli/web_server_dashboard.py`, `registration_lifecycle.py`, dashboard-auth and secret-source registries) | 24 | 6,626 |
| **total** | **216** | **~50.8k** |

`plugins/platforms/` (53.9k, 66% of `plugins/`) is seam 10; install/update/catalog flows are seam 03.

Modules that matter:

| module | LOC | owns |
|---|---|---|
| `hermes_cli/plugins.py` | 2,331 | `VALID_HOOKS` (41 names), `PluginContext` (854-line class, ~45 methods), `PluginManager`, per-home manager cache, module-level hook helpers |
| `hermes_cli/plugins_discovery.py` | 311 | directory + entry-point scan, `gate_manifest` (kind → load/defer/park), later-wins winner selection |
| `hermes_cli/plugins_loader.py` | 717 | import-by-path, load deadline, deferred platforms, host routing, portable (Agent Plugin) load |
| `hermes_cli/plugins_dispatch.py` | 602 | `invoke_hook` (signature-filtered kwargs, timeouts, fail-closed `pre_tool_call`), event bus, prompt sections, middleware |
| `hermes_cli/plugins_ledger.py` + `registration_lifecycle.py` | 303 + 95 | per-registration leases so force reload / disable unwinds registries |
| `hermes_cli/plugin_host*.py`, `plugin_isolation*.py` | 2,016 | `plugins.isolation: host` — user plugins in a per-profile child process |
| `plugins/memory/__init__.py`, `plugins/context_engine/__init__.py`, `plugins/cron_providers/__init__.py`, `plugins/plugin_loader.py` | 568 + 126 + 101 + 191 | three "exclusive" kinds with their own discovery (bundled-first) |
| `providers/__init__.py` | 647 | model-provider discovery (last-writer-wins, per-home layers) |
| `hermes_cli/web_server_dashboard.py` | 934 | dashboard plugin discovery (`*/dashboard/manifest.json`, first-name-wins, launch home) |
| `gateway/hooks.py` | 181 | `~/.hermes/hooks/<name>/HOOK.yaml` + `handler.py` event hooks |
| `agent/provider_registry.py` | 204 | generic scoped registry behind 7 `agent/*_registry.py` |

## How it works end to end

### Flow 1 — a user plugin blocks a tool call (`pre_tool_call`)

Inputs: `plugin_enabled` (user plugin listed in `plugins.enabled`), `isolation_host` (`plugins.isolation: host`).

1. `model_tools.py:162` (module import) calls `hermes_cli/plugins.py:1824::discover_plugins` — discovery is an import side effect (PLG-10).
2. `hermes_cli/plugins.py:1768::get_plugin_manager` returns the manager for the active home (one per profile).
3. `hermes_cli/plugins.py:1350::PluginManager.discover_and_load` takes the lock and binds the home scope.
4. `hermes_cli/plugins_discovery.py:189::collect_directory_manifests` scans bundled (skipping `memory`, `context_engine`, `model-providers`, `cron_providers`, `:207-208`), user, project. (PLG-01)
5. `hermes_cli/plugins.py:1491` (`PluginManager._discover_and_load_inner`) `resolve_manifest_winners` picks later-wins; `hermes_cli/plugins_discovery.py:257::gate_manifest` parks `exclusive`/`model-provider` and requires `plugins.enabled` for user plugins (`:297`).
6. `hermes_cli/plugins_loader.py:434::_load_plugin_scoped` builds a `PluginContext`; `:458` decides in-process vs host, and when `isolation_host` is true `:466` routes the import to the plugin host instead (one of 9 copies of this branch, PLG-02).
7. The plugin's `register(ctx)` calls `hermes_cli/plugins.py:974::PluginContext.register_hook`, leased in the ledger (`plugins_ledger.py:63`).
8. At tool time, `agent/tool_executor.py:671` calls `hermes_cli/plugins.py:2150::_dispatch_pre_tool_call_hooks` → `:2038::_get_pre_tool_call_directive_details` → `hermes_cli/lifecycle.py:26::invoke_hook`.
9. `hermes_cli/plugins_dispatch.py:209::invoke_hook` runs each callback with `_hook_callback_kwargs` (`:183`), bounded by `plugins.hook_callback_timeout`; a timeout or raise on `pre_tool_call` becomes a block directive (fail-closed).
10. Precedence block > approve > none is applied by the caller (`hermes_cli/plugins.py:2038-2060`), not by the dispatcher.

### Flow 2 — `memory.provider: mem0` activates a memory provider

Inputs: `provider_is_bundled`, `isolation_host`.

1. `agent/agent_init.py:1371-1376` sees a non-core provider name and calls `plugins.memory::load_memory_provider`.
2. `plugins/memory/__init__.py:192::load_memory_provider` → `:124::find_provider_dir` (bundled → user → project → entry point; bundled-first, the reverse of Flow 1 step 5).
3. `plugins/memory/__init__.py:237` refuses a non-bundled provider when isolation is on without a host; `:340::_load_provider_from_dir` routes to the host at `:344` (another copy of the host branch).
4. Otherwise `plugins/plugin_loader.py:93::load_plugin_module` imports by path (a separate import-by-path from `plugins_loader.py`).
5. `plugins/memory/__init__.py:374::_ProviderCollector` captures `register_memory_provider` and forwards other `register_*` calls to a real `PluginContext`; hooks go through the ledger's "fallback hook" group (`hermes_cli/plugins_ledger.py:179-201`) because the same directory may also load through general discovery (PLG-06).
6. `agent/agent_init.py:1383` → `agent/memory_manager.py:379::MemoryManager.add_provider`.

### Flow 3 — a gateway user types `/model`

Inputs: `hook_dir_present` (`~/.hermes/hooks/<x>/HOOK.yaml` declares `command:model`).

1. `gateway/run_inbound.py:813` calls `hermes_cli/plugins.py:1992::fire_pre_command_hook` — plugin hook, observer-only, returns ignored (`:197-203`).
2. `gateway/run_inbound.py:827` then calls `gateway/hooks.py:125::emit_collect("command:model")` — the second hook system, which CAN deny, handle or rewrite (`run_inbound.py:832-846`). (PLG-03)
3. `gateway/hooks.py:157::ProfileHookRegistries._active` lazily builds a `HookRegistry` for the home.
4. `gateway/hooks.py:89::discover_and_load` walks `hooks/` and `gateway/hooks.py:43::_load_hook_dir` executes `handler.py` with `spec_from_file_location` in the gateway process (`:59-65`) — no plugin-host routing even under `plugins.isolation: host` (PLG-02).
5. Handler errors are `print`ed (`gateway/hooks.py:137-138`).

## Findings

### PLG-01 — Seven plugin discovery systems with four precedence rules; kinds are systems instead of rows
- severity: high · effort: L · kind: collapse · low_hanging: false
- evidence: `hermes_cli/plugins_discovery.py:207-208`, `hermes_cli/plugins_discovery.py:221`, `plugins/memory/__init__.py:4-7`, `plugins/memory/__init__.py:95-109`, `plugins/context_engine/__init__.py:32-57`, `plugins/cron_providers/__init__.py:39-54`, `providers/__init__.py:575-643`, `hermes_cli/web_server_dashboard.py:465-506`, `hermes_cli/web_server_dashboard.py:549`, `gateway/hooks.py:89-111`, `hermes_cli/plugins_manifest.py:268`, `hermes_cli/plugins_manifest.py:502-521`
- problem: Today code-loading discovery is done by `PluginManager`, `plugins/memory`, `plugins/context_engine`, `plugins/cron_providers`, `providers/__init__.py`, the dashboard scanner and `gateway/hooks.py`. Each has its own directory walk, its own `spec_from_file_location` sequence (6 copies), its own entry-point code (2 groups, the `hasattr(eps,"select")` shim 3×) and its own precedence: PM later-wins, model providers last-writer-wins, memory/context/cron bundled-first, dashboard user-first. The same directory under `~/.hermes/plugins/foo` therefore means different things by kind. Kind is partly guessed by substring-sniffing `__init__.py` (`plugins_manifest.py:268`, plus 3 copies in memory/context/cron). Every cross-cutting rule must be re-implemented N times; the dashboard copy already diverged into two security advisories (GHSA-5qr3-c538-wm9j env truthiness and the absolute-path `api` RCE, recorded at `web_server_dashboard.py:495-502`). A contributor adding a kind has no single pattern to follow.
- move: Add `hermes_cli/plugin_kinds.py` with one frozen table `PluginKind(name, base_class, registry, select_key, precedence, cardinality, load)`. Rows: `standalone`; `backend:<category>` (image_gen, video_gen, web, browser, tts, stt, terminal_env, secret_source — today's `_SCOPED_PROVIDER_REGISTRARS`); `exclusive:memory` (`memory.provider`, bundled-first, load on select); `exclusive:context_engine` (`context.engine`); `exclusive:cron` (`cron.provider`); `model-provider` (last-writer-wins); `platform` (deferred); `dashboard` (manifest.json). `PluginManager` scans each source once, reads `kind:` from the manifest (no sniffing; a manifest without `kind` defaults to `standalone` and warns with the fix) and asks the kind row for precedence. Delete the discovery halves of `plugins/memory/__init__.py`, `plugins/context_engine/__init__.py`, `plugins/cron_providers/__init__.py`, `plugins/plugin_loader.py`, the dashboard scanner (`web_server_dashboard.py:465-575`) and `providers/__init__.py::_scan_home_layer`/`_discover_entry_point_providers`; each keeps a ~20-line selector `select(kind, name)`. One entry-point group with the kind in the manifest; `hermes_agent.memory_providers` stays an alias group for one deprecation window.
- reference: jupyter_client `jupyter_client/provisioning/factory.py:165-170` (entry-point group per extension type, one factory resolves by name); inspect_ai `src/inspect_ai/_util/registry.py:621-627` (one registry keyed by `registry_key(type, name)`); pluggy `src/pluggy/_manager.py:482` (`load_setuptools_entrypoints` once).
- loc_delta: −1,500 (rough: ~800 discovery lines in memory/context/cron/plugin_loader, ~400 in providers, ~300 in the dashboard scanner, plus a ~250-line kind table)
- risk: Precedence is a documented contract per kind (`plugins/memory/__init__.py:7`: "Changing this order is a breaking change"); the kind row must keep each rule, not unify it. Model-provider discovery runs while `hermes_cli.config`/`auth` import (`plugins/AGENTS.md:101-103`); the unified loader must stay callable at that point without importing user code. Tests that patch `plugins.memory._iter_provider_dirs` and friends move.
- depends_on: []

### PLG-02 — Plugin-host isolation is enforced by copy in 7 files; gateway `HOOK.yaml` handlers bypass it
- severity: high · effort: M · kind: boundary · low_hanging: true
- evidence: `plugins/AGENTS.md:99-104`, `hermes_cli/plugins_loader.py:458`, `hermes_cli/plugins_loader.py:543-546`, `providers/__init__.py:402-412`, `hermes_cli/web_server_dashboard.py:881-885`, `plugins/context_engine/__init__.py:78-80`, `plugins/cron_providers/__init__.py:82-84`, `plugins/memory/__init__.py:237`, `plugins/memory/__init__.py:344`, `plugins/memory/config_schema.py:106`, `gateway/hooks.py:43-72`, `gateway/hooks.py:142-170`
- problem: `plugins/AGENTS.md:99-104` states "Every user-code import path routes to the host or refuses … A new user-code loader MUST do the same." The rule is kept by hand: each loader has its own `isolation_mode() == ISOLATION_HOST` / `user_plugin_host()` branch (`rg -n "user_plugin_host\(\)|isolation_mode\(\)" -g '!tests/**'`: 9 loader sites in 7 files). `gateway/hooks.py::_load_hook_dir` has none: it `exec_module`s `~/.hermes/hooks/<name>/handler.py` in the gateway process, once per served profile (`ProfileHookRegistries`, `gateway/hooks.py:142`). Under `plugins.isolation: host` plus multiplex, a profile's hook handler runs inside the gateway process — the exposure the host exists to remove ("a host sees only its own profile's secrets", `plugins/AGENTS.md:115-116`). The invariant cannot be checked statically because there is no single choke point.
- move: One function `hermes_cli/plugin_isolation.py::import_user_code(path, *, module_name, capture, base_ref) -> object`, the only place allowed to call `spec_from_file_location` on a non-bundled path; it routes to the host or refuses. All loaders call it (falls out of PLG-01, but can land first). Gateway hooks either go through it or are folded into the plugin bus by PLG-03. Add "`spec_from_file_location` outside `plugin_isolation.py`" to the gist's Phase-1 engine as an AST rule: one rule, zero violations after the move.
- reference: pluggy `src/pluggy/_manager.py:482` (one loader for all external plugins); home-assistant-core `homeassistant/loader.py:349` (`async_get_custom_components`, one entry for all custom code).
- loc_delta: −150
- risk: The host returns proxies (`RemotePluginContext`); gateway handlers are `handle(event_type, context)` functions, so the host needs a callable proxy for them or they are refused under `host`. Preserve: bundled plugins import in-process; `HERMES_PLUGIN_HOST_PROCESS=1` never spawns a nested host.
- depends_on: []

### PLG-03 — Two hook vocabularies for the same lifecycle points: plugin `VALID_HOOKS` and gateway `HOOK.yaml` events
- severity: high · effort: M · kind: collapse · low_hanging: true
- evidence: `gateway/run_inbound.py:813-817`, `gateway/run_inbound.py:827`, `gateway/run_inbound.py:832-846`, `hermes_cli/plugins.py:1992-2003`, `gateway/hooks.py:1-10`, `gateway/hooks.py:121-139`, `gateway/run_turn.py:537`, `run_agent.py:409`, `agent/shell_hooks.py:170`, `agent/outbound_webhooks.py:94`, `gateway/hooks.py:86-87`
- problem: For a gateway slash command, `run_inbound.py:813` fires the plugin `pre_command` hook (observer-only, returns ignored) and 14 lines later `:827` fires the gateway `command:<name>` hook, which can deny, handle or rewrite. The same split exists for session start (`session:start` at `gateway/run_turn.py:537` vs `on_session_start` at `run_agent.py:409`), agent start/end and reactions. A plugin author who wants to veto a command must ship a `HOOK.yaml` directory instead of a plugin; a `HOOK.yaml` author gets no host isolation (PLG-02), no timeouts, `print` error handling (`gateway/hooks.py:137`) and a dict payload instead of kwargs. Shell hooks and outbound webhooks already show the right shape: config-driven adapters that append onto the one plugin hook bus (`agent/shell_hooks.py:170`, `agent/outbound_webhooks.py:94`). `gateway/builtin_hooks/` is an empty package and `_register_builtin_hooks` an empty method.
- move: Delete `HookRegistry.emit/emit_collect` and the 8 `self.hooks.emit*` call sites. Keep `HOOK.yaml` directories as a third config adapter, shaped like `agent/shell_hooks.py`: at discovery each declared gateway event maps to a `VALID_HOOKS` name (`session:start→on_session_start`, `agent:end→post_llm_call`, `command:*→pre_command`, `reaction:*→gateway_platform_event`) and `handle()` is wrapped to receive `(event_type, context)`. Promote `pre_command` from observer to a decision hook returning `{"decision": deny|handled|rewrite}` (the parser exists at `run_inbound.py:832-846`), giving plugins the power `HOOK.yaml` has today. Delete `gateway/builtin_hooks/`.
- reference: pluggy `src/pluggy/_hooks.py` (`HookspecMarker`, `firstresult`: one spec per event, many impl sources); blinker `src/blinker/base.py` (named signals).
- loc_delta: −250
- risk: Existing `HOOK.yaml` users depend on event names and the `context` dict; the adapter keeps both. `command:*` handlers may be async; `invoke_hook` resolves coroutine results via `resolve_plugin_command_result` (`plugins_dispatch.py:199-207`). The running-agent path must keep NOT firing command hooks (`run_inbound.py:806-808`).
- depends_on: []

### PLG-04 — Registrars outside the unload ledger; context references are process-global and refuse re-registration
- severity: high · effort: M · kind: boundary · low_hanging: true
- evidence: `hermes_cli/plugins.py:738-752`, `agent/context_references.py:29`, `agent/context_references.py:58-69`, `hermes_cli/plugins.py:858-873`, `hermes_cli/plugins.py:917-929`, `hermes_cli/plugins_ledger.py:227-253`, `hermes_cli/plugins_ledger.py:288-296`, `gateway/platforms/base.py:2316-2319`, `hermes_cli/plugins.py:1251-1267`
- problem: Unload correctness depends on every `register_*` method remembering to call `_track*`. AST scan of `PluginContext` registrars (`scripts/plg_untracked_registrars.py`) finds three that record no lease: `register_context_reference`, `register_platform_handler`, `register_redaction_patterns`. Read from code: (1) `agent/context_references.py:58-69` stores providers in a module dict keyed by prefix, not by profile scope, and raises `ValueError("already registered")` on a second registration. A force re-discovery unloads and re-registers; the re-register raises, is logged as "registration failed" (`plugins.py:749-750`), and the provider object from the previous module generation stays live. In a multiplexed process the second profile's manager gets the first profile's provider instance. (2) `register_platform_handler` appends to `_platform_handler_factories` without a lease, so a targeted unload (`hermes plugins disable`, `plugins_ledger.py:250-252`) leaves the factory wired into the next adapter `connect()` (`gateway/platforms/base.py:2316-2319`); only unload-all clears it (`plugins_ledger.py:294`). (3) Redaction patterns are additive for the life of the process. Profile-scope leaks are the #1 bug class in the gist (366 fix commits); this is that class, made possible by a missing structural choke point.
- move: Make the ledger impossible to skip: `PluginContext` writes every registration through one method `_put(kind, key, value, adapter)` where `adapter` is a small protocol `{put(scope, key, value) -> previous; restore(scope, key, current, previous)}`. Port `agent/context_references.py` to `ProviderRegistry` (scoped; same-owner re-registration overwrites; identity-conditional restore). Give `register_platform_handler` and `register_redaction_patterns` adapters. Then the abandoned-load guard moves into `_put` (PLG-09).
- reference: inspect_ai `src/inspect_ai/_util/registry.py:127-148` (`registry_add`: one write path into one keyed store); pluggy `src/pluggy/_manager.py:278-300` (`unregister` removes every impl of a plugin because every registration went through one place).
- loc_delta: −50
- risk: Built-in prefix rejection and cross-plugin duplicate-prefix rejection must stay; only same-owner re-registration becomes an overwrite. Runtime behaviour of (1) and (2) was read from code, not executed (UNVERIFIED).
- depends_on: []

### PLG-05 — Four hand-rolled scoped registries next to the generic `ProviderRegistry`, plus 18 manager-local containers
- severity: medium · effort: M · kind: collapse · low_hanging: false
- evidence: `agent/provider_registry.py:27-170`, `hermes_cli/dashboard_auth/registry.py:15-16`, `agent/secret_sources/registry.py:33-35`, `gateway/platform_registry.py:119`, `gateway/platform_registry.py:414`, `providers/__init__.py:54-89`, `hermes_cli/plugins.py:1251-1267`, `hermes_cli/plugins_ledger.py:288-296`
- problem: `ProviderRegistry` (global map + per-scope maps + generation + snapshot/restore) backs 7 registries. Dashboard auth, secret sources, platforms and model-provider profiles reimplement the same shape by hand (128, 434, 414 and ~90 lines). Inside `PluginManager` another 18 containers (listed at `plugins_ledger.py:288-295`) hold manager-local registrations, each with its own restore lambda. A reader must learn 5 registry implementations to answer "what does plugin X own in profile Y".
- move: Port the four hand-rolled registries to `ProviderRegistry`, keeping their module-level names through the class's existing `export()` (`provider_registry.py:8-9`) so test seams stay. Replace the 18 manager-local dicts with one `RegistrationStore` keyed `(kind, key)` → ordered `[(owner, value)]`; readers become `store.values(kind)`. `get_plugin_toolsets` (`plugins.py:2304-2331`) and listings become queries instead of joins over three structures.
- reference: inspect_ai `src/inspect_ai/_util/registry.py:621-627` (`registry_key(type, name)` over one `_registry` dict).
- loc_delta: −400
- risk: The platform registry carries deferred loaders and enum aliasing (`gateway/config.py:280`); secret sources carry orchestrator-owned ordering (`plugins.py:1121-1124`). Both need extra fields, not a different registry class. Many tests patch the hand-rolled module dicts.
- depends_on: [PLG-04]

### PLG-06 — Exclusive kinds load the same directory twice; the ledger carries a special case for it
- severity: medium · effort: M · kind: restructure · low_hanging: false
- evidence: `hermes_cli/plugins_ledger.py:179-201`, `hermes_cli/plugins.py:1253-1254`, `hermes_cli/plugins.py:754-764`, `plugins/memory/__init__.py:374-377`, `plugins/context_engine/__init__.py:90-123`, `agent/agent_init.py:1934-1942`, `hermes_cli/plugins.py:717-736`, `hermes_cli/plugins.py:2245`
- problem: A memory-provider directory can be imported by general discovery AND by `plugins/memory`, so `register()` runs twice against one manager. The ledger keeps a second ownership structure (`_memory_hook_registrations`, "dual-kind hook ownership") so hooks are not doubled, and `PluginContext.register_memory_provider` exists only as an inert recorder because "without this method its register() would fail" (`plugins.py:755-757`). Context engines have two load paths in sequence: `plugins.context_engine.load_context_engine`, then whatever a general plugin registered via `ctx.register_context_engine` (`agent_init.py:1934-1942`). Each exclusive kind has its own collector class (`_ProviderCollector` ×2, `_EngineCollector`).
- move: With PLG-01, exclusive-kind plugins load once through `PluginManager`; `register_memory_provider` / `register_context_engine` / a new `register_cron_scheduler` put candidates into the kind's registry; the selector picks by `memory.provider` / `context.engine` / `cron.provider`. Delete `_memory_hook_registrations`, `_register_fallback_hook`, `_drop_fallback_hooks`, the three collector classes and the context-engine double path.
- reference: llm `llm/hookspecs.py:12-14` and `llm/plugins.py:15-30` (`register_models(register)`: plugins contribute candidates; selection by name is the host's job).
- loc_delta: −300
- risk: Memory activation must still import only the ACTIVE provider (`plugins/AGENTS.md:62`: "Enumerates without importing", so `hermes --help` stays clean). Eagerly loading all candidates would import every memory SDK; the kind row needs `load: on_select`.
- depends_on: [PLG-01]

### PLG-07 — Core hardcodes in-tree vendor plugins; 4 vendor plugins sit in-tree against the repo's own rule
- severity: medium · effort: M · kind: kill · low_hanging: false
- evidence: `AGENTS.md:97-102`, `plugins/AGENTS.md:28-33`, `gateway/run.py:2890-2893`, `gateway/run.py:3876-3884`, `gateway/run_startup.py:1638`, `gateway/run_profile_reconcile.py:260`, `toolsets.py:178-182`, `hermes_cli/auth_spotify.py:1`, `hermes_cli/tools_config.py:382-386`, `tools/send_message_senders.py:131`
- problem: The rubric says vendor SaaS connectors and observability backends ship as standalone plugin repos. In-tree today: `spotify` (508 LOC, plus 390 in core `hermes_cli/auth_spotify.py` and a core `spotify` toolset at `toolsets.py:178`), `google_meet` (2,042), `teams_pipeline` (1,634, wired by name into `gateway/run.py:3876-3884` with its own enable check at `:2890-2893`), `observability/langfuse` (1,044, plus a "Langfuse Cloud" row in core `hermes_cli/tools_config.py:382-386`). All predate the June 2026 rule (spotify 2026-04-24 8d12fb1e6b, google_meet 2026-04-27 df3c9593f8, teams_pipeline 2026-05-08 07bbd93337); only `observability/` is named as precedent, and the gist (§5) lists this as a contradiction to settle. Core also imports specific plugins: `gateway/run_profile_reconcile.py:260` imports `plugins.memory.holographic.store`; `tools/send_message_senders.py` imports telegram 6×. Each is plugin-specific logic in core, which `plugins/AGENTS.md:9-15` forbids.
- move: Move spotify, google_meet, teams_pipeline and observability/langfuse to standalone repos in `plugin-catalog/`, with the auto-migration already used for honcho/hindsight/supermemory (`hermes_cli/memory_provider_migration.py`). Replace `_wire_teams_pipeline_runtime` with the generic surface the plugin can already reach (`on_plugin_loaded`, `ctx.inject_message`, platform handlers). Move `auth_spotify.py` and the `spotify` toolset into the plugin. Replace the holographic import with a `MemoryProvider.release_home(home)` ABC method (default no-op).
- reference: llm `llm/plugins.py:10-13` (`DEFAULT_PLUGINS` holds only first-party defaults; vendor models ship as separate `llm-*` packages).
- loc_delta: −5,600 in-tree (moved out; about −120 in core)
- risk: Users with these enabled need the catalog auto-install path on `hermes update`; their tests under `tests/plugins/` move to the plugin repos. This is a maintainer policy decision as much as a code one.
- depends_on: []

### PLG-08 — Extension surface with no in-tree consumer
- severity: medium · effort: S · kind: kill · low_hanging: false
- evidence: `hermes_cli/plugins.py:109-205`, `hermes_cli/kanban_db.py:269`, `hermes_cli/kanban_db.py:2372`, `agent/plugin_stream_hooks.py:101-108`, `hermes_cli/middleware.py:20-26`, `hermes_cli/plugin_events.py:66-88`, `hermes_cli/plugins_dispatch.py:99-100`, `gateway/builtin_hooks/__init__.py:1`, `plugins/plugin_utils.py:1-14`, `AGENTS.md:77-79`
- problem: Of 41 `VALID_HOOKS`, 26 have no subscriber in `plugins/` or in the built-in observability map (child scan, `notes/11-sub-hooks.md` "Hooks with no invoke site or no consumer"), including all 8 kanban hooks (added together in 5e10351683) and the 4 stream hooks, which start one daemon thread per registered callback (`agent/plugin_stream_hooks.py:101-108`). Middleware's only in-tree consumer was the removed `nemo_relay` plugin (`git log -S register_middleware`: 2e0c9083db, 0c8cf21882). `broadcast_plugin_event` has no callers; the event bus reserves the `hermes:` namespace but core never publishes to it; `gateway/builtin_hooks/` is a docstring; `plugins/plugin_utils.py` has no importers. The root rubric rejects "hooks/callbacks/extension points with no concrete consumer"; the compat contract (`plugins/AGENTS.md:125`, `:132-133`) forbids removing `PluginContext` methods without a two-minor deprecation.
- move: Internal-only, delete now: `gateway/builtin_hooks/`, `HookRegistry._register_builtin_hooks`. Public surface: check the catalog pins (`plugin-catalog/*.yaml`) for users of middleware, `broadcast_plugin_event`, `plugin_utils`, the kanban and stream hooks; deprecate the unused ones per the contract. Make each `VALID_HOOKS` entry name its consumer in the table, so a hook without one is visible in review.
- reference: datasette `datasette/hookspecs.py:7-33` (each hookspec has an in-tree default implementation in `datasette/default_*`).
- loc_delta: −400 (after the deprecation window)
- risk: External plugins may use these (UNVERIFIED: catalog repos not cloned). Removal is gated by the compat contract.
- depends_on: []

### PLG-09 — `PluginContext` public API is assembled by `setattr` loops at import; static tools cannot see it
- severity: medium · effort: S · kind: hygiene · low_hanging: false
- evidence: `hermes_cli/plugins.py:1087-1169`, `hermes_cli/plugins.py:1189-1194`, `hermes_cli/plugins.py:231`, `hermes_cli/plugins.py:839-879`, `hermes_cli/plugins.py:38-61`
- problem: Eight public registrars (`register_image_gen_provider` … `register_transcription_provider`) do not exist in source: a table of 7-tuples is turned into methods by a `setattr` loop (`:1167-1168`), and a second loop wraps every `register_*` by name with the abandoned-load guard (`:1191-1193`). Pyright/ty, IDE completion and `rg "def register_web_search_provider"` cannot find them. `PluginContext` is an 854-line class that also carries platform-specific registrars (`register_slack_action_handler`, `register_telegram_handler`) on the generic surface. The facade re-exports ~40 sibling names under `# noqa: F401` (`:38-61`).
- move: Write the 8 registrars as explicit 3-line methods that call `_register_scoped_provider` with a row from the table (data stays a table; methods become greppable and typed). Move the abandoned-load guard into the single registration choke point from PLG-04 instead of a by-name wrapper. Move `PluginContext` to `hermes_cli/plugin_context.py`. Keep `register_slack_action_handler`/`register_telegram_handler` as documented aliases of `register_platform_handler` (the contract forbids removal).
- reference: llm `llm/hookspecs.py:7-33` (the whole plugin surface is six explicit functions in one ~30-line file).
- loc_delta: +40
- risk: Whether the docs build reads docstrings off the generated methods (UNVERIFIED). Tests calling the generated methods keep working.
- depends_on: [PLG-04]

### PLG-10 — Plugin discovery is an import side effect, with lazy catch-up calls scattered across readers
- severity: medium · effort: M · kind: restructure · low_hanging: false
- evidence: `model_tools.py:158-164`, `plugins/AGENTS.md:67-69`, `hermes_cli/plugins.py:1835`, `hermes_cli/plugins.py:1914`, `hermes_cli/plugins.py:2238`, `hermes_cli/plugins.py:1355-1359`, `providers/__init__.py:575`
- problem: `discover_plugins()` runs because something imported `model_tools.py` (`:162`). `plugins/AGENTS.md:67-69` lists this as a pitfall: code that reads plugin state without importing `model_tools` must call `discover_plugins()` itself. The code compensates with `_ensure_plugins_discovered` (`:2238`), `_delivery_manager` (`:1914`), a background discovery thread (`:1835`) and a re-entrancy escape for plugins whose `register()` imports `model_tools` (`:1355-1359`). Model providers discover lazily on first `get_provider_profile()`. Startup order is implicit and differs per entry point (CLI, gateway, TUI, ACP, cron worker).
- move: Each entry point calls one explicit `hermes_cli.plugin_boot.boot(home)` stage after config load and before the first agent build; registry readers assert `booted(home)` instead of discovering. Remove the `model_tools` import side effect and `_ensure_plugins_discovered`.
- reference: home-assistant-core `homeassistant/bootstrap.py:311` (`async_setup_hass`) and `:890` (`_async_set_up_integrations`, staged setup with timeouts).
- loc_delta: −60
- risk: Tests and embedders rely on "import model_tools → plugins loaded". Background discovery exists for CLI startup latency; the boot stage must keep it off the critical path where it is today.
- depends_on: []

## Kill list

| target | why | importers/callers | evidence |
|---|---|---|---|
| `gateway/hooks.py::HookRegistry.emit/emit_collect` + 8 `self.hooks.emit*` sites | second hook bus; replaced by an adapter onto `VALID_HOOKS` (PLG-03) | 8 sites in `gateway/` | `gateway/hooks.py:121-139`; `rg -n "hooks.emit\(|hooks.emit_collect\(" -g '!tests/**'` = 8 |
| `gateway/builtin_hooks/` + `HookRegistry._register_builtin_hooks` | empty package, empty extension point | 0 | `gateway/builtin_hooks/__init__.py:1`, `gateway/hooks.py:86-87` |
| `plugins/plugin_loader.py` | third import-by-path + collector; folds into one loader (PLG-01) | 3 (memory, context_engine, cron) | `plugins/plugin_loader.py:93`, `:144-150` |
| `hermes_cli/plugins_ledger.py::_register_fallback_hook`, `_drop_fallback_hooks`, `PluginManager._memory_hook_registrations` | exist only because memory dirs load twice (PLG-06) | memory loader | `hermes_cli/plugins_ledger.py:179-201`, `hermes_cli/plugins.py:1253-1254` |
| `hermes_cli/plugins_manifest.py::_detect_kind_from_source` + 3 `_is_*_dir` text sniffers | kind guessed from a substring of `__init__.py` | 4 | `hermes_cli/plugins_manifest.py:268`, `plugins/memory/__init__.py:64`, `plugins/context_engine/__init__.py:22`, `plugins/cron_providers/__init__.py:21` |
| `plugins/spotify`, `plugins/google_meet`, `plugins/teams_pipeline`, `plugins/observability` (+ `hermes_cli/auth_spotify.py`, `gateway/run.py::_wire_teams_pipeline_runtime`) | vendor products in-tree against `AGENTS.md:97-102` | core: 1 import, 1 toolset, 1 auth module, 1 setup row | PLG-07 |
| `plugins/plugin_utils.py` | 0 in-tree importers; documented author helper (deprecate, don't delete) | 0 | `rg plugin_utils -g '!tests/**'`; `website/docs/developer-guide/plugins/index.md:1025` |

## Simplify list

| what N things | become what 1 thing | lines saved | evidence |
|---|---|---|---|
| 7 discovery systems (PM, memory, context_engine, cron, model-providers, dashboard, gateway hooks) | one `PluginManager` scan + `PluginKind` table | ~1,500 | PLG-01 |
| 6 import-by-path copies + 9 host-routing branches | `plugin_isolation.import_user_code` | ~150 | PLG-02 |
| plugin hooks + gateway `HOOK.yaml` events (shell hooks and webhooks already adapters) | one hook bus with 3 config adapters | ~250 | PLG-03 |
| 5 registry implementations + 18 manager-local containers | `ProviderRegistry` + one `RegistrationStore` | ~400 | PLG-05 |
| 3 collector classes + the dual-load ledger special case | exclusive kinds loaded once, selected by name | ~300 | PLG-06 |
| 3 `hasattr(eps, "select")` entry-point shims across 2 groups | one group, kind in the manifest | ~40 | `hermes_cli/plugins_discovery.py:63`, `plugins/memory/__init__.py:116-118`, `providers/__init__.py:502-505` |

## Reference patterns to copy

| repo | path | pattern | where it applies here |
|---|---|---|---|
| jupyter_client | `jupyter_client/provisioning/factory.py:165-170` | one entry-point group per extension type, resolved by name via one factory | PLG-01 exclusive kinds |
| inspect_ai | `src/inspect_ai/_util/registry.py:127-148`, `:621-627` | one keyed registry `registry_key(type, name)`, one write path | PLG-04, PLG-05 |
| pluggy | `src/pluggy/_manager.py:185`, `:278-300`, `:482` | register/unregister a plugin object once; entry-point loading in one call | PLG-02, PLG-04; optional dispatch engine |
| llm | `llm/hookspecs.py:7-33`, `llm/plugins.py:10-52` | small explicit hookspec file; plugins contribute candidates via `register(...)`; defaults are first-party only | PLG-06, PLG-07, PLG-09 |
| datasette | `datasette/plugins.py:36-66`, `datasette/hookspecs.py:7-33` | one `pm`, each hookspec with an in-tree default implementation | PLG-08 |
| home-assistant-core | `homeassistant/bootstrap.py:311`, `:890`; `homeassistant/config_entries.py:151`, `:1075` | explicit staged boot; per-entry state machine with `async_unload` | PLG-10; unload ledger shape |

## Answer to the seam question

**How many extension mechanisms.** Counted from code (method per row in `notes/11-sub-kinds.md` and `notes/11-sub-hooks.md`):
(a) **7 systems that discover and import plugin code**: `PluginManager` (standalone/backend/platform kinds, `hermes_agent.plugins` entry points, portable Agent Plugins), `plugins/memory` (with its own `hermes_agent.memory_providers` group), `plugins/context_engine`, `plugins/cron_providers`, `providers/__init__.py` (model providers), the dashboard scanner (`*/dashboard/manifest.json`) and `gateway/hooks.py`. Plus a name-only scan of `plugins/platforms` in `gateway/config.py:280`. They use **4 precedence rules**.
(b) **~31 registries** plugins write into: 18 manager-local containers, 7 `ProviderRegistry` instances, and hand-rolled ones for secret sources, dashboard auth, platforms, model-provider profiles, tools, context references, redaction patterns and locale packs.
(c) **7 dispatch channels**: `VALID_HOOKS` (41 names) with shell hooks and outbound webhooks as config adapters onto it; middleware (4 kinds); the plugin event bus; the plugin→desktop broadcast; gateway `HOOK.yaml` events (9 names + `command:*`, `reaction:*`); the per-callback stream observer queue; ~20 single-slot callback setters (approval, vault, adapters).
(d) **3 non-code mechanisms**: skills (skill dirs, `external_dirs`, plugin `register_skill`), MCP servers (config + portable plugin MCP), toolsets (plugin toolsets derived from the tool registry).

**Could one pluggy-style hookspec/hookimpl + entry-point registry replace the bespoke ones?** Partly, and pluggy is not the first move. pluggy matches dispatch semantics Hermes already hand-built: argument-name subset matching is `_hook_callback_kwargs` (`plugins_dispatch.py:183`), `firstresult` covers the first-wins hooks, hook wrappers cover middleware, `unregister` covers the ledger for hooks, and `load_setuptools_entrypoints` replaces the entry-point code written three times. That is ~400 lines. It does not cover what makes this subsystem large: one manager per profile home, lease-based unload of ~31 registries for force reload, the plugin-host process boundary, callback timeouts with fail-closed policy hooks, manifests/catalog/consent. It would also move the plugin API from `ctx.register_hook(name, fn)` to `@hookimpl` functions, which the compat contract allows only as an addition. The code-judo move is upstream of pluggy: collapse the 7 discovery systems into one loader with a kind table (PLG-01), put every registration through one choke point (PLG-04/05), and fold gateway hooks into the one bus (PLG-03). After that, swapping `invoke_hook` for a pluggy hook relay is a contained, optional change.

## Cross-seam notes

- 03-pm-flows: the install/update/catalog lifecycle is ~5k LOC (`hermes_cli/plugins_cmd*.py` ~4.0k, `plugins_transaction.py`, `plugins_provenance.py`, `plugins_updates.py`, `plugins_cadence.py`, `pm/plugin_*.py`); one plugin's state lives in `plugins.enabled`, `plugins.entries.<id>`, `.install-metadata.json`, plugin state JSON and PM receipts (`hermes_cli/plugins_provenance.py:1-6`).
- 05-providers: `providers/__init__.py:575-643` has its own discovery plus `hermes_cli/plugin_host_profiles.py` (153) for isolation; `PROVIDER_REGISTRY` (`hermes_cli/auth.py:250`) mirrors plugin providers via `hermes_cli/auth_plugin_providers.py:45`.
- 06-tools: `tools/send_message_senders.py:131,141,203,214,253,264` import `plugins.platforms.telegram` directly; `tools/web_tools.py:19` imports firecrawl; `tools/image_generation_tool.py:178` imports fal.
- 08-state / profile scope: dashboard plugins resolve user plugins from the process launch home (`hermes_cli/web_server_dashboard.py:487-494`) while `PluginManager` is per active home (`hermes_cli/plugins.py:1768`).
- 10-gateway: `gateway/run.py:2890-2893`, `:3876-3884` teams_pipeline wiring; `gateway/config.py:280` rescans `plugins/platforms` for enum names, duplicating the PM category recursion; `gateway/run_profile_reconcile.py:260` imports `plugins.memory.holographic.store`.
- 13-tui-cron: 8 kanban hooks fired from `hermes_cli/kanban_db.py` have no in-tree consumer; kanban is core (~18.4k LOC) with a 1.8k-line dashboard plugin.
- 14-errors-obs: `gateway/hooks.py:101`, `:137` report errors with `print`; `hermes_cli/lifecycle.py:26-29` runs the built-in observability observer before plugins on every hook.
- 15-kill: `hermes_cli/plugin_compat.py` (22 lines, inert stubs kept for pre-removal updaters); `plugins/__init__.py` is a one-line comment.

## UNVERIFIED

- Runtime effect of PLG-04 (context-reference re-registration failing on force reload; stale platform-handler factory after a targeted disable) is read from code, not executed. Verify with a temp `HERMES_HOME`, a plugin that calls `register_context_reference`, then `discover_plugins(force=True)` and an identity check on `get_context_reference_providers()`.
- Whether external catalog plugins use middleware, `broadcast_plugin_event`, `plugins.plugin_utils`, kanban hooks or stream hooks (PLG-08). Verify by cloning each `plugin-catalog/*.yaml` pin and grepping.
- Whether pluggy is already a runtime dependency (it appears in `uv.lock`, likely via pytest). Verify from the lock entry's dependents.
- Per-hook invoke-site counts and the "26 hooks with no in-tree consumer" figure come from a child regex scan (`notes/11-sub-hooks.md`); I re-opened only `plugins.py:1992-2003`, `:2038-2060`, `run_inbound.py:806-846`, `kanban_db.py:269`, `:2372`.
- LOC deltas are estimates from file sizes, not drafted patches.
- Whether website docs are generated from the `setattr`-built registrar docstrings (PLG-09 risk).
- The exposure in PLG-02 under multiplex (what a `handler.py` loaded for profile B can read inside the gateway process) was not exercised. What is verified: `gateway/hooks.py:59-65` imports it in-process and `gateway/hooks.py` has no isolation check.
- The "~31 registries" count combines my reading of `plugins_ledger.py:288-295` (18 containers) with the child's registry table; context-reference, redaction and locale registries were opened, transports and streaming TTS were not.
