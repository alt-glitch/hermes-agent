# 01 Repo and package layout, packaging, import graph

Checkout `origin/main` = `ea81748579`. Reference SHAs: inputs/reference-repos.md. Scripts and raw outputs: `scripts/01-layout/` (imports.py, analyse.py, families.py, layering.py, syspath.py, q*.py; out/*.json).

## TL;DR

- No layering exists: with eager imports alone, 10 of 17 package groups form one strongly connected component; with lazy imports, 16 of 17 do (only hermes_platform is outside). Against a five-layer contract, 1,135 import edges point upward today.
- hermes_cli is the core library, not the CLI: runtime, state and base code import 114 distinct hermes_cli modules 850 times. hermes_cli.config alone has 836 import sites, and it imports agent.secret_scope back.
- Biggest kill: the 12 import-time sys.path.insert calls in library modules, plus the code that exists only because 63 generic top-level names (cli, utils, tools, agent, cron, plugins, providers, pm) are installed: harden_import_path, guarded bootstrap imports, the re-export seams.
- Biggest simplification: one installed package, hermes_agent/, in a src layout. Subpackages are the layers. hermes_state*.py (33 root files) becomes one package, and cli.py moves next to its 17 mixins. Root top-level names go from 63 to 1.
- Low-hanging (S/M effort, high severity): 3 (LAY-03 misplaced primitives, LAY-05 cli.py placement, LAY-06 hermes_state package). The facade+siblings split cut file sizes but kept the god objects: 40-53% of a mixin's self.X reads hit another mixin, and gateway/cli siblings late-import 120/98 distinct facade names.

## What this area is

Scope: the 52 tracked root `*.py` (33 of them `hermes_state*.py`), `setup.py`, `pyproject.toml` packaging, and the package boundaries between the 11 top-level packages: 803,792 LOC in 1,968 in-scope files (parent metrics). Import graph: 16,700 import statements resolved to in-scope modules.

| module | LOC | owns |
|---|---|---|
| `pyproject.toml` | - | entry points (pyproject.toml:566-569), packages.find include list (pyproject.toml:800-825), package-data |
| `setup.py` | 99 | wheel/sdist guard (Nix-only builds) and _root_py_modules: every root *.py becomes a top-level module (setup.py:87-99) |
| `hermes_bootstrap.py` | 572 | first import of every entry point: UTF-8 stdio, harden_import_path (sys.path surgery), PM activation, early recovery |
| `hermes_constants.py` | 1411 | base layer: HERMES_HOME/profile resolution, plus node discovery, scratch dir, reasoning-effort parsing, WSL/container wrappers |
| `hermes_cli/config.py` | 4250 | config load/save; the most-imported module in the tree (836 import sites) |
| `cli.py` | 1797 | HermesCLI facade composed of 17 mixins that live in hermes_cli/ |
| `hermes_state.py` | 1695 | SessionDB facade composed of 15 mixins; 32 sibling hermes_state_*.py at repo root |
| `gateway/run.py` | 6170 | GatewayRunner facade composed of 18 mixins in gateway/run_*.py and peers |
| `gateway/session_context.py` | 224 | stdlib-only session ContextVars; imported 68 times from outside gateway |
| `gateway/status.py` | 2217 | gateway runtime status plus generic process helpers (_pid_exists, get_process_start_time) imported 144 times from outside gateway |
| `hermes_cli/_subprocess_compat.py` | 868 | Windows subprocess helpers; imported by tools 23x, agent 10x |

Package-level import matrix: `inputs/metrics/SUMMARY.md` § Cross-package import matrix (parent). Proposed-layer violation counts: `scripts/01-layout/out/layering.json`.

Facade families measured (scripts/01-layout/families.py):

| family | mixin bases | sibling files / LOC | sibling fns with late facade import | distinct facade names read | self.X reads resolving to another mixin | coupled mixin pairs |
|---|---|---|---|---|---|---|
| `hermes_state.py::SessionDB` | 15 | 15 / 11,695 (+17 non-mixin siblings) | 15 / 581 | 13 | 545 / 1,023 (53%) | 47 / 225 |
| `gateway/run.py::GatewayRunner` | 18 | 18 / 22,608 | 220 / 997 | 120 | 942 / 2,089 (45%) | 120 / 324 |
| `cli.py::HermesCLI` | 17 | 17 / 17,589 | 221 / 803 | 98 | 872 / 2,177 (40%) | 146 / 289 |

## How it works end to end

### User runs `hermes` and the classic CLI REPL starts (`hermes-chat-startup`)

Trigger: `hermes` console script (no subcommand -> chat).

Inputs: `editable_map_current` (bool, default True): the venv's editable-install finder already knows every current top-level name (false right after a pull that added a root module or package); `cwd_has_utils_pkg` (bool, default False): the user launched hermes from a directory containing its own utils/, ui/ or proxy/ package

1. `pyproject.toml::[project.scripts].hermes` (`pyproject.toml:567`): console script imports hermes_cli.main:main; importing the hermes_cli package first runs hermes_cli/__init__.py → LAY-07
2. `hermes_cli/__init__.py::_ensure_utf8` (`hermes_cli/__init__.py:76`): package import side effect: reconfigures sys.stdout/stderr; __version__ is a lazy __getattr__ because pm may be missing from an old editable map (hermes_cli/__init__.py:18-37) → LAY-07
3. `hermes_cli/main.py (module top)` (`hermes_cli/main.py:16`) *(when editable_map_current = False)*: `import hermes_bootstrap` guarded by ModuleNotFoundError, because the editable .pth may not list the root module yet → LAY-07
4. `hermes_bootstrap.py::harden_import_path` (`hermes_bootstrap.py:434`) *(when cwd_has_utils_pkg = True)*: drops '' and '.' from sys.path and relocates the repo root to sys.path[0], so a cwd package named utils/ cannot shadow Hermes's top-level utils module (fix c39b2b50ee, #51693) → LAY-07
5. `hermes_bootstrap.py (module top)` (`hermes_bootstrap.py:527`): base-layer root module eagerly imports pm.environments, then hermes_cli._early_recovery and hermes_cli._parser (hermes_bootstrap.py:528-530): base -> CLI edge → LAY-01
6. `hermes_cli/main.py::main` (`hermes_cli/main.py:3610`): argparse dispatch; no subcommand routes to cmd_chat
7. `hermes_cli/main.py::cmd_chat` (`hermes_cli/main.py:1909`): `from cli import main as cli_main`: the hermes_cli package reaches up to a repo-root module → LAY-05
8. `cli.py (module top)` (`cli.py:32`): eagerly imports 16 mixins from hermes_cli/cli_*_mixin.py (cli.py:32-47) and re-exports private sibling names 'so cli.<name> stays the seam' (cli.py:48-142, 10 noqa F401 blocks) → LAY-04
9. `cli.py::main` (`cli.py:1666`): builds HermesCLI(...) at cli.py:1548; the class has 17 mixin bases (cli.py:891) → LAY-04
10. `hermes_cli/cli_agent_setup_mixin.py (method body)` (`hermes_cli/cli_agent_setup_mixin.py:235`): late `from cli import ChatConsole, logger`: one of 225 late facade imports in 221 cli mixin functions → LAY-04
11. `agent/agent_init.py (module top)` (`agent/agent_init.py:40`): agent runtime eagerly imports DEFAULT_CONFIG and cfg_get from hermes_cli.config: runtime -> CLI-package edge → LAY-02
12. `hermes_cli/config.py (function body)` (`hermes_cli/config.py:1589`): config lazily imports agent.secret_scope (6 sites, config.py:1589-2887): config <-> agent cycle hidden by function-level imports → LAY-02

### Model calls send_message to a Telegram target (`send-message-telegram`)

Trigger: send_message tool call with a telegram:<chat> target.

Inputs: `thread_id_set` (bool, default False): the target is a forum topic; `telegram_dep_installed` (bool, default True): python-telegram-bot is importable

1. `tools/send_message_tool.py::send_message_tool` (`tools/send_message_tool.py:33`): tool handler resolves the platform and calls the per-platform sender imported at tools/send_message_tool.py:19
2. `tools/send_message_senders.py::_send_telegram` (`tools/send_message_senders.py:259`): standalone Telegram send path inside the tools layer
3. `tools/send_message_senders.py::_send_telegram` (`tools/send_message_senders.py:264`): lazy import of plugins.platforms.telegram.telegram_ids: the tools layer imports a bundled plugin by path → LAY-12
4. `tools/send_message_senders.py::_telegram_thread_kwargs` (`tools/send_message_senders.py:131`) *(when thread_id_set = True)*: imports the 7,422-line TelegramAdapter to call one static method; a broad except falls back to a hand copy of the rule → LAY-12
5. `plugins/platforms/telegram/adapter.py (module top)` (`plugins/platforms/telegram/adapter.py:137`) *(when telegram_dep_installed = True)*: import-time sys.path.insert(0, repo root) → LAY-08
6. `plugins/platforms/telegram/adapter.py (module top)` (`plugins/platforms/telegram/adapter.py:142`) *(when telegram_dep_installed = True)*: imports gateway.platforms.base (plugin -> gateway, the allowed direction)
7. `gateway/platforms/base.py (module top)` (`gateway/platforms/base.py:424`) *(when telegram_dep_installed = True)*: a second import-time sys.path.insert(0, repo root) on the same call path → LAY-08

## Findings

### LAY-01: There is no package layering: almost every package is in one import cycle

- severity: **critical** · effort: **XL** · kind: restructure · low_hanging: false · loc_delta: None · depends_on: LAY-02, LAY-03, LAY-05, LAY-06, LAY-12
- evidence: `scripts/01-layout/out/analysis.json::group_scc_eager`, `scripts/01-layout/out/layering.json::today_total_up_edges`, `hermes_bootstrap.py:527`, `hermes_state_common.py:15`, `tools/browser_tool_cloud.py:13`, `agent/agent_init.py:40`
- **problem:** Today: with module-level (eager) imports only, the groups agent, cron, gateway, hermes_cli, plugins, pm, root base modules, root runtime modules (run_agent/model_tools/toolsets), hermes_state* and tools form one strongly connected component. With function-level imports too, 16 of 17 groups do; only hermes_platform is outside (AST import graph, 16,700 edges, scripts/01-layout/imports.py + analyse.py). The 'dependency chain' in AGENTS.md:251-252 does not describe this graph. Against the five-layer contract proposed below, 1,135 edges point upward today (119 at module level). Who pays: every contributor. No package can be read, tested or imported alone. Import order bugs are fixed one at a time by turning imports into function-level imports (14,018 of them in scope, parent metrics). That hides the cycle and leaves it in place.
- **move:** Adopt this contract (import-linter `layers`, top to bottom; a layer may import only layers below it): 5 plugins (bundled) > 4 surfaces (CLI/REPL, gateway, tui_gateway, acp_adapter, cron, mcp_serve) > 3 runtime (agent, tools, run_agent, model_tools, toolsets) > 2 state + providers > 1 core (config, profiles, secret/session scope, credentials) > 0 base (hermes_platform, pm, logging, time, yaml, home paths). Ship it advisory with today's 1,135 violations as the baseline (gist Phase 4 'import-linter'), then remove violations through LAY-02, LAY-03, LAY-05, LAY-06 and LAY-12. The gist rule then holds without a growing exemption list.
- **reference:** inspect_ai `.repos/inspect_ai/src/inspect_ai/_cli/main.py:1`: the CLI is a leaf private package: zero modules outside _cli/ import inspect_ai._cli (rg over 834 files)
- **risk:** Pure import moves. Behaviour to preserve: lazy imports that exist for startup time, not cycles (e.g. heavy SDKs), must stay function-level. The contract must count only module-level edges as hard violations at first.

### LAY-02: hermes_cli is the core library: runtime and state import 114 of its modules

- severity: **critical** · effort: **L** · kind: boundary · low_hanging: false · loc_delta: None · depends_on: LAY-03
- evidence: `agent/agent_init.py:40`, `agent/auxiliary_client.py:121`, `agent/credential_pool.py:21`, `hermes_cli/config.py:1589`, `hermes_cli/config.py:3494`, `hermes_bootstrap.py:528`, `pm/runtime.py:120`
- **problem:** Today: agent, tools, providers, pm, run_agent/model_tools and hermes_state* import 114 distinct hermes_cli modules, 850 times (scripts/01-layout/out/analysis.json). Top targets: hermes_cli.config 245, auth 75, plugins 41, _subprocess_compat 34, providers 30, models 27, runtime_provider 24, profiles 22. hermes_cli.config has 836 import sites in total, 376 of them outside hermes_cli. These modules are core, not CLI, and they import the runtime back. hermes_cli/config.py imports agent.secret_scope (6 sites from config.py:1589), agent.redact, agent.skill_utils and gateway.display_config (config.py:3494). A plain move of all 114 modules (78.6k LOC) into a core package fixes nothing. The moved set still imports agent 170 times, tools 105 times and CLI-only hermes_cli modules 249 times, so 957 upward edges remain (scripts/01-layout/layering.py). Cost: every reader of agent/ or tools/ must learn the 260k-line CLI package. A change to CLI config plumbing can break the gateway and cron.
- **move:** Carve a small core package (proposed hermes_agent/core/). Contents: config load/save (hermes_cli/config.py + the 10 config_*.py), profiles resolution (hermes_cli/profiles.py minus CLI commands), the credential store (hermes_cli/auth*.py storage half), runtime_provider resolution, and the scope primitives now in agent/secret_scope.py and agent/redact.py. Cut its upward edges. Skill config vars (config.py:917, 3104) become a registry that agent fills. display_config keys (config.py:3494) move into core. hermes_cli keeps argparse, setup wizards and REPL code, and nothing below the surface layer imports it.
- **reference:** home-assistant-core `.repos/home-assistant-core/homeassistant/core_config.py:1`: core config is its own module below the integrations and the CLI runner (homeassistant/runner.py); integrations import it, never the reverse
- **risk:** Patch seams: tests monkeypatch hermes_cli.config.X at the facade (AGENTS.md:267-270 warns that blind repointing broke 130+ tests). Profile-scope semantics of load_config/get_secret must not change (AGENTS.md:299-311). Plugins that import hermes_cli.config directly break (UNVERIFIED count).

### LAY-03: Stdlib-level primitives live in surface packages and force runtime -> gateway/CLI imports

- severity: **high** · effort: **M** · kind: restructure · low_hanging: true · loc_delta: -20 · depends_on: []
- evidence: `gateway/session_context.py:8`, `tools/approval_context.py:107`, `tools/async_delegation.py:250`, `hermes_cli/_subprocess_compat.py:1`, `hermes_cli/_subprocess_compat.py:657`, `gateway/status.py:1`
- **problem:** Today: gateway/session_context.py imports only stdlib (session_context.py:8-11). It is imported 68 times from outside gateway: tools 41, agent 12, hermes_cli 7 (get_session_env 49). gateway/status.py (2,217 lines) holds generic process helpers. Outside gateway they are imported 144 times: get_process_start_time 35, _pid_exists 31 (a private name), get_running_pid 23, terminate_pid 8. hermes_cli/_subprocess_compat.py (868 lines of Windows subprocess helpers) is imported by tools 23x and agent 10x. It also imports gateway.status back (_subprocess_compat.py:657). These three modules alone create about 150 of the runtime-to-surface upward edges in LAY-01. Process-identity bugs are the class AGENTS.md:288-293 calls out (~10 fleet-update issues). The canonical helpers for that class sit in a gateway module that the tools layer imports privately.
- **move:** Move gateway/session_context.py into the core scope package beside secret_scope (no code change). Move the process helpers (_pid_exists -> pid_exists, get_process_start_time, terminate_pid, start_time_fingerprints_match) into hermes_platform/process.py; keep the gateway-specific matchers (looks_like_gateway_command_line) in gateway/status.py. Move hermes_cli/_subprocess_compat.py to hermes_platform/subprocess.py. One PR per module. Each rewrites imports at the call sites, with no re-export shim (AGENTS.md:276-278).
- **reference:** httpx `.repos/httpx/httpx/_utils.py:1`: shared low-level helpers sit in one private bottom module that every layer imports; no feature module hosts them
- **risk:** Monkeypatch targets like gateway.session_context.get_session_env and gateway.status._pid_exists in tests move. hermes_platform's rule 'facts take no environment-variable input' (AGENTS.md:312-321) must not be applied to session_context, which reads os.environ as its fallback by design.

### LAY-04: Facade + siblings split the files but kept three god objects whose mixins share one namespace

- severity: **high** · effort: **L** · kind: restructure · low_hanging: false · loc_delta: -600 · depends_on: []
- evidence: `cli.py:891`, `cli.py:48`, `gateway/run.py:3389`, `hermes_state.py:459`, `gateway/run_adapters.py:156`, `hermes_cli/cli_agent_setup_mixin.py:235`, `scripts/01-layout/out/families.json`
- **problem:** Today (AST, scripts/01-layout/families.py): GatewayRunner has 18 mixin bases (gateway/run.py:3389), HermesCLI has 17 (cli.py:891) and SessionDB has 15 (hermes_state.py:459). Share of self.X reads inside a mixin that resolve to an attribute defined by a different mixin or the facade class: state 545/1,023 (53%), gateway 942/2,089 (45%), cli 872/2,177 (40%). Mixin pairs coupled this way: state 47/225, gateway 120/324, cli 146/289. Late facade imports: in gateway, 220 of 997 sibling functions run `from gateway.run import ...`, reading 120 distinct facade names, mostly module constants (_AGENT_CACHE_MAX_SIZE, _INTERRUPT_REASON_*) and helpers. In cli, 221 of 803 mixin functions run `from cli import ...`, reading 98 names (_cprint, _ACCENT, CLI_CONFIG). cli.py:48 re-exports sibling privates 'so `cli.<name>` stays the seam'. State is cleaner: 15 of 581. The split shrank files. It did not cut what a reader must hold in mind: to follow one GatewayRunner method you still need the whole class's attribute set and the facade's module globals. The cause is deliberate. AGENTS.md:265-270 makes the facade the monkeypatch seam, so siblings must read names through it at call time. I argue against that rule: it puts test convenience above module boundaries, and it makes each facade a global namespace that 200+ functions reach into.
- **move:** Two steps per family. (1) Move the facade's module constants and helpers that siblings late-import into a private bottom module (gateway/_run_shared.py, hermes_cli/repl/_shared.py). Siblings import it at module top. This deletes about 223 + 225 late-import statements and the cli.py:48-142 re-export blocks; tests patch the defining module. (2) Turn mixins with a low foreign-reference ratio into collaborator objects that GatewayRunner/HermesCLI own (self.agent_cache = AgentCache(...), self.shutdown = ShutdownController(runner_state)), each taking explicit constructor dependencies. Start with the mixins that touch the fewest other mixins' attributes (families.json lists the pairs).
- **reference:** home-assistant-core `.repos/home-assistant-core/homeassistant/core.py:408`: HomeAssistant owns bus, services, states, config as separate objects (core.py:408-411), not as mixins over one shared self
- **risk:** The tests' patch targets are the facade names. Step (1) must rewrite them in the same PR (AGENTS.md: 130+ tests broke once). Class-level defaults that tests rely on for partial construction (gateway/run.py:3397) must survive the collaborator split.

### LAY-05: The CLI facade is a repo-root module whose 17 mixins live in hermes_cli/

- severity: **high** · effort: **M** · kind: restructure · low_hanging: true · loc_delta: -100 · depends_on: []
- evidence: `cli.py:32`, `cli.py:891`, `hermes_cli/main.py:1909`, `hermes_cli/cli_single_query.py:25`, `hermes_cli/cli_model_switch_mixin.py:257`
- **problem:** Today: cli.py sits at the repo root and is installed as a top-level module named `cli`. At module level it imports 16 mixins from hermes_cli/ (cli.py:32-47). hermes_cli imports it back 280 times from function bodies (hermes_cli -> cli edges, scripts/01-layout/out/analysis.json), and the entry point reaches it through `from cli import main` (hermes_cli/main.py:1909). The family breaks the repo's own facade rule ('siblings in the same directory', AGENTS.md:256-258). Its 30 hermes_cli/cli_*.py files are spread over a 484-file flat directory. `cli` is also a generic name that any dependency or cwd package can shadow (see LAY-07).
- **move:** Create hermes_cli/repl/. cli.py becomes hermes_cli/repl/__init__.py (or app.py). hermes_cli/cli_*_mixin.py and the other cli_*.py clusters move in as repl/_<topic>.py. hermes_cli/main.py:1909 imports hermes_cli.repl. The root `cli` top-level name disappears. Do this with LAY-04 step (1) so the re-export blocks go in the same PR.
- **reference:** inspect_ai `.repos/inspect_ai/pyproject.toml:187`: entry point inspect_ai._cli.main:main: the CLI lives inside the package, in one subpackage
- **risk:** Tests patch cli.<name> (the seam cli.py:48 preserves). They must move with the code. External launchers that run `python cli.py` (UNVERIFIED) need a pointer.

### LAY-06: Session storage is 33 top-level root modules, and it imports the agent package

- severity: **high** · effort: **M** · kind: restructure · low_hanging: true · loc_delta: -50 · depends_on: []
- evidence: `hermes_state.py:30`, `hermes_state_common.py:15`, `hermes_state_common.py:16`, `hermes_state_messages.py:13`, `hermes_state_identity.py:10`, `hermes_state_timeline.py:8`, `setup.py:87`
- **problem:** Today: hermes_state.py plus 32 hermes_state_*.py siblings (20,228 LOC, wc -l) sit at the repo root. setup.py:87-99 installs each one as its own top-level module. The storage layer imports the runtime at module level 14 times: hermes_state_common.py:15-16 (agent.skill_commands, agent.context_compressor), hermes_state_messages.py:13-20, hermes_state_identity.py:10-11, hermes_state_timeline.py:8-9, hermes_state_search.py:14, plus 16 lazy (30 state -> agent edges). agent imports hermes_state back. So the session database cannot be imported, tested or reused (by cron, the dashboard, or `hermes sessions`) without loading the agent package. The facade imports 27 sibling modules at module top (hermes_state.py:30-79). Each new sibling is a new top-level name, which an existing editable install does not see (hermes-agent-dev skill: hermes_state_profile_repair.py was 'missing' until PYTHONPATH=.).
- **move:** Create a hermes_state/ package (later hermes_agent/state/). hermes_state.py becomes __init__.py and exports SessionDB and the error types; siblings become private _<topic>.py modules. Move the pure helpers it takes from agent (message_sanitization, message_metadata, the compressor's marker constants, skill_commands' parsers) down into state or core, so the state -> agent edges go to zero. Internals are seam 08's.
- **reference:** sqlite-utils `.repos/sqlite-utils/sqlite_utils/db.py:1`: the database layer is one package module that imports nothing from the CLI or app layers
- **risk:** Tests patch hermes_state.X and hermes_state_<topic>.X. Moving them changes import paths, not behaviour. The read-pool and WAL logic must keep their module-level state per process.

### LAY-07: 63 generic top-level import names are installed, and a stack of path hacks exists to keep them importable

- severity: **high** · effort: **L** · kind: restructure · low_hanging: false · loc_delta: -300 · depends_on: LAY-02, LAY-05, LAY-06
- evidence: `setup.py:87`, `pyproject.toml:800`, `hermes_bootstrap.py:434`, `hermes_bootstrap.py:505`, `hermes_cli/__init__.py:18`, `hermes_cli/main.py:12`, `agent/legacy_cli.py:13`
- **problem:** Today: the install puts 52 root modules (cli, utils, toolsets, run_agent, model_tools, 33 hermes_state*, ...) and 11 packages (agent, tools, hermes_cli, gateway, tui_gateway, cron, plugins, pm, providers, hermes_platform, acp_adapter) on the import path as top-level names. Costs found in the code: (1) a cwd package named utils/ui/proxy shadowed Hermes modules and crashed the gateway child (c39b2b50ee, #51693), so hermes_bootstrap.harden_import_path (hermes_bootstrap.py:434-453) now rewrites sys.path on every launch. (2) The setuptools editable finder maps only the top-level names known at install time. Every new root module or package is therefore unimportable after a pull, so bootstrap imports are wrapped in ModuleNotFoundError guards (hermes_cli/main.py:12-19, agent/legacy_cli.py:13-16), hermes_cli.__version__ is a lazy __getattr__ that tolerates a missing pm (hermes_cli/__init__.py:10-37), and the bootstrap force-inserts the repo root (hermes_bootstrap.py:505-508). (3) 12 library modules insert the repo root at import time (LAY-08). (4) Kanban workers needed PYTHONPATH fixes (5392a83ccd: #122299, #122487, #122500). 156 commits mention 'editable'.
- **move:** One import package named hermes_agent, matching the distribution name and the existing `hermes_agent.plugins` entry-point group (providers/__init__.py:7). Use a src layout: src/hermes_agent/{base,platform,pm,core,state,providers,runtime,surfaces,plugins}. Packaging becomes `[tool.setuptools.packages.find] where=['src'] include=['hermes_agent*']`. setup.py's _root_py_modules goes, and harden_import_path is reduced to dropping '' from sys.path. The editable map then has one entry, so new submodules never need a reinstall. Order: new packages (core from LAY-02/03, state from LAY-06, repl from LAY-05) are created inside hermes_agent/ from the start. The old top-level packages move in last, one mechanical PR per name.
- **reference:** attrs `.repos/attrs/pyproject.toml:98`: src layout: the only importable names are the packages under src/ (packages = ['src/attr', 'src/attrs']); inspect_ai does the same at .repos/inspect_ai/pyproject.toml:24-26
- **risk:** The largest import rewrite in the repo (about 16.7k import statements plus test patch targets). User and pip plugins that import agent.*, tools.* or hermes_cli.* break. AGENTS.md:276-278 forbids compat shims, so the move needs one announced breaking release (UNVERIFIED: how many catalog plugins import internal paths). The updater's old-tree/new-tree handoff (hermes_bootstrap.py:510-519) must keep working across the rename.

### LAY-08: Twelve library modules insert the repo root into sys.path when imported

- severity: **medium** · effort: **S** · kind: kill · low_hanging: false · loc_delta: -40 · depends_on: []
- evidence: `gateway/run.py:1570`, `gateway/platforms/base.py:424`, `cron/scheduler.py:36`, `tools/cronjob_tools.py:32`, `hermes_cli/cron.py:12`, `hermes_cli/web_server.py:34`, `plugins/platforms/telegram/adapter.py:137`, `plugins/platforms/discord/adapter.py:258`, `plugins/platforms/slack/adapter.py:34`, `plugins/platforms/whatsapp/adapter.py:208`, `plugins/platforms/raft/adapter.py:37`, `pm/launch.py:7`
- **problem:** Today: 16 module-level sys.path.insert calls in scope (scripts/01-layout/syspath.py). 3 sit under `if __name__ == '__main__'` (hermes_cli/_launchers.py:21, hermes_cli/source_completion.py:23, tools/bot_mode_dm.py:889) and 1 is script-mode bootstrap (hermes_cli/main.py:46). The other 12 run whenever the module is imported. Importing a gateway platform adapter therefore mutates the process-wide import path, and it does so after hermes_bootstrap.harden_import_path has set the order deliberately. The telegram send path in flow 2 does it twice. The only stated reason is standalone script runs (cron/scheduler.py:34-35, 'module reload after hermes update').
- **move:** Delete the 12 import-time inserts. Entry points already run hermes_bootstrap, which places the root. For the standalone cron-worker case, spawn with `-m` plus the install root on PYTHONPATH (the 5392a83ccd pattern). pm/launch.py is a launcher; keep it only if it is executed as a script, and add a __main__ guard. Once LAY-07 lands, none of these can exist.
- **reference:** null
- **risk:** A process that imports one of these modules without going through an entry point (cron external worker, restart watcher) may lose the repo root. Verify each spawner's argv before deleting (UNVERIFIED).

### LAY-10: Package directories are flat, with filename prefixes standing in for subpackages

- severity: **medium** · effort: **M** · kind: restructure · low_hanging: false · loc_delta: 0 · depends_on: LAY-04
- evidence: `hermes_cli/update_cmd.py:1`, `hermes_cli/kanban_db.py:1`, `hermes_cli/auth.py:1`, `hermes_cli/web_server.py:1`
- **problem:** Today: hermes_cli/ has 484 .py files in its top directory, tools/ 268, agent/ 256, gateway/ 123 (ls). Prefix families in hermes_cli/ alone: update_* 31, cli_* 30, plugins_* 24, web_* 22, kanban* 18, auth* 18, plugin_* 17, model_* 14, gateway_* 14, config* 11, setup* 10. The rule 'siblings live beside the facade' (AGENTS.md:256-258) produces this shape. Nothing marks which sibling is private to its family. Any module anywhere can import hermes_cli.kanban_db_dispatch, and 4 eager module cycles sit inside such families (hermes_cli.setup*, hermes_cli.kanban_db*, cron.scheduler*, tools.browser_tool_*; analysis.json::module_scc_eager).
- **move:** Give each family of 8 or more files its own subpackage: hermes_cli/update/, kanban/, auth/, web/, plugins/ (and the repl/ from LAY-05). The facade becomes __init__.py and exports the family's public names. Siblings become _<topic>.py. An import-linter `forbidden` contract stops outside code from importing `*._*` modules. This changes the AGENTS.md facade rule from 'same directory' to 'same package'.
- **reference:** httpx `.repos/httpx/httpx/__init__.py:1`: public names re-exported from private _modules (__init__.py:1-8, __all__ at :29); callers never import httpx._client
- **risk:** Mechanical moves. Test patch targets and docs that name old paths must move in the same PR (AGENTS.md:279-282).

### LAY-11: hermes_constants.py is a 1,411-line grab bag that duplicates hermes_platform through wrappers

- severity: **medium** · effort: **M** · kind: collapse · low_hanging: false · loc_delta: -60 · depends_on: []
- evidence: `hermes_constants.py:1135`, `hermes_constants.py:1142`, `hermes_constants.py:1149`, `hermes_constants.py:997`, `hermes_constants.py:489`, `hermes_constants.py:892`, `hermes_platform/host/runtime.py:17`
- **problem:** Today: the base module that every package imports holds 116 top-level definitions. Besides home and profile resolution it contains node-executable discovery (hermes_constants.py:428-552), secure-dir chown policy (807-890), scratch-dir pruning (892-995), reasoning-effort and per-model routing parsing (997-1133) and WSL path translation (1163-1188). is_termux, is_wsl, is_container and _detect_container (1135-1162) are one-line wrappers over hermes_platform.host.runtime; _detect_container is kept as 'the historical test seam'. 20 non-test call sites import the wrappers. Reasoning-effort parsing is provider/runtime logic placed in the bottom layer. Every importer of get_hermes_home loads all of it.
- **move:** Keep only home/profile path resolution in hermes_constants (later core/home.py). Delete the four platform wrappers and point the 20 callers at hermes_platform.host. Move node discovery to hermes_platform/resolver/ (AGENTS.md:318-321 already says resolvers land there). Move scratch dir and secure-dir policy to base/fs.py. Move reasoning/routing parsing to agent or providers.
- **reference:** inspect_ai `.repos/inspect_ai/src/inspect_ai/_util/constants.py:1`: constants module holds constants; helpers live in topical _util modules (84 of them)
- **risk:** Tests that patch hermes_constants._detect_container or is_wsl need their targets moved. Profile-scope behaviour of get_hermes_home must not change.

### LAY-12: Core layers import bundled plugins by path, so 'plugins' are hard dependencies of tools

- severity: **medium** · effort: **M** · kind: boundary · low_hanging: false · loc_delta: None · depends_on: []
- evidence: `tools/browser_tool_cloud.py:13`, `tools/browser_tool_cloud.py:14`, `tools/web_tools.py:19`, `tools/xai_video_tools.py:10`, `tools/send_message_senders.py:131`, `agent/agent_init.py:1374`, `hermes_cli/backup.py:245`
- **problem:** Today: 57 imports from non-plugin code into plugins/ (analysis.json::plugins_imported_by_nonplugins_total). Some are module-level: tools/browser_tool_cloud.py:13-14 imports the browser_use and browserbase providers, tools/web_tools.py:19 imports firecrawl, tools/xai_video_tools.py:10 imports video_gen.xai. Others are lazy: tools/send_message_senders.py imports the 7,422-line Telegram adapter for one static method, plus the matrix adapter (send_message_senders.py:541); hermes_cli imports plugins.memory 21 times. A bundled plugin that core imports at module level cannot be disabled, removed or published out of tree. AGENTS.md:95-96 says core must not special-case plugins.
- **move:** Core reaches bundled providers only through the registries it already has (the provider registry in providers/__init__.py, the memory provider loader). Move the shared helpers that tools need (telegram_ids parsing, thread-id mapping) into the gateway platform layer or a small shared module that the plugin also imports. Add an import-linter forbidden contract: runtime and core may not import plugins.*.
- **reference:** pluggy `.repos/pluggy/src/pluggy/_manager.py:1`: host calls plugins only through hook relays; it never imports a plugin module by name
- **risk:** Plugin load order: eager imports today guarantee availability at tool-registration time. A registry lookup must keep check_fn results identical. Details are seam 11's.

### LAY-09: Packaging config ships off-path runners as top-level modules and lists packages by hand

- severity: **low** · effort: **S** · kind: hygiene · low_hanging: false · loc_delta: -15 · depends_on: []
- evidence: `setup.py:87`, `pyproject.toml:804`, `pyproject.toml:823`, `pyproject.toml:568`, `batch_runner.py:34`
- **problem:** Today: setup.py:87-99 lists os.listdir(repo root) and ships every *.py except setup.py as a top-level module. In the Nix wheel (the only allowed build, setup.py:1-24) that includes batch_runner, mini_swe_runner, trajectory_compressor and toolset_distributions as top-level importable names. pyproject.toml:800-825 enumerates 11 packages by hand and lists tools/tools.* twice (804-805 and 823-824). A twelfth top-level package added later must be added there too. The `hermes-agent` console script (pyproject.toml:568) points at a 'legacy' single-query runner (agent/legacy_cli.py:1-8).
- **move:** Now: move the four off-path runners out of the repo root (seam 15 decides kill vs move) and drop the duplicate tools entries. After LAY-07: include=['hermes_agent*'] and no py_modules. Decide whether the legacy `hermes-agent` script still has users; if not, remove it (UNVERIFIED usage).
- **reference:** llm `.repos/llm/pyproject.toml:86`: packages.find include = ['llm*']: one glob, nothing at the root
- **risk:** Nix build input filter (nix/lib.nix pythonSrc, per setup.py:85 comment) must match the new layout.

## Kill list

| target | why | importers/callers | evidence |
|---|---|---|---|
| 12 import-time sys.path.insert calls (gateway/run.py:1570, gateway/platforms/base.py:424, cron/scheduler.py:36, tools/cronjob_tools.py:32, hermes_cli/cron.py:12, hermes_cli/web_server.py:34, 5 plugins/platforms/*/adapter.py, pm/launch.py:7) | library modules mutate the process import path on import; entry points already set it | 0 | scripts/01-layout/syspath.py output; LAY-08 |
| hermes_constants.py::is_termux, is_wsl, is_container, _detect_container | one-line pass-through wrappers over hermes_platform.host.runtime | 20 | hermes_constants.py:1135-1162; rg 'from hermes_constants import.*(is_wsl|is_container|is_termux)' outside tests = 20 |
| cli.py:48-142 re-export blocks (10 `# noqa: F401` imports) | exist only so tests can patch cli.<name>; siblings read their own names back through the facade | 280 | cli.py:48 comment; hermes_cli -> cli late-import edges = 280 |
| ~448 late facade imports in gateway/run_*.py (223) and hermes_cli/cli_*.py (225) | read module constants/helpers through the facade at call time; replace with a private shared module imported at top | - | scripts/01-layout/out/families.json; LAY-04 |
| setup.py::_root_py_modules | disappears with a single package (LAY-07); today ships off-path runners as top-level modules | 1 | setup.py:87-99 |
| pyproject.toml duplicate tools/tools.* entries | listed twice in packages.find | 0 | pyproject.toml:804-805, 823-824 |

