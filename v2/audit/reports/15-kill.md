# 15 Kill list: off-path code, dead code, duplicate helpers, global state

## TL;DR
- Structural problem: process state lives in ~48 lazy module singletons with hand-rolled per-profile keys; ~50 reset helpers exist only for tests (KIL-01).
- Biggest kill: ~2,400 LOC of RL/datagen root scripts shipped as top-level wheel modules, plus the trajectory format inside AIAgent (KIL-10); and ~850 LOC of verified dead/test-only code (KIL-07).
- Biggest simplification: ~1,600 lines of duplicated helpers across 11 categories collapse onto canonicals that already exist (KIL-02..06, 11, 12).
- Low-hanging fruit: 5 (KIL-02, 03, 04, 05, 06).
- Seam answer: little true dead code (7 functions); the weight is in duplicated helpers that drift on correctness and in module-global state.

## What this area is
Four sweeps: (a) off-path RL/datagen code, notes/15-kill/a-offpath.md; (b) dead code, notes/15-kill/b-dead.md; (c) duplicate helpers, notes/15-kill/c-dupes.md; (d) global state, utils.py, hermes_platform, notes/15-kill/d-globals.md.

| module | LOC | owns |
|---|---|---|
| batch_runner.py | 1018 | parallel datagen over AIAgent with toolset distributions |
| trajectory_compressor.py | 869 | post-hoc trajectory compression for training data |
| mini_swe_runner.py | 406 | SWE-style task runner emitting Hermes trajectories |
| toolset_distributions.py | 106 | random toolset sampling for batch_runner |
| hermes_constants_scratch.py | 198 | scratch-dir pruning; ON-path (hermes_constants.py:922, tools/environments/local.py:65) |
| agent/trajectory.py | 56 | save_trajectory JSONL writer, scratchpad helpers |
| utils.py | 729 | grab-bag helpers, 259 production importers |
| hermes_platform/ | 1364 | host facts and resolvers, 25 non-test importers |

## How it works end to end
### An RL/datagen root script is installed with the wheel and reaches into AIAgent for the trajectory format
Trigger: pip/uv installs hermes-agent; a researcher runs `python -m batch_runner` or an agent turn finishes with trajectory saving on

Inputs: `save_trajectories` (AIAgent was built with trajectory saving (hermes-agent --save_trajectories or batch_runner)); `run_batch_runner` (user runs the datagen script rather than hermes)

1. `setup.py::_root_py_modules` (setup.py:87) — lists every root *.py except setup.py, including the four datagen scripts [always] → KIL-10
2. `setup.py::setup` (setup.py:99) — publishes them as top-level py_modules in site-packages [always] → KIL-10
3. `batch_runner.py (module)` (batch_runner.py:28) — imports fire (a core dependency, pyproject.toml:50) [when run_batch_runner=True] → KIL-10
4. `batch_runner.py (module)` (batch_runner.py:33) — imports run_agent.AIAgent and model_tools.TOOL_TO_TOOLSET_MAP [when run_batch_runner=True]
5. `toolset_distributions.py (module)` (toolset_distributions.py:11) — imported only by batch_runner (:34); validates names against toolsets [when run_batch_runner=True] → KIL-10
6. `agent/turn_finalizer.py (save_trajectory step)` (agent/turn_finalizer.py:603) — at turn end calls agent._save_trajectory [when save_trajectories=True] → KIL-10
7. `agent/session_persistence.py::_save_trajectory` (agent/session_persistence.py:525) — converts and writes the trajectory [when save_trajectories=True]
8. `agent/session_persistence.py::_convert_to_trajectory_format` (agent/session_persistence.py:523) — method forward kept on AIAgent so batch_runner can call it [when save_trajectories=True] → KIL-10
9. `agent/agent_runtime_helpers.py::convert_to_trajectory_format` (agent/agent_runtime_helpers.py:168) — builds ShareGPT turns with _TRAJECTORY_SYSTEM_PROMPT [when save_trajectories=True] → KIL-10
10. `agent/trajectory.py::save_trajectory` (agent/trajectory.py:37) — appends to trajectory_samples.jsonl / failed_trajectories.jsonl in the cwd [when save_trajectories=True]

