# 03 Install, update, optional-dependency and plugin-install flows

Repo `origin/main` = `ea81748579`. Reference repos: llm 764dc38, pluggy 7aa82ed, home-assistant-core 0f3081e.

## TL;DR

- The dependency engine is already one thing: every install, update, repair, plugin enable and lazy extra ends in pm.sync_venv (pm/install.py:782). The mess is the layer around it: records, front-ends, remedies and recovery written by hermes_cli on PM's behalf.
- Most important structural problem: the PM boundary is inverted. PM's journal recovery, repair driver and generation GC live in hermes_cli (pm/install.py:820, pm/cli.py:757, pm/recovery.py:52; 26 pm->hermes_cli imports), while hermes_cli writes PM-owned state outside PM (plugin remove, provider picker, .install-metadata.json, local_runtime facts, receipts).
- Biggest kill: the frozen old-updater surface (562 bare + 126 guarded names, 71 stop_for_relaunch shims in 17 files, old_updater_*.py, update_finish.py, update_handoff.py) once a minimum updatable release is declared.
- Biggest simplification: one PM-owned record layer (receipt engine with kinds, install records, publication journal, footprint) so latest.json, .install-metadata.json and uninstall stop being written or guessed by three owners each.
- Low-hanging fruit: 8 of 13 findings (S/M effort, high severity). Seam answer: about 25 mechanisms across the five jobs; one per job is reachable by killing about 12 of them, listed in the seam answer.

## What this area is

Scope: 35,233 lines in 104 files (counted with `wc -l` over the path globs below; `pm/` itself, 11,803 lines in 48 files, was read for boundaries only and belongs to seam 02).

Paths: `hermes_cli/update*.py`, `hermes_cli/_update_takeover.py`, `hermes_cli/_old_updater.py`, `hermes_cli/old_updater_*.py`, `hermes_cli/post_update.py`, `hermes_cli/windows_*update.py`, `hermes_cli/desktop_update_verify.py`, `hermes_cli/plugin_compat.py`, `hermes_cli/plugins_cmd*.py`, `hermes_cli/plugins_transaction.py`, `hermes_cli/plugins_admission.py`, `hermes_cli/plugins_activation*.py`, `hermes_cli/plugins_provenance.py`, `hermes_cli/plugins_updates.py`, `hermes_cli/plugin_catalog*.py`, `hermes_cli/plugin_packs.py`, `hermes_bootstrap.py`, `hermes_startup_watchdog.py`, `setup-hermes.sh`, `hermes_cli/_install_repair.py`, `hermes_cli/main_install_repair.py`, `hermes_cli/boot_bootstrap.py`, `hermes_cli/install_identity.py`, `hermes_cli/doctor*.py`, `hermes_cli/uninstall.py`, `hermes_cli/venv_sync.py`, `hermes_cli/source_*.py`, `hermes_cli/_launchers.py`, `hermes_cli/_early_recovery.py`, `hermes_cli/runtime_state.py`, `hermes_cli/data_cleanup.py`, `tools/lazy_deps.py`, `hermes_cli/npm_engine.py`, `hermes_cli/local_runtime/`, `pm/ (read for boundaries only; internals are seam 02)`

Entry points: `scripts/install.sh` / `install.ps1` / `setup-hermes.sh` (install), `hermes_bootstrap.py` (every launch), `hermes update` (`hermes_cli/main.py::cmd_update`), `pm.extras.ensure_import` (lazy extras), `hermes plugins install|enable|remove|update` plus dashboard/TUI routes, `hermes doctor`, `hermes uninstall`.

| module | lines | owns |
|---|---|---|
| `pm/install.py::sync_venv` | 983 | the one dependency-sync engine every flow ends in (lock, publication journal, generation commit, receipt) |
| `hermes_cli/update_cmd.py` | 1625 | `hermes update` orchestration up to the code swap (git/ZIP apply, receipt begin, plan) |
| `hermes_cli/update_completion.py` | 313 | post-swap completion in a new-tree child: PM sync, products, fleet restart, verify, receipt |
| `hermes_cli/update_cmd_fleet.py` | 2165 | gateway fleet restart (systemd/launchd/manual), version matrix, restart obligations |
| `hermes_cli/update_receipt.py` | 795 | update receipt engine; shares latest.json with pm/receipt.py |
| `hermes_cli/_old_updater.py + old_updater_main.py + old_updater_deps.py` | 421 | frozen names for pre-PM updaters mid-swap; hand-off to _update_takeover.py |
| `hermes_cli/source_completion.py` | 181 | the shared install/update tail (launchers, product builds, maintenance, stamp) |
| `hermes_bootstrap.py` | 572 | import-time launch prep of every entry point: legacy post-swap, completion finish, auto-repair, dependency activation |
| `hermes_cli/venv_sync.py + _early_recovery.py + runtime_state.py` | 1553 | source-completion markers, auto repair driver, PM publication recovery (PM logic living in hermes_cli) |
| `hermes_cli/plugins_cmd_install.py` | 697 | plugin install core plus the CLI and dashboard front-ends |
| `hermes_cli/plugins_cmd_remove.py` | 94 | plugin removal outside the PM transaction |
| `pm/extras.py` | 300 | lazy optional-dependency entry point ensure_import / ensure_and_bind |
| `hermes_cli/doctor*.py` | 3343 | `hermes doctor`: 27 checks; install checks re-implemented beside `hermes pm doctor` |
| `hermes_cli/uninstall.py` | 1211 | full/lite/data uninstall; lite mode does not know PM's footprint |

Evidence base: four leaf readers wrote cited surveys in `notes/03-sub-update.md`, `notes/03-sub-plugins.md`, `notes/03-sub-optdeps.md` and `notes/03-sub-doctor.md`. The core claim of every high-severity finding was re-opened by the author; counts taken from the leaf notes are marked in UNVERIFIED.

## How it works end to end

### Flow `fresh-install`: User runs the one-line installer, then launches hermes for the first time

Trigger: curl -fsSL .../install.sh | bash, then `hermes`

Inputs that change the path:
- `terminal_present` (bool, default `True`): /dev/tty is readable, so setup and gateway stages can prompt
- `pending_source_update` (bool, default `False`): a source-completion-pending marker exists at first launch
- `install_damaged` (bool, default `False`): legacy .update-incomplete marker present or recorded site-packages missing

