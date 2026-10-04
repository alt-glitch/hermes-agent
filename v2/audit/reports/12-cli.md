# 12 CLI, subcommands, slash commands, dashboard backend, ACP

Revision `ea81748579`. Reference SHAs: llm 764dc38, datasette cec5e6b, sqlite-utils 6bc1d33, textual 06dbeef.
Raw survey notes: `notes/12-cli/task-0.log` (dashboard), `notes/12-cli/task-1.log` (ACP + slash surfaces).

## TL;DR

- Most important structural problem: slash commands have no layer that is independent of the surface. Each command is a method that prints, on a surface-specific object: `HermesCLI` (CLI), `GatewayRunner` mixins (gateway), `_SLASH_BUILTINS` plus a subprocess "shadow" `HermesCLI` (TUI/Desktop), and `_cmd_*` methods (ACP). As a result, `/help` exists 4 times and `/model` runs twice per TUI invocation, in two processes.
- Biggest kill: the TUI slash worker. It is a persistent `HermesCLI` subprocess per session that captures Rich output and then replays side effects onto the live agent through `_SLASH_MIRRORS` (`tui_gateway/slash_worker.py`, `methods_slash.py:438-503`, `server.py:248`).
- Biggest simplification: finish the `slash_exec.EXECUTORS` "thin slice" (6 of 102 commands since 2026-07-29). Every `CommandDef` then owns one executor that returns a typed reply plus effects. About 26 hand-written name lists and 4 handler hosts collapse into one table.
- Low-hanging fruit: 4 findings (CLI-02, CLI-03, CLI-04, CLI-05).
- Seam answer: commands are described by 1 argparse tree plus about 8 side tables, 1 slash registry plus about 26 side tables, 284 dashboard routes that call domain code directly, and a 9-entry ACP list. Making one registry authoritative deletes about 6-8k lines. Most of that is in the slash path, not argparse.

## What this area is

Scope: `hermes_cli/` (259,663 lines, 644 tracked files; `scripts/cli_topics.py`), `cli.py` (1,797), `acp_adapter/` (4,502, 14 files), `agent/legacy_cli.py` (94). Total about 266k lines.

Entry points (`pyproject.toml:566-569`): `hermes = hermes_cli.main:main`, `hermes-agent = agent.legacy_cli:main`, `hermes-acp = acp_adapter.entry:main`.

Measured with `scripts/cli_parser_probe.py`. It builds the real argparse tree with no dispatch, under a scratch `HERMES_HOME`:
- 72 top-level `hermes` commands (75 names with aliases) and 426 argparse parser nodes.
- `COMMAND_REGISTRY`: 102 slash commands (35 `cli_only`, 9 `gateway_only`, 2 config-gated, 26 aliases).
- `HermesCLI._SLASH_DISPATCH` has 44 entries. Another 50 commands resolve by the `_handle_<name>_command` naming convention.
- `HermesCLI`: 17 mixins, 627 methods, 241 distinct `self.X =` attributes (`rg -o "self\.(\w+)\s*=[^=]"` over `cli.py` + `cli_*_mixin.py`). Siblings late-bind the facade 263 times with `from cli import` (`rg -c`).

Modules that matter:

| module | LOC | owns |
|---|---|---|
| `hermes_cli/main.py` | 3,731 | entry `main()`, 4 argv fast paths, `_build_cli_parser`, 40 `cmd_*` handlers/forwarders, `_BUILTIN_SUBCOMMANDS` |
| `hermes_cli/subcommands/*.py` | 66 files | `build_<group>_parser(subparsers, cmd_<group>=...)` per group |
| `hermes_cli/commands.py` (+ `_completion`, `_platforms`) | 567 (+953) | `CommandDef` / `COMMAND_REGISTRY`, `resolve_command`, gateway help, Telegram/Slack menus |
| `hermes_cli/slash_exec.py` | 199 | registry-owned executors (`EXECUTORS`, 6 entries) |
| `cli.py` + `hermes_cli/cli_*` | 23,153 | `HermesCLI` REPL and every CLI slash handler |
| `hermes_cli/console_engine.py` | 862 | dashboard "Hermes Console": a curated re-wrap of argparse subcommands |
| `hermes_cli/web_server.py` + 17 `web_server_*.py` + `web_routers/` (27 files) + `dashboard_auth/` (15) | ~25k | dashboard FastAPI backend, 284 HTTP/WS routes |
| `acp_adapter/` | 4,502 | ACP server; own 9-command slash list (`commands.py:48`) |
| `gateway/slash_commands*.py` (other seam, read for comparison) | 4,571 | gateway slash handlers |

### Why `hermes_cli/` is 260k lines (topic breakdown)

Rules are first-match on filename (`scripts/cli_topics.py`). The external-importer count is the number of files in `agent tools gateway tui_gateway cron plugins acp_adapter run_agent.py model_tools.py cli.py hermes_state*.py` that import the topic (`rg -l`).

| topic | LOC | files | CLI? | external importer files | proposed home |
|---|---|---|---|---|---|
| dashboard backend (web_server*, web_routers, dashboard_auth, PTY bridge) | 31,704 | 72 | no, HTTP server | web_server 2, dashboard_auth 7 | `hermes_dashboard/` |
| interactive classic CLI (HermesCLI mixins, render, input) | 27,349 | 52 | yes | — | stays |
| update / install / release / source build | 20,234 | 58 | no, updater runtime | update_cmd 0 | `hermes_update/` (seam 03) |
| auth / accounts / secrets | 17,377 | 39 | no, core library | auth 44 | core package (seam 07/05) |
| models / providers / runtime provider | 17,326 | 34 | no, core library | models 39, runtime_provider 37 | `providers/` (seam 05) |
| setup wizard / tools config / doctor | 16,853 | 45 | yes (interactive) | — | stays |
| plugins (loader, host, catalog, install) | 16,528 | 43 | no, core library | plugins 57 | `hermes_plugins/` (seam 11) |
| kanban (board DB, dispatcher, CLI) | 15,318 | 18 | DB + dispatcher are not | kanban_db 10 | `kanban/` with `tools/kanban_tools.py`, `plugins/kanban/` |
| gateway service management (systemd/launchd/Windows, migrate) | 14,737 | 22 | no, service manager | gateway 10 | `gateway/service/` |
| sessions / state / backup / worktrees | 14,424 | 35 | mixed | backup 2 | split (seam 08) |
| command framework (entry, argparse, slash registry) | 12,683 | 81 | yes | — | stays |
| config system | 10,704 | 18 | no, core library | config 239 | core package (seam 07) |
| agent features exposed as commands (goals, skills hub, curator, ...) | 10,479 | 24 | mixed | goals 10 | mixed |
| observability package | 10,029 | 26 | no | observability 47 | `hermes_observability/` (seam 14) |
| desktop app / OS integration | 9,903 | 33 | no | local_runtime 9 | `hermes_desktop_host/` |
| profiles | 5,125 | 10 | no, core library | profiles 47 | core package |
| one-shot migrations / retirements | 3,199 | 12 | yes, one-shot | — | kill list (seam 15) |
| MCP config/catalog | 2,587 | 5 | no | — | `tools/mcp*` |
| generic utilities | 1,596 | 8 | no | — | core utils |
| local proxy | 1,508 | 9 | no, server | — | own package |