## Findings
### KIL-01 Process state lives in ~48 lazy module singletons; profile scoping is re-implemented per module and ~50 reset helpers exist only for tests
- severity: high | effort: L | kind: restructure | low_hanging: False | loc_delta: -1500 | depends_on: 08-state, 09-concurrency
- evidence: `tools/registry.py:1015`, `tools/process_registry.py:2709`, `gateway/platform_registry.py:414`, `agent/lsp/__init__.py:40`, `hermes_cli/skin_engine.py:433`, `providers/__init__.py:215`, `model_tools.py:173`, `agent/skill_bundles.py:23`, `tools/env_probe.py:181`
- problem: AST count (scripts/kil_singletons.py): 48 lazy `global X; if X is None` getters, 176 module-level class instances, 53 @cache/@lru_cache functions, 418 `global` statements (rg -c '^\s*global\s'). Each per-profile singleton builds its own home-keyed dict and lock (`_services_by_home` agent/lsp, `_active_skin_by_home`, `_home_layer` in providers, `(owner_scope, name)` in mcp_tool). Where a module forgets, state leaks across profiles: `model_tools._last_resolved_tool_names` (:173) is one process list written by every get_tool_definitions() and read as the enabled_tools fallback (:834), and is also written from tools/delegate_tool_results.py:309; `agent/skill_bundles._bundles_cache` (:23) is not home-keyed. About 50 reset/clear helpers have no production caller (26 named *_for_tests; tools/env_probe.py:181 calls a *_for_tests function from production). Contributors pay on every new cache: they must remember hermes_home_key() (AGENTS.md rule) and write a reset helper.
- move: Introduce one scoped service container: a `Registry` of factories (app lifetime) and one `Container` per profile scope, created by the existing profile runtime scope and closed on eviction. Move the per-home singletons (LSP service, skin, provider home layer, MCP OAuth manager, skill bundles, tool-name resolution) to container services. hermes_home_key() becomes the container identity. Tests build a fresh container, so the `reset_*_for_tests` helpers are deleted. `_last_resolved_tool_names` becomes a field on the agent/session, not a module global.
- reference: svcs `.repos/svcs/src/svcs/_core.py:573` — Registry of factories (:184) + per-scope Container that instantiates on first get() and runs cleanups on close() (:661, :1005)
- risk: Profile isolation in multiplex gateway/TUI; the launch-home exceptions (tui_gateway/server.py:441 `_get_db`) must stay launch-scoped. Migrate one singleton per PR.

### KIL-02 Atomic file write is re-implemented ~53 times beside utils.atomic_write_*; most copies use fixed tmp names and skip fsync
- severity: high | effort: M | kind: collapse | low_hanging: True | loc_delta: -250 | depends_on: KIL-08
- evidence: `utils.py:338`, `utils.py:379`, `gateway/run_inbound.py:355`, `gateway/platforms/qqbot/adapter.py:730`, `plugins/platforms/discord/adapter.py:6549`, `plugins/platforms/feishu/adapter.py:1858`, `plugins/platforms/telegram/adapter.py:4979`, `hermes_cli/profiles.py:2096`, `gateway/host_rendezvous.py:373`, `hermes_cli/source_stamp.py:77`
- problem: utils.atomic_write_text/bytes/atomic_json_write (≈127 calls in ~100 files) already do mkstemp + fchmod + fsync + replace + cleanup. ~53 other writers (≈20 defs, ≈33 inline blocks; scripts/kil_dupes_scan.py + kil_atomic_refine.py, each read) hand-roll tmp+replace. ~30 use a fixed `with_suffix('.tmp')`/`name+'.tmp'` (concurrent writers share one tmp), ~45 skip fsync, most leave the tmp on failure, secret writers hand-roll 0600. The `.update_response` answer to `hermes update` is written by 5 separate copies (qqbot, run_inbound, discord, feishu, telegram). Several files hold both the canonical call and a hand copy (profiles.py, anthropic_credentials.py, gateway_windows.py, source_stamp.py).
- move: Replace every payload writer with utils.atomic_write_text/bytes/atomic_json_write (mode=0o600 for secrets). Add one `gateway/update_prompt.py::write_update_response(answer)` used by the 5 adapters and hermes_cli/update_cmd.py. Keep the listed legitimate divergences (config._ensure_default_soul_md symlink replace, streaming uploads, dir publishes).
- reference: none
- risk: Symlink-preserving replace changes behaviour where a copy replaced the link itself; check each target is not a symlink by design.