## Simplify list

| what N things | become what 1 thing | lines saved | evidence |
|---|---|---|---|
| hermes_state.py, 32 hermes_state_*.py at repo root | one hermes_state/ package (__init__ exports SessionDB; private _<topic>.py) | 50 | LAY-06; hermes_state.py:30-79 |
| cli.py (root), 30 hermes_cli/cli_*.py | hermes_cli/repl/ subpackage | 100 | LAY-05; cli.py:32-47, hermes_cli/main.py:1909 |
| gateway/session_context.py, agent/secret_scope.py, hermes_constants home override ContextVar | one core scope package | - | LAY-02/LAY-03; gateway/session_context.py:8, agent/secret_scope.py:23, hermes_constants.py:26 |
| gateway/status.py process helpers, hermes_cli/_subprocess_compat.py, hermes_constants platform wrappers | hermes_platform/process.py + hermes_platform/subprocess.py | 60 | LAY-03/LAY-11 |
| 52 root modules, 11 top-level packages | one hermes_agent package in src layout | 300 | LAY-07 |
| prefix families: hermes_cli/update_* (31), plugins_* (24), web_* (22), kanban* (18), auth* (18) | subpackages with private _modules | 0 | LAY-10 |

## Reference patterns to copy

| repo | path | pattern | where it applies here |
|---|---|---|---|
| inspect_ai | `.repos/inspect_ai/pyproject.toml:24` | src layout, include=['inspect_ai*']; 834 files under one name; CLI in private _cli/ that nothing else imports | LAY-01, LAY-05, LAY-07 |
| attrs | `.repos/attrs/pyproject.toml:98` | src layout: only packages under src/ are importable; tests run against the installed package | LAY-07 |
| httpx | `.repos/httpx/httpx/__init__.py:1` | private _modules + curated public __init__ with __all__ | LAY-06, LAY-10 |
| home-assistant-core | `.repos/home-assistant-core/homeassistant/core.py:408` | core object owns bus/services/states/config collaborators instead of mixins over one self | LAY-04 |
| llm | `.repos/llm/pyproject.toml:86` | single package, include=['llm*'], console script llm.cli:cli | LAY-09 |
| datasette | `.repos/datasette/datasette/app.py:1` | one package; app object owns lifecycle; utils/ and views/ are subpackages, not filename prefixes | LAY-10 |
| pluggy | `.repos/pluggy/src/pluggy/_manager.py:1` | host reaches plugins only through hook relays | LAY-12 |