Rollup: CLI proper (interactive CLI + command framework + setup wizard + migrations) is 60,084 lines (23%). Core libraries that other packages import (config, profiles, auth, models, plugins, MCP, observability, utils) are 81,272 lines (31%). Servers and services (dashboard, gateway service, proxy, desktop host, updater, kanban) are 93,404 lines (36%). Mixed is 24,903 lines (10%).

## How it works end to end

### Flow A: user types `/model gpt-5` in the TUI (or Desktop)

1. `tui_gateway/methods_tools.py:1118` (`slash.exec`) splits the command into `base="model"` and `arg="gpt-5"`.
2. `tui_gateway/methods_slash.py:320::_live_slash_command_output` answers bare `/model` from the live session. With an argument it returns `None`.
3. `methods_tools.py:1136-1142` routes `_PENDING_INPUT_COMMANDS` (`tui_gateway/server.py:3542`) and bundles to `command.dispatch`. `model` is not in that set.
4. `methods_tools.py:1146-1158` runs the skill gate and the plugin command check.
5. `methods_tools.py:1160-1176` lazily spawns `_SlashWorker` (`server.py:248`, "Persistent HermesCLI subprocess") under a per-session lock.
6. `tui_gateway/slash_worker.py:183` builds a full `HermesCLI(...)` in the child process (`cli.is_slash_worker = True`, `:186`).
7. `slash_worker.py:135-150` swaps the Rich console to a `StringIO`, redirects stdout/stderr and calls `cli.process_command("/model gpt-5")`.
8. `cli.py:1192::HermesCLI.process_command` resolves through `resolve_command`, then `_SLASH_DISPATCH["model"] -> _handle_model_switch` (`cli.py:1157-1186`).
9. `hermes_cli/cli_model_switch_mixin.py:250::_commit_model_switch` swaps the shadow CLI's agent and prints a summary. `:262` skips metrics because "the tui_gateway mirror counts the real switch".
10. `slash_worker.py:146` strips ANSI from the captured text and returns it to the parent.
11. `methods_tools.py:1184::_mirror_slash_side_effects` → `methods_slash.py:474`, which looks up `_SLASH_MIRRORS["model"]` (`:438`).
12. `tui_gateway/model_switch.py:295::_apply_model_switch` performs the switch again on the live agent. Both paths end in `hermes_cli/model_switch.py:1740::switch_model`.

### Flow B: `hermes cron list`, and the same command in the dashboard console

1. `hermes_cli/main.py:3610::main` runs process setup, then tries 4 fast paths (`:3674-3681`). Each one parses argv by hand and bails out because `cron` is not chat/serve.
2. `main.py:3451::_build_cli_parser` builds all 72 groups (426 nodes), including `subcommands/cron.py:14::build_cron_parser(subparsers, cmd_cron=...)`.
3. `main.py:3415::_register_plugin_cli_commands` is skipped because `cron` is in the hand-kept `_BUILTIN_SUBCOMMANDS` (`main.py:2897`).
4. `main.py:3565::_parse_cli_args` parses with the bpo-9338 workaround.
5. `main.py:3012::_prepare_agent_startup` returns early, because `cron list` is not in `_AGENT_COMMANDS` / `_AGENT_SUBCOMMANDS` (`main.py:2971-2976`).
6. `main.py:3723` calls `args.func` = `cmd_cron`, which is a `_forward_command` closure (`main.py:1973`).
7. `hermes_cli/cron.py:948::cron_command` re-dispatches on the string `args.cron_command` through `_CRON_SUBCOMMANDS` (`cron.py:928`).
8. Dashboard variant: `hermes_cli/web_routers/chat_ws.py:278::console_ws` → `console_engine.py:387::HermesConsoleEngine.execute`.
9. `console_engine.py:236::_dispatch` rebuilds the `cron` subparser from the `_CLI_FAMILIES` description (`console_engine.py:269`).
10. `console_engine.py:52::_capture_output` runs the same `cmd_cron` under `redirect_stdout` and catches `SystemExit`.

## Findings

### CLI-01: Slash commands are methods on four surface objects; there is no surface-independent command layer
- severity critical · effort L · kind restructure · low_hanging false · loc_delta about -5,000 · depends_on []
- evidence:
  - `cli.py:1157`, `cli.py:1178-1186`
  - `gateway/run_busy.py:910-930`
  - `tui_gateway/methods_tools.py:1091`, `tui_gateway/methods_tools.py:1118-1190`
  - `tui_gateway/server.py:248`, `tui_gateway/slash_worker.py:135-186`
  - `tui_gateway/methods_slash.py:303-503`
  - `hermes_cli/cli_model_switch_mixin.py:262`
  - `acp_adapter/commands.py:48-131`
  - `hermes_cli/slash_exec.py:1-199`
  - `hermes_cli/goal_command.py::dispatch_goal_command`