### KIL-03 Boolean env/config parsing has 31 private helpers and ~100 inline compares; 44 inline sites ignore 'on', including allow-all-users gates
- severity: high | effort: M | kind: collapse | low_hanging: True | loc_delta: -180 | depends_on: —
- evidence: `utils.py:25`, `utils.py:643`, `gateway/authz_mixin.py:28`, `gateway/authz_mixin.py:56`, `tools/connectors/gateway/config.py:42`, `plugins/platforms/feishu/adapter.py:366`, `gateway/config.py:36`
- problem: utils.is_truthy_value (114 calls / 67 files) accepts 1/true/yes/on. 31 other helpers, 32 word-set constants in 24 files and ~102 inline `x in ('1','true',...)` compares exist (scan category 3_truthy + rg). 44 inline sites and 8 constant sets omit 'on', among them the `*_ALLOW_ALL_USERS` checks in the discord/slack/telegram/matrix/teams/whatsapp adapters and gateway/authz_mixin `_TRUTHY`: `FOO=on` enables a feature through one path and is ignored by another. tools/connectors/gateway/config._coerce_bool returns True for any unknown string. utils.env_bool (:643) has 0 callers and ignores its `default`. No tri-state canonical exists; gateway/config._bool_token is imported cross-package as one.
- move: Add `utils.parse_bool_token(value) -> bool | None` (promote gateway/config._bool_token) next to is_truthy_value; delete utils.env_bool; replace the 31 helpers and 32 word sets with the two utils functions; rewrite inline compares as is_truthy_value calls. Access-policy gates first.
- reference: none
- risk: Values that were ignored ('on') start enabling allow-all-user gates; announce in release notes. Garbage-is-True in connectors config must become False deliberately.

### KIL-04 24 git subprocess wrappers bypass hermes_cli/_subprocess_compat; three `hermes update` wrappers have no timeout
- severity: high | effort: M | kind: collapse | low_hanging: True | loc_delta: -150 | depends_on: 12-cli
- evidence: `agent/coding_context.py:416`, `hermes_cli/update_cmd_check.py:16`, `hermes_cli/update_cmd_git.py:37`, `hermes_cli/update_cmd_stash.py:36`, `tools/subagent_worktree.py:25`, `hermes_cli/version_info.py:61`
- problem: _subprocess_compat owns bounded_git_probe, harden_git_argv, noninteractive_git_env and windows_hide_flags. scripts/kil_subproc_wrappers.py found 148 thin run-a-command wrappers; 24 are git wrappers. Only 5 of 24 apply the GHSA-7x36 hardening, several skip Windows console hiding, and update_cmd_check._git, update_cmd_git._git_run and update_cmd_stash._git_quiet have no timeout, so `hermes update` can hang on a stuck git.
- move: Add `_subprocess_compat.run_git(argv, cwd, *, timeout, hardened=True, check=False)`; delete the 24 wrappers. Hardening off only where the cwd is the Hermes checkout itself.
- reference: none
- risk: Default timeouts on long fetches during update; set an explicit generous timeout for fetch/pull.

### KIL-05 PID liveness has ~17 independent implementations; the canonical is a private name imported 40 times; one raw os.kill(pid,0) runs on Windows
- severity: high | effort: S | kind: collapse | low_hanging: True | loc_delta: -150 | depends_on: —
- evidence: `gateway/status.py:1049`, `hermes_cli/_subprocess_compat.py:632`, `tui_gateway/host_supervisor.py:103`, `tools/bot_desktop/browser.py:165`, `tools/bot_desktop/runtime.py:162`, `tools/browser_tool_lifecycle.py:537`
- problem: gateway.status._pid_exists (psutil + zombie check, falls back to pid_exists_stdlib) is imported 40 times from cron/, tools/, plugins/, hermes_cli/ despite the underscore. ~17 other functions answer the same question differently: tools/bot_desktop/browser._pid_alive treats zombies as alive, its sibling runtime._pid_alive does not; tui_gateway/host_supervisor._pid_alive calls raw os.kill(pid, 0) in a module with an nt branch (bpo-14484: on Windows that signal terminates the target).
- move: Promote to public `_subprocess_compat.pid_alive(pid) -> bool` (zombie = dead); re-point the 40 imports; delete the ~12 independent copies. Keep hermes_cli/_early_recovery._pid_is_running (dependency-free by design) and hermes_platform/resolver/app._pid_alive (tri-state).
- reference: none
- risk: Zombie semantics change for bot_desktop/browser; Windows path must keep OpenProcess.

