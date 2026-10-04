# 07 Config, environment variables, profiles, secret scope

Checkout `origin/main` ea81748579. Reference SHAs: pydantic-settings 5927b44, svcs 5d93cbc, structlog 91f44ae, attrs a602f78.

## TL;DR

- Structural problem: a profile is not an object. 'Which profile am I serving' is spread over 9 ambient channels (6 ContextVars, 3 process globals) plus os.environ, and 7 hand-written binders each set a different subset. That is the mechanism behind the #1 bug class (profile_scope_leak: 366 fix commits, 305 issues, 6 reverts).
- Biggest kill: the config -> os.environ bridges. Three hand-written TERMINAL_* maps disagree on home_mode/modal_mode/temp_dir; the gateway exports every top-level scalar config key into os.environ at import time; the bridge runs from 8 call sites. Tools should read typed settings from the bound scope.
- Biggest simplification: one pydantic settings model (pydantic 2.13 is already a core dependency) replaces DEFAULT_CONFIG-as-schema-by-example, the 10+ side tables in config.py, the hand validators, and the three loaders whose only difference is 'merge defaults or not' (model_fields_set answers presence).
- Low-hanging fruit: 3 (CFG-03 classic-CLI second defaults table that drifted: max_turns 500 vs unlimited, delegation 45 vs 250, and --ignore-user-config not honored by load_config(); CFG-04 interim single terminal map; CFG-05 one HermesPaths object for ~12 home resolvers).
- Seam answer: no typed model and no ordered sources. Config is a dict read ad hoc (496 load_config() call sites, 760 '(... or {}).get(' chains); env is both secret store and config bus; profile scope is process-global env plus loose contextvars. Target: HermesSettings (typed, ordered sources) carried inside one frozen ProfileScope bound by one ContextVar.

## What this area is

Covered 20,956 lines in 35 files (wc -l): `hermes_cli/config.py`, `hermes_cli/config_*.py`, `hermes_cli/cli_config_load.py`, `hermes_cli/managed_scope.py`, `hermes_cli/env_loader.py`, `hermes_cli/profiles.py`, `hermes_cli/profile_*.py`, `hermes_constants.py`, `hermes_yaml.py`, `agent/secret_scope.py`, `agent/secret_sources/`, `tools/terminal_scope.py`, `gateway/config_env.py`, `gateway/config_loader.py`, `binders: gateway/run.py::_profile_runtime_scope, tui_gateway/model_switch.py, cron/scheduler*.py, hermes_cli/kanban_db_dispatch.py`.

Entry points: `hermes_cli/main.py::_apply_profile_override` (process profile), `hermes_cli/config.py::load_config` (most readers), `hermes_cli/cli_config_load.py::load_cli_config` (classic CLI), `hermes_cli/config_effective.py::load_user_config_effective` (gateway/TUI/cron), `gateway/run.py::_profile_runtime_scope` (per-turn profile binding), `agent/secret_scope.py::get_secret` (credential reads).

| module | loc | owns |
|---|---|---|
| `hermes_cli/config.py` | 4249 | load_config/read_raw_config + 5 caches, ${VAR} expansion, config writers, hermes config get/set/unset CLI, validation tables, .env writer, install-method detection, show_config UI, platform manifests |
| `hermes_cli/config_defaults.py` | 3198 | DEFAULT_CONFIG (dict literal, _config_version 49) and OPTIONAL_ENV_VARS; the de facto schema |
| `hermes_constants.py` | 1411 | home resolution (get_hermes_home + 3 siblings + pin), profile markers/tombstones, plus unrelated node/venv lookup, reasoning-effort parsing, OpenRouter URLs, WSL paths, scratch dir; imported by 525 in-scope files |
| `hermes_cli/profiles.py` | 2579 | profile CRUD, clone/export/import/rename, alias wrappers, served-set enumeration, active_profile sticky file |
| `hermes_cli/config_migrations.py` | 853 | migration ladder v12..v49; each step read-modify-writes config.yaml |
| `hermes_cli/env_loader.py` | 824 | process dotenv load into os.environ (python-dotenv + interpolation), external secret-source hydration per home, terminal re-bridge |
| `agent/secret_scope.py` | 453 | _SECRET_SCOPE ContextVar, multiplex flag + context, get_secret, the private .env tokenizer, build_profile_secret_scope, _GLOBAL_ENV_EXACT allowlist |
| `hermes_cli/cli_config_load.py` | 317 | classic-CLI loader: its own defaults table, its own merge, its own config->env mirror |
| `hermes_cli/config_effective.py` | 109 | third loader: user file + managed overlay + expansion, NO defaults (gateway, TUI, cron) |
| `tools/terminal_scope.py` | 213 | terminal-policy ContextVar; builds the complete TERMINAL_* mapping for a profile |
| `gateway/config_env.py` | 654 | env -> GatewayConfig overrides (env wins over YAML for platform credentials/flags) |

## How it works end to end

### A message for secondary profile B arrives at a multiplexing gateway; a tool reads config, a secret and the terminal backend

Trigger: hermes gateway run (default profile A, gateway.multiplex_profiles on); inbound message routed to profile B

Inputs: `multiplex_profiles` (bool, default True): gateway serves several profiles from one process; `secret_in_B_env` (bool, default True): the requested credential exists in B's .env or secret sources; `var_is_global` (bool, default False): the env var name is on secret_scope._GLOBAL_ENV_EXACT / prefixes