## Answer to the seam question

Target: one import package, hermes_agent, in a src layout (src/hermes_agent/). The name matches the distribution and the existing hermes_agent.plugins entry-point group. Its subpackages are the layers, and an import-linter layers contract enforces them: base (home paths, logging, time, yaml, fs) and platform (hermes_platform + process + subprocess) and pm at the bottom; then core (config, profiles, secret/session scope, credentials); then state and providers; then runtime (agent, tools, model_tools, toolsets, run_agent); then surfaces (cli/repl, gateway, tui_gateway, acp, cron, mcp_serve); then bundled plugins on top. Each package keeps a curated __init__ with private _<topic> modules (httpx, inspect_ai). There is one top-level name instead of 63. Smallest sequence, where each step removes upward edges and none depends on the rename: (1) S: delete the 12 import-time sys.path inserts and the duplicate packaging entries; move the off-path runners out of the root. (2) M: move the misplaced primitives (gateway/session_context.py to core scope, process helpers and _subprocess_compat to hermes_platform, hermes_constants wrappers deleted), which removes about 150 runtime-to-surface edges. (3) M: package hermes_state*.py (33 root files to 1 package) and cut its 30 imports of agent; move cli.py into hermes_cli/repl/ with its mixins. That takes root top-level names from 52 to about 15. (4) L: carve core out of hermes_cli (config, profiles, credential store, runtime_provider, plus agent/secret_scope and redact) and cut its imports of agent, tools and gateway. (5) Turn on the layers contract in advisory mode with the 1,135-edge baseline, and ratchet it. (6) L: create hermes_agent/ and move each remaining top-level package in, one mechanical PR per name. New packages from steps 2-4 are born inside hermes_agent/ so no module moves twice. The facade+siblings pattern should keep its file-size discipline. It should give up 'the facade is the patch seam': siblings import shared names from a private module, and mixins become owned collaborators (LAY-04).