### KIL-06 A2A push-callback SSRF check re-implements tools/url_safety without DNS resolution or redirect re-validation
- severity: high | effort: S | kind: boundary | low_hanging: True | loc_delta: -60 | depends_on: —
- evidence: `plugins/platforms/a2a/security.py:184`, `plugins/platforms/a2a/adapter.py:805`, `tools/url_safety.py:339`, `gateway/platforms/base.py:524`, `tools/vision_tools.py:249`
- problem: is_safe_callback_url checks string prefixes and IP literals only; a hostname that resolves to 169.254.169.254 or 10.x passes. The caller POSTs with plain urllib urlopen, which follows redirects without re-checking. tools/url_safety.is_safe_url (38 calls / 25 files) and create_ssrf_safe_client already do DNS resolution and redirect validation. Three near-identical `_ssrf_redirect_guard` hooks also duplicate create_ssrf_safe_*client.
- move: Replace is_safe_callback_url with tools.url_safety.is_safe_url and the urlopen POST with create_ssrf_safe_client. Delete the three redirect-guard copies in favour of the safe clients.
- reference: none
- risk: Loopback callbacks used in local testing; keep the explicit loopback-bind opt-in.

### KIL-07 Verified dead and test-only code: 7 dead functions, a 111-line unimported module, a 156-line superseded voice path, and an orphaned GPG check
- severity: medium | effort: S | kind: kill | low_hanging: False | loc_delta: -850 | depends_on: —
- evidence: `hermes_cli/update_receipt.py:452`, `tools/browser_tool_lifecycle.py:480`, `hermes_cli/auth_oauth_grants.py:396`, `hermes_cli/gateway.py:5768`, `tools/url_safety.py:80`, `gateway/restart.py:20`, `hermes_cli/update_cmd.py:706`, `gateway/memory_monitor.py:67`, `tools/voice_mode.py:1135`, `agent/proxy_sources/iron_proxy.py:190`, `utils.py:643`, `hermes_cli/update_cmd.py:21`
- problem: Of 600 vulture candidates, 58 were reviewed by hand (notes/15-kill/b-dead.md): 7 VERIFIED-DEAD (132 LOC, rg finds only the def), 11 TEST-ONLY (469 LOC), 40 live through string dispatch (69% false-positive rate: `_handle_{x}_command`, `_hm_cmd_`, `_busy_`, `_tool_`, globals()[...]). gateway/memory_monitor.py is imported only by its test. tools/voice_mode.listen_for_speech is the superseded half-duplex path. iron_proxy._verify_checksums_signature is no longer called because install moved to pm.installed_package (:185): either the signature check was dropped or PM does it elsewhere. `_update_handoff` import in update_cmd.py:21 is never read.
- move: Delete the 7 dead functions, utils.env_bool, gateway/memory_monitor.py with its test, listen_for_speech with its tests. Decide the GPG check: wire it into the PM install path or delete it with a note that PM verifies. Leave the 22 frozen old-updater names (tests/compat/old_updater_surface.json) alone.
- reference: none
- risk: Old-updater compat surface: never hand-trim hermes_cli/main.py:841 block; regenerate with scripts/audit-old-updater-imports.py.