| # | where | line | does | when | finding |
|---|---|---|---|---|---|
| 1 | `scripts/install.sh::stage_repository` | `scripts/install.sh:445` | clones the checkout, or parks local changes on a rescue ref when re-run | always |  |
| 2 | `scripts/install.sh::bootstrap_python` | `scripts/install.sh:631` | stages the pinned uv (generated pins at :170-213, sha256 check at :302-309) and finds or downloads a bootstrap Python | always |  |
| 3 | `scripts/install.sh::bootstrap_pm` | `scripts/install.sh:658` | runs `<boot python> -m pm.cli install` inside the checkout | always |  |
| 4 | `pm/cli.py::cmd_install` | `pm/cli.py:343` | installs tool binaries first, activates them on PATH, then syncs the venv with the [all] extra set | always |  |
| 5 | `pm/install.py::sync_venv` | `pm/install.py:782` | takes the install lock, runs hermes_cli.runtime_state.recover_publication, commits a new generation and writes a pm receipt to update_receipts/latest.json | always | PMF-02 |
| 6 | `hermes_cli/source_completion.py::main` | `hermes_cli/source_completion.py:129` | installer stage `products` runs this file under the bootstrap Python; it re-execs itself on PM's selected interpreter | always |  |
| 7 | `hermes_cli/source_completion.py::complete_source_checkout` | `hermes_cli/source_completion.py:29` | claims UpdateLock, then publishes launchers, builds products, runs post-update maintenance and writes the source stamp (the same tail an update runs) | always | PMF-07 |
| 8 | `scripts/install.sh::stage_config` | `scripts/install.sh:765` | seeds HERMES_HOME directories, .env (0600) and config.yaml | always |  |
| 9 | `scripts/install.sh::stage_setup` | `scripts/install.sh:784` | runs `hermes setup` against /dev/tty | terminal_present = True |  |
| 10 | `scripts/install.sh::stage_complete` | `scripts/install.sh:803` | writes .hermes-bootstrap-complete by tmp + mv | always |  |
| 11 | `hermes_bootstrap.py (module body)` | `hermes_bootstrap.py:538` | first launch: prepare_launch finishes a pending source update and execs the managed interpreter | pending_source_update = True |  |
| 12 | `hermes_cli/_early_recovery.py::recover_if_needed` | `hermes_bootstrap.py:562` | automatic dependency repair through pm.recovery.repair_dependencies -> pm.client.sync_venv(repair=True) | install_damaged = True | PMF-02 |
| 13 | `pm/environments.py::activate_dependencies` | `hermes_bootstrap.py:563` | puts the selected generation on sys.path; on failure prints `run hermes pm repair` and exits 1 | always |  |
| 14 | `hermes_cli/venv_sync.py::check_runtime` | `hermes_cli/main.py:3666` | after boot_bootstrap (main.py:3659), prints PM's passive install verdict; `hermes doctor` never shows this verdict | always | PMF-08 |

### Flow `hermes-update`: User runs `hermes update` on a git source install

Trigger: hermes update

Inputs that change the path:
- `install_kind` (enum[git,zip,sealed], default `git`): git checkout, Windows ZIP install, or docker/nix/apt/desktop-app (refused)
- `windows` (bool, default `False`): host is Windows (gateways are paused around the swap)
- `no_gateway_restart` (bool, default `False`): --no-gateway-restart passed
- `old_release_updater` (bool, default `False`): the running updater is a pre-takeover release that lazily imports new-tree names after the swap

| # | where | line | does | when | finding |
|---|---|---|---|---|---|
| 1 | `hermes_cli/main.py::cmd_update` | `hermes_cli/main.py:2497` | retargets to the owning install, takes UpdateLock (check-then-write marker), finalizes the receipt on every exit | always | PMF-07 |
| 2 | `hermes_cli/main.py::_update_preflight_handled` | `hermes_cli/main.py:2421` | handles --plan/--check; update_contract.evaluate_update_admission refuses sealed kinds with a refused receipt, exit 2 | install_kind = sealed |  |
| 3 | `hermes_cli/update_cmd.py::_cmd_update_impl` | `hermes_cli/update_cmd.py:1433` | begins the update receipt (in-memory ContextVar only, update_receipt.py:201) and records the runtime inventory plan | always | PMF-01 |
| 4 | `hermes_cli/update_cmd_maint.py::_run_pre_update_backup` | `hermes_cli/update_cmd_maint.py:766` | quick snapshot of every profile | always |  |
| 5 | `hermes_cli/update_cmd_windows.py::_pause_windows_gateways_for_update` | `hermes_cli/update_cmd_windows.py:912` | stops Windows gateways via control socket and registers an atexit resume | windows = True |  |
| 6 | `hermes_cli/update_cmd_zip.py::_update_via_zip` | `hermes_cli/update_cmd_zip.py:375` | downloads the GitHub ZIP with urlretrieve and swaps by a rename loop with no on-disk crash marker | install_kind = zip | PMF-07 |
| 7 | `hermes_cli/update_cmd.py::_pull_updates` | `hermes_cli/update_cmd.py:898` | writes the interrupted-pull marker, fast-forwards or detaches to the target sha, removes the marker | install_kind = git |  |
| 8 | `hermes_cli/update_cmd.py::_complete_source_update` | `hermes_cli/update_cmd.py:738` | arms the host restart obligation (update_cmd_fleet.py:85) and calls run_completion | always | PMF-13 |
| 9 | `hermes_cli/update_completion.py::run_completion` | `hermes_cli/update_completion.py:38` | spawns `python -I -S update_completion.py request result` from the new tree; the parent keeps the lock and waits for a correlated result | always |  |
| 10 | `hermes_cli/update_completion.py::_prepare` | `hermes_cli/update_completion.py:135` | arms source-completion-pending, runs pm.sync_venv (which writes a pm receipt over latest.json), then spawns child 2 on the selected Python | always | PMF-01 |
| 11 | `hermes_cli/update_completion.py::_complete_selected` | `hermes_cli/update_completion.py:172` | runs complete_source_checkout, then restarts the gateway fleet (update_cmd_fleet.py:1728) unless skipped | no_gateway_restart = False | PMF-11 |
| 12 | `hermes_cli/update_cmd_fleet.py::_verify_fleet_after_update` | `hermes_cli/update_cmd_fleet.py:1920` | version matrix of live gateways; a stale gateway fails the update | always |  |
| 13 | `hermes_cli/update_receipt.py::finalize_update_receipt` | `hermes_cli/update_receipt.py:269` | writes update_<stamp>.json and overwrites latest.json; carries pending manual serves forward by reading latest.json (:302) | always | PMF-01 |
| 14 | `hermes_cli/_old_updater.py::stop_for_relaunch` | `hermes_cli/_old_updater.py:143` | old release path: a frozen shim frame-walks the old process, spawns _update_takeover.py, which syncs PM and execs update_finish.py (a drifted copy of step 11) | old_release_updater = True | PMF-10 |

### Flow `lazy-optional-dep`: Agent calls text_to_speech for the first time with the default `edge` provider (extra not installed)

Trigger: model emits a text_to_speech tool call

Inputs that change the path:
- `lazy_installs_allowed` (bool, default `True`): security.allow_lazy_installs true and HERMES_DISABLE_LAZY_INSTALLS unset
- `stdin_tty` (bool, default `False`): stdin and stdout are TTYs and no prompt_toolkit app is running
- `adoption_safe` (bool, default `True`): no already-imported distribution changed in the new generation

| # | where | line | does | when | finding |
|---|---|---|---|---|---|
| 1 | `tools/tts_tool.py::check_tts_requirements` | `tools/tts_tool.py:576` | keeps the tool listed when the extra is missing but lazily installable | always |  |
| 2 | `tools/tts_tool.py::_select_builtin_engine` | `tools/tts_tool.py:210` | reaches _importable(_import_edge_tts) for the edge provider (:217) | always |  |
| 3 | `tools/tts_tool.py::_sdk_importer` | `tools/tts_tool.py:57` | local wrapper: calls pm.ensure_import inside contextlib.suppress(Exception), discarding the reason | always | PMF-04 |
| 4 | `pm/extras.py::ensure_import` | `pm/extras.py:186` | returns if importable; raises if the platform gate excludes the extra | always |  |
| 5 | `pm/extras.py::ensure_import` | `pm/extras.py:210` | asks `Install it now? [Y/n]` before any policy check | stdin_tty = True | PMF-04 |
| 6 | `pm/client.py::sync_venv` | `pm/client.py:205` | calls pm.install.sync_venv in-process or spawns the PM worker | always |  |
| 7 | `pm/install.py::sync_venv` | `pm/install.py:811` | begins a receipt (every outcome writes latest.json), waits up to 10 s for the install lock, then refuses when lazy installs are off (:840) | lazy_installs_allowed = False | PMF-01 |
| 8 | `pm/install.py::_commit_selection` | `pm/install.py:756` | builds and selects a new generation with the extra | lazy_installs_allowed = True |  |
| 9 | `pm/environments_adopt.py::adopt` | `pm/environments_adopt.py:64` | swaps this process onto the new generation and invalidates import caches; otherwise ensure_import raises `restart Hermes` | adoption_safe = True |  |
| 10 | `tools/tts_tool.py::_select_builtin_engine` | `tools/tts_tool.py:222` | on any failure, returns `Enable Edge TTS with: hermes pm install --extra edge-tts`, even when the extra is installed and only a restart is needed; nothing is memoized, so the next call repeats steps 4-7 | always | PMF-04 |