- problem:
  - How it works today: a command's behaviour lives in a method that prints. The method sits on the object of the surface that first needed it:
    - `HermesCLI`: 78 `_handle_*_command`/`_cmd_*` methods across the mixins (`rg -c`).
    - `GatewayRunner` mixins: 62 `_handle_*_command` methods; `gateway/slash_commands*.py` is 4,571 lines.
    - TUI: `_SLASH_BUILTINS` (18 keys) plus `_LIVE_SLASH_OUTPUT` formatters (13).
    - ACP: 9 `_cmd_*` methods.
  - TUI and Desktop do not reimplement the CLI-only commands. They spawn a persistent `HermesCLI` subprocess per session, capture its Rich output, strip ANSI, and replay mutations onto the live agent through `_SLASH_MIRRORS`. The code calls this a "shadow CLI" (`cli_model_switch_mixin.py:262`). `/model x` therefore runs `switch_model` twice, in two processes.
  - Each session that uses a slash command pays for a second full CLI process, including its own MCP fleet (comment at `methods_tools.py:1163`).
  - `/help` has 4 implementations: `cli_loops_mixin.py:82`, `slash_exec.py:102`, `methods_slash.py::_format_live_help_output`, `acp_adapter/commands.py:133`. `/queue`, `/steer` and `/compress` each have 3 or 4.
  - Every fix to a command has to find its twins. The gist's "missed sibling path" rework class (56 tags, `inputs/gist/0-plan.md` §4 Phase 6) is this structure.
  - The repo already has the right shape twice: `goal_command.dispatch_goal_command` (all surfaces delegate to it, `hermes_cli/AGENTS.md` § Shared goal commands) and `slash_exec.EXECUTORS`. `EXECUTORS` covers 6 of 102 commands, and it stopped at "informational" commands (`bcb352eeab`, 2026-07-29).
- move: Make the executor the only implementation.
  1. `CommandDef` gains `run: str` ("module:function", kept import-light like `execute`). Every command implements `run(ctx: CommandContext) -> CommandReply`.
  2. `CommandContext` carries `args` and a `SessionPort` protocol implemented once per surface: `agent`, `session_db`, `config`, `profile_scope()`, `is_running`.
  3. `CommandReply` carries `text`, `data`, and a tuple of typed effects: `SwitchModel(result)`, `QueueTurn(text)`, `RebuildAgent`, `ExitRepl`, `ClearScreen`, `OpenPicker(kind)`. Each surface applies them.
  4. CLI `process_command`, gateway `_command_handler_table`, TUI `command.dispatch`/`slash.exec` and ACP `_handle_slash_command` each become "resolve → check busy policy from registry → run → render/apply effects", about 40 lines each.
  5. Delete `tui_gateway/slash_worker.py`, `_SlashWorker`, `_SLASH_MIRRORS`, `_PENDING_INPUT_COMMANDS`, `_WORKER_BLOCKED_COMMANDS`, `_SLASH_BUILTINS`, the ACP `_cmd_*` methods, and the gateway `_handle_*_command` bodies, once each command is migrated.
  6. Migrate one category per PR. Mutating commands go first (`model`, `compress`, `queue`, `steer`, `reset`/`new`), because they carry the duplicates.