### KIL-08 Root utils.py (729 lines, 259 production importers) is a grab-bag of 7 unrelated topics
- severity: medium | effort: M | kind: restructure | low_hanging: False | loc_delta: 0 | depends_on: —
- evidence: `utils.py:25`, `utils.py:84`, `utils.py:379`, `utils.py:597`, `utils.py:651`, `utils.py:695`, `utils.py:721`
- problem: utils.py mixes atomic file I/O (≈12 helpers, ~60% of lines), YAML/JSON loading, env parsing, URL host matching, proxy env mutation, credential permission warnings and one LLM policy predicate (model_forces_max_completion_tokens :695). 259 production files import it. Because the module has no topic, contributors do not find the canonical helper and write a local copy (KIL-02, -03, -09 copy counts).
- move: Split into `hermes_io/atomic.py` (atomic writes, mkstemp_beside, fsync), `hermes_io/serial.py` (json/yaml read helpers + a new read_yaml_mapping), `hermes_env.py` (is_truthy_value, parse_bool_token, env_int/float, coerce_int/float), `hermes_net/url.py` (base_url_*, proxy). Move model_forces_max_completion_tokens to providers/. Keep utils.py as a re-export for one release only if the old-updater surface needs it.
- reference: none
- risk: The old-updater frozen surface may import utils names; check tests/compat/old_updater_surface.json before moving.

### KIL-09 hermes_platform is the sanctioned host-fact layer but ~37 machine-fact bypasses and 166 bare shutil.which calls route around it; the guard grandfathers 137
- severity: medium | effort: L | kind: boundary | low_hanging: False | loc_delta: -200 | depends_on: —
- evidence: `hermes_platform/host/runtime.py:8`, `hermes_platform/host/facts.py:27`, `hermes_cli/main_install_repair.py:89`, `hermes_cli/gateway.py:2041`, `gateway/restart.py:276`, `hermes_cli/cli_terminal_input.py:450`, `tests/fixtures/resolution_allowlist.json:44`, `hermes_platform/declaration.py:207`
- problem: 15 duplicate is_windows/is_container predicates, 9 hand-rolled /.dockerenv, WSL and TERMUX_VERSION env sniffs (AGENTS.md forbids env vars for host facts), 13 platform.machine() calls that miss the Wow64/Rosetta handling in facts.native_arch, and 166 bare shutil.which calls. Only 25 non-test files import hermes_platform. The resolution allowlist has 137 rows, so the guard records the bypasses instead of shrinking them. hermes_platform/declaration.py also holds a mutable module registry inside a facts package.
- move: Delete the 15 predicates and 9 sniffs in favour of hermes_platform.host.runtime; replace platform.machine() with facts.native_arch; migrate which calls to locate_command package by package and shrink the allowlist per PR. Move the declaration registry out of hermes_platform.
- reference: none
- risk: Termux/WSL detection differences; locate_command search order must match current which behaviour on Windows.

### KIL-10 RL/datagen code (2,399 LOC at the repo root) ships in every wheel as top-level modules and keeps a trajectory format inside AIAgent
- severity: medium | effort: M | kind: kill | low_hanging: False | loc_delta: -300 | depends_on: 01-layout, PLG-07
- evidence: `setup.py:87`, `setup.py:99`, `batch_runner.py:33`, `mini_swe_runner.py:26`, `trajectory_compressor.py:29`, `toolset_distributions.py:11`, `agent/agent_runtime_helpers.py:168`, `agent/session_persistence.py:523`, `agent/turn_finalizer.py:603`, `pyproject.toml:50`
- problem: batch_runner.py (1018), mini_swe_runner.py (406), trajectory_compressor.py (869) and toolset_distributions.py (106) have no importer in user-path code (rg; only each other and scripts/sample_and_compress.py). setup.py::_root_py_modules (:87) ships every root *.py as a top-level module, so these four land in site-packages as `batch_runner`, `trajectory_compressor`, etc. In the other direction, AIAgent carries the datagen format: agent_runtime_helpers.convert_to_trajectory_format (:168, with _TRAJECTORY_SYSTEM_PROMPT :94) is forwarded as an AIAgent method (session_persistence.py:523) because batch_runner calls it (agent/trajectory.py:1 docstring), and turn_finalizer saves trajectories (:603). `fire` is a core dependency (pyproject.toml:50) used only by these scripts and cli.py's __main__ block (cli.py:1795). hermes_constants_scratch.py is NOT off-path: hermes_constants.py:922 and tools/environments/local.py:65 import it. The off-path scripts import private core names (trajectory_compressor.py:64 `_fixed_temperature_for_model`, :323 `_to_openai_base_url`) and an undeclared `transformers` (:300), so core refactors break them silently. hermes_cli/doctor_platform.py:437 still warns about 'RL Training tools (tinker)' that are not on main.
- move: Move the four modules into a `hermes_datagen/` package (or out of the repo next to tinker-atropos) that depends on hermes-agent, not the other way. Move convert_to_trajectory_format and save_trajectory there and give it a public `AIAgent.messages` read; drop the AIAgent method forward. Replace _root_py_modules with an explicit allow-list or move root modules into a package so the wheel stops publishing top-level names. Move `fire` to a `datagen` extra (cli.py __main__ can use argparse).
- reference: none
- risk: `hermes-agent --save_trajectories` (agent/legacy_cli.py:51) users; batch datagen pipelines that run from a checkout.