Proposed contract (import-linter style):

```ini
[importlinter:contract:layers]
name = Hermes layers
type = layers
layers =
    hermes_agent.plugins
    hermes_agent.surfaces  # repl/cli, gateway, tui_gateway, acp, cron, mcp_serve
    hermes_agent.runtime   # agent, tools, model_tools, toolsets, run_agent
    hermes_agent.state | hermes_agent.providers
    hermes_agent.core      # config, profiles, scope, credentials
    hermes_agent.base | hermes_agent.platform | hermes_agent.pm

[importlinter:contract:private-modules]
name = no imports of another package's _private modules
type = forbidden  # expressed per family
```

Violations today against this contract (mapped onto current packages): 1,135 upward import edges, 119 of them module-level. Largest pairs: agent → hermes_cli 462, tools → hermes_cli 305, tools → gateway 116, hermes_state* → agent 30, agent → gateway 26, pm → hermes_cli 26, tools → cron 24. Moving every hermes_cli module that lower layers import (114 modules, 78.6k LOC) without cutting their own imports leaves 957; the carve in LAY-02 has to cut edges, not just relocate files.

## Cross-seam notes

- 13-tui-cron: `tui_gateway/method_ctx.py:78`: tui_gateway/method_ctx.py::bind_module rebinds methods_*.py globals onto server.py (parent fact 5); a layout-level variant of the facade-as-namespace problem in LAY-04, worse because static analysis is blind
- 15-kill: `hermes_constants.py:922`: hermes_constants_scratch is not off-path: hermes_constants.py and tools/environments/local.py import it; parent-facts lists it with the off-path runners
- 08-state: `hermes_state_common.py:15`: the state layer imports agent at module level (14 eager edges) for sanitization/metadata/compressor helpers
- 07-config: `hermes_cli/config.py:1589`: hermes_cli/config.py imports agent.secret_scope in 6 function bodies; config and secret scope are one concept split across agent/ and hermes_cli/
- 02-pm-core: `pm/runtime.py:120`: pm (base layer) imports hermes_cli 26 times, 12 of them hermes_cli.runtime_state; pm's state model lives in the CLI package
- 10-gateway: `gateway/run.py:1568`: importing gateway.run sets os.environ['_HERMES_GATEWAY']='1' as a module side effect so a later cli.py import behaves differently
- 09-concurrency: `gateway/session_context.py:18`: gateway/session_context.py keeps a process-level latch _session_context_engaged that changes how ContextVars and os.environ interact
- 11-plugins: `tools/browser_tool_cloud.py:13`: tools imports bundled browser/web/video providers at module level; disabling those plugins cannot remove them
- 12-cli: `cli.py:48`: cli.py re-exports private sibling names for the test seam; hermes_cli/main.py reaches the REPL through a root module
- 04-agent-loop: `run_agent.py:21`: run_agent.py imports hermes_cli._early_recovery at module level; the agent facade depends on CLI update recovery