- reference: textual `.repos/textual/src/textual/command.py:402` (`Command`) and `.repos/textual/src/textual/system_commands.py:19` (`SystemCommandsProvider`). Commands are data plus a callback. The palette UI only renders and invokes them. In-repo exemplar: `hermes_cli/slash_exec.py:20-35` (`CommandContext`/`CommandReply`).
- risk:
  - Facade monkeypatch seams on `cli.HermesCLI._handle_*` and gateway mixins break, and tests that patch them must move to the executor.
  - Behaviour to keep:
    - deferred vs `--now` cache invalidation (root AGENTS.md)
    - busy-policy semantics per surface (`busy_policy`, `busy_handler`)
    - profile scope binding off-turn (`methods_slash.py:494`, #122655)
    - the TUI compute-host forwarding (`_compute_host_slash`)
    - CLI pickers that need prompt_toolkit (expressed as `OpenPicker` effects)

### CLI-02: About 26 hand-written slash-name collections restate `COMMAND_REGISTRY` data, and they have already drifted
- severity high · effort M · kind collapse · low_hanging true · loc_delta about -250 · depends_on []
- evidence:
  - `gateway/run_busy.py:908-922`, `gateway/run_busy.py:952-954`
  - `gateway/run.py:4076`
  - `gateway/run_inbound.py:1044`
  - `tui_gateway/server.py:3531-3547`
  - `tui_gateway/methods_slash.py:19`, `tui_gateway/methods_slash.py:348`
  - `tui_gateway/methods_session_control.py:214`
  - `acp_adapter/commands.py:40`, `acp_adapter/commands.py:48-70`
  - `cli.py:1158`
  - `hermes_cli/commands.py:45-73`
- problem:
  - `hermes_cli/AGENTS.md` says `COMMAND_REGISTRY` "is the single source". It is not. An AST scan of collection literals with ≥3 registry names, tests excluded (`notes/12-cli/task-1.log` B3), finds about 26 parallel collections. These are the clearest:
    - gateway `_PLAIN_COMMANDS` (22), `_IDLE_COMMANDS` (35), `_BUSY_SPECIAL_HANDLERS`, `_BUSY_REJECT_TEXT`, `_HM_CANONICAL_COMMANDS`
    - TUI `_PENDING_INPUT_COMMANDS`, `_TUI_HIDDEN`, `_TUI_EXTRA`, `_MUTATES_WHILE_RUNNING`, `_SESSION_CONTROL_SLASHES`
    - ACP `_COMMANDS` and `_MID_TURN_BLOCKED_COMMANDS`
  - "Blocked while a turn runs" is defined 4 ways: registry `busy_policy`, ACP `:40`, TUI `methods_slash.py:348`, gateway busy tables. Every one of the 22 `_PLAIN_COMMANDS` has `busy_policy="dispatch"`, so that tuple is derivable.
  - Drift already observed:
    - ACP accepts `/reset` but not its canonical `/new`.
    - ACP does not know `/compact`.
    - ACP advertises `/tools`, which the registry marks `cli_only`.
    - ACP `/queue` only appends, while the registry describes list/edit/rm.
    - `_SLASH_DISPATCH["exit"]` (`cli.py:1158`) is unreachable, because `resolve_command("exit")` returns `quit`.
  - Surface visibility is spread across `cli_only`, `gateway_only`, `gateway_config_gate`, `desktop`, `desktop_subcommands`, `_TUI_HIDDEN` and `_TUI_EXTRA`: seven mechanisms for "which surfaces show this command".
- move:
  1. Replace `cli_only`/`gateway_only`/`desktop`/`_TUI_HIDDEN` with one `surfaces: frozenset[Surface]` field (`Surface = Literal["cli","tui","desktop","gateway","acp"]`). Move `_TUI_EXTRA` entries into the registry with `surfaces={"tui"}`.
  2. Derive the gateway `_PLAIN_COMMANDS` and the busy tables from `busy_policy`/`busy_handler`. Derive ACP `_COMMANDS` from `surfaces`, and ACP and TUI blocking from `busy_policy == "reject"`.
  3. Add one invariant test: every name in any dispatch table resolves to a registry entry visible on that surface.
  4. Delete the `"exit"` key.
- reference: llm `.repos/llm/llm/cli.py:534-541`. The click decorator carries name, aliases, help and handler in one declaration, so no second list can drift.
- risk:
  - The gateway idle vs busy split must keep the same membership. Diff the derived sets against today's tuples in the PR.
  - ACP clients that type `/reset` must keep working (it is an alias, so it does).

### CLI-03: The argparse command tree has six registration conventions, string re-dispatch inside every group, forwarding shims in `main.py`, and a second description of the tree in `console_engine`
- severity high · effort M · kind collapse · low_hanging true · loc_delta about -900 · depends_on []
- evidence:
  - `hermes_cli/main.py:1949-1990`, `hermes_cli/main.py:3451-3562`, `hermes_cli/main.py:3402-3441`
  - `hermes_cli/cron.py:928-952`, `hermes_cli/plugins_cmd.py:1001-1006`, `hermes_cli/auth_commands.py:904`
  - `hermes_cli/console_engine.py:260-345`
  - `hermes_cli/subcommands/__init__.py:1-6`
- problem:
  - How a group joins `hermes` today depends on the group:
    1. `subcommands/X.py::build_X_parser(subparsers, cmd_X=...)` with a `cmd_X` in `main.py`
    2. `subcommands/X.py` → `X.register_cli(parent)` (curator, pets, journey, checkpoints, bundles, vault, secrets, proxy)
    3. `X.build_parser(subparsers).set_defaults(func=...)` (kanban, project)
    4. `portal_cli.add_parser`
    5. `send_cmd.register_send_subparser` and `agent.lsp.cli.register_subparser`
    6. plugin dict descriptors `{name, help, setup_fn, handler_fn}`, with a separate discovery path for memory plugins (`main.py:3424-3439`)
  - `console_engine.py` encodes four of these as `_CliSurface` kinds ("extracted", "registered", "builder", "adder"). It re-describes 27 families with hand-typed subcommand lists and `*` mutating markers (`_CLI_FAMILIES`, `console_engine.py:269`), plus `_BLOCKED_TOP` and `_BLOCKED_PAIRS`.
  - Inside each group, argparse already knows which leaf was chosen. The code still stores the leaf name in `dest="<group>_action"` (56 sites, `rg`) and looks it up again in a per-module dict (`_CRON_SUBCOMMANDS`, `_PLUGIN_ACTIONS`, `_AUTH_ACTIONS`, ...; 52 `getattr(args, "<group>_action")` sites).
  - This is why AGENTS.md needs the rule "argparse alias dispatch: dest is the literal the user typed".
  - `main.py` holds 24 `_forward_command` closures plus 16 `cmd_*` functions that only exist so the builders can be injected without importing `main`.
  - Adding a subcommand touches 3-4 files. Adding it to the dashboard console touches a fifth, and nothing checks that the five agree.
- move:
  1. Use one convention. Each command module exports `register(subparsers) -> None` and calls `set_defaults(func=<leaf handler>)` on every leaf parser. Leaf handlers are referenced as `"module:attr"` strings and resolved at call time, which keeps the lazy imports and patch seams.
  2. Delete the `<group>_action` re-dispatch dicts and `_forward_command`.
  3. Put console metadata on the parser (`set_defaults(_console="read"|"mutating"|"blocked")`). `console_engine` then walks the real tree instead of `_CLI_FAMILIES`/`_BLOCKED_*`.
  4. Plugins get one hook, `register_commands(subparsers)`. Memory plugins use it too.
- reference: llm `.repos/llm/llm/cli.py:1543-1549` (`@cli.group(cls=DefaultGroup)`) and `.repos/llm/llm/hookspecs.py:8` (`register_commands(cli)`), called once at `.repos/llm/llm/cli.py:4107`. datasette does the same at `.repos/datasette/datasette/cli.py:895`.
- risk:
  - Plugin authors' `register_cli_command(name, help, setup_fn, handler_fn)` is a documented plugin API. Keep it as an adapter onto the new hook.
  - `hermes --help` order is registration order (`main.py:3454`) and must stay stable.
  - Tests that patch `hermes_cli.main.cmd_X` need new targets.

### CLI-04: Operations print, prompt and `sys.exit` instead of returning results, so other surfaces capture stdout or spawn the CLI
- severity high · effort M · kind boundary · low_hanging true · loc_delta about -300 · depends_on []
- evidence:
  - `tui_gateway/slash_worker.py:135-150`
  - `hermes_cli/console_engine.py:52-62`
  - `hermes_cli/web_server_gateway.py:290-400`
  - `hermes_cli/backup.py:731-1052`
  - `hermes_cli/cli_commands_mixin.py`: 152 print/_cprint calls
- problem:
  - The output surfaces are built around terminal-shaped operations:
    - The TUI/Desktop gets slash output by running the CLI in a subprocess and scraping a Rich console.
    - The dashboard's `/api/console` runs argparse handlers under `redirect_stdout` and converts `SystemExit` codes into results.
    - Dashboard gateway verbs spawn `hermes [-p X] gateway <verb>` as a child process.
  - `backup.run_import` (CC 56, 321 lines, the second-worst function in the tree per `SUMMARY.md`) interleaves zip validation, the restore loop, an overwrite prompt, about 60 `print` calls and 5 `sys.exit` calls. Neither the dashboard nor the updater can call it and get a structured answer.
  - Every new surface pays this cost again. Scraped text cannot carry the warnings or fields that a UI needs.
  - Count: `rg -c redirect_stdout` finds 17 call sites across `hermes_cli` and `tui_gateway`.
- move:
  - Split each operation into `do_X(...) -> XReport` (a frozen dataclass, no I/O on stdout, raises typed errors) and a CLI renderer `print_X(report)`.
  - First targets:
    - `backup.run_import` → `restore_backup(zip_path, target, *, overwrite: bool) -> RestoreReport` plus a renderer; the prompt moves to the CLI caller.
    - gateway start/stop/status as functions the dashboard calls in process. Keep the subprocess path only for `update`, which must replace the running code.
    - the console engine's handlers, once CLI-03 gives them a leaf function.
- reference: sqlite-utils `.repos/sqlite-utils/sqlite_utils/cli.py:446-456`. The `vacuum` command is three lines over `Database.vacuum()` (`.repos/sqlite-utils/sqlite_utils/db.py:2026`). The library returns values, and only the click layer prints.
- risk:
  - Exit codes are a contract for scripts (`hermes import` returns 1 on damaged archives, `backup.py:732`).
  - Gateway start from the dashboard must keep the scrubbed per-profile child env (`web_server_gateway.py:351-396`).

### CLI-05: The dashboard backend reimplements domain operations per router, against private helpers, in router + `web_server_<domain>` file pairs
- severity high · effort M · kind collapse · low_hanging true · loc_delta about -1,500 · depends_on [CLI-04]
- evidence:
  - config: `hermes_cli/web_routers/config_env.py:118`, `hermes_cli/config.py:3611`, `tui_gateway/methods_config_set.py:107-489`
  - MCP: `hermes_cli/web_routers/mcp.py:100`, `hermes_cli/web_routers/mcp.py:127-131`, `hermes_cli/web_routers/mcp.py:190-195`
  - cron: `hermes_cli/web_server_cron.py:19-70`, `hermes_cli/web_server_cron.py:158-163`
  - tools: `hermes_cli/web_routers/tools.py:308`
  - skills: `hermes_cli/web_routers/skills.py:343`
  - app: `hermes_cli/web_server.py:1010-1040`
- problem:
  - 284 routes in 24 routers plus 17 `web_server_*` helper siblings (about 25k lines, `notes/12-cli/task-0.log`). Shared code exists only at the bottom layer (`SessionDB`, `load_config`/`save_config`, `switch_model`, `profiles.create_profile`).
  - Above that layer each surface writes its own operation:
    - Config set has three algorithms: a dashboard whole-document `_deep_merge`, CLI `set_config_value`, and TUI per-key setters (380 lines).
    - Routers import private names across packages: `tools.skills_tool._find_all_skills`, `tools_config._save_platform_tools`, `mcp_config._save_mcp_server`/`_remove_mcp_server`, and `tui_gateway.mcp_rpc_helpers` from `hermes_cli` (`web_routers/mcp.py:100`, an upward import into the TUI backend).
    - The MCP plugin-ownership 409 check is pasted twice. Cron validation is a second copy of the `cronjob` tool's normalisation.
  - Domain logic is split between `web_routers/<d>.py` and `web_server_<d>.py`, so a reader opens two files per endpoint.
  - 0 `response_model=` and 148 `except Exception` in the routers, so the HTTP contract is untyped dicts.
- move:
  1. One public service function per operation, in the module that owns the domain. Examples: `config.apply_config_patch(patch, *, scope) -> ConfigChange` used by the dashboard, CLI `config set` and the TUI `config.set`; `mcp_config.add_server` / `remove_server` with the ownership check inside.
  2. Routers become parse → call → serialize with `response_model=`.
  3. Fold each `web_server_<d>.py` into its router, or into the domain service when the code is not HTTP-specific.
  4. Remove the `hermes_cli → tui_gateway` import by moving `server_configs_with_sources` into `mcp_config`.
- reference: sqlite-utils `.repos/sqlite-utils/sqlite_utils/cli.py:446-456` over `.repos/sqlite-utils/sqlite_utils/db.py:2026`. Every front end calls one library method; the front end owns only argument parsing and output.
- risk:
  - Config writes must keep going through `atomic_config_write`/`atomic_config_replace` (`hermes_cli/AGENTS.md` § One writer seam).
  - The dashboard's whole-document save semantics (deletion by omission refused) must be preserved per caller.

### CLI-06: `hermes_cli` is the core library, not the CLI; 77% of its lines are not CLI code
- severity high · effort XL · kind restructure · low_hanging false · loc_delta about 0 (moves) · depends_on [01-layout]
- evidence:
  - `inputs/metrics/hermes_cli_topics.json`
  - `hermes_cli/config.py` (imported by 239 non-`hermes_cli` files)
  - `hermes_cli/plugins.py` (57), `hermes_cli/profiles.py` (47), `hermes_cli/observability/` (47), `hermes_cli/auth.py` (44), `hermes_cli/models.py` (39), `hermes_cli/runtime_provider.py` (37)
  - `hermes_cli/kanban_db.py`, `hermes_cli/web_server.py`
- problem:
  - Only 60k of 260k lines are command-line code (topic table above).
  - The rest:
    - libraries the agent loop, tools and gateway import at runtime: config, auth, providers, plugins, profiles, observability (81k)
    - long-running servers and services: dashboard, gateway service manager, proxy, updater, kanban dispatcher, desktop host (93k)
  - The import matrix shows the cost: `agent → hermes_cli` 41 eager / 420 lazy edges, and `tools → hermes_cli` 39/266 (`SUMMARY.md`). The "CLI" package sits under the agent core.
  - A contributor cannot tell from the path whether a module runs in the REPL, in a server, or inside every agent turn.
  - `hermes_cli/AGENTS.md` (24k chars) has to cover config, skins, updater, profiles, multiplex, free tier and gateway service installs, because they all live here.
- move:
  - Move by topic, one package per PR, without shims (root AGENTS.md forbids re-export shims):
    - `hermes_dashboard/`: web_server*, web_routers, dashboard_auth, main_dashboard, dashboard_procs, console_engine
    - `kanban/`: kanban_db*, dispatcher, plus `tools/kanban_tools.py` and `plugins/kanban`
    - `gateway/service/`: gateway.py, gateway_launchd/windows/migrate/enroll
    - `hermes_update/`: update_*, _old_updater, source_*
    - `hermes_observability/`
  - Leave config/auth/profiles/providers to seams 01/05/07, which own the core-package question.
  - `hermes_cli` keeps: main, subcommands, commands*, cli_*, setup wizard, doctor, curses UI.
- reference: datasette keeps its CLI to one 928-line module over the `Datasette` app object (`.repos/datasette/datasette/cli.py:125-127`). llm keeps `llm/cli.py` as a client of the importable `llm.get_model` (`.repos/llm/llm/__init__.py:347`).
- risk:
  - Every move breaks `monkeypatch` targets and plugin imports of internal paths. Internal paths are not API, but `hermes_cli/update_handoff.py` and `update_serve_obligations.py` are a frozen compat surface for old updaters (`hermes_cli/AGENTS.md:178-185`) and must not move.
  - Docs that cite paths must be fixed in the same PR.

### CLI-07: The eager full-tree parser forces four hand-rolled argv fast paths and a hand-kept builtin list
- severity medium · effort M · kind restructure · low_hanging false · loc_delta about -350 · depends_on [CLI-03]
- evidence:
  - `hermes_cli/main.py:348-409`, `hermes_cli/main.py:2893-2918`
  - `hermes_cli/main.py:3205-3383`
  - `hermes_cli/main.py:3171-3177`
  - `hermes_cli/main.py:3220-3226`, `hermes_cli/main.py:3259-3264`, `hermes_cli/main.py:3688-3693`
- problem:
  - `main.py` imports 61 subcommand builder modules at module level, and `_build_cli_parser` builds all 426 parser nodes ("~140ms", `main.py:3247`). To avoid that, `main()` tries `_try_termux_fast_tui_launch`, `_try_termux_fast_cli_launch`, `_try_fast_serve_launch` and `_try_fast_chat_launch` first. Each re-derives the chat/serve decision from raw argv and repeats preconditions:
    - The container-exec routing check appears 3 times.
    - `--yolo` env setting appears 3 times (`:3019`, `:3283`, `:3703`).
  - The divergence has produced bugs: `-z` ignored `--resume`/`-c` until #105892 (`main.py:3174-3176`).
  - `_BUILTIN_SUBCOMMANDS` is a hand copy of the top-level names, kept only to decide whether plugin discovery runs. Its comment says "Keep in sync".
- move:
  1. One lazy table `COMMANDS: dict[str, str]` mapping each top-level name to `"module:register"`.
  2. Build only the selected group's subparser. Build all groups only for `--help` and completion.
  3. `_BUILTIN_SUBCOMMANDS` becomes `COMMANDS.keys()`.
  4. The four fast paths collapse into the normal path, because the normal path is now cheap.
  5. Container routing and `--yolo` run once, before parsing.
- reference: null. No reference repo has a lazy click/argparse group: `rg LazyGroup .repos` finds nothing in the CLIs. The table is the same idea as pyproject console-script entry points (`pyproject.toml:566-569`).
- risk:
  - Startup time on Termux and Windows is the reason the fast paths exist. Measure cold `hermes`, `hermes serve` and `hermes --tui` before and after.
  - The bpo-9338 workaround (`main.py:3565-3600`) needs the full set of command names, and the table provides it.

### CLI-08: Four non-interactive "run one prompt" runners
- severity medium · effort M · kind collapse · low_hanging false · loc_delta about -500 · depends_on []
- evidence:
  - `hermes_cli/cli_single_query.py:483` (`-q`, goes through `HermesCLI`)
  - `hermes_cli/oneshot.py:238` (`-z`, "Bypasses cli.py entirely", `main.py:3171`)
  - `hermes_cli/quiet_single_query.py:1-10` (`chat -Q`, Bot Mode)
  - `run_agent.py:1506` (`hermes-agent`)
  - `hermes_cli/main.py:3174-3176`
- problem:
  - `-q`, `-z`, `chat -Q` and `hermes-agent` each build an agent, run one turn and print. Each has its own resume handling, toolset defaults, exit-code mapping and cleanup.
  - `main.py:_ONESHOT_CLEANUPS` mirrors `cli.py:_run_cleanup()` by hand (`main.py:100-132`).
  - Sibling drift produced #105892 (`-z` silently dropped `--resume`) and the `chat -Q` session-key bug described in `quiet_single_query.py:3-9`.
  - `agent/oneshot.py` is an unrelated concept (stateless auxiliary call) with the same name.
- move:
  - One `run_noninteractive(prompt, *, session: SessionArgs, output: Literal["final","quiet","stream-json"], usage_file) -> RunResult` in `hermes_cli/noninteractive.py`. Every flag maps onto it.
  - Process-global cleanup lives in one function that both it and the REPL call.
  - Rename `agent/oneshot.py` to `agent/aux_oneshot.py`.
- reference: llm `.repos/llm/llm/cli.py:895`. One `prompt` command resolves the model once (`get_model(...)`) and switches output by flags instead of separate entry points.
- risk:
  - Bot Mode delivers DMs through `chat -Q --query-file` and relies on its notify loop (`quiet_single_query.py:1-10`).
  - `-z` stdout must stay final-response-only.
  - Usage-file keys are consumed by batch pipelines (`oneshot.py:25-30`).

### CLI-09: `HermesCLI` is one namespace spread over 17 mixins
- severity medium · effort L · kind restructure · low_hanging false · loc_delta about -2,000 · depends_on [CLI-01]
- evidence:
  - `cli.py:891`
  - `hermes_cli/cli_commands_mixin.py` (2,732), `hermes_cli/cli_tui_mixin.py` (2,322), `hermes_cli/cli_init_mixin.py` (455)
  - `hermes_cli/AGENTS.md:16-18`
- problem:
  - `class HermesCLI(CLIInitMixin, ... CLIChatTurnMixin)` has 17 bases, 627 methods and 241 instance attributes. `cli_init_mixin.py` alone assigns 159 of them.
  - The mixins are not modules. Each reads attributes the others set, and the siblings reach back into `cli.py` 263 times (`from cli import`) to keep monkeypatch seams. Mutable module state stays in `cli.py` by rule.
  - The decomposition spread one class over files without narrowing any interface.
  - Because `HermesCLI` is also the slash-command host for TUI/Desktop (CLI-01), REPL concerns and command logic cannot be separated.
- move:
  - After CLI-01, the command mixins (commands, loops, info, session, model_switch, billing, about 7.5k lines) become registry executors over `SessionPort`.
  - `HermesCLI` keeps prompt_toolkit concerns: TUI widgets, status bar, stream, modal, terminal input, voice.
  - Promote what remains to composed objects with explicit dependencies (`StatusBar(state)`, `StreamRenderer(console)`) instead of mixins sharing `self`.
- reference: textual `.repos/textual/src/textual/command.py:532`. `CommandPalette` is its own screen object fed by providers; it is not a mixin on `App`.
- risk:
  - "Wrapper CLIs extend via the protected hooks in `cli_tui_mixin.py`" (`hermes_cli/AGENTS.md:39-40`, documented in the developer guide) is an extension API, and those hooks must survive.
  - Many tests construct `HermesCLI` via `object.__new__` and set attributes by hand.

### CLI-10: Kill the `hermes-agent` legacy runner
- severity medium · effort S · kind kill · low_hanging false · loc_delta about -200 · depends_on []
- evidence:
  - `pyproject.toml:568`
  - `agent/legacy_cli.py:1-94`
  - `run_agent.py:1506-1586`
- problem:
  - A second CLI program builds `AIAgent` directly with its own flags (`--save-trajectories`, `--log-prefix-chars`, OpenRouter-style defaults) and prints an emoji banner (`run_agent.py:1537`).
  - Its only reason to exist is `pip install` users who type `hermes-agent`.
  - It has needed two fixes so far: f80977c0bd ("guard legacy hermes-agent entrypoint") and 2fb564d2df (bare invocation ran a real model turn with a demo query, #54648). `legacy_cli.py` also carries its own `_early_recovery` copy (`legacy_cli.py:18-23`).
- move:
  - Point `hermes-agent` at a 10-line shim that maps `--query/-q`/positional to `hermes -z` and prints a deprecation line, for one release.
  - Then remove the console script, `agent/legacy_cli.py` and `run_agent.main`/`_print_tool_listing`.
  - Trajectory saving stays where it is used (`batch_runner.py`, off-path).
- reference: null
- risk:
  - External scripts that call `hermes-agent --save-trajectories` lose that flag. UNVERIFIED how many exist; the installer does not reference the script (`rg hermes-agent scripts/install.sh` shows only repo/dir names).

## Kill list

| target | why | importers/callers | evidence |
|---|---|---|---|
| `tui_gateway/slash_worker.py` + `server.py::_SlashWorker` | a shadow `HermesCLI` subprocess per session that exists only because commands print | 1 (`methods_tools.py:1164`) | CLI-01; `slash_worker.py:183`, `cli_model_switch_mixin.py:262` |
| `tui_gateway/methods_slash.py::_SLASH_MIRRORS` / `_mirror_slash_side_effects` | replays worker mutations on the live agent | `methods_tools.py:1184`, `methods_slash.py:305` | CLI-01 |
| `acp_adapter/commands.py::_COMMANDS`, `_cmd_*` (8 of 9) | own command list with drift; reimplements CLI/gateway behaviour | ACP only | CLI-01/02; `commands.py:48-131` |
| `cli.py:1158` `_SLASH_DISPATCH["exit"]` | unreachable: `resolve_command("exit")` → `quit` | 0 effective | `notes/12-cli/task-1.log` B1 |
| `hermes_cli/main.py::_forward_command` + 24 forwarders | indirection that exists only to inject handlers | `_build_cli_parser` | CLI-03; `main.py:1949-1990` |
| `hermes_cli/main.py::_BUILTIN_SUBCOMMANDS` | hand copy of the parser's top-level names | `_plugin_cli_discovery_needed` | CLI-07; `main.py:2897` |
| 4 fast paths `_try_*_launch` | argv re-parsing that exists only because the parser is eager | `main()` | CLI-07; `main.py:3205-3383` |
| `console_engine.py::_CLI_FAMILIES`, `_CliSurface` kinds, `_BLOCKED_*` | second description of the argparse tree | `HermesConsoleEngine` | CLI-03; `console_engine.py:260-345` |
| `agent/legacy_cli.py`, `run_agent.py::main`, `hermes-agent` script | duplicate of `hermes -z` | console script only | CLI-10 |

## Simplify list

| what N things | become what 1 thing | lines saved | evidence |
|---|---|---|---|
| CLI `_handle_*` (78), gateway `_handle_*` (62), TUI builtins/formatters/mirrors, ACP `_cmd_*` (9) | one `CommandDef.run` executor per command + 4 thin surface adapters | ~5,000 | CLI-01 |
| ~26 slash-name collections + 7 visibility mechanisms | `CommandDef.surfaces` + `busy_policy`, everything else derived | ~250 | CLI-02 |
| 6 parser registration conventions + 52 `<group>_action` re-dispatch sites + console re-description | `register(subparsers)` with `set_defaults(func="mod:attr")` per leaf | ~900 | CLI-03 |
| 4 argv fast paths + `_BUILTIN_SUBCOMMANDS` + full eager tree | one lazy `COMMANDS` name→module table | ~350 | CLI-07 |
| `-q`, `-z`, `chat -Q`, `hermes-agent` runners | `run_noninteractive(..., output=...)` | ~500 | CLI-08 |
| 3 config-set algorithms (dashboard, CLI, TUI) | `config.apply_config_patch` | ~400 | CLI-05 |
| `web_routers/<d>.py` + `web_server_<d>.py` pairs (11 domains) | one router per domain over a domain service | ~1,000 | CLI-05 |

## Reference patterns to copy

| repo | path | pattern | where it applies here |
|---|---|---|---|
| llm | `.repos/llm/llm/cli.py:534-541`, `:1543-1549` | click group/subgroup: name, alias, help and handler in one declaration | argparse tree (CLI-03); registry as the only list (CLI-02) |
| llm | `.repos/llm/llm/hookspecs.py:8`, `.repos/llm/llm/cli.py:4107` | one `register_commands(cli)` plugin hook | plugin CLI commands (CLI-03) |
| datasette | `.repos/datasette/datasette/cli.py:125-127`, `:895` | default subcommand via `DefaultGroup`; plugin commands through the same hook | bare `hermes` → chat (CLI-07), plugins (CLI-03) |
| sqlite-utils | `.repos/sqlite-utils/sqlite_utils/cli.py:446-456` → `db.py:2026` | CLI command is 3 lines over a library method that returns, not prints | operations layer (CLI-04, CLI-05) |
| textual | `.repos/textual/src/textual/command.py:402`, `system_commands.py:19` | commands as data + callback, provided to a renderer | surface-neutral slash executors (CLI-01, CLI-09) |
| in-repo | `hermes_cli/slash_exec.py:20-35`, `hermes_cli/goal_command.py::dispatch_goal_command` | `CommandContext` → `CommandReply`, one dispatcher for all surfaces | the target shape for CLI-01 |

## Answer to the seam question

How the command model works today:
- There are four command languages:
  1. the argparse tree for `hermes <cmd>`: 72 top-level commands, 426 parser nodes
  2. the slash registry `COMMAND_REGISTRY`: 102 commands
  3. the dashboard's REST/WS surface: 284 routes
  4. ACP's own 9 slash commands
- The dashboard also runs a fifth, a curated argparse re-wrap (`console_engine`).
- None of them is a single source:
  - argparse is described once by the parser and again by `_BUILTIN_SUBCOMMANDS`, 40 `main.py` handler shims, about 52 per-group action dicts, `_AGENT_COMMANDS`/`_AGENT_SUBCOMMANDS` and the console engine's `_CLI_FAMILIES`/`_BLOCKED_*`. That is about 8 parallel lists.
  - Slash commands are named by the registry plus about 26 hand-written collections across CLI, gateway, TUI and ACP. They are implemented up to 4 times, and in the TUI by a shadow `HermesCLI` subprocess.
  - Dashboard routes do not use either registry. They call domain helpers directly, often private ones, and reimplement config set, cron validation and MCP ownership checks.

What one registry would delete:
- A click-style rewrite of argparse alone saves about 1.2k lines (CLI-03, CLI-07). It is worth doing, but it is not the big win.
- The big win is making `CommandDef` executable. Each command gets one `run(ctx) -> CommandReply` with typed effects, and each surface implements a `SessionPort` once.
- That deletes the slash worker, the mirrors, ACP's list, the gateway's handler tuples and most of the duplicated handler bodies. That is about 5k lines, plus the bug class where one surface's twin is not fixed (CLI-01, CLI-02).
- The dashboard should not route through the slash registry. Its routes should call the same domain service functions as the CLI (CLI-04, CLI-05).
- `hermes_cli` is 260k lines because it is the core library and four servers as well as the CLI. Only 23% is command-line code (CLI-06).

## Cross-seam notes

- 04-agent-loop: 7 sites call `AIAgent(...)` directly with no shared factory: `acp_adapter/session.py:571`, `tui_gateway/server.py:2665`, `tui_gateway/methods_prompt.py:1012`, `:1090`, `cron/scheduler.py:2505`, `gateway/slash_commands_session.py:607`, `hermes_cli/prompt_size.py:61`.
- 13-tui-cron: `tui_gateway/methods_slash.py`, `server.py:3528-3547` hold 9 slash routing tables; the slash worker is a second agent process per session (`methods_tools.py:1160-1176`).
- 10-gateway: `gateway/run_busy.py:910-922` `_PLAIN_COMMANDS`/`_IDLE_COMMANDS` are hand tuples derivable from `busy_policy`. `curator` is a non-`cli_only` registry command with no gateway handler found (UNVERIFIED).
- 07-config: three config-set implementations: `web_routers/config_env.py:118`, `hermes_cli/config.py:3611`, `tui_gateway/methods_config_set.py:107-489`.
- 14-errors-obs: `hermes_cli/observability/` (10k lines) is imported by 47 files outside `hermes_cli`; `web_routers` has 148 `except Exception`.
- 15-kill: `hermes-agent` script, `agent/legacy_cli.py`, `run_agent.py::main` (CLI-10); `hermes_cli` one-shot migration modules total 3,199 lines (`claw.py`, `agent_import.py`, `*_retirement.py`).
- 03-pm-flows: `hermes_cli/update_*` (20k lines) is updater runtime living in the CLI package; the dashboard spawns it as a subprocess (`web_server_gateway.py:290`).
- 01-layout: `hermes_cli/gateway_setup_wizard.py` calls the facade through `_gw()` 192 times and `gateway_launchd.py` 108 times (`rg -c "_gw\(\)\."`), so the facade + siblings split did not narrow the interface.

## UNVERIFIED

- ~26 parallel slash collections: from a literal-only AST scan by a child reader (`notes/12-cli/task-1.log` B3); inline `if name == "..."` ladders and collections with <3 names are not counted. Verify by extending the scan to `Compare` nodes.
- `curator` has no gateway handler: not confirmed by reading `gateway/run_busy.py` dispatch fallbacks. Verify by sending `/curator` on a gateway test adapter.
- loc_delta figures are estimates from the LOC of files that would disappear or shrink; no prototype was built.
- The 140ms parser cost is the code comment (`main.py:3247`), not measured here. Verify with `python -X importtime -m hermes_cli.main --help`.
- External use of `hermes-agent --save-trajectories`: unknown. Verify via issue search / PyPI download stats.
- Desktop TS slash palette curation (`apps/desktop`) likely holds another command list; out of scope, not read.
- The 284-route count includes 3 SPA/asset routes and excludes 11 `dashboard_auth` routes (child reader's count).