### KIL-11 Small display/parse helpers duplicated 10-30 times each; ≥4 model-visible truncators bypass the mandated `elide`
- severity: medium | effort: M | kind: collapse | low_hanging: False | loc_delta: -600 | depends_on: KIL-08
- evidence: `agent/compression_marker.py:62`, `acp_adapter/tools.py:158`, `hermes_cli/kanban_specify.py:81`, `agent/usage_pricing.py:741`, `cli.py:254`, `tui_gateway/_env.py:17`, `gateway/config.py:104`, `agent/retry_utils.py:1`
- problem: agent/compression_marker.elide says every model-visible renderer must truncate through it (#121548); acp_adapter/tools._truncate_text, kanban_specify._truncate and feishu_comment._truncate do not. ~29 truncation helpers + 119 inline `s[:n]+'…'` disagree on whether the result exceeds the limit. Durations render 13 ways (cli.py:254 is a byte copy of usage_pricing.format_duration_compact). tui_gateway/_env.py duplicates utils.env_int/env_float; ~19 value-to-int parsers differ on bool/None/inf. ~28 retry loops roll their own exponential sleep without agent/retry_utils.jittered_backoff, mostly without jitter.
- move: One `ellipsize(text, limit)` for display plus elide for model text; delete cli.py::format_duration_compact and tui_gateway/_env.py; add utils coerce_int/coerce_float (promote gateway/config._coerce_*); add `retry_utils.retry_call(fn, attempts, base, cap, retry_on)` and port the gateway adapters.
- reference: none
- risk: Platform message-limit sizing (off-by-3) and retry timing per adapter; port retry loops one adapter per PR.

### KIL-12 ~17 sites compute HERMES_HOME themselves with a `~/.hermes` fallback that is wrong on Windows and ignores HERMES_DATA_DIR_SUFFIX
- severity: medium | effort: S | kind: collapse | low_hanging: False | loc_delta: -40 | depends_on: —
- evidence: `mcp_serve.py:40`, `tui_gateway/launch_profile_policy.py:54`, `agent/file_safety.py:16`, `gateway/lifecycle_ledger.py:27`, `gateway/shutdown_watchdog.py:178`, `hermes_cli/_old_updater.py:110`
- problem: hermes_constants.get_hermes_home (673 calls / 366 files) defaults to %LOCALAPPDATA%\hermes on Windows and honours the suffix. Fallbacks in mcp_serve, file_safety, env_loader, self_repo_guard and tui_gateway/launch_profile_policy (the servable-home allowlist, security-relevant) use `env or ~/.hermes`. gateway/lifecycle_ledger and shutdown_watchdog hold identical `_process_hermes_home` one-liners. _old_updater reaches into the private `_HERMES_HOME_OVERRIDE`.
- move: Call hermes_constants.get_hermes_home/get_process_hermes_home everywhere; keep only hermes_cli/_startup_fast's import-free path and make it call _get_platform_default_hermes_home's logic copy-free (a tiny stdlib-only module both import).
- reference: none
- risk: Startup latency for the fast path; old-updater compatibility for _old_updater.

## Kill list
| target | why | importers/callers | evidence |
|---|---|---|---|
| batch_runner.py, mini_swe_runner.py, trajectory_compressor.py, toolset_distributions.py (move out of the core wheel) | RL/datagen scripts; no user-path importer; shipped as top-level modules | 0 | setup.py:87; rg importers (notes/15-kill/a-offpath.md) |
| agent/agent_runtime_helpers.py::convert_to_trajectory_format (+_TRAJECTORY_* helpers :94-194) and AIAgent._convert_to_trajectory_format forward | datagen format inside the agent; move with KIL-10 | 2 | agent/session_persistence.py:523 |
| hermes_cli/doctor_platform.py:437 tinker/RL Python-version warning | warns about RL tools that are not on main | ? | hermes_cli/doctor_platform.py:437 |
| hermes_cli/update_receipt.py::settle_latest_receipt_fleet | no caller | 0 | hermes_cli/update_receipt.py:452 |
| tools/browser_tool_lifecycle.py::_kill_process_tree | superseded by agent.deadline.kill_process_tree | 0 | tools/browser_tool_lifecycle.py:480 |
| hermes_cli/auth_oauth_grants.py::_oauth_identity | no caller | 0 | hermes_cli/auth_oauth_grants.py:396 |
| hermes_cli/gateway.py::_pm_runtime_venv_dir | no caller | 0 | hermes_cli/gateway.py:5768 |
| tools/url_safety.py::sensitive_query_param_name + _SENSITIVE_QUERY_PARAM_NAMES | no caller | 0 | tools/url_safety.py:73,80 |
| gateway/restart.py::map_fatal_config_exit_for_launchd | no caller; logic inlined at hermes_cli/stderr_timestamp.py:152 | 0 | gateway/restart.py:20 |
| hermes_cli/update_cmd.py::_print_update_check_result | no caller; --check uses report_*_verdict | 0 | hermes_cli/update_cmd.py:706 |
| utils.py::env_bool | no caller; ignores default | 0 | utils.py:643 |
| gateway/memory_monitor.py (whole module, 111 LOC) | imported only by its test | 0 | gateway/memory_monitor.py:67 |
| tools/voice_mode.py::listen_for_speech (156 LOC) | test-only; superseded by full_duplex_listen | 0 | tools/voice_mode.py:1135 |
| hermes_cli/update_cmd.py:21 `_update_handoff` import | binding never read (confirm intent) | 0 | hermes_cli/update_cmd.py:21 |
| cli.py::format_duration_compact | byte copy of agent/usage_pricing.format_duration_compact | ? | cli.py:254 |
| tui_gateway/_env.py (21 LOC) | duplicates utils.env_int/env_float | 6 | tui_gateway/_env.py:17 |
| ~50 reset_*/clear_* helpers with no production caller | exist only because state is module-global (KIL-01) | 0 | notes/15-kill/d-globals.md §2; tools/env_probe.py:181 |

## Simplify list
| what N things | become what 1 thing | lines saved | evidence |
|---|---|---|---|
| ~53 hand-rolled atomic writers, 5 .update_response writers | utils.atomic_write_* + gateway/update_prompt.write_update_response | 250 | notes/15-kill/c-dupes.md §1 |
| 31 bool helpers, 32 word-set constants, ~100 inline compares | utils.is_truthy_value + utils.parse_bool_token | 180 | notes/15-kill/c-dupes.md §3 |
| 24 git wrappers | _subprocess_compat.run_git | 150 | notes/15-kill/c-dupes.md §5 |
| ~17 PID liveness functions, private gateway.status._pid_exists | _subprocess_compat.pid_alive | 150 | notes/15-kill/c-dupes.md §8 |
| ~28 retry loops | agent/retry_utils.retry_call | 250 | notes/15-kill/c-dupes.md §7 |
| 12 JSON readers, 5 YAML-dict readers, 9 HTTP _get_json | utils.read_json_or_empty + read_yaml_mapping + one http get_json | 150 | notes/15-kill/c-dupes.md §2 |
| 13 duration formatters, 3 'N ago' formatters | usage_pricing.format_duration_compact + timefmt.relative_time | 90 | notes/15-kill/c-dupes.md §6 |
| 6 env number readers, ~19 value parsers | utils.env_int/env_float + coerce_int/coerce_float | 120 | notes/15-kill/c-dupes.md §9 |
| ~29 truncation helpers | compression_marker.elide (model) + one ellipsize (display) | 70 | notes/15-kill/c-dupes.md §10 |
| A2A SSRF check, 3 redirect guards, 4 loopback helpers | tools/url_safety + agent/proxy_bypass.is_loopback_host | 60 | notes/15-kill/c-dupes.md §11 |
| ~17 home resolvers | hermes_constants.get_hermes_home | 40 | notes/15-kill/c-dupes.md §4 |
| 48 lazy singletons with per-home dicts | svcs-style Registry + per-profile Container | 1500 | notes/15-kill/d-globals.md §2, §5 |
| utils.py grab-bag (7 topics) | hermes_io/atomic, hermes_io/serial, hermes_env, hermes_net/url | 0 | notes/15-kill/d-globals.md §3 |

## Reference patterns to copy
| repo | path | pattern | where it applies here |
|---|---|---|---|
| svcs | .repos/svcs/src/svcs/_core.py:184 | Registry of factories, app lifetime | KIL-01: replace lazy global singletons |
| svcs | .repos/svcs/src/svcs/_core.py:573 | per-scope Container with get() and close() cleanups | KIL-01: one container per profile scope; tests build a fresh one instead of reset_*_for_tests |

## Answer to the seam question
Hermes has little true dead code: 7 verified-dead functions (132 LOC) and 11 test-only symbols (469 LOC) out of 58 reviewed, and 69% of vulture's big hits are live through string dispatch. The kill list is short: the four RL/datagen root scripts (2,399 LOC) and the trajectory format they pull into AIAgent, gateway/memory_monitor.py, listen_for_speech and the 7 dead functions. The real weight is elsewhere: ~1,600 lines of duplicated helpers whose copies disagree on correctness (fixed tmp names, 'on' ignored by allow-all gates, no git timeout, raw os.kill on Windows, SSRF check without DNS), and module-global singletons that make every profile-scoped cache a per-module discipline. Fix order: the correctness copies (KIL-03..06), then the atomic-write collapse, then the container for global state.

## Cross-seam notes
- 01-layout: `setup.py:87` — setup.py publishes every root *.py as a top-level module (`utils`, `cli`, `batch_runner`); name-collision risk in site-packages
- 11-plugins: `reports/11-plugins.json` — Third-party vendor plugins in tree are PLG-07; not repeated here
- 11-plugins: `plugins/platforms/a2a/security.py:184` — A2A callback SSRF check (KIL-06) lives in a platform plugin
- 06-tools: `batch_runner.py:34` — toolset_distributions.py is imported only by batch_runner; it should leave the tools scope
- 08-state: `hermes_state_common.py:1144` — hermes_state_common._lock_holder_provably_dead uses raw os.kill(pid,0) without visible nt guard
- 12-cli: `hermes_cli/update_cmd_stash.py:36` — hermes update git wrappers lack timeouts
- 14-errors-obs: `plugins/platforms/telegram/adapter.py:3578` — ~28 retry loops without jitter in gateway adapters

## UNVERIFIED
- UNVERIFIED: agent/skill_bundles.py:23 _bundles_cache as a live cross-profile leak: needs an A→B→A multiplex repro.
- UNVERIFIED: model_tools._last_resolved_tool_names causing cross-session tool leakage: depends on whether enabled_tools is always passed on the gateway path.
- UNVERIFIED: iron_proxy GPG check: whether pm.installed_package verifies release signatures (read pm install path).
- UNVERIFIED: A2A SSRF exploitability: depends on who can register a push URL (read a2a adapter auth).
- UNVERIFIED: Per-site semantics of ~96 JSON-load bodies, ~44 JSON-save bodies, 119 inline truncations, generic _run* wrappers and retry-loop equivalence; LOC estimates assume ~5 lines/site.
- UNVERIFIED: Whether tests/test_managed_runtime_resolution.py scans plugins/ for bare which.
- UNVERIFIED: agent/legacy_cli.py (hermes-agent console script) user count; whether anyone outside datagen uses --save_trajectories.
- UNVERIFIED: Whether setup.py ships hermes_constants_scratch, cli, utils etc. as top-level names in the published wheel (read setup.py only; did not build a wheel).
- UNVERIFIED: global count 418 vs brief 406 (scope difference).