### Flow `plugin-install`: User installs a catalog plugin from the CLI and enables it

Trigger: hermes plugins install <catalog-name> --enable

Inputs that change the path:
- `surface` (enum[cli,dashboard,pack], default `cli`): CLI command, dashboard/TUI/connectors/migration (dashboard_install_plugin), or a plugin pack
- `enable` (bool, default `True`): user asked to enable after install

| # | where | line | does | when | finding |
|---|---|---|---|---|---|
| 1 | `hermes_cli/plugins_cmd.py::plugins_command` | `hermes_cli/plugins_cmd.py:1001` | dispatches the `install` action table entry to cmd_install | always |  |
| 2 | `hermes_cli/plugins_cmd_install.py::cmd_install` | `hermes_cli/plugins_cmd_install.py:480` | classifies the identifier (bare name -> catalog entry) | surface = cli | PMF-12 |
| 3 | `hermes_cli/plugins_cmd_install.py::cmd_install` | `hermes_cli/plugins_cmd_install.py:516` | kill-list check (catalog.raise_if_removed); plugin packs call _install_plugin_core directly and skip it | surface = cli | PMF-03 |
| 4 | `hermes_cli/plugins_cmd_catalog.py::install_catalog_entry` | `hermes_cli/plugins_cmd_catalog.py:238` | platform gate, then _install_plugin_core at the reviewed pin | always |  |
| 5 | `hermes_cli/plugins_cmd_git.py::_clone_plugin_repo` | `hermes_cli/plugins_cmd_git.py:215` | shallow clone into a temp dir inside plugins/, pin checkout and verify | always |  |
| 6 | `hermes_cli/plugins_cmd_install.py::_install_plugin_core` | `hermes_cli/plugins_cmd_install.py:313` | reads manifest, version gate, security scan, builds the install record | always |  |
| 7 | `hermes_cli/plugins_transaction.py::publish_plugin` | `hermes_cli/plugins_transaction.py:16` | hands the staged tree to pm.client.sync_venv(plugins=StagedUpdate) | always |  |
| 8 | `pm/publication.py::StagedPlugin.publish` | `pm/publication.py:142` | journaled swap of tree + .install-metadata.json; a fresh (inactive) install does no dependency work | always | PMF-02 |
| 9 | `hermes_cli/plugins_cmd_install.py::_install_plugin_python_deps` | `hermes_cli/plugins_cmd_install.py:58` | CLI only: npm ci into the LIVE tree outside any transaction, then the Python-deps consent prompt | enable = True | PMF-12 |
| 10 | `hermes_cli/plugins_cmd.py::_set_plugin_enabled` | `hermes_cli/plugins_cmd.py:588` | second PM transaction: Selection admission (plugins_admission.py:50) builds the venv and writes config.yaml together | enable = True |  |
| 11 | `hermes_cli/plugins_activation.py::activate_plugin_now` | `hermes_cli/plugins_activation.py:96` | CLI posts to the running backend; dashboard loads in-process; CLI tests the --enable flag, not the admission outcome (plugins_cmd_install.py:616) | enable = True | PMF-12 |
| 12 | `hermes_cli/plugins_discovery.py::gate_manifest` | `hermes_cli/plugins_discovery.py:257` | loader gate: disabled wins, opt-in, kill list re-checked for non-bundled plugins (after deps were already installed) | always | PMF-03 |

Shorter traces not in the JSON: `hermes doctor` (12 steps) is in `notes/03-sub-doctor.md` §7; plugin enable/disable/update/remove in `notes/03-sub-plugins.md` Flow 2.

## Findings

### PMF-01: Two receipt engines write one latest.json, so any PM sync (including a lazy TTS install) replaces the update receipt that the dashboard and fleet checks read

- severity: **high** · effort: **M** · kind: collapse · low_hanging: true · loc_delta: -200 · depends_on: none
- evidence: `pm/receipt.py:4-9`, `pm/receipt.py:299-313`, `pm/install.py:802-811`, `hermes_cli/update_receipt.py:298-302`, `hermes_cli/update_receipt.py:343-345`, `hermes_cli/update_receipt.py:479`, `hermes_cli/update_receipt.py:486-494`, `hermes_cli/web_routers/actions.py:400-440`, `apps/desktop/electron/main.ts:18848-18857`, `hermes_cli/update_cmd_fleet.py:481-487`
- problem: pm/receipt.py claims the SAME schema as update receipts (pm/receipt.py:4-9); it does not (pm: kind/venv_rebuild/feature_list; update: pre_update/post_update/fleet/gateway_restart). Both write update_receipts/latest.json, PM under .pm-write.lock, update without it, and settle_latest_receipt_fleet with plain write_text (update_receipt.py:479). PM writes a receipt on EVERY sync outcome including no-ops and lazy refusals (pm/install.py:802-811). Readers disagree on what latest.json is: the dashboard endpoint /api/hermes/update/receipt calls it 'the durable success signal' of the last update (actions.py:405-410), Desktop calls it 'the latest pm/venv/plugin-operation receipt' (main.ts:18848). After any lazy extra, plugin enable or `hermes pm install`, the dashboard shows a pm sync as the last update (no post_sha, no fleet), and finalize_update_receipt drops fallback pending_manual_serves rows because it reads them from latest.json (update_receipt.py:298-302). Fleet catch-up is partly shielded by the host obligation (update_cmd_fleet.py:484-485) but falls back to the same pointer.
- move: Make pm/receipt.py the only receipt engine (ContextVar, rotation, atomic write under .pm-write.lock). UpdateReceipt becomes a kind='update' payload built on it; update_receipt.py keeps only the update-specific fields and fleet settlement. Split pointers: latest.json (any kind; Desktop, `hermes pm status`) and latest-update.json (kind=update; read_latest_receipt, actions.py, fleet catch-up, serve obligations). settle_latest_receipt_fleet goes through the same atomic locked writer.
- reference: none applies
- risk: Desktop and managed-ssh readers of latest.json (apps/desktop/electron/main.ts:18857, managed-ssh-update.ts:419) must keep their shape; 13 hermes_cli.update_receipt names are in the frozen old-updater surface and must stay importable until PMF-10.

### PMF-02: The PM boundary is inverted: PM's recovery, repair and GC live in hermes_cli, and hermes_cli writes PM-owned state outside PM