1. `gateway/run.py::_bridge_config_to_env` (`gateway/run.py:2094`): at IMPORT time, exports launch profile A's config into os.environ: every top-level scalar key, terminal.*, auxiliary.*, agent timeouts, display, timezone, redaction. [CFG-04]
2. `gateway/run_turn.py::_profile_scope_for_source` (`gateway/run_turn.py:2274`) — only when `multiplex_profiles` = True: picks B's home and enters the per-turn binder.
3. `gateway/run.py::_profile_runtime_scope` (`gateway/run.py:1824`): binder #1 of 7: sets the home ContextVar, then secrets, then terminal policy, each with its own token. [CFG-01]
4. `hermes_constants.py::set_hermes_home_override` (`hermes_constants.py:26`): sets _HERMES_HOME_OVERRIDE (ContextVar 1). [CFG-01]
5. `gateway/run.py::_load_profile_secret_scope` (`gateway/run.py:1808`): hydrate_profile_secret_sources (must run first: build only reads the per-home cache), then build_profile_secret_scope. [CFG-01]
6. `agent/secret_scope.py::build_profile_secret_scope` (`agent/secret_scope.py:391`): B's .env via the private tokenizer (no ${VAR} interpolation) + external sources + gateway allow-all bridge + managed .env. [CFG-06]
7. `agent/secret_scope.py::set_secret_scope` (`agent/secret_scope.py:143`): sets _SECRET_SCOPE (ContextVar 2). [CFG-01]
8. `tools/terminal_scope.py::build_profile_terminal_scope` (`tools/terminal_scope.py:89`): projects B's terminal policy through TERMINAL_CONFIG_ENV_MAP, which has no home_mode row. [CFG-04]
9. `hermes_cli/config.py::load_config` (`hermes_cli/config.py:2123`): a tool reads config: get_config_path -> get_hermes_home (override wins) -> DEFAULT_CONFIG deep-merge + expansion + managed overlay, cached per path. [CFG-02]
10. `agent/secret_scope.py::get_secret` (`agent/secret_scope.py:219`) — only when `var_is_global` = False: global name -> os.environ (A's values); else scope hit; else default under multiplex. [CFG-09]
11. `tools/terminal_scope.py::terminal_env` (`tools/terminal_scope.py:75`): terminal tool reads TERMINAL_* from the bound policy (ContextVar 3), not os.environ. [CFG-04]

### User runs `hermes -p work chat`; the classic CLI and its tools each load config their own way

Trigger: hermes -p work chat (classic CLI), optionally with --ignore-user-config / --safe-mode

Inputs: `ignore_user_config` (bool, default False): --ignore-user-config or --safe-mode was passed; `max_turns_set` (bool, default False): config.yaml sets agent.max_turns

1. `hermes_cli/main.py::_apply_profile_override` (`hermes_cli/main.py:594`): pre-parses -p (or the sticky active_profile file) and writes os.environ['HERMES_HOME'] before any other import. [CFG-05]
2. `hermes_cli/main.py::_apply_user_config_bypass` (`hermes_cli/main.py:3115`) — only when `ignore_user_config` = True: sets HERMES_IGNORE_USER_CONFIG=1 in os.environ. [CFG-03]
3. `cli.py (module body)` (`cli.py:336`): import-time: _hermes_home = get_hermes_home(); load_hermes_dotenv writes .env into os.environ. [CFG-05]
4. `hermes_cli/cli_config_load.py::load_cli_config` (`hermes_cli/cli_config_load.py:258`): loader #2: reads config.yaml itself (or the packaged cli-config.yaml when the bypass is set) over _cli_config_defaults. [CFG-03]
5. `hermes_cli/cli_config_load.py::_cli_config_defaults` (`hermes_cli/cli_config_load.py:182`): a second defaults table: agent.max_turns 500, delegation.max_iterations 45. [CFG-03]
6. `hermes_cli/cli_config_load.py::_mirror_config_to_env` (`hermes_cli/cli_config_load.py:121`): writes TERMINAL_*, AUXILIARY_*, HERMES_REDACT_SECRETS, HERMES_CJK_FTS into os.environ (bridge copy #2; no modal_mode/temp_dir rows). [CFG-04]
7. `hermes_cli/cli_init_mixin.py::_init_turn_limits` (`hermes_cli/cli_init_mixin.py:199`) — only when `max_turns_set` = False: max_turns = CLI arg > CLI_CONFIG agent.max_turns (500 default) > root key > HERMES_MAX_ITERATIONS; DEFAULT_CONFIG says null = unlimited. [CFG-03]
8. `hermes_cli/config.py::load_config` (`hermes_cli/config.py:2123`): every tool and subcommand reads loader #1 instead; it never consults HERMES_IGNORE_USER_CONFIG. [CFG-03]
9. `tools/delegate_tool_config.py::_load_config` (`tools/delegate_tool_config.py:442`) — only when `ignore_user_config` = True: delegate_task reads loader #1, but falls back to cli.CLI_CONFIG when the bypass is set, because only loader #2 honors it. [CFG-03]

## Findings

### CFG-01 A profile is not an object: scope is 9 ambient channels (6 ContextVars, 3 globals) set piecemeal by 7 hand-written binders

- severity: **critical** · effort: L · kind: restructure · low_hanging: false · loc_delta: -800 · depends_on: —
- evidence: `hermes_constants.py:18`, `hermes_constants.py:173`, `agent/secret_scope.py:28`, `agent/secret_scope.py:38`, `agent/secret_scope.py:112`, `tools/terminal_scope.py:23`, `cron/jobs.py:125`, `agent/secret_sources/base.py:35`, `gateway/run.py:1824`, `tui_gateway/model_switch.py:54`, `cron/scheduler_provider.py:119`, `cron/scheduler.py:3281`, `cron/scheduler.py:3395`, `hermes_cli/kanban_db_dispatch.py:2664`, `tui_gateway/launch_profile_policy.py:166`, `cron/scheduler.py:3285`

**Problem (today).** Root AGENTS.md defines a profile as 'home + secret scope + terminal scope'. In code each part is a separate ambient channel: _HERMES_HOME_OVERRIDE (hermes_constants.py:18), _SECRET_SCOPE (agent/secret_scope.py:112), _MULTIPLEX_CONTEXT (:38), hermes_terminal_scope (tools/terminal_scope.py:23), _cron_store_override (cron/jobs.py:125), the secret-source environment (agent/secret_sources/base.py:35), plus process globals _MULTIPLEX_ACTIVE, _AUTO_PINNED_HOME (agent/secret_scope.py:28-30) and _PINNED_PROCESS_HERMES_HOME (hermes_constants.py:173). No type says 'these travel together'. Each binder chooses its own subset and order: gateway/run.py:1824 binds home+secret+terminal; cron/scheduler_provider.py:119 binds home+cron store only; cron/scheduler.py:3281 binds secret+multiplex context and :3395 terminal separately; tui_gateway/model_switch.py:54 has a launch-profile special case that binds secret only until multiplex turns on; hermes_cli/kanban_db_dispatch.py:2664 and tui_gateway/launch_profile_policy.py:166 are two more. Beyond them, set_hermes_home_override( appears 127 times in 58 in-scope files (rg -c), each binding home alone. Construction has temporal coupling: build_profile_secret_scope only reads a per-home cache, so hydrate_profile_secret_sources must run first (cron/scheduler.py:3285-3287 documents the trap). A path that binds home but forgets secrets, or secrets but not terminal, compiles and passes single-profile tests, and reads the launch profile silently. This is the mechanism behind profile_scope_leak (366 fix commits, 305 issues, 6 reverts), secret_scope (70) and import_time_capture (29) in inputs/gist/C-fix-commit-classes.md.

**Move (proposed).** New module hermes_scope.py (stdlib + attrs/dataclass): frozen ProfileScope(home: Path, secrets: Mapping[str,str], terminal: TerminalPolicy | Refusal, settings: HermesSettings (CFG-02), multiplex: bool). One factory ProfileScope.load(home, *, hydrate: bool = True, env_overlay=None) owns the hydrate->build order. One ContextVar _SCOPE and one context manager bind(scope) (structlog.bound_contextvars shape) that installs and restores atomically. get_hermes_home(), get_secret(), terminal_env(), cron store resolution and load_config() read current_scope(); no other setter exists. The 7 binders collapse to `with bind(ProfileScope.load(home)):`; the launch-profile variant becomes ProfileScope.launch(frozen_env). Delete set/reset pairs for home, secret, terminal, multiplex context and cron store as public API (keep them private to hermes_scope during migration). Thread hops keep using copy_context(); one var means one thing to copy. The gist's profile-scope lint (P05/P06/P31-P33) shrinks to 'no reads of os.environ for profile values' because there is no partial binding left to lint.

**Reference.** svcs `src/svcs/_core.py:573` — Container: one per-request object that owns every per-scope service and is closed as a unit, instead of module-level state

**Risk.** Tests monkeypatch the individual setters and module-level binders (gateway.run._profile_runtime_scope is a documented seam); those seams move. Preserve: launch-profile scope uses .env over the env frozen at activation, never live os.environ (#107422, #112878); terminal refusal scope on unreadable policy; hydrate_secrets=False on flush paths (5s budget); copy_context propagation to executor threads.

### CFG-02 No typed config: DEFAULT_CONFIG is a schema-by-example and 10+ side tables patch the holes

- severity: **critical** · effort: L · kind: boundary · low_hanging: false · loc_delta: -2500 · depends_on: —
- evidence: `hermes_cli/config_defaults.py:33`, `hermes_cli/config.py:1001`, `hermes_cli/config.py:1228`, `hermes_cli/config.py:3199`, `hermes_cli/config.py:3384`, `hermes_cli/config.py:3414`, `hermes_cli/config.py:3426`, `hermes_cli/config.py:2925`, `hermes_cli/config.py:1891`, `hermes_cli/config.py:1919`

**Problem (today).** The config contract is a 2,700-line dict literal (hermes_cli/config_defaults.py:33). Types are inferred from the Python type of the default: _coerce_config_set_value keeps a string only 'if isinstance(_default_value_for_key(key), str)' (config.py:3384), so every key whose default is None or absent has no type. Side tables fill the gaps by hand: _EXTRA_KNOWN_ROOT_KEYS (:1001), _OPEN_DICT_TOP_LEVEL_KEYS, _SCHEMA_DEFINED_DICT_KEYS, _DYNAMIC_TOP_LEVEL_KEYS, _PLATFORM_CONTAINER_KEYS (:3199-3227), _KNOWN_CONTAINER_TYPES (:3414), _SCALAR_AS_ONE_ITEM_LIST_KEYS (:3426), _SECRET_CONFIG_KEYS + suffix rules (:2925-2934), _ENV_CONFIG_KEYS (:856), plus hand validators _validate_* (:1065-1271) and per-key coercers like resolve_turn_limit (:1891). Readers then walk dicts defensively: 496 load_config() and 142 load_config_readonly() call sites, 760 '(... or {}).get(' chains in 385 files, 201 '.get(x, {}).get(' chains in 118 files, 124 cfg_get( (rg -c over the in-scope tree; text counts). Every reader re-decides type, default and null handling. The gist counts the result: config_key_drift 28, stringly_bool_config 15, 'untyped YAML config shape / None deref' 3 of 20 static root causes in the 150-fix sample.

**Move (proposed).** New package hermes_cli/settings/: one pydantic v2 model per section (AgentSettings, TerminalSettings, DisplaySettings, DelegationSettings, ...) composed into HermesSettings(BaseModel, extra='allow' at the root for plugin sections, extra='forbid' inside owned sections). Field defaults replace DEFAULT_CONFIG; Annotated validators replace resolve_turn_limit and the bool parsers; SecretStr marks secrets so redaction reads the field type, not a suffix list. `hermes config set` coerces with TypeAdapter(field.annotation) and rejects unknown paths from the model, which deletes _validate_config_key's 5 tables. Readers call load_settings().agent.max_turns. DEFAULT_CONFIG stays only as HermesSettings().model_dump() for the docs and the YAML template. Migrate section by section: a section moves when its readers move. pydantic==2.13.4 is already a core dependency (pyproject.toml:71); pydantic-settings is optional (CFG-09 uses it for env).

**Reference.** pydantic-settings `pydantic_settings/main.py:152` — BaseSettings: typed model whose defaults, types and env/file sources are declared once on the class

**Risk.** Existing user files contain values the dict path tolerated (strings for bools, legacy shapes). Validation must be lenient on load (coerce + warn, never refuse to start) and strict only on `config set`. Comment-preserving writes (atomic_config_write, ruamel round-trip) must keep writing the user's raw mapping, never model_dump(). Plugins read arbitrary sections: keep extra='allow' at the root. 39k tests construct dict configs; provide HermesSettings.model_validate(dict) at the boundary so fixtures keep working.

### CFG-03 The classic CLI has its own loader and defaults table that drifted; --ignore-user-config only reaches it

- severity: **high** · effort: M · kind: collapse · low_hanging: true · loc_delta: -350 · depends_on: —
- evidence: `hermes_cli/cli_config_load.py:182`, `hermes_cli/cli_config_load.py:201`, `hermes_cli/cli_config_load.py:220`, `hermes_cli/config_defaults.py:78`, `hermes_cli/config_defaults.py:1364`, `hermes_cli/cli_init_mixin.py:206`, `hermes_cli/cli_config_load.py:265`, `hermes_cli/config.py:2357`, `hermes_cli/main.py:3111`, `hermes_cli/main.py:3118`, `tools/delegate_tool_config.py:442`, `hermes_cli/config_effective.py:52`

**Problem (today).** hermes_cli/AGENTS.md:99 names three loaders; there are more (load_config, load_config_readonly, read_raw_config(_readonly), read_user_config_raw, load_user_config_effective, load_cli_config, tui_gateway/server.py _load_cfg_raw, profiles._load_yaml_dict, terminal_scope's direct YAML read) with six caches (_LOAD_CONFIG_CACHE, _RAW_CONFIG_CACHE, _LAST_EXPANDED_CONFIG_BY_PATH in config.py:164-181; _EFFECTIVE_CACHE, _LAST_GOOD_USER_RAW in config_effective.py:28-30; the TUI _cfg_cache). The worst one is load_cli_config: _cli_config_defaults (cli_config_load.py:182) is a second defaults table that has drifted from DEFAULT_CONFIG. agent.max_turns is 500 there (:201) and None = unlimited in DEFAULT_CONFIG (config_defaults.py:78, c32119b12c 'default agent.max_turns to unlimited'); _init_turn_limits reads the CLI table (cli_init_mixin.py:206), so the classic CLI caps a turn at 500 iterations while the shared default is unlimited. delegation.max_iterations is 45 there (:220) and 250 in DEFAULT_CONFIG (config_defaults.py:1364). The bypass flag HERMES_IGNORE_USER_CONFIG, set by --ignore-user-config and --safe-mode (main.py:3111, :3118), is honored by load_cli_config (:265) and require_parseable_user_config only; _load_config_impl (config.py:2357) never checks it, so the 496 load_config() readers still read the user file. tools/delegate_tool_config.py:442 codes around exactly this asymmetry by falling back to cli.CLI_CONFIG.

**Move (proposed).** Delete _cli_config_defaults and _merge_file_config. load_cli_config becomes load_config() plus the CLI-only cwd rule (terminal.cwd '.' -> os.getcwd()) applied at the CLI call site. Move the bypass into the one loader: get_config_path() returns None (empty user layer) when the bypass is active, so every reader honours it. Delete the CLI_CONFIG fallback in tools/delegate_tool_config.py:449-456. After CFG-02, collapse the remaining loaders into load_settings(home) -> LoadedConfig(settings, user_set: frozenset[path], raw) cached once per (home, file signature, env snapshot); 'no defaults' readers use loaded.is_set('gateway.x') instead of a separate loader, which deletes config_effective.py.

**Reference.** pydantic-settings `pydantic_settings/main.py:330` — settings_customise_sources: one ordered source list per settings class; no per-surface loaders

**Risk.** Behaviour change notice needed: classic-CLI users with no agent.max_turns go from 500 to unlimited (that is the documented default) and delegation children from 45 to 250 iterations. Tests patch cli.CLI_CONFIG (83 hits in 17 in-scope files, 22 test files); keep CLI_CONFIG as the result of load_config() for one release. The packaged cli-config.yaml fallback must survive for --ignore-user-config.

### CFG-04 os.environ is the config bus: three disagreeing TERMINAL_* maps, an import-time export of every scalar key, three precedence rules

- severity: **high** · effort: M · kind: collapse · low_hanging: true · loc_delta: -400 · depends_on: CFG-01, CFG-02
- evidence: `hermes_cli/config.py:2159`, `hermes_cli/cli_config_load.py:83`, `gateway/run.py:2021`, `gateway/run.py:2096`, `gateway/run.py:2146`, `hermes_cli/config.py:2205`, `hermes_cli/cli_config_load.py:149`, `gateway/run.py:1975`, `tools/terminal_tool.py:661`, `hermes_cli/env_loader.py:571`, `tools/terminal_scope.py:105`, `agent/secret_scope.py:405`

**Problem (today).** Tools read settings from env vars, so every surface projects config.yaml into os.environ. The terminal projection exists three times as hand-written maps: TERMINAL_CONFIG_ENV_MAP (config.py:2159), _TERMINAL_ENV_MAPPINGS (cli_config_load.py:83) and a local dict in _bridge_terminal_config_to_env (gateway/run.py:2021). scripts/cfg_terminal_maps.py diffs them: home_mode is missing from the config.py map (which terminal_scope.py:105 and apply_terminal_config_to_env use) but present in the CLI and gateway maps; modal_mode and temp_dir are only in the config.py map. Seven DEFAULT_CONFIG.terminal keys are bridged by none. Precedence is defined three ways: CLI 'env wins unless the file has a terminal section' (cli_config_load.py:149), gateway 'config.yaml unconditionally wins' (gateway/run.py:1975), apply_terminal_config_to_env 'explicit raw keys win, defaults backfill' (config.py:2205). The bridge runs from 8 call sites (rg 'apply_terminal_config_to_env(' plus the two private copies), including inside the terminal tool itself (tools/terminal_tool.py:661). The gateway also exports EVERY top-level scalar config key as an env var of the same name at import time (gateway/run.py:2096-2098, run at :2146). In-scope code writes os.environ[...] 133 times in 59 files. Env is process-global, so whatever the launch profile wrote is what an unbound read of another profile sees (the 'first-writer-wins backend leak', #68559, cited at gateway/run.py:1847). The same bus forces agent/secret_scope.py:405 to import a gateway allow-all bridge and re-seed it into the default profile's secret scope.

**Move (proposed).** End state (with CFG-01/02): tools read current_scope().settings.terminal (a TerminalSettings model); env vars exist only as the serialization for child processes, produced once by TerminalSettings.to_child_env() at spawn (served_profile_child_env already is that seam). Delete _mirror_config_to_env, _bridge_config_to_env, _bridge_terminal_config_to_env, _bridge_auxiliary_config_to_env, the top-level scalar export, and apply_terminal_config_to_env for in-process consumers. Interim S step that pays off now: derive one map from DEFAULT_CONFIG['terminal'] keys (backend -> TERMINAL_ENV, else TERMINAL_<KEY>) in config.py, import it in cli_config_load.py and gateway/run.py, and pick one precedence rule (explicit file key > env > default, which is what terminal_scope already does).

**Reference.** pydantic-settings `pydantic_settings/sources/providers/env.py:47` — EnvSettingsSource reads env INTO the typed model once; nothing writes the model back out to os.environ

**Risk.** Child processes (terminal backends, TUI, dashboard PTY, cron workers) genuinely consume TERMINAL_* env; the spawn-time serialization must cover them. Users with TERMINAL_* in .env rely on env-overrides-default. The docker_image 'pinned' provenance flag (config.py:2236, terminal_scope.py:139) must survive. Changing precedence is a behaviour change for whichever surface loses its current rule.

### CFG-05 'Which home' is answered by about 12 functions plus a process-global pin

- severity: **high** · effort: M · kind: collapse · low_hanging: true · loc_delta: -250 · depends_on: CFG-01
- evidence: `hermes_constants.py:111`, `hermes_constants.py:160`, `hermes_constants.py:176`, `hermes_constants.py:199`, `hermes_constants.py:216`, `hermes_cli/profiles.py:286`, `hermes_cli/profiles.py:2551`, `gateway/shutdown_watchdog.py:178`, `gateway/lifecycle_ledger.py:27`, `hermes_cli/env_loader.py:793`, `hermes_startup_watchdog.py:100`, `tui_gateway/server.py:424`, `agent/secret_scope.py:41`, `hermes_cli/main.py:594`

**Problem (today).** hermes_constants.py has four home resolvers: get_hermes_home (:111, override > env > default), get_process_hermes_home (:160, env live, ignores override), get_routing_process_hermes_home (:199, pin > process) and get_default_hermes_root (:216, memoised root inference). A host pin (pin_process_hermes_home, :176) is a process global that set_multiplex_active also sets and conditionally clears (agent/secret_scope.py:41-65). Around them sit local re-derivations: profiles._get_profiles_root and _get_default_hermes_home (profiles.py:286-292), profile_root_for_env_home (:2551), and four private _process_hermes_home functions. Two of those are copy-pasted (gateway/shutdown_watchdog.py:178, gateway/lifecycle_ledger.py:27) with semantics different from the canonical one: 'process home if HERMES_HOME is set, else get_hermes_home()', which honours a task override when the env var is empty. gateway/AGENTS.md:244-251 needs a rule ('do not add another routing decision that compares against get_process_hermes_home') to keep contributors choosing the right one. The launch home is mutable because the CLI creates it by writing os.environ['HERMES_HOME'] before imports (hermes_cli/main.py:594).

**Move (proposed).** One frozen HermesPaths(launch_home, root, profiles_root) built once at process start from argv/env (the code now in _apply_profile_override and get_default_hermes_root) and stored on the process. An embedding host constructs it with its own launch_home, which replaces pin_process_hermes_home and _AUTO_PINNED_HOME. Per-task home is current_scope().home (CFG-01). Delete get_process_hermes_home, get_routing_process_hermes_home, the pin API and every private _process_hermes_home; profiles.py reads paths.profiles_root.

**Reference.** attrs `src/attr/_next_gen.py:431` — frozen value object computed once and passed or stored; evolve() for variants instead of mutable globals

**Risk.** get_process_hermes_home follows HERMES_HOME live on purpose for process-level assets (themes, dashboard manifests; hermes_constants.py:160-167); that read must map to paths.launch_home. Hermes WebUI mirrors the served profile into HERMES_HOME per turn; it must switch to constructing HermesPaths explicitly. Tests set HERMES_HOME per test (autouse fixture) and expect live pickup; provide a reset hook for tests.

### CFG-09 Env vars have no declaration: 229 HERMES_* names, 895 raw reads, and a hand allowlist decides global vs secret

- severity: **high** · effort: L · kind: boundary · low_hanging: false · loc_delta: -300 · depends_on: CFG-02, CFG-04
- evidence: `agent/secret_scope.py:174`, `agent/secret_scope.py:202`, `agent/secret_scope.py:236`, `hermes_cli/config_defaults.py:2776`, `hermes_cli/config.py:185`, `gateway/run.py:1977`, `hermes_cli/cli_init_mixin.py:208`

**Problem (today).** inputs/metrics/env_names.json lists 229 distinct HERMES_* names; in-scope code calls os.getenv/os.environ.get 895 times in 390 files and get_secret 155 times in 81 files (rg -c). Nothing declares which names exist, their type, or whether a name is a per-profile secret or a process setting. get_secret classifies by a hand list, _GLOBAL_ENV_EXACT + _GLOBAL_ENV_PREFIXES (agent/secret_scope.py:174-206), defaulting to 'secret'. A name missing from the list reads from the wrong source under multiplex. Secrets are declared in a third place (OPTIONAL_ENV_VARS, config_defaults.py:2776, plus _EXTRA_ENV_KEYS, config.py:185). Many HERMES_* names are config carriers written by the bridges (HERMES_MAX_ITERATIONS, HERMES_AGENT_TIMEOUT, gateway/run.py:1977-1987) and read back elsewhere (cli_init_mixin.py:208). The gist counts new_hermes_env_var at 217 fix commits.

**Move (proposed).** Two declared models. ProcessEnv(BaseSettings, env_prefix='HERMES_') lists every legitimate process-level variable with its type (HERMES_HOME, HERMES_KANBAN_*, API_SERVER_* listener settings, debug switches); it is read once at start into HermesPaths/process state. Secrets are fields of a SecretsModel built from OPTIONAL_ENV_VARS (SecretStr). get_secret's global-vs-secret decision becomes 'is the name a ProcessEnv field', so _GLOBAL_ENV_EXACT disappears. Config-carrier env vars disappear with CFG-04. The gist's 'no new non-secret HERMES_* reads' ratchet becomes 'add a field', which review can see.

**Reference.** pydantic-settings `pydantic_settings/main.py:65` — env_prefix / env_nested_delimiter: env names derived from declared fields, not hand lists

**Risk.** Some env names are external contracts (systemd units, Docker images, Desktop app, documented debug flags). Keep the names; only their declaration moves. pydantic-settings would be a new dependency (pin per policy) or a 60-line in-house EnvSource can do the same.

### CFG-06 The same .env file is parsed by three parsers with different semantics

- severity: **medium** · effort: S · kind: collapse · low_hanging: false · loc_delta: -120 · depends_on: —
- evidence: `agent/secret_scope.py:335`, `agent/secret_scope.py:352`, `hermes_cli/env_loader.py:324`, `hermes_cli/env_loader.py:343`, `hermes_cli/profile_channels.py:212`, `hermes_cli/config.py:2565`

**Problem (today).** agent/secret_scope.py:352 calls load_env_file 'THE .env tokenizer' so 'no two boundaries disagree'. It is a private tokenizer (_parse_env_text :335) with no ${VAR} interpolation. The launch process installs the same file into os.environ with python-dotenv's DotEnv parser plus a custom ${VAR}/${VAR:-default} resolver (hermes_cli/env_loader.py:324-350). Profile channel inventory uses a third, dotenv_values (hermes_cli/profile_channels.py:212). So a line KEY=${OTHER} yields the expanded value for the launch profile (os.environ path) and the literal '${OTHER}' for a routed profile (secret-scope path). config.py:2565 keeps a forwarding _parse_env_value as a frozen compat surface for pre-PM updaters.

**Move (proposed).** One parser module (hermes_cli/dotenv_file.py or inside hermes_scope.py) returning Dict[str, str] with one documented interpolation rule (resolve against the file itself, then the process launch env snapshot). env_loader publishes that dict into os.environ for the launch profile only; build_profile_secret_scope and profile_channels consume the same dict. Decide the interpolation rule explicitly in the PR.

**Reference.** pydantic-settings `pydantic_settings/sources/providers/dotenv.py:27` — DotEnvSettingsSource: one dotenv reader feeding the typed model, same parsing for every consumer

**Risk.** Any change to interpolation alters credential values for someone; the ${VAR} pass-peeling in env_loader (_DOTENV_PUBLISHED) exists for layered files and must keep working. The frozen compat name config._parse_env_value must stay until the pre-PM updater compat window closes.

### CFG-07 Migrations are 18 separate read-modify-write file round trips; a failed step is skipped and the version is still stamped latest

- severity: **medium** · effort: M · kind: restructure · low_hanging: false · loc_delta: -60 · depends_on: —
- evidence: `hermes_cli/config_migrations.py:60`, `hermes_cli/config_migrations.py:831`, `hermes_cli/config_migrations.py:839`, `hermes_cli/config.py:1412`, `hermes_cli/config.py:1355`

**Problem (today).** Each migration step re-reads config.yaml through read_raw_config, mutates, and persists through _commit -> _persist_migration (config_migrations.py:60-72; 18 persist/_commit calls in the file by rg -c). run_migrations catches any exception from a step, records a warning and continues (:839-853). migrate_config then stamps _config_version = latest unconditionally (config.py:1411-1413), so a skipped step can never run again; the comment at :849-851 says so. A crash mid-ladder leaves the file at an intermediate shape with the old version stamp. migrate_config also rewrites .env first (sanitize_env_file, :1355).

**Move (proposed).** Steps become pure functions dict -> dict over the raw mapping. run_migrations folds them in memory, stops at the first failure, and writes once through atomic_config_replace with _config_version = last successful target. Interactive prompts (missing env vars, skill config) run after the write, as today. With CFG-02 the ladder runs on the raw dict before model validation.

**Reference.** none

**Risk.** Steps that today rely on reading their predecessor's persisted output must take the in-memory dict instead. The v12 support floor and LEGACY_KEY_STEPS for unversioned files must keep their semantics. A user who hit a skipped step under the current code is already stamped latest; decide whether to re-run idempotent steps once.

### CFG-08 hermes_constants.py is a 1,411-line grab bag imported by 525 files

- severity: **medium** · effort: M · kind: restructure · low_hanging: false · loc_delta: 0 · depends_on: CFG-05
- evidence: `hermes_constants.py:1`, `hermes_constants.py:489`, `hermes_constants.py:994`, `hermes_constants.py:1109`, `hermes_constants.py:1233`, `hermes_constants.py:1279`, `hermes_constants.py:1163`, `hermes_constants.py:892`

**Problem (today).** The docstring promises 'shared constants, import-safe'. Roughly 400 lines are home/profile resolution; the rest is node and agent-browser executable lookup (:428-552), reasoning-effort parsing and per-model routing (:994-1130), OpenRouter and AI Gateway URLs (:1231-1276), venv paths (:1279-1353), WSL path translation (:1163-1188), scratch-dir policy (:742-992), IPv4 preference, partial-update hints. 525 in-scope files import it (rg -l). Every concern in it shares one import edge into every package, and root AGENTS.md says executable resolvers belong in hermes_platform/resolver/, which this file contradicts.

**Move (proposed).** Split by owner: home/profile -> hermes_scope.py / HermesPaths (CFG-01, CFG-05); reasoning parsing -> agent/reasoning_config.py; provider URLs -> providers/; node/venv/agent-browser lookup -> hermes_platform/resolver/; scratch policy -> the existing hermes_constants_scratch.py. hermes_constants keeps true constants only. Move callers in the same PR (no re-export shims, per root AGENTS.md).

**Reference.** none

**Risk.** 525 importers; mechanical but wide. Tests patch hermes_constants.get_hermes_home heavily; that seam moves with CFG-05. hermes_constants must stay stdlib-only for bootstrap paths (startup watchdog, updater).

### CFG-10 hermes_cli/config.py (4,249 lines) mixes loading, writing, CLI commands, display and install detection

- severity: **medium** · effort: M · kind: restructure · low_hanging: false · loc_delta: 0 · depends_on: CFG-02, CFG-03
- evidence: `hermes_cli/config.py:58`, `hermes_cli/config.py:267`, `hermes_cli/config.py:2357`, `hermes_cli/config.py:2556`, `hermes_cli/config.py:2966`, `hermes_cli/config.py:3611`, `hermes_cli/config.py:4069`

**Problem (today).** One module holds install-method detection and update messages (:58-435), the loaders and caches (:1919-2437), the .env file writer (:2556-2916), show_config display (:2966-3166), the `hermes config get/set/unset/migrate/check` commands (:3611-4040) and platform plugin manifests (:4069-4249). config_effective.py, config_migrations.py and config_defaults.py reach back into its private names (_config._expand_env_vars, _config._CONFIG_LOCK, _config._RAW_CONFIG_CACHE in config_effective.py:34-89).

**Move (proposed).** After CFG-02/03 shrink it: hermes_cli/settings/ (model + load_settings + caches), hermes_cli/env_file.py (.env read/write), hermes_cli/config_cmd.py (get/set/unset/migrate/check + display), hermes_cli/install_method.py. No module imports another's underscore names.

**Reference.** none

**Risk.** Patch seams: tests monkeypatch hermes_cli.config.* names (get_config_path, load_config); move them with their callers and keep one canonical binding.

## Kill list

| target | why | importers/callers | evidence |
|---|---|---|---|
| `hermes_cli/cli_config_load.py::_cli_config_defaults (+ _merge_file_config)` | second defaults table; drifted (max_turns 500 vs unlimited, delegation 45 vs 250) | 1 | hermes_cli/cli_config_load.py:182; caller load_cli_config :268; rg 4 hits / 2 files |
| `hermes_cli/cli_config_load.py::_TERMINAL_ENV_MAPPINGS` | duplicate of config.TERMINAL_CONFIG_ENV_MAP with different rows | 1 | hermes_cli/cli_config_load.py:83; scripts/cfg_terminal_maps.py |
| `gateway/run.py::_bridge_terminal_config_to_env local map` | third copy of the terminal map | 1 | gateway/run.py:2017-2068 |
| `gateway/run.py:2096-2098 top-level scalar export loop` | exports every scalar root config key as an env var of the same name at import | 1 | gateway/run.py:2096 |
| `tools/delegate_tool_config.py::_load_config CLI_CONFIG fallback` | exists only because load_config() ignores HERMES_IGNORE_USER_CONFIG | 1 | tools/delegate_tool_config.py:449-456 |
| `gateway/shutdown_watchdog.py::_process_hermes_home, gateway/lifecycle_ledger.py::_process_hermes_home` | copy-pasted home resolver with non-canonical semantics | 2 | gateway/shutdown_watchdog.py:178; gateway/lifecycle_ledger.py:27 |
| `hermes_constants.py::pin_process_hermes_home / process_hermes_home_is_pinned + agent/secret_scope.py::_AUTO_PINNED_HOME` | mutable launch identity; replaced by HermesPaths built once (CFG-05) | 4 | hermes_constants.py:176; agent/secret_scope.py:59-65; hermes_cli/gateway_migrate.py:222 |
| `hermes_cli/config_effective.py (whole module, after CFG-02/03)` | a loader whose only purpose is 'no defaults merged'; replaced by LoadedConfig.is_set() | 21 | hermes_cli/config_effective.py:52; rg load_user_config_effective( 23 hits / 21 files |

## Simplify list

| what N things | become what 1 thing | lines saved (est.) | evidence |
|---|---|---|---|
| hermes_constants.py::set_hermes_home_override; agent/secret_scope.py::set_secret_scope; agent/secret_scope.py::set_multiplex_context; tools/terminal_scope.py::install_profile_terminal_scope; cron/jobs.py::use_cron_store; 7 composite binders | hermes_scope.py: ProfileScope.load(home) + bind(scope) over one ContextVar | 800 | gateway/run.py:1824; tui_gateway/model_switch.py:54; cron/scheduler.py:3281 |
| DEFAULT_CONFIG dict; _KNOWN_ROOT_KEYS/_EXTRA_KNOWN_ROOT_KEYS; _OPEN_DICT/_SCHEMA_DEFINED/_DYNAMIC/_PLATFORM_CONTAINER keys; _KNOWN_CONTAINER_TYPES; _SECRET_CONFIG_KEYS; _validate_* hand validators; _coerce_config_set_value | hermes_cli/settings/ pydantic HermesSettings | 2500 | hermes_cli/config_defaults.py:33; hermes_cli/config.py:1001-1271, 3199-3460 |
| load_config; load_config_readonly; read_raw_config(_readonly); load_user_config_effective; load_cli_config; tui _load_cfg_raw | load_settings(home) -> LoadedConfig(settings, user_set, raw) with one cache | 450 | hermes_cli/config.py:1943-2437; hermes_cli/config_effective.py; hermes_cli/cli_config_load.py:258 |
| config.TERMINAL_CONFIG_ENV_MAP; cli_config_load._TERMINAL_ENV_MAPPINGS; gateway/run.py _terminal_env_map; _mirror_config_to_env; _bridge_config_to_env; apply_terminal_config_to_env | TerminalSettings read from scope; TerminalSettings.to_child_env() at spawn | 400 | hermes_cli/config.py:2159-2253; hermes_cli/cli_config_load.py:83-180; gateway/run.py:1970-2160 |
| get_hermes_home; get_process_hermes_home; get_routing_process_hermes_home; get_default_hermes_root; pin API; 4 private _process_hermes_home; profiles._get_profiles_root/_get_default_hermes_home | HermesPaths (process) + current_scope().home (task) | 250 | hermes_constants.py:111-233; gateway/shutdown_watchdog.py:178; gateway/lifecycle_ledger.py:27 |
| secret_scope._parse_env_text; env_loader DotEnv+custom interpolation; profile_channels dotenv_values | one .env parser | 120 | agent/secret_scope.py:257-348; hermes_cli/env_loader.py:324-380; hermes_cli/profile_channels.py:212 |

## Reference patterns to copy

| repo | path | pattern | where it applies here |
|---|---|---|---|
| pydantic-settings | `.repos/pydantic-settings/pydantic_settings/main.py:152` | BaseSettings: types, defaults and sources declared on one class | CFG-02 HermesSettings |
| pydantic-settings | `.repos/pydantic-settings/pydantic_settings/main.py:330` | settings_customise_sources returns the ordered source tuple (init > env > dotenv > secrets) | CFG-03 one loader with ordered layers: defaults < user yaml < managed overlay; env only for declared fields |
| pydantic-settings | `.repos/pydantic-settings/pydantic_settings/sources/providers/yaml.py:36` | YamlConfigSettingsSource as one source among several | CFG-02/03 user config.yaml + managed config.yaml as two YAML sources |
| pydantic-settings | `.repos/pydantic-settings/pydantic_settings/sources/providers/env.py:47` | EnvSettingsSource reads env into the model; nothing writes back | CFG-04, CFG-09 |
| pydantic-settings | `.repos/pydantic-settings/pydantic_settings/main.py:65` | env_nested_delimiter / env_prefix derive env names from fields | CFG-09 ProcessEnv |
| svcs | `.repos/svcs/src/svcs/_core.py:573` | Container per request/scope, closed as a unit | CFG-01 ProfileScope as the per-activity container |
| structlog | `.repos/structlog/src/structlog/contextvars.py:177` | bound_contextvars: bind and restore as one context manager | CFG-01 bind(scope) |
| attrs | `.repos/attrs/src/attr/_next_gen.py:431` | frozen classes; evolve() (src/attr/_make.py:589) for variants | CFG-01 ProfileScope, CFG-05 HermesPaths, launch-scope variant |

## Answer to the seam question

No. There is no typed config model and no ordered-source model. Config is a dict built by one of at least six loaders that differ in whether defaults are merged, whether the managed overlay applies, whether the ignore-user-config flag is honored and which cache they use; call sites read it with 496 load_config() calls and ~960 defensive '.get(..., {})' / '(... or {}).get' chains. DEFAULT_CONFIG is the schema only by example, and ten side tables plus hand validators supply what the example cannot say. Env vars play three roles at once: secret store, process settings, and a bus that carries config from the loader to tools; three hand-written bridges project config into os.environ with three precedence rules. A pydantic-settings style model would replace DEFAULT_CONFIG, the side tables, the validators and coercers, the 'no defaults' loader (presence becomes model_fields_set), the config->env bridges (tools read typed fields) and the _GLOBAL_ENV_EXACT allowlist (declared ProcessEnv fields). pydantic 2.13 is already a core dependency. Profiles should be data passed down: one frozen ProfileScope(home, settings, secrets, terminal policy, multiplex) built by one factory and bound by one ContextVar, with a frozen HermesPaths for the process's own identity. Today the same idea is expressed as nine ambient channels set piecemeal by seven binders and 127 bare home overrides, which is exactly the shape that produces the #1 bug class. Order: CFG-03 and the CFG-04 interim map now (small, fix live drift); CFG-01 next (removes the leak mechanism); CFG-02 section by section; CFG-04/09 end state last.

## Cross-seam notes

- 01-layout: `hermes_constants.py:1; tools/environments/local.py` — hermes_constants_scratch.py is imported by hermes_constants.py and tools/environments/local.py; it is on-path, not off-path as parent fact 10 lists it
- 15-kill: `gateway/config_env.py:105; tools/terminal_scope.py:189` — 27 truthy/bool parser defs in scope (rg '^def (is_truthy|_truthy|_env_bool|_as_bool|_coerce_bool|_parse_bool|...)'), plus inline truthy sets
- 05-providers: `hermes_constants.py:994` — reasoning-effort parsing, per-model routing and OpenRouter/AI-Gateway URLs live in hermes_constants.py
- 10-gateway: `gateway/run.py:1973` — gateway/run.py does config->env bridging and env writes at module import time (launch profile frozen into os.environ)
- 12-cli: `cli.py:336` — cli.py loads dotenv and config at import time (_hermes_home, CLI_CONFIG module globals); main.py writes HERMES_HOME into os.environ before imports
- 13-tui-cron: `cron/scheduler_provider.py:119` — cron binds home+store (_profile_cron_scope), secrets (_install_fire_secret_scope) and terminal (scheduler.py:3395) in three separate places
- 14-errors-obs: `hermes_cli/config.py:2370` — config hot path swallows everything on the lock-free fast path (except Exception: pass), and delegate config loader swallows to {}
- 09-concurrency: `hermes_cli/config.py:2375` — load_config() takes _CONFIG_LOCK (RLock) and may call ensure_hermes_home/backup_config (file I/O) on a cache miss; gist lists load_config inside async as a hang class
- 11-plugins: `agent/secret_scope.py:405` — agent/secret_scope.py (core) imports gateway.config_loader and hermes_cli.env_loader/managed_scope while building a scope: core depends on gateway policy

## UNVERIFIED

- UNVERIFIED: that a classic-CLI session with no agent.max_turns actually stops at 500 iterations while TUI/gateway run unlimited. Read from cli_init_mixin.py:206 + cli_config_load.py:201 + config_defaults.py:78. Verify: temp HERMES_HOME, empty config.yaml, construct HermesCLI and print .max_turns; compare TUI agent max_iterations.
- UNVERIFIED: that tools read the user's config.yaml under --ignore-user-config / --safe-mode. Read from config.py:2357 (no flag check) and main.py:3111-3118. Verify: config.yaml with a distinctive delegation.max_iterations, run `hermes --ignore-user-config chat -q` with a tool that calls load_config() and log the value.
- UNVERIFIED: runtime effect of the map drift (terminal.home_mode ignored under a bound terminal scope; modal_mode/temp_dir not bridged by the classic CLI/gateway bridges). Map contents are verified (scripts/cfg_terminal_maps.py); whether another bridge path (env_loader._reapply_terminal_config_bridge, terminal_tool.py:661) backfills them was not traced end to end. Verify with an A->B multiplex run where B sets terminal.home_mode: profile.
- UNVERIFIED: that KEY=${OTHER} in a routed profile's .env reaches tools as the literal '${OTHER}'. Parser behaviour read from agent/secret_scope.py:335-348 vs env_loader.py:324-350; not executed.
- UNVERIFIED: that existing user config files validate under a pydantic model in lenient mode. Needs a corpus (test fixtures + DEFAULT_CONFIG history) replayed through a prototype model.
- UNVERIFIED: all loc_delta values are estimates from the line spans cited, not from a prototype.
- Counts are rg text counts over the in-scope tree (agent run_agent.py model_tools.py toolsets.py cli.py hermes_*.py utils.py mcp_serve.py hermes_cli tools gateway tui_gateway cron plugins pm acp_adapter hermes_platform providers); they include comments and docstrings.