## UNVERIFIED

- UNVERIFIED: import counts come from a static AST pass (scripts/01-layout/imports.py). importlib/registry-string imports are not counted, and the resolution of `from pkg import name` to a submodule is heuristic. Verify with a runtime import trace (python -X importtime) on each entry point.
- UNVERIFIED: whether deleting the 12 import-time sys.path inserts breaks a standalone spawn (cron external worker, restart watcher, kanban worker). Verify by listing every subprocess argv that runs a .py path and doing an E2E run of each.
- UNVERIFIED: how many external/catalog plugins import internal top-level names (agent.*, tools.*, hermes_cli.*). This sets the cost of LAY-07. Verify by scanning plugin-catalog entries and their repos.
- UNVERIFIED: that the Nix wheel actually contains the off-path root modules. Inferred from setup.py:87-99 and its comment on nix/lib.nix; no wheel was built.
- UNVERIFIED: number of tests that patch facade names (cli.X, gateway.run.X, hermes_state.X) and would move with LAY-04/05/06. Verify by grepping tests/ for monkeypatch/patch targets per facade.
- UNVERIFIED: split of the 14,018 function-level imports between cycle avoidance and startup-time deferral. Verify by sampling and checking whether a module-level import would create a cycle.
- UNVERIFIED: whether the import name `hermes` would collide with an existing PyPI or local package (an untracked hermes/ directory exists in this checkout). This is why the proposal uses hermes_agent.
- UNVERIFIED: whether anyone still uses the `hermes-agent` console script (pyproject.toml:568).