- severity: **high** · effort: **L** · kind: restructure · low_hanging: false · loc_delta: -60 · depends_on: 02-pm-core
- evidence: `pm/install.py:820`, `pm/cli.py:756-763`, `pm/recovery.py:50-60`, `hermes_cli/runtime_state.py:62-136`, `pm/publication.py:1`, `pm/publication.py:145`, `hermes_cli/plugins_cmd_git.py:51-87`, `hermes_cli/plugins_cmd_update.py:164-227`, `hermes_cli/local_runtime/binaries.py:212-240`, `inputs/metrics/SUMMARY.md:149`
- problem: AGENTS.md says PM owns Hermes Python dependency changes (AGENTS.md:350-354). In code, PM's own transaction depends on hermes_cli: sync_venv imports hermes_cli.runtime_state.recover_publication (pm/install.py:820); `hermes pm repair` is hermes_cli._early_recovery.recover_if_needed (pm/cli.py:757); repair_dependencies calls hermes_cli.venv_sync.collect_superseded_generations (pm/recovery.py:52); publication takes hermes_cli.auth._file_lock while its docstring says 'No application dependency imports' (pm/publication.py:1,145). The parent's import matrix shows pm -> hermes_cli 0 eager / 26 lazy edges (SUMMARY.md:149); rg counts 26 import lines in 13 pm files. In the other direction, hermes_cli writes PM state outside PM: .install-metadata.json has three writers with two lock holders, two of them unlocked (plugins_cmd_git.py:51-87, plugins_cmd_update.py:164-227, pm/publication.py:152-175); local_runtime._adopt renames into PM's store and writes pm.Facts directly (binaries.py:212-240); plugin remove and the provider picker edit PM membership (PMF-05). Every change to PM's state format needs edits in both trees, and the stdlib-only boot path (hermes_bootstrap.py:526-563) carries the cycle.
- move: Move PM-owned state behind pm APIs: (1) recover_publication/finish_publication from hermes_cli/runtime_state.py into pm/publication.py; (2) the marker/lock/attempt core of recover_if_needed into pm/recovery.py (hermes_cli/_early_recovery.py keeps restore_interrupted_pull and the quarantine sweep); (3) collect_superseded_generations into pm; (4) new pm/install_records.py (read, update(name, fn) under one lock) used by every .install-metadata.json writer; (5) pm.adopt(package, source_dir) for local_runtime. hermes_cli keeps re-export names only where the frozen surface pins them. Then declare the direction (pm never imports hermes_cli) as an import-linter contract; the TID251 banned-api block (pyproject.toml:902-908) already guards the opposite direction.
- reference: `.repos/home-assistant-core/homeassistant/requirements.py:128-137` (one RequirementsManager instance owns the lock, installed cache and failure history; integrations only ask it)
- risk: Boot ordering: hermes_bootstrap.py imports recovery before activation and must stay stdlib-only (hermes_bootstrap.py:530-533). Tests patch names on hermes_cli.runtime_state and plugins_transaction.recover_plugin_publication (pinned by tests/hermes_cli/test_plugin_historic_compat.py per notes/03-sub-plugins.md); keep those bindings.

### PMF-03: The plugin kill list is enforced by each caller; plugin packs and dashboard/TUI enable skip it, so a recalled plugin's dependencies get installed

- severity: **high** · effort: **S** · kind: hygiene · low_hanging: true · loc_delta: -15 · depends_on: none
- evidence: `hermes_cli/plugin_packs.py:377-396`, `hermes_cli/plugins_cmd.py:898-927`, `hermes_cli/plugins_cmd.py:655-665`, `hermes_cli/plugins_cmd_install.py:516-521`, `hermes_cli/plugins_discovery.py:302-310`, `plugins/AGENTS.md:43-47`
- problem: plugins/AGENTS.md:43-47 says every install path refuses removed.yaml matches and the same check runs at update, enable and load. Packs call _install_plugin_core then _set_plugin_enabled with no removal check (plugin_packs.py:377-396; `removed` appears only at :105, unrelated). dashboard_set_agent_plugin_enabled (plugins_cmd.py:898-927), used by the dashboard and TUI, skips the check that CLI cmd_enable runs (plugins_cmd.py:655-665). The loader still refuses the import (plugins_discovery.py:302-310), but PM admission has already resolved and installed the plugin's Python dependencies into the shared venv. The check lives in five callers instead of the two choke points.
- move: Check once inside _install_plugin_core after the manifest name is known (name, git_url, catalog name; honour allow_removed from the record) and once inside _set_plugin_enabled when enable=True. Delete the caller-side checks at plugins_cmd_install.py:516-521 (keep the --allow-removed warning), :643-651, plugins_cmd_catalog.py:248-249 and plugins_cmd.py:655-665.
- reference: `.repos/pluggy/src/pluggy/_manager.py:495-505` (load_setuptools_entrypoints skips blocked names inside the single registrar loop, not in each caller)
- risk: Low; the load-time gate stays as backstop. The memory-provider migration (memory_provider_migration.py:159-169) must still report a removed catalog entry cleanly.

### PMF-04: Lazy optional dependencies have no single entry point: policy is checked after the prompt and the worker spawn, failures are not memoized, and 10 call sites discard the reason

- severity: **high** · effort: **M** · kind: restructure · low_hanging: true · loc_delta: -250 · depends_on: none
- evidence: `pm/extras.py:186-236`, `pm/extras.py:239-259`, `pm/install.py:840-841`, `pm/install.py:802-811`, `tools/tts_tool.py:57-71`, `tools/tts_tool.py:222-225`, `tools/transcription_common.py:73-78`, `plugins/web/_common.py:176-178`, `inputs/gist/D-issues-rejected-prs-reverts.md:15`
- problem: ensure_import prompts `Install it now? [Y/n]` (pm/extras.py:210) and then calls sync_venv, which spawns the PM worker and only then refuses when lazy installs are off (pm/install.py:840-841); every refusal and no-op writes a receipt (pm/install.py:802-811, and see PMF-01). Nothing remembers a failure, so with lazy installs off, a frozen bundle or no network, every TTS/STT/adapter call repeats the worker spawn. Callers wrap it five different ways (tools/tts_tool.py:57-71, transcription_common.py:73-78, plugins/web/_common.py:176-178, remote_common.py:97-99, wake_word_engines.py:34-37) beside ensure_and_bind (4 callers); 10 of 29 sites drop the reason, so 'installed, restart Hermes' reaches the user as 'not installed, run hermes pm install --extra edge-tts' (tts_tool.py:222-225). Users get four remedy dialects: install_hint (42 lines), raw `pip install` (56 non-comment lines, which AGENTS.md forbids), `hermes setup` (16), `hermes pm repair` (28, which cannot add features, pm/install.py:787-788). The gist counts 52 closed import-error issues, 24/60 sampled being a missing optional dependency (gist D:15).
- move: Add pm.extras.require(extra, importer) -> Bound(values) | Unavailable(reason, remedy). Order: available -> extra_supported -> lazy_installs_allowed (before any prompt or subprocess) -> per-process failure memo keyed by (extra, selected generation) -> sync_venv -> adopt -> importer(). Unavailable.remedy is install_hint(extra) or 'restart Hermes'. Replace the 29 ensure_import sites, 4 ensure_and_bind sites and the 5 wrappers; delete the alias tables _PM_FEATURE_ALIASES (tools/tts_tool.py:54) and _LAZY_SDK_FEATURES (tools/tts_tool_lifecycle.py:50) in favour of pm.extras.ANCHORS; derive the platform-registry install_hint from the extra name.
- reference: `.repos/home-assistant-core/homeassistant/requirements.py:296-339` (fast path against an installed cache, raise early for requirements in install_failure_history, take pip_lock, recompute under the lock, record both installed and failed sets)
- risk: Tests fake SDKs through sys.modules (pm/extras.py:77-83); the memo must key on the selected generation so an explicit `hermes pm install --extra` invalidates it. Locale strings carrying install_hint need retranslation.

### PMF-05: Plugin remove and the memory-provider picker change PM membership without a PM transaction

- severity: **high** · effort: **M** · kind: boundary · low_hanging: true · loc_delta: 20 · depends_on: PMF-02
- evidence: `hermes_cli/plugins_cmd_remove.py:21-41`, `hermes_cli/plugins_cmd_remove.py:58-77`, `hermes_cli/plugins_cmd.py:556-585`, `hermes_cli/plugins_cmd.py:541-546`, `pm/plugins_state.py:140-160`, `pm/publication.py:142-175`
- problem: Install and enable go through PM's journaled publication (pm/publication.py:142-175) and _activate_key documents that 'PM owns the selection and dependency publication together' (plugins_cmd.py:541-546). Remove does not: _remove_plugin_core hand-rolls a move-aside and restore (plugins_cmd_remove.py:21-41), and _forget_plugin_config writes plugins.enabled/disabled/entries and memory.provider with save_config (plugins_cmd.py:556-585). The provider picker also writes memory.provider raw, although PM treats the provider as a member (pm/plugins_state.py:140-160). After every remove of an enabled plugin with dependencies (CLI, dashboard, TUI), the current generation and facts still describe the removed member until some later sync; the three remove steps (toolset write, tree removal, config purge) commit separately. Two rollback implementations exist for one kind of change.
- move: Add pm/plugin_inputs.py::Removal{home, target, aliases} next to StagedUpdate and a PluginRemoval in pm/publication.py that journals tree -> .previous-*, the metadata-row drop and the config purge as one row (recovery already replays plugin rows). Provider writes go through Selection with a memory_provider field. _remove_plugin_core and _forget_plugin_config shrink to building the request. Removal follows the eviction contract (pm/plugin_eviction.py): never fails on the venv build; the next successful sync drops the stale member.
- reference: `.repos/llm/llm/cli.py:3321-3345` (uninstall is the exact inverse of install through the same tool and the same environment)
- risk: Remove may now trigger a uv rebuild (slow or offline); keep the rebuild deferred as the eviction contract does. Symlinked dev plugins (plugins_cmd_remove.py:68-70) must stay unlink-only.

### PMF-06: Network installers outside PM ignore the lazy-install policy, and PM's docstring claims a Docker default the Dockerfile does not set

- severity: **high** · effort: **S** · kind: boundary · low_hanging: true · loc_delta: 15 · depends_on: PMF-04
- evidence: `agent/lsp/install.py:239-294`, `plugins/platforms/whatsapp/adapter.py:370-395`, `plugins/platforms/photon/adapter.py:217-219`, `pm/install.py:161-169`, `Dockerfile:450-455`
- problem: The policy gate security.allow_lazy_installs exists so an operator can forbid on-demand network installs. LSP runs `npm install` / `go install` of unpinned language servers with no lazy check (agent/lsp/install.py:239-294; `rg -n lazy agent/lsp` returns nothing; pm.ensure('npm') is consulted only when npm is missing). WhatsApp runs `npm install` at connect whenever node exists (whatsapp/adapter.py:370-395). Photon does gate (photon/adapter.py:217-219), so enforcement is opt-in per feature. pm/install.py:164-165 says HERMES_DISABLE_LAZY_INSTALLS is 'set by the official Docker image'; Dockerfile:450-455 says lazy installs are on in Docker unless the config disables them.
- move: Expose pm.require_lazy(name, what) (the public form of _refuse_lazy) and call it from every installer that fetches from the network outside PM. Longer term, give LSP Node servers a PM-managed environment (the analogue of ensure_python_tool, pm/operations.py:249-319) so agent/lsp/install.py keeps only recipes. Fix the pm/install.py docstring to match the Dockerfile.
- reference: none applies
- risk: LSP auto-install stops for users who turned lazy installs off; that is the intended behaviour but needs a hint naming `hermes pm install`.

### PMF-07: UpdateLock, the one mutex for update, install completion and boot-time completion, is check-then-write and treats a failed write as acquired; the ZIP swap has no crash marker

- severity: **high** · effort: **S** · kind: hygiene · low_hanging: true · loc_delta: 60 · depends_on: none
- evidence: `hermes_cli/update_lock.py:313-339`, `hermes_cli/source_completion.py:52-68`, `hermes_cli/update_cmd_zip.py:92-122`, `hermes_cli/update_cmd.py:916-958`, `pm/filesystem.py:34-51`
- problem: acquire() reads the marker, then write_text()s it (update_lock.py:320-333); there is no exclusive create, and an OSError returns True (:334-338). complete_source_checkout relies on this lock to serialize stacked completions that build the same output directories (source_completion.py:52-68, #123376), and dashboard, cron, Desktop and CLI can all start updates. PM already has a kernel lock helper (pm/filesystem.py:34-51) used by its install lock. The Windows ZIP apply renames entries one by one and rolls back only on an in-process OSError (update_cmd_zip.py:92-122); a killed update leaves a mixed tree and *.hermes-update-old siblings with no marker, while the git path has an interrupted-pull marker (update_cmd.py:916-958). Updater failures are the #4 issue class (398 closed issues, gist D:10).
- move: Keep the marker bytes for the Tauri/Electron readers (update_lock.py:1-6), but hold pm.filesystem.lock_fd on a sibling .hermes-update-in-progress.lock for the process lifetime and create the marker with O_CREAT|O_EXCL after stale-holder cleanup; a write failure returns False. Write a zip-swap manifest of (dst, backup) pairs before the rename loop and teach _early_recovery to roll it back, beside restore_interrupted_pull.
- reference: none applies
- risk: Marker format is shared with Rust/TS readers; handoff-pid and ancestor semantics (update_lock.py:322-326) must keep letting a child run under its parent's claim.

### PMF-08: `hermes doctor` is a second, divergent install checker: it never shows PM's verdict, its import list disagrees with PM's, and it re-derives the launcher layout

- severity: **high** · effort: **S** · kind: collapse · low_hanging: true · loc_delta: -80 · depends_on: none
- evidence: `hermes_cli/doctor_platform.py:481-499`, `pm/recovery.py:12-20`, `pm/cli.py:421-469`, `hermes_cli/main.py:3663-3668`, `hermes_cli/doctor_platform.py:587-657`, `hermes_cli/_launchers.py:579-635`
- problem: Every CLI and gateway launch prints PM's install verdict (main.py:3663-3668, via venv_sync.check_runtime -> pm.activate). `hermes doctor` does not call it or `hermes pm doctor` (pm/cli.py:421-469); rg for check_runtime|pm.activate|cmd_doctor over hermes_cli/doctor*.py returns 0. Doctor imports its own 8 packages (doctor_platform.py:481-485) while PM validates 7 different startup imports (pm/recovery.py:12-20); 3 overlap. So doctor can say 'All checks passed' on an install the next launch reports out of sync, and the two lists drift independently. Doctor's launcher check computes the expected target and link dir itself, 'mirroring install.sh' (doctor_platform.py:587-657), while install and update publish through _launchers.expose_cli (579-635); --fix can rewrite a link the installer owns. Launcher repair exists in four places (doctor, expose_cli, venv_sync.publish_launchers, Windows _install_repair).
- move: Turn pm/cli.py::cmd_doctor into pm.diagnose() -> list[Row] covering activate problems, per-package verify and the STARTUP_IMPORTS set; `hermes pm doctor` prints it and doctor's dependency section renders the same rows. Delete _PACKAGES and _check_required_packages. Doctor's launcher check calls expose_cli(create=should_fix) on POSIX and ensure_windows_bin_launchers on Windows and prints the result; delete its own link logic.
- reference: none applies
- risk: Low. Doctor already imports PM (doctor_platform.py:419). expose_cli keeps the 'do not touch user-managed targets' guard (_owns_launcher) that doctor has at :634-636.

### PMF-09: Lite (keep-data) uninstall leaves PM's whole footprint behind, and its docstring says the opposite

- severity: **high** · effort: **M** · kind: boundary · low_hanging: true · loc_delta: 10 · depends_on: PMF-02
- evidence: `hermes_cli/uninstall.py:498-531`, `pm/environments.py:33-38`, `pm/environments.py:190-201`, `hermes_cli/data_cleanup.py:20-31`
- problem: remove_legacy_runtime_trees says 'Runtime artifacts are install-scoped now, so the current locations go away with rmtree(project_root)' (uninstall.py:501-503). They do not: the store defaults to <root>/tools (pm/environments.py:201) and per-checkout state lives in <root>/installs/<install_key> (pm/environments.py:33-38), both outside the checkout. Lite uninstall removes only <home>/node and <home>/bin/uv. Managed Python, Node, git, ripgrep, llama.cpp engines, every venv generation, cache/uv and cache/partials stay, and the per-checkout installs/<key> is never referenced again. data mode already knows these paths to protect them (data_cleanup.py:20-31), so two modules hold two partial copies of PM's footprint.
- move: Add pm.footprint(project_root) -> {install_scoped: [...], machine_shared: [...]}. Lite uninstall removes install_scoped, and machine_shared only when no other installs/* entry remains; data_cleanup uses the same call for its protected set; remove_legacy_runtime_trees folds into it.
- reference: none applies
- risk: Must not delete a store shared with another checkout or profile root; gate machine_shared on installs/ being empty after removal.

### PMF-10: The frozen old-updater surface has no minimum supported release, so 562 names and 71 shims are pinned forever

- severity: **high** · effort: **L** · kind: kill · low_hanging: false · loc_delta: -1000 · depends_on: none
- evidence: `hermes_cli/_old_updater.py:143-176`, `hermes_cli/old_updater_main.py:1-159`, `hermes_cli/old_updater_deps.py:1-70`, `hermes_cli/main.py:841-867`, `hermes_cli/main.py:2236-2284`, `tools/lazy_deps.py:1-26`, `hermes_cli/plugin_compat.py:1-22`, `hermes_bootstrap.py:492-518`, `hermes_cli/AGENTS.md:178-185`
- problem: hermes_cli/AGENTS.md:178-185 says removing a name 'bricks every release mid-update'. tests/compat/old_updater_surface.json pins 562 bare + 126 guarded names across agent/, gateway/, plugins/, tools/ and hermes_cli/ (top: hermes_cli.update_cmd 64, gateway 44, config 43, main 37); 71 stop_for_relaunch shims sit in 17 files (rg -c '^\s+stop_for_relaunch\(' excluding tests), including non-update modules (tools_config, managed_uv, npm_engine, dashboard_procs); old_updater_main.py alone carries 37 ARG001 hits (SUMMARY.md:35). The guard costs 1,339 lines of audit script plus 322 lines of compat tests. tools/lazy_deps.py runs a frame walk on every call (lazy_deps.py:20-22). Every rename across ~150 files is reviewed against history, permanently. Four separate owners can finish an update because of it (PMF-11).
- move: Declare a minimum updatable release (for example the first release that ships _old_updater.stop_for_relaunch). Older installs print 're-run the installer' through one bootstrap intercept, the way hermes_bootstrap.py:510-518 already intercepts --post-swap before importing the graph. Then filter the frozen JSON to names imported by releases at or above the floor; replace per-name stubs with one hermes_cli/_retired package whose module __getattr__ calls stop_for_relaunch for listed names; delete old_updater_main.py, old_updater_deps.py, npm_engine.py, plugin_compat.py, tools/lazy_deps.py and the legacy .update-incomplete/.lazy-refresh-incomplete readers once no release at or above the floor needs them. This argues against the AGENTS.md 'forever' rule: a floor is a product decision, not a code constraint.
- reference: none applies
- risk: High if done before the floor is announced: an old updater mid-swap would import a missing name and crash. A generic __getattr__ loses the signature shapes some old except clauses rely on (update_cmd.py:142-148). Needs release data on how many installs predate the floor.

### PMF-11: Four owners can finish an update; the historical tail update_finish.py has already drifted from update_completion, and the restart-recovery layer still documents a premise the handoff removed

- severity: **medium** · effort: **M** · kind: collapse · low_hanging: false · loc_delta: -400 · depends_on: PMF-10
- evidence: `hermes_cli/update_finish.py:9-35`, `hermes_cli/update_completion.py:172-229`, `hermes_cli/update_finish.py:38-48`, `hermes_cli/update_completion.py:180-182`, `hermes_cli/update_restart_recovery.py:1-8`, `hermes_cli/update_abort_recovery.py:93-128`, `hermes_cli/venv_sync.py:479`
- problem: The current path (update_completion._prepare -> _complete_selected), the historical takeover (_old_updater -> _update_takeover -> update_finish.finish_update), the legacy --post-swap argv (hermes_bootstrap.py:510-518 -> update_handoff) and next-launch recovery (venv_sync._finish_source_update, venv_sync.py:479) each finish an update. update_finish.py says it is 'shared by current and historical update callers' (:1) but only the historical path uses it, and it has drifted: it calls _run_post_update_maintenance directly instead of complete_source_checkout (no launcher publish, no product build, no clear_completion), ignores --no-gateway-restart and the fleet skip reason that update_completion honours (update_completion.py:199-224), and deserializes the plan with a different filter (update_finish.py:38-48 vs update_completion.py:180-182). Separately, update_restart_recovery.py:3-8 says the updater 'keeps executing in the interpreter that started before git pull'; the restart now runs in completion child 2 on new code, yet update_abort_recovery still spawns a second fresh interpreter of the same code (update_abort_recovery.py:93-128, 734 lines across both modules).
- move: _update_takeover.main builds the update_completion request (it already has receipt, plan, windows_resume, desktop, assume_yes and gateway_mode) and runs update_completion.py as its child; delete update_finish.py. Then check what update_restart_recovery still catches (git log -S _run_fresh_recovery_process, #92145 tests): if only the systemd cgroup kill remains, keep a ~60-line 're-run the restart phase in a transient scope' and delete the rest; otherwise correct the docstring.
- reference: none applies
- risk: restart_update / cli_started semantics in update_finish.py:57-60 need porting; the fail-closed contract of the abort recovery and the gateway-mode cgroup isolation (update_abort_recovery.py:109-116) must survive.

### PMF-12: Four plugin install front-ends and three update copies decide consent, Node deps, env, capabilities and activation separately

- severity: **medium** · effort: **L** · kind: collapse · low_hanging: false · loc_delta: -250 · depends_on: PMF-03
- evidence: `hermes_cli/plugins_cmd_install.py:480-620`, `hermes_cli/plugins_cmd_install.py:623-697`, `hermes_cli/plugin_packs.py:340-410`, `hermes_cli/plugins_cmd_install.py:58-106`, `hermes_cli/plugins_cmd_install.py:616-619`, `hermes_cli/plugins_cmd_update.py:275-308`, `tui_gateway/methods_tools.py:1901-1930`
- problem: cmd_install (CLI), dashboard_install_plugin (dashboard, TUI, connectors, memory-provider migration) and install_pack_plugins wrap _install_plugin_core differently: only the CLI installs Node dependencies, and it does so with npm ci into the LIVE tree after publication, outside the transaction (plugins_cmd_install.py:58-106); only the CLI asks the Python-deps question; packs record no catalog provenance and skip the kill list (PMF-03); the CLI calls activate_plugin_now when --enable was passed even if admission refused (plugins_cmd_install.py:616-619 tests `enable`, not the final should_enable). Update exists three times (cmd_update, dashboard_update_user_plugin, TUI _plugins_update). Each new gate (the inline issue references in these functions) lands in two to four places; the siblings reach the facade through _pc() 199 times.
- move: One InstallRequest(identifier | catalog_entry, ref, force, enable, allow_removed) and a Consent protocol (scan_caution, python_deps, node_deps, capabilities, env) with TtyConsent, PreGranted(set) and Refuse implementations. install_plugin(request, consent) -> InstallOutcome(target, name, enabled, activation, warnings, missing_env). Node dependencies install in the staged tree before publication, as update already does (plugins_transaction.py:62-69). cmd_install, dashboard_install_plugin and install_pack_plugins become adapters of at most 30 lines; the same for update_installed_plugin(name, consent).
- reference: none applies
- risk: Tests patch names on the plugins_cmd facade (_pc() x199); land the Consent type first, then move one surface per PR.

### PMF-13: Eleven lock/receipt/obligation records track one update; three of them record the same 'restart owed' fact

- severity: **low** · effort: **M** · kind: collapse · low_hanging: false · loc_delta: -200 · depends_on: PMF-01
- evidence: `hermes_cli/update_host_obligation.py:33`, `hermes_cli/update_cmd_fleet.py:50-110`, `hermes_cli/update_serve_obligations.py:16-72`, `hermes_cli/update_receipt.py:298-302`, `hermes_cli/update_cmd_fleet.py:96-98`
- problem: A pending gateway/serve restart is recorded in the host obligation (update_host_obligation.py), the legacy per-home fleet_restart_pending marker (update_cmd_fleet.py:50-110; its docstring says 'nothing writes it any more' while :104 still writes it as the #117275 fallback), and manual-serve files plus pending_manual_serves receipt rows (update_serve_obligations.py:16-72, update_receipt.py:298-302). Readers merge three sources to answer 'is the fleet current'. hermes_cli/AGENTS.md:180-182 calls update_serve_obligations.py a frozen compat surface, but it is live in the current fleet path (update_cmd_fleet.py:479-487). Production code also branches on pytest (update_cmd_fleet.py:96-98 _pytest_owns_live_checkout).
- move: One update_obligations module with one atomic record per host (gateways + manual serves), the per-home marker as the documented write fallback of that same module, and receipts referencing the record instead of carrying rows. Fix the docstring and the AGENTS.md label. Replace the pytest branch with an injected home in tests.
- reference: none applies
- risk: Frozen names in hermes_cli.update_cmd (64 in the JSON) include some of these helpers; Windows .gateway-planned-stop.json readers stay separate.

## Kill list

| target | why | callers | evidence |
|---|---|---|---|
| `hermes_cli/update_finish.py` | historical copy of update_completion._complete_selected that has drifted (no complete_source_checkout, ignores --no-gateway-restart) | 1 | spawned by path only from hermes_cli/_update_takeover.py:99-101; see PMF-11 |
| `hermes_cli/doctor_platform.py::_PACKAGES + _check_required_packages` | second, disagreeing import list beside pm/recovery.py::STARTUP_IMPORTS | 1 | DOCTOR_CHECKS hermes_cli/doctor.py:111-127; PMF-08 |
| `hermes_cli/doctor_platform.py::_check_command_installation link logic (lines 613-650)` | re-derives the launcher layout that _launchers.expose_cli owns | 1 | doctor_platform.py:613-650 vs _launchers.py:579-635; PMF-08 |
| `tools/tts_tool.py::_PM_FEATURE_ALIASES, tools/tts_tool_lifecycle.py::_LAZY_SDK_FEATURES` | duplicate feature->extra tables of pm.extras.ANCHORS | 2 | tools/tts_tool.py:54, tools/tts_tool_lifecycle.py:50; PMF-04 |
| `five local ensure-then-import wrappers` | re-implement ensure_and_bind with different error handling | 5 | tools/tts_tool.py:57-71, tools/transcription_common.py:73-78, plugins/web/_common.py:176-178, tools/environments/remote_common.py:97-99, tools/wake_word_engines.py:34-37 |
| `caller-side kill-list checks` | move into the two choke points | 4 | plugins_cmd_install.py:516-521, :643-651, plugins_cmd_catalog.py:248-249, plugins_cmd.py:655-665; PMF-03 |
| `hermes_cli/doctor_state.py::_check_update_provenance (wire it or delete it)` | decorated doctor check missing from DOCTOR_CHECKS; only tests call it | 0 | doctor_state.py:529-536 vs doctor.py:111-127 (per notes/03-sub-doctor.md; last touched by 9cfa6e5021) |
| `hermes_cli/old_updater_main.py, old_updater_deps.py, npm_engine.py, plugin_compat.py, tools/lazy_deps.py (after a floor)` | inert stubs kept for pre-PM updaters mid-swap | 0 | no live callers outside the frozen surface (main.py:841-867, 2236-2284; update_cmd.py:86-89); PMF-10 |
| `.update-incomplete / .lazy-refresh-incomplete readers (after a floor)` | no writer exists in the current tree; only old updaters create them | 5 | _early_recovery.py:622, venv_sync.py:488,568, _update_takeover.py:45, main_install_repair.py:42-76 (per notes/03-sub-doctor.md) |

## Simplify list

| what N things | become what 1 thing | lines saved | evidence |
|---|---|---|---|
| pm/receipt.py; hermes_cli/update_receipt.py (engine core) | one pm receipt engine with kinds and two pointers (latest.json, latest-update.json) | ~200 | pm/receipt.py:299-313, update_receipt.py:269-350; PMF-01 |
| hermes_cli/runtime_state.py (publication recovery); hermes_cli/_early_recovery.py::recover_if_needed core; hermes_cli/plugins_cmd_git.py::_update_install_record; pm/publication.py metadata writer; plugins_cmd_update.py adopt/trust writers | pm/publication.py + pm/recovery.py + pm/install_records.py | ~60 | pm/install.py:820, pm/cli.py:757, plugins_cmd_git.py:51-87; PMF-02 |
| 29 ensure_import sites; 4 ensure_and_bind sites; 5 local wrappers; 4 remedy-string dialects | pm.extras.require(extra, importer) -> Bound | Unavailable(reason, remedy) | ~250 | pm/extras.py:186-259; PMF-04 |
| hermes_cli/update_finish.py; hermes_cli/_update_takeover.py::prepare; hermes_cli/update_completion.py | hermes_cli/update_completion.py as the only completion owner | ~220 | update_finish.py:9-35 vs update_completion.py:172-229; PMF-11 |
| doctor launcher check; _launchers.expose_cli; venv_sync.publish_launchers; _install_repair Windows launchers | _launchers.expose_cli(create=) on POSIX + ensure_windows_bin_launchers | ~60 | doctor_platform.py:587-657, _launchers.py:579-635; PMF-08 |
| cmd_install; dashboard_install_plugin; install_pack_plugins; cmd_update; dashboard_update_user_plugin; TUI _plugins_update | install_plugin(request, consent) and update_installed_plugin(name, consent) | ~250 | plugins_cmd_install.py:480-697, plugin_packs.py:340-410; PMF-12 |
| host obligation; legacy fleet_restart_pending marker; manual-serve files + receipt rows | one update_obligations record per host | ~200 | update_host_obligation.py:33, update_cmd_fleet.py:50-110, update_serve_obligations.py:16-72; PMF-13 |
| uninstall.py::remove_legacy_runtime_trees; data_cleanup.py protected PM paths | pm.footprint(project_root) | ~20 | uninstall.py:498-531, data_cleanup.py:20-31; PMF-09 |

## Reference patterns to copy

| repo | path | pattern | where it applies here |
|---|---|---|---|
| home-assistant-core | `homeassistant/requirements.py:128-137, 296-339` | one manager owns pip_lock, is_installed_cache and install_failure_history; fast path, fail fast on known failures, recompute under the lock, record both outcomes | PMF-04 pm.extras.require; PMF-02 single owner of install state |
| llm | `llm/cli.py:3321-3345` | install and uninstall are symmetric operations through one tool into one environment | PMF-05 remove through PM like install |
| pluggy | `src/pluggy/_manager.py:495-505` | block list checked inside the single registrar loop | PMF-03 kill list at the two choke points |
| home-assistant-core | `homeassistant/bootstrap.py:146, 311, 890` | staged bootstrap with per-stage timeouts and one recovery mode | launch prep spread over hermes_bootstrap.py:475-572, main.py:3630-3672 and gateway/run.py:6050-6082 (cross-seam) |

## Answer to the seam question

Counted by job, from the four flow traces (notes/03-sub-*.md, spot-checked here). Install: three bootstrap prologues (scripts/install.sh, scripts/install.ps1, setup-hermes.sh) plus Docker, Nix, Termux APT and Desktop, all converging on `pm.cli install` + `source_completion.complete_source_checkout`. That convergence is the part that already works. Launch-time repair: four entries (hermes_bootstrap prepare_launch, recover_if_needed, boot_bootstrap, main.py check_runtime warning). Update: five apply paths (git, ZIP, MS Store, App Installer, Desktop handoff), four completion owners and eleven lock/receipt/obligation records. Optional dependency: six mechanisms (ensure_import, ensure_and_bind plus five wrappers, explicit setup-time sync_venv, pm.ensure for binaries, raw npm/go installers, hand-written find_spec probes) and four remedy dialects. Plugin install: four front-ends, three update copies, and remove outside PM. Diagnosis and repair: two doctors and four launcher-repair implementations. That is roughly 25 independent mechanisms. The dependency engine underneath is already one (every path ends in pm.sync_venv), so the work is not a new engine. Kill or merge these to get one path per job: update_finish.py and the takeover prepare (into update_completion); the old-updater shims behind a declared floor; the pm/update receipt split (one engine, two pointers); the three restart-owed records (one); the five lazy wrappers and four remedy dialects (pm.extras.require); raw npm/go installers outside PM (behind pm.require_lazy or a PM Node environment); doctor's package list and launcher logic (pm.diagnose, expose_cli); plugin remove and the provider picker outside PM (Removal/Selection inputs); the four plugin front-ends (one install_plugin with a Consent object); uninstall's guessed footprint (pm.footprint). The remaining multiplicity is legitimate: per-OS installer prologues, the five apply paths that match real deployment kinds, and the fleet restart per supervisor kind.

## Cross-seam notes

- 02-pm-core: `pm/install.py:820`: pm imports hermes_cli at 26 lines in 13 files; PM's publication recovery, repair driver and generation GC live in hermes_cli
- 02-pm-core: `pm/receipt.py:4-9`: pm/receipt.py docstring claims the update receipt schema; it differs, and every sync outcome writes latest.json
- 02-pm-core: `pm/client.py:146-150`: pm.client._request loops on readline with no overall timeout for the PM worker (per notes/03-sub-plugins.md, not re-opened)
- 15-kill: `hermes_cli/main.py:2236-2284`: old-updater guard tooling: tests/compat/old_updater_surface.json (562 bare + 126 guarded names) and scripts/audit-old-updater-imports.py (1,339 lines)
- 12-cli: `hermes_cli/main.py:841-867`: hermes_cli/main.py carries four frozen-updater re-export blocks and a module __getattr__ for the frozen surface
- 11-plugins: `pm/plugins_state.py:64-79`: three different alias rules decide whether a plugin is enabled (loader, PM, CLI writer); PM can install deps for a plugin the loader treats as disabled
- 11-plugins: `hermes_cli/plugins_state.py:134-195`: hermes_cli/plugins_state.py (per-plugin KV store) and pm/plugins_state.py (selection reader) share a name and nothing else
- 10-gateway: `gateway/run.py:6062-6082`: gateway/run.py duplicates main.py's boot block (check_runtime + boot_bootstrap) and says so in a comment
- 06-tools: `agent/lsp/install.py:239-294`: LSP installs npm/go language servers by subprocess outside PM with no lazy-policy check
- 14-errors-obs: `hermes_cli/update_cmd_git.py:353`: 22 of 37 subprocess call sites in the update files have no timeout, including a network `fetch upstream` (count per notes/03-sub-update.md)
- 13-tui-cron: `tui_gateway/methods_tools.py:1901-1930`: TUI has its own third copy of plugin update that refuses non-catalog installs
- 07-config: `hermes_cli/AGENTS.md:180-182`: hermes_cli/AGENTS.md labels update_serve_obligations.py a frozen compat surface; it is live in the fleet path
- 09-concurrency: `hermes_cli/update_cmd_fleet.py:96-98`: update path branches on pytest in production code (_pytest_owns_live_checkout)

## UNVERIFIED

- UNVERIFIED: Whether venv_sync.prepare_launch re-syncs a stale venv when source-completion-pending is absent, i.e. in the window between deleting the pull marker (update_cmd.py:958) and arm_completion in the child (update_completion.py:148). Verify: read venv_sync.py:338-443 and pm.venv_is_current.
- UNVERIFIED: Which abort classes update_restart_recovery still catches now that the restart runs on new code (PMF-11). Verify: git log -S'_run_fresh_recovery_process', issue #92145 and tests/hermes_cli/*restart_recovery*.
- UNVERIFIED: Size of lite-uninstall leftovers (PMF-09 says 'likely GBs'). Verify: du -sh <root>/{tools,installs,cache/uv,models} on a real install.
- UNVERIFIED: Whether `hermes pm gc` ever removes installs/<key> for a deleted checkout. Verify: read pm/cli.py:472-527 and hermes_cli/runtime_state.py::collect_generations.
- UNVERIFIED: Whether the published Docker image disables lazy installs another way (s6 env file, seeded config in docker/). Only Dockerfile and docker/ were grepped for 'lazy'. Verify: read docker/stage2-hook.sh and the seeded config template.
- UNVERIFIED: Which shipped releases import each frozen name, i.e. how much PMF-10 deletes for a given floor. Verify: run scripts/audit-old-updater-imports.py with a commit floor (not run: no execution of repo scripts).
- UNVERIFIED: Removing an enabled plugin with dependencies makes the next non-explicit sync see the venv out of sync and refuse when lazy installs are off (PMF-05 consequence). Verify: read pm/install.py::_runtime_state_matches and reproduce in a scratch HERMES_HOME.
- UNVERIFIED: Counts and line citations gathered by the four leaf readers (notes/03-sub-update.md, 03-sub-plugins.md, 03-sub-optdeps.md, 03-sub-doctor.md) were spot-checked, not all re-opened. Re-opened by the author: update_lock.py:305-340, pm/receipt.py:1-12,225-313, update_receipt.py:295-350,470-495, update_serve_obligations.py, update_cmd_fleet.py:50-112,475-535, web_routers/actions.py:390-440, desktop main.ts:18848-18870, plugins_cmd_remove.py, plugins_cmd.py:541-600,655-666,898-927, plugin_packs.py:365-400, plugins_cmd_install.py:340-365,462-478, pm/extras.py:181-262, pm/install.py:160-190,782-852, pm/client.py:30-50,200-235, agent/lsp/install.py:236-270, Dockerfile:448-458, doctor_platform.py:478-500, pm/recovery.py:10-62, uninstall.py:496-532, pm/environments.py:25-45,190-210, hermes_bootstrap.py:488-572, update_finish.py:1-60, update_completion.py:172-230, update_restart_recovery.py:1-12, pm/cli.py:310-410,750-765, source_completion.py, scripts/install.sh install stages, the reference-repo lines.
- UNVERIFIED: The subprocess timeout count (22 of 37) and the 71-shim / 562+126-name counts come from the update leaf reader's commands, not re-run here.
- UNVERIFIED: Gist figures (398 updater issues, 52 import-error issues) are quoted from inputs/gist/D-issues-rejected-prs-reverts.md:10,15, not re-derived.
- UNVERIFIED: loc_delta values are estimates from cited ranges, not measured diffs.
