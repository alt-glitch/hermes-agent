# 02 PM core (package manager internals)

Revision: `origin/main` = `ea81748579`. Reference SHAs: llm 764dc38, attrs a602f78, stamina 7836f46,
httpx b5addb6, jupyter_client 978361b, home-assistant-core 0f3081e.
Sub-notes (children, re-checked where cited): `notes/02-sub-download.md`, `notes/02-sub-uv-cli.md`.
Consumer survey script: `scripts/pmc_consumers.py` (stdlib AST over the in-scope tree minus `pm/`).

## TL;DR

1. Biggest structural problem: PM has no single model of "a Python environment generation". Three
   separate generation stores (app venv, PM runtime, side environments) each have their own selection
   file, lock, lease and collector, and one of them has no collector at all (PMC-01).
2. Biggest kill: the hand-mirrored worker IPC layer. `pm/client.py` (421 lines), the string routing table
   `pm/worker_operations.py` and the per-operation special cases in `pm/worker.py` restate every operation
   signature twice. One `@operation` registry plus one generic proxy replaces them (PMC-02). The package
   definition marshalling across that seam has no production consumer (PMC-08).
3. Biggest simplification: one resolved `Install` layout value replaces two path modules, six separate
   `manifest.json` probes and the worker's runtime monkeypatch of `pm.paths` (PMC-03).
4. Low-hanging fruit (high severity, effort S or M): 4 (PMC-02, PMC-03, PMC-04, PMC-06).
5. Seam answer: pm/ is several overlapping mechanisms with one good core (pinned store + uv engine).
   Its public API is not narrow: 90 files use the facade and 176 more imports reach into 25 submodules.

## What this area is

Scope covered: all 48 files of `pm/` (11,851 lines, parent metrics) plus the PM half that lives in
`hermes_cli/runtime_state.py` (243 lines), `pyproject.toml [tool.hermes]` (571-606) and the TID251 bans
(`pyproject.toml:902-908`). PM is 5 weeks old: first commit `3d12e86ef1` on 2026-08-29; 246 commits touch
`pm/` since, 153 of them with a `fix` subject (`git log --format=%s -- pm/ | grep -ci '^fix'`, non-shallow
clone). `tests/pm/` holds 118 files / 18,250 lines, more than the source.

Entry points: `hermes pm …` (`hermes_cli/main.py:677-680` → `pm/cli.py::main`), `python -m pm.cli install`
(installers), `python -m pm.build_env` (Dockerfile, CI, termux), `python -m pm.environments` (shell
activation, `scripts/_activation.sh:59`), `pm/worker.py` (spawned per call by `pm/client.py::_request`),
`pm/launch.py` (re-exec target of `pm/runtime.py::run_cli`), and the in-process facade `import pm`.

| module | LOC | owns |
|---|---|---|
| `pm/packages.py` | 1247 | built-in catalog: 19 `Package` subclasses, incl. `Venv` (the app venv) |
| `pm/install.py` | 983 | tool-store installs (`ensure`, `_install`), app-venv sync (`sync_venv`), PATH activation, drift |
| `pm/cli.py` | 872 | `hermes pm` subcommands; re-execs itself into the PM runtime (`cli.py:853-858`) |
| `pm/downloader.py` | 652 | resumable ranged downloader, also used for LLM model files |
| `pm/environments.py` | 512 | install layout, selected venv, boot activation, shell export rendering |
| `pm/update.py` | 487 | upstream index scrapers for `pm update` |
| `pm/store.py` | 450 | content store of published entries, archive fetch, extraction, tree digests |
| `pm/environment.py` | 440 | `PythonEnvironment`: the single uv argv builder |
| `pm/client.py` | 421 | caller-side proxy to the per-call worker process |
| `pm/workspace.py` | 382 | plugin discovery → generated uv workspace; npm sidecar install |
| `pm/operations.py` | 330 | build ops + side environments (`ensure_environment`) |
| `pm/receipt.py` | 328 | ContextVar-held operation receipts |
| `pm/lock.py` | 306 | `Lockfile` (lock.json) and `Facts` (two facts.json files) |
| `pm/runtime.py` | 274 | PM's own isolated interpreter: prepare, lease, collect, launch |
| `hermes_cli/runtime_state.py` | 243 | PM's install lock, publication journal, leases, app-generation GC |

### Domain model as it is

| noun | where | one line |
|---|---|---|
| Package | `pm/package.py:47` | class-level declaration of a pinned tool; subclasses override fetch/unpack/stage/verify/env |
| StatePackage / Venv | `pm/package.py:289`, `pm/packages.py:351` | the app venv modelled as a "package" with a stamp instead of a store entry |
| Registry | `pm/registry.py:14` | module-global `_packages` dict filled by `@register` at import |
| Lockfile | `pm/lock.py:75` | `pm/lock.json`: version + per-target url/sha256 |
| Facts | `pm/lock.py:146` | installed state; one class, two files, two record shapes (tool `entry` vs venv `stamp`) |
| Store | `pm/store.py:345` | directory of immutable entries `<name>-<ver>-<target>`, `fetch-<sha>` archives, `.previous-*`, `.reclaim-*` |
| Target | `pm/store.py:149` | `os-arch[-libc]` string |
| Runner | `pm/package.py:357` | composed env + `subprocess.run` mirror |
| PythonEnvironment | `pm/environment.py:255` | frozen uv engine bound to one destination |
| Generation (app) | `pm/packages.py:408` | `<installs>/<key>/environments/<uuid>/venv`, selected by per-install `facts.json` |
| Generation (PM runtime) | `pm/runtime.py:159` | `<installs>/<key>/pm-runtime/generations/<uuid>`, selected by `selected.json` |
| Generation (side env) | `pm/operations.py:306` | `$HERMES_HOME/environments/<name>/gen-<hex>`, selected by `active.json` |
| Workspace | `pm/workspace.py:112` | generated uv workspace pyproject: core + plugin members |
| PluginInput | `pm/plugin_inputs.py:39` | `Members | Candidates | Selection | StagedUpdate` |
| Publication | `pm/publication.py:62,104`, `hermes_cli/runtime_state.py:94` | journal tying config.yaml / plugin-tree writes to the facts commit |
| Lease | `hermes_cli/runtime_state.py:149` | flock'd file under `.leases/` pinning a generation for a process lifetime |
| Receipt | `pm/receipt.py:54` | ambient ContextVar record of a sync, written to `logs/update_receipts/` |
| Operation | `pm/worker_operations.py:14` | `(module, packages, bootstrap tier)` routing row, keyed by function-name string |
| Runtime | `pm/runtime.py:126` | PM's own locked interpreter (`pm/pyproject.toml`, `pm/uv.lock`) |
| Extra / Feature | `pm/extras.py:17`, `pm/features.py:21` | extra → import anchor table; bundle's frozen `enabled-features.json` |

### Public API actually used (consumer survey, `scripts/pmc_consumers.py`)

The facade (`pm/__init__.py:22-39`) exports 42 names. Outside `pm/`, 90 files use it 215 times. The top
symbols are `ensure` 33, `installed_package` 31, `InstallError` 29, `ensure_import` 28, `install_hint` 21 and
`sync_venv` 14. Beyond the facade, 176 imports in the in-scope tree go straight to 25 submodules:

- `pm.environments`: 71 imports in 30 files
- `pm.paths`: 17
- `pm.extras`: 14
- `pm.install`: 9, including `lazy_installs_allowed` and `sealed`
- `pm.plugin_declarations`: 9
- `pm.workspace`: 8, including the private `_is_member_candidate` at `hermes_cli/memory_setup.py:59`
- `pm.client`: 7
- `pm.filesystem`: 7
- 17 more submodules

Of the 15 worker operations, 11 have no in-scope runtime caller. They serve `scripts/`, CI, the Dockerfile
and `pm/cli.py` (rg per name).

### State files PM writes, and their atomicity

| file | writer | atomic | lock |
|---|---|---|---|
| `pm/lock.json` | `Lockfile.save` `pm/lock.py:110` | yes (`durable_write_bytes`) | `.lock.json.lock` + stale-row check |
| store `facts.json` (tools) | `Facts._merge_and_write` `pm/lock.py:225` | yes | store `.install.lock` (`pm/store.py:436`) |
| per-install `facts.json` (venv selection) | `Facts.record_state` `pm/lock.py:263` | yes, after `os.sync` (`pm/environments.py:215`) | `<installs>/<key>/.install.lock` (`hermes_cli/runtime_state.py:49`) |
| `pm-runtime/selected.json` | `pm/runtime.py:166` | yes | `.prepare.lock` (`pm/runtime.py:142`) |
| side-env `active.json` | `pm/operations.py:314` | yes | `<root>/.install.lock` (`pm/operations.py:295`) |
| `publication.json` journal | `pm/publication.py:100,171`, `pm/plugin_eviction.py:123` | yes | under the install lock |
| user `config.yaml` (plugins.enabled/disabled, memory.provider) | `pm/publication.py:101`, `pm/plugin_eviction.py:125` | yes | install lock + snapshot compare |
| plugin `.install-metadata.json` | `pm/publication.py:175` | yes | `hermes_cli.auth._file_lock` (private) |
| `declined-packages.json` | `pm/defaults.py:57` | yes | none |
| `enabled-features.json` | `pm/features.py:46` | **no** (`write_text`) | none (bundle time) |
| activation input stamps | `pm/environments.py:136-147` | **no** (rmtree then recreate) | none |
| receipts `pm_*.json`, `latest.json` | `pm/receipt.py:308-312` | yes | `.pm-write.lock` |
| download `.ranges` sidecar / `.part` | `pm/downloader.py:455` / in place | sidecar yes / body by design no | `.locks/<sha(url)>` |

Eight distinct lock files guard these. Most durable writes are correct. The structural issue is that the
same "write a selection record last" protocol is implemented three times (PMC-01).

### How PM drives uv

One argv builder: `pm/environment.py::PythonEnvironment._run` (`environment.py:271-324`).

- It strips ambient `UV_*`/`PYTHON*`, forces `UV_PYTHON`, `UV_PROJECT_ENVIRONMENT`, `UV_CACHE_DIR` and
  `UV_PYTHON_DOWNLOADS=never`, and points uv at an empty XDG config dir.
- Eight subcommands go through it: venv, lock, lock --check, sync, export, pip install, cache prune and pip check.
- uv and the pinned Python come from `pm/_uv.py::_toolchain`.
- Engines are built in two places only: `managed_environment` (`environment.py:213`) and `stage_runtime`
  (`pm/runtime_stage.py:28`).

This part is clean and is the core to keep.

## How it works end to end

### Flow A: a feature first needs an optional extra (lazy install)

Trigger: `agent/trace_upload.py:189` calls `pm.ensure_import("trace-upload")`.

1. `pm/__init__.py:45::__getattr__` lazily resolves `ensure_import` from `pm.extras`.
2. `pm/extras.py:186::ensure_import` → `available()` (`extras.py:91`): anchors via `find_spec`. Installed → return.
3. `pm/extras.py:210`: on a TTY outside prompt_toolkit, asks "Install it now?".
4. `pm/client.py:205::sync_venv`: refuses a lazy extra from a foreign interpreter (`client.py:209`).
5. `pm/client.py:91::_request`: builds the JSON request, including `package_definitions` (`client.py:105`) [PMC-08].
6. `pm/client.py:50::_worker_command` → `pm/runtime.py:256::runtime_command` → `runtime_python` (`runtime.py:216`) → `prepare_runtime` (`runtime.py:126`) may stage a PM runtime generation [PMC-01].
7. `pm/worker.py:38::main`: rebinds `paths.repo_root` and `paths.lockfile_path` with lambdas (`worker.py:72-73`) [PMC-03].
8. `pm/worker.py:100`: resolves `OPERATIONS["sync_venv"]` by name; special-cases plugin decoding (`worker.py:102-103`) [PMC-02].
9. `pm/install.py:782::sync_venv` → `_venv_install_lock` (`install.py:694`) → `hermes_cli/runtime_state.py:40::runtime_lock` [PMC-04].
10. `pm/install.py:840`: lazy policy → `pm/install.py:161::lazy_installs_allowed` imports `hermes_cli.config` inside the PM worker [PMC-07].
11. `pm/install.py:756::_commit_selection` → `pm/packages.py:393::Venv.apply`: new generation dir (`packages.py:408`) [PMC-01, PMC-06].
12. `pm/workspace.py:350::lock_and_sync` → `pm/environment.py:351::PythonEnvironment.sync` → `_run` (`environment.py:271`): `uv lock` / `uv sync`.
13. `pm/lock.py:263::Facts.record_state`: per-install `facts.json` names the new generation [PMC-06].
14. `pm/extras.py:230-236`: `adopt_selected` swaps `sys.path` if safe, else raises "restart Hermes".

### Flow B: a tool binary is needed (`bws`)

Trigger: `agent/secret_sources/bitwarden.py:91` calls `pm.ensure("bws")`.

1. `pm/client.py:181::ensure`: inside the PM runtime, calls `pm.install.ensure` directly (`client.py:185`).
2. `pm/client.py:189-191`: not a `StatePackage`; `_missing_or_refuse` (`client.py:19`) — all installed → `Runner(env_for(...))`.
3. `pm/client.py:201`: else `_request("ensure")` → worker (Flow A steps 5-8).
4. `pm/install.py:511::ensure`: `StatePackage` branch (`install.py:534`) [PMC-06]; deps walk (`install.py:544`); `_installed_location` (`install.py:84`).
5. `pm/install.py:558`: lazy refusal when missing and not explicit [PMC-07].
6. `pm/install.py:386::_install`: store `install_lock` (`install.py:418`), settle a prior `.previous-*` (`install.py:425`).
7. `pm/install.py:31::_prepare_artifacts` → `pm/store.py:363::Store.fetch_many` → `pm/downloader.py:267::Download.run` [PMC-09].
8. `pm/install.py:455::_publish_entry` (`install.py:320`) → `pm/store.py:414::Store.publish` (rename with Windows retry).
9. `pm/lock.py:235::Facts.record` → `_merge_and_write` (`lock.py:225`): durable write of tool facts.
10. `pm/install.py:572::env_for` → `pm/package.py:23::compose_env` → `pm/package.py:357::Runner`.

## Findings

### PMC-01: Three generation stores implement the same select-last protocol three ways (high, L, collapse)

Evidence: `pm/packages.py:408-448`, `pm/install.py:756-780`, `pm/lock.py:263-273`, `pm/environments.py:259-280`,
`pm/runtime.py:126-171`, `pm/runtime.py:182-212`, `pm/operations.py:133-143`, `pm/operations.py:248-319`,
`hermes_cli/runtime_state.py:139-208`, `hermes_cli/venv_sync.py:130`.

Problem (today): the app venv, PM's own runtime and side environments (LSP servers, test env, CI tools) all
follow one protocol:

1. Build a fresh directory.
2. Flush it to disk.
3. Atomically write a record that names it.
4. Keep the old directory.
5. Collect unleased directories later.

Each of the three implements this protocol separately:

| | app venv | PM runtime | side environments |
|---|---|---|---|
| directory | `environments/<uuid>` | `generations/<uuid>` | `gen-<hex>` |
| record | `facts.json` venv fact (`environment`, `stamp`) | `selected.json` (`inputs`) | `active.json` (`inputs`, `requirements`) |
| lock | `.install.lock` | `.prepare.lock` | `.install.lock` |
| identity hash | `Venv.expected_stamp` | `runtime._inputs` | `_ensure_generation.identity` |
| collector | `runtime_state.collect_generations` (24h age floor) | `runtime.collect_runtime_generations` (no age floor) | none |

Side environments have no collector: `rg 'gen-\[|glob\("gen'` finds only the validator at
`pm/operations.py:141`. Every requirement change therefore leaves a full venv behind under
`$HERMES_HOME/environments/<name>/`. The two collectors that do exist are invoked from two copies of the same
code (`pm/cli.py:518-523` and `hermes_cli/venv_sync.py:139-145`, per `notes/02-sub-uv-cli.md` §4). Every
durability or Windows-hold fix has to land three times. The fix log shows that pattern
(`git log --format=%s -- pm/ | grep -i displaced`).

Move (proposed): add one `pm/generations.py` with a `Generations(root)` class that owns:

- `build(identity, builder) -> Path`
- `selected()`
- `lease()`
- `collect(min_age)`

It writes one frozen `Selection` record (`generation`, `identity`, `meta`). App venv, PM runtime and side
environments become three `Generations` roots. The lease and GC code in `hermes_cli/runtime_state.py` moves
into it. The venv fact in the per-install `facts.json` becomes the app root's `selected.json`.

Reference: attrs `.repos/attrs/src/attr/_next_gen.py:431` (`frozen`) for the `Selection` record.

loc_delta: about -250 (three implementations of ~120 lines each become ~130).

Risk: boot activation reads the selection before any imports (`pm/environments.py:380-438`). The record must
stay readable with the stdlib alone, and the lease/lock ordering in `activate_dependencies` must be kept. Old
installs carry the venv selection in `facts.json`, so one release needs a read-compat shim.

Depends on: PMC-03.

### PMC-02: The worker IPC boundary is hand-mirrored in three files (high, M, collapse, low-hanging)

Evidence: `pm/client.py:265-421`, `pm/worker_operations.py:23-39`, `pm/worker.py:96-121`, `pm/client.py:74-88`,
`pm/client.py:185`, `pm/client.py:226`, `pm/client.py:258`, `pm/client.py:266`, `pm/client.py:355`,
`pm/cli.py:314-322`.

Problem (today): every PM operation exists in three places:

1. An implementation in `pm/install.py`, `pm/operations.py` or `pm/build_operations.py`.
2. A client wrapper in `pm/client.py` that restates the full keyword signature and hand-converts `Path` to
   `str` (11 near-identical wrappers, `client.py:273-421`).
3. A row in a string-keyed table (`worker_operations.py:23-39`), resolved with
   `getattr(import_module(...), name)`.

The worker then special-cases operations by name (`worker.py:102-111`): plugin decoding for two operations,
and `pause_event` and `Runner` handling for `ensure`. Errors come back through a hard-coded 7-entry type map
(`client.py:74-76`).

Each public function also has a second path, `if is_runtime(): direct(...)`, at 8 sites. The two paths
diverge:

- `client.sync_venv`'s foreign-interpreter guard (`client.py:209-220`) does not exist on the direct path.
- `pm/cli.py::_install_python_environments` calls `pm.install.sync_venv` directly
  (`notes/02-sub-uv-cli.md` §4), so it also skips the guard.

Adding or changing one parameter means editing three files and both paths, and tests must cover both
transports.

Move (proposed):

- Put one decorator on each implementation: `@operation(needs=("uv",), bootstrap="policy")`. It records the
  function object (not a string) in a registry in `pm/operations.py`.
- Add one generic proxy, `pm._remote.call(fn, **kwargs)`. It serializes arguments from `inspect.signature`;
  one codec handles Paths and the four plugin input types.
- The worker calls `registry[name](**kwargs)` with no per-operation branches.
- `InstallError` and its subclasses carry `to_wire()` / `from_wire()`.
- Delete the `pm/client.py` wrappers and `pm/worker_operations.py`. The facade exports the decorated
  functions.

Reference: jupyter_client's typed JSON message envelope, `.repos/jupyter_client/jupyter_client/session.py:651-700`
(`msg_header`/`msg`/`serialize`). Every message type uses one header shape, with no per-type marshalling.

loc_delta: about -300.

Risk: the worker must keep running on the PM runtime's stdlib plus its 4 dependencies. The facade must stay
lazy (PEP 562, `pm/__init__.py:12-14`) so the `pm.environments` boot stays cheap. Tests that monkeypatch
`pm.client.X` break.

Depends on: [].

### PMC-03: Paths are free functions re-derived per call, and the worker monkeypatches them (high, M, restructure, low-hanging)

Evidence: `pm/worker.py:72-73`, `pm/paths.py:9-77`, `pm/environments.py:150-212`, `pm/install.py:206`,
`pm/lock.py:56`, `pm/runtime.py:61-95`, `pm/paths.py:67`, `pm/environments.py:177-180`, `pm/paths.py:17`.

Problem (today): free functions rediscover the install layout on every call. The layout can be:

- a source checkout;
- a sealed payload with `manifest.json`;
- a Nix/Docker resident runtime found through `install-stamp.json`;
- a borrowed `HERMES_HOME`.

The functions are split between `pm/paths.py` and `pm/environments.py`, and `pm/paths.py` delegates back to
`pm/environments.py`.

- Six separate sites probe `manifest.json`, using two different anchors: `store_root().parent` and
  `repo_root().parent` (`rg '"manifest.json"' pm`).
- Two env vars override pieces of the layout: `HERMES_RUNTIME_DIR` and `HERMES_INSTALL_ROOT`.
- The worker gets its context by assigning lambdas over module functions at runtime
  (`paths.repo_root = lambda: ...`). Every later reader in that process inherits this global rebinding.
- The owner/borrower logic (`owning_home_root`, `pm/environments.py:41-91`) took 3 fix commits in the last
  week of history alone (`git log --format=%s -- pm/ | head`).

Move (proposed): resolve the layout once into a frozen `Install` value, built by
`Install.discover(project_root)`. Its fields are `kind` (`source`, `payload` or `resident`), `repo`,
`lockfile`, `store`, `writable_store`, `state_dir`, `tool_facts` and `selection`.

- Every PM function takes the `Install`, or a `Store`/`Generations` built from it.
- The worker request carries it as data.
- `pm/paths.py` is deleted. `pm/environments.py` keeps only boot activation.

Reference: attrs `frozen` + `evolve` (`.repos/attrs/src/attr/_next_gen.py:431`, `.repos/attrs/src/attr/_make.py:589`).

loc_delta: about -150.

Risk: `pm.environments` must stay importable with the stdlib and `hermes_constants` only, because it runs
before imports at boot. `hermes_cli` imports `pm.paths.install_root`, `install_stamp_path` and `repo_root`
15 times, and those callers move to `Install`. To respect the profile-scope rule, `discover` resolves
`HERMES_HOME` at call time, never at import.

Depends on: [].

### PMC-04: PM and hermes_cli import each other, and PM's own lock/journal module lives in hermes_cli (high, M, boundary, low-hanging)

Evidence: `hermes_cli/runtime_state.py:17-26`, `pm/install.py:179`, `pm/install.py:697`, `pm/environments.py:77`,
`pm/environments.py:390`, `pm/publication.py:145`, `pm/receipt.py:113`, `pm/update.py:204`, `pm/cli.py:766`,
`pm/packages.py:252`, `pm/packages.py:894`, `pm/security_packages.py:101`, `pm/security_packages.py:116`,
`pm/plugins_state.py:38`.

Problem (today): PM's docstrings say it runs independently of the application graph (`pm/runtime.py:1-5`,
`pm/publication.py:1`). The Dockerfile stage copies only `pm/` and `hermes_constants.py`
(`Dockerfile:202-207`). In fact the PM worker imports:

- `hermes_cli.config`, for the lazy policy (`install.py:179`);
- `hermes_cli.runtime_state`, for its own install lock and journal;
- the private `hermes_cli.auth._file_lock` (`publication.py:145`);
- the private `hermes_cli._launchers._launcher_python` (`environments.py:77`);
- `hermes_cli.update_receipt`, `hermes_cli.urllib_security`, `hermes_cli.plugins_manifest` and
  `hermes_cli.macos_signing`;
- the root module `utils` (`plugins_state.py:38`);
- `scripts.bundles.native` (`cli.py:766`);
- `tools` and `agent` modules, for package verification.

The parent import matrix shows 26 lazy pm→hermes_cli edges, and 24 eager plus 144 lazy hermes_cli→pm edges.
`hermes_cli/runtime_state.py` imports only `pm` and the stdlib, so it is PM code filed under the app. The
old-updater compatibility surface pins its file path (`tests/compat/old_updater_surface.json:693,873`).

Cost: a bootstrap stage that ships only `pm/` breaks the first time a code path reaches one of these
imports. The bug only shows on that install kind.

Move (proposed):

- Move the body of `hermes_cli/runtime_state.py` into `pm/` (`pm/generations.py`, see PMC-01). Leave a
  forwarding module at the old path, which the compat surface requires.
- The lazy policy arrives as data in the request (PMC-07).
- `_file_lock` and `_launcher_python` move to `pm/filesystem.py` and `pm/launchers.py`, or the caller passes
  them in.
- Package verification hooks that need `agent` or `tools` take a callable from the caller.
- Add an import-linter contract: pm may import only the stdlib, its 4 runtime dependencies,
  `hermes_constants` and `hermes_platform`.

Reference: home-assistant's `homeassistant/requirements.py:19` imports only `.util.package` for installs, and
config arrives through `pip_kwargs()` (`.repos/home-assistant-core/homeassistant/requirements.py:96-121`).

loc_delta: about -20 (moves, not deletions).

Risk: old updater processes may import `hermes_cli.runtime_state` mid-swap, so the forwarder must re-export
every name it has today. Tests patch `hermes_cli.runtime_state._atomic_bytes` (comment at
`hermes_cli/runtime_state.py:18-20`).

Depends on: PMC-07.

### PMC-05: The package manager owns plugin enablement writes to every profile's config.yaml (high, L, restructure)

Evidence: `pm/publication.py:62-101`, `pm/publication.py:104-175`, `pm/plugin_eviction.py:77-125`,
`pm/plugin_eviction.py:143-207`, `pm/plugins_state.py:22-79`, `pm/plugins_state.py:118-149`,
`hermes_cli/runtime_state.py:62-136`, `hermes_cli/plugins_discovery.py:112-122`, `pm/install.py:715-737`.

Problem (today):

- **PM reads plugin enablement with its own rules.** It parses every profile's `config.yaml` with its own
  validator and enablement rules (`plugins_state.py:22-79`), including the
  `name.rsplit("/")[-1] in disabled` rule. The plugin loader has a separate definition in
  `_get_enabled_plugins`/`_get_disabled_plugins` (`hermes_cli/plugins_discovery.py:112-122`).
- **PM writes user config and plugin trees.**
  - It writes `plugins.enabled`, `plugins.disabled` and `memory.provider` into those files with a ruamel
    round-trip (`publication.py:76-89`, `plugin_eviction.py:90-111`).
  - It replaces plugin directories and their `.install-metadata.json` (`publication.py:142-175`).
  - It recovers all of this from a journal whose recovery logic lives in
    `hermes_cli/runtime_state.py:62-136`, with two row shapes (`kind: plugin` vs `configs`).
- **The sync entry point carries four mutually exclusive plugin input kinds** (`pm/plugin_inputs.py:13-39`)
  to select which of these behaviours runs.

This is the plugin seam's business inside the dependency engine. The two definitions of "enabled" can
disagree, and the memory-provider rule is encoded twice (`plugins_state.py:124-160`,
`plugin_eviction.py:102-108`).

Move (proposed): keep PM's atomic guarantee but make it generic.

- PM's sync takes `members: list[Path]` and an optional
  `Publication(files: dict[Path, bytes], trees: list[(target, staged)])`. The plugin layer prepares it as
  opaque bytes.
- PM journals and commits those bytes together with the selection. It never parses YAML and does not know
  about `plugins.enabled`.
- Enablement reading and eviction policy (which plugins to disable, and how to edit config) move to
  `hermes_cli/plugins_*`.
- The four `PluginInput` kinds collapse to `members` + `publication`.
- `pm/plugins_state.py`, the YAML editing in `pm/publication.py`, and `PluginEviction` in
  `pm/plugin_eviction.py` leave `pm/`.

Reference: home-assistant's integration loader asks the requirements manager for a requirement list only; it
never lets it write config entries (`.repos/home-assistant-core/homeassistant/requirements.py:139-160`).

loc_delta: about -250 in pm/ (+150 in hermes_cli; net -100).

Risk: the commit must stay atomic across config bytes, plugin tree and selection. The boot journal recovery
order must be kept: `recover_publication` runs before activation (`pm/environments.py:394-396`). This
crosses into the 11-plugins and 03-pm-flows seams.

Depends on: PMC-01, PMC-04.

### PMC-06: The app venv is forced into the `Package` hierarchy, and one Facts class holds two record types in two files (high, M, boundary, low-hanging)

Evidence: `pm/package.py:289-299`, `pm/packages.py:351-449`, `pm/client.py:58`, `pm/client.py:189`,
`pm/install.py:534-540`, `pm/registry.py:66`, `pm/lock.py:169`, `pm/lock.py:205-208`, `pm/install.py:195`,
`pm/install.py:653`, `pm/install.py:831`, `pm/install.py:836`.

Problem (today):

- **`Venv` is a `Package` in name only.** It subclasses `Package` but uses none of url, fetch, unpack, stage,
  verify, env or store_entry. Its `expected_stamp(extras, *, plugin_dirs)` signature differs from the base
  `expected_stamp(extras)`.
- **The mismatch is patched with branches.** There are `isinstance(..., StatePackage)` checks at four sites
  and a `"state"` bootstrap tier in the worker table. `pm.ensure("venv")` silently becomes `sync_venv`
  (`install.py:534-540`).
- **`Facts` holds two record types in one dict.** Tool records (`entry`, `version`, `env`, `artifacts`,
  `digest`) sit beside the venv record (`stamp`, `extras`, `environment`, `resolved_lock`), told apart by
  `"entry" in fact` (`lock.py:169`, `lock.py:205-208`).
- **The venv record has a legacy location.** It is read from the per-install file, with a fallback to the
  store file at four sites.
- **`pm/install.py` (983 lines) mixes both engines.** Tool installs are at `install.py:31-591` and `853-983`;
  venv sync is at `install.py:593-851`.

Move (proposed):

- `Venv` stops being a `Package`. Delete `StatePackage`, the four `isinstance` branches and the `"state"` tier.
- Split `pm/install.py` into `pm/tools.py` (store installs, PATH) and `pm/appenv.py` (venv sync).
- Replace the untyped fact dicts with two frozen records, `ToolFact` and `EnvSelection`. `EnvSelection` is
  PMC-01's `Selection`.
- Drop the store-file venv fallback after one migration.

Reference: attrs `define(frozen=True)` value objects (`.repos/attrs/src/attr/_next_gen.py:23`).

loc_delta: about -120.

Risk: shipped payload `facts.json` files are sealed and read-only, and they carry the old shape, so reading
must still accept it. `hermes_cli/doctor_platform.py:420` imports `pm.packages.Venv`.

Depends on: PMC-01.

### PMC-07: Install consent is a boolean threaded through every signature, plus ambient reads (medium, M, boundary)

Evidence: `pm/install.py:161-190`, `pm/client.py:57-71`, `pm/worker_operations.py:17`, `pm/operations.py:21-25`,
`pm/operations.py:292-293`, `pm/install.py:558`, `pm/install.py:680`, `pm/install.py:840`, `pm/workspace.py:321`,
`pm/runtime.py:156-158`.

Problem (today): the question "may PM download or build now?" is decided in 19 places
(`rg 'lazy_installs_allowed\(\)|_refuse_lazy\(' pm`). Each decision combines up to four inputs:

- a caller-supplied `explicit: bool` (128 mentions across pm/);
- a `repair` flag;
- the operation's `bootstrap` tier (`always|policy|state|never`);
- an ambient read of `security.allow_lazy_installs` through `hermes_cli.config`, inside the PM worker
  (`install.py:179-190`).

The client also forwards policy to the worker by setting `HERMES_DISABLE_LAZY_INSTALLS=1` in the child env
(`client.py:67`), so an env var serves as an internal IPC field. No single place tells a reader which
operations may download.

Move (proposed): use one `Consent` enum (`explicit`, `lazy_allowed`, `lazy_refused`, `repair`). The entry
point decides it once and it travels in the request. The entry point is the CLI or the `ensure_import`
caller, which already runs in the app process and can read config. The worker never reads config or env for
policy, and `Operation.bootstrap` folds into the same check.

Reference: `.repos/home-assistant-core/homeassistant/requirements.py:96-121` computes `pip_kwargs` once and
passes it down; `requirements.py:285-297` applies the `skip_pip_packages` policy in one place.

loc_delta: about -60. This also removes one internal instance of the gist's "new env var" bug class
(217 fix commits).

Risk: Docker and the hermetic test harness set `HERMES_DISABLE_LAZY_INSTALLS`; that stays an entry-point input.

Depends on: PMC-02.

### PMC-08: Package-definition marshalling across the worker seam has no production consumer (medium, S, kill)

Evidence: `pm/registry.py:69-157`, `pm/client.py:105`, `pm/worker.py:98`, `pm/__init__.py:37`.

Problem (today): every worker request serializes the module, qualname, file path and namespace-package paths
of each non-`pm.packages` `Package` class in the closure (`registry.py:69-103`). The worker re-imports them,
with a `spec_from_file_location` fallback and synthetic namespace modules (`registry.py:106-156`).

- No production code registers a `Package` outside `pm/packages.py` and `pm/security_packages.py`.
  `rg '\((Binary|Deb|State)?Package\)'` outside pm/ finds only tests and an unregistered
  `scripts/termux/stage_runtime_libs.py:54`.
- `pm.security_packages` is already a built-in module (`registry.py:17`), so its classes are marshalled on
  every request for nothing.
- The facade still exports `register` and `Package` publicly.

This is a plugin extension point with no consumer, which root AGENTS.md rejects as speculative
infrastructure.

Move (proposed): delete `package_definitions`, `load_package_definitions`, the `packages` request field and
the worker call, and stop exporting `register` from the facade. If plugin-defined packages are wanted later,
use entry-point discovery in the worker.

Reference: entry-point discovery, `.repos/jupyter_client/jupyter_client/provisioning/factory.py:164-170`.

loc_delta: -110.

Risk: `tests/pm/test_worker_registry.py`, `tests/pm/test_runtime_bootstrap_tls.py:140` and the fixtures that
register fake packages go. They test only this mechanism.

Depends on: [].

### PMC-09: Two HTTP client configurations, nested retries, and per-package scrapers split from their packages (medium, M, collapse)

Evidence: `pm/downloader.py:51-68`, `pm/store.py:174-191`, `pm/update.py:214-254`, `pm/network.py:62-85`,
`pm/downloader.py:331-344`, `pm/downloader.py:464-490`, `pm/update.py:335-351`, `pm/update.py:422-428`,
`pm/update.py:470-486`, `hermes_cli/web_routers/local_models.py:440-444`.

Problem (today; from `notes/02-sub-download.md`, spot-checked):

- **Two HTTP setups.** PM fetches over two urllib openers. They differ in redirect policy (https-only vs
  header-stripping that still follows https→http), TLS setup and User-Agent. `store.hash_url` imports the
  downloader's private `_OPENER`/`_UA`.
- **Hard-coded timeouts.** Each call site has its own literal: 60, 120, 600, 60 and 60 seconds.
- **Nested retries.** The ranged fetch downgrades inside `retry_network`, which runs inside a per-mirror
  loop, and each source is probed twice.
- **Three Windows file-hold retry loops** use three schedules (`downloader.py:193`, `store.py:418`,
  `install.py:242`).
- **Scrapers live apart from their packages.** The single-consumer upstream scrapers in `pm/update.py`
  (node, martin-riedl, btbn, pbs, llama) sit away from the `Package.latest_versions` they serve. GitHub
  pagination is copied three times.
- **Model downloads skip hashing.** `Download` is also the dashboard's LLM model downloader, and it is used
  there without a sha256 (`local_models.py:440-444`).

Move (proposed):

- Add one stdlib client object in `pm/http.py`: one opener, https-only redirects, truststore, one UA, a
  `Timeout` value and one retry policy with jitter. The downloader, `hash_url` and the update scrapers all
  use it.
- Use one `replace_with_retry` helper for Windows file holds.
- Move the single-consumer scrapers onto their `Package` classes.
- Use one GitHub pagination helper.
- Keep the range/resume core.

Reference: `.repos/httpx/httpx/_client.py:594` (one long-lived `Client`), `.repos/httpx/httpx/_config.py:72`
(a `Timeout` object), `.repos/stamina/src/stamina/_core.py:119` (`retry_context` with a typed `on=`). pm must
stay stdlib-only, so copy the shape, not the dependency.

loc_delta: about -120 (the child estimated 100-190).

Risk: mirror fallback and pause semantics must survive, and so must the handling of Windows antivirus file
holds.

Depends on: [].

### PMC-10: Build and CI operations ship in the runtime facade and route through the per-call worker (medium, M, restructure)

Evidence: `pm/__init__.py:28-33`, `pm/worker_operations.py:26-38`, `pm/build_env.py:64-101`, `pm/cli.py:853-858`,
`pm/runtime.py:271-274`, `pm/client.py:304-312`.

Problem (today): of the 15 worker operations, 11 have no in-scope runtime caller: `build_environment`,
`lock_project`, `stage_manager_runtime`, `ensure_environment`, `ensure_project_environment`,
`check_project_lock`, `export_requirements`, `build_requirements_environment`, `prepare_tools`, `stage_tools`
and `prune_cache`. Their callers are `scripts/bundles/*`, `scripts/termux/*`, `scripts/ci/*`, the Dockerfile,
`pm/build_env.py` and `pm/cli.py` (rg per name).

Four different mechanisms reach the PM runtime:

1. Re-exec of the whole CLI (`run_cli`, `cli.py:853-858`), which parses argv twice.
2. A worker process per call (`client._request`).
3. Direct calls when `is_runtime()` is true.
4. `stage_manager_runtime`, which always runs directly (`client.py:304-312`).

Move (proposed): adopt one rule: PM code runs inside the PM runtime.

- Command-line entry points (`pm.cli`, `pm.build_env`) re-exec into it once, through `run_cli`.
- Only the small runtime API that app code uses goes through the worker: `ensure`, `sync_venv`,
  `venv_is_current`, `ensure_python_tool` and `ensure_import`.
- Build operations move to `pm/build/` and leave both the facade and the worker table.

Reference: `.repos/llm/llm/cli.py:3321-3336`. simonw's `llm install` is one in-process `run_module("pip")`
call, the minimum shape of "the CLI owns the install".

loc_delta: about -150 (wrappers and table rows; overlaps PMC-02).

Risk: `scripts/` callers import `pm.build_environment` and similar names from the facade; they switch to
`pm.build`.

Depends on: PMC-02.

### PMC-11: Receipts are ambient ContextVar state with cross-process correlation glue (medium, M, restructure)

Evidence: `pm/receipt.py:54-74`, `pm/receipt.py:104-117`, `pm/receipt.py:158-166`, `pm/receipt.py:186-193`,
`pm/client.py:41-46`, `pm/client.py:166`, `pm/worker.py:96`, `pm/worker.py:120`, `pm/install.py:811-850`.

Problem (today): a sync's record is spread across several mechanisms:

- four ContextVars, updated with copy-on-write deep copies;
- a correlation id pulled from `hermes_cli.update_receipt`;
- a worker-side context, plus a client-side `accept_worker_receipt` step that re-files the result.

`record_*` calls are scattered across `install.py`, `client.py` and `plugin_eviction.py`, and a 35-line
module docstring explains the hazards. The plugin update cadence also writes into PM receipts
(`record_plugin_checks`, `receipt.py:186-193`).

Move (proposed):

- `sync_venv` creates a `Receipt` object, passes it explicitly to the helpers that record, and returns it.
  The worker already returns it in its response.
- The update flow attaches the returned receipt to its own.
- `record_plugin_checks` moves to the plugin cadence's own receipt.

Reference: home-assistant's `RequirementsManager` keeps install history as explicit instance state
(`.repos/home-assistant-core/homeassistant/requirements.py:126-137`).

loc_delta: about -100.

Risk: the updater embeds sync sections by correlation id; that contract becomes a return value.

Depends on: PMC-02.

### PMC-12: No narrow public API, and the import bans are stale and routed around (medium, S, boundary)

Evidence: `pyproject.toml:902-908`, `pm/workspace.py:33`, `hermes_cli/plugins_admission.py:76`,
`hermes_cli/memory_setup.py:59`, `pm/client.py:20`, `pm/store.py:174`, `pm/__init__.py:22-39`.

Problem (today):

- Consumers import 25 pm submodules directly (176 imports), on top of the 42-name facade.
- TID251 bans `pm.uv`, `pm.client.uv` and `pm.install.uv`, none of which exist, plus `pm._uv`,
  `pm.environment` and `pm.runtime_stage`.
- The `pm.environment` ban is bypassed by a re-export in `pm/workspace.py:33`, which
  `hermes_cli/plugins_admission.py:76` consumes.
- Private names cross module and package lines: `_is_member_candidate`, `_refuse_lazy`,
  `downloader._OPENER` and `update._get_json`.

Move (proposed): the public surface becomes the facade (runtime API) plus `pm.environments` (boot). Replace
the six TID251 entries with one import-linter "forbidden" contract: outside `pm/`, import only `pm` and
`pm.environments`. Delete the `workspace.py:33` re-export.

Reference: none in the reference set matches this exactly; attrs keeps `src/attrs/__init__.py` as its only
public surface over `attr._make` internals.

loc_delta: about -10, plus import rewrites in ~50 files.

Risk: low; the import changes are mechanical.

Depends on: [].

## Kill list

| target | why | importers/callers | evidence |
|---|---|---|---|
| `pm/registry.py::package_definitions`, `::load_package_definitions` | marshals external Package classes; none exist in production | 1 (`pm/client.py:105`), 1 (`pm/worker.py:98`) | PMC-08 |
| `pm/worker_operations.py` | string routing table restating function names | 2 (`pm/client.py:16`, `pm/worker.py:69`) | PMC-02 |
| `pm/client.py` wrappers `build_environment` … `prune_cache` | 11 signature copies of the implementations | facade only | `pm/client.py:273-421` |
| `pm/paths.py` | delegates to `pm/environments.py`; replaced by `Install` | 17 imports outside pm | PMC-03 |
| `pm/package.py::StatePackage` + 4 `isinstance` branches | app venv is not a package | `pm/packages.py:351` | PMC-06 |
| `pm/workspace.py:33` re-export of `ResolutionConflict`, `classify_uv_failure` | bypasses the TID251 ban; nothing imports `classify_uv_failure` through this path | 2 | PMC-12, `notes/02-sub-uv-cli.md` §7 |
| `pm/store.py::Store.fetch` | only tests call it; production uses `fetch_many` | 0 non-test | `notes/02-sub-download.md` §6 |
| TID251 entries `pm.uv`, `pm.client.uv`, `pm.install.uv` | they name modules/attributes that do not exist | 0 | `pyproject.toml:903-905` |
| `pm/install.py` store-file venv fallback (`_facts().get("venv")`) | legacy record location, read at 4 sites | 4 | PMC-06 |
| `HERMES_DISABLE_LAZY_INSTALLS` as client→worker IPC (`client.py:67`) | env var used as an internal message field | 1 | PMC-07 |

## Simplify list

| what N things | become what 1 thing | lines saved | evidence |
|---|---|---|---|
| app-venv, PM-runtime, side-env generation stores (3 records, 3 locks, 2 collectors) | `pm/generations.py::Generations` | ~250 | PMC-01 |
| `client.py` wrappers + `worker_operations.py` + `worker.py` per-op branches | `@operation` registry + one proxy | ~300 | PMC-02 |
| `pm/paths.py` + layout half of `pm/environments.py` + 6 `manifest.json` probes | `Install` frozen value | ~150 | PMC-03 |
| `Facts` two shapes in two files | `ToolFact` + `EnvSelection` records | ~120 | PMC-06 |
| 19 consent decision sites + 4 bootstrap tiers + env IPC | `Consent` decided at entry | ~60 | PMC-07 |
| 2 urllib openers, 3 GH pagination loops, 3 Windows-hold retries | `pm/http.py` client + one retry helper | ~120 | PMC-09 |
| 3 ways into the PM runtime (re-exec, per-call worker, direct) + always-direct bootstrap op | re-exec for CLIs, worker for 5 runtime ops | ~150 | PMC-10 |
| 4 ContextVars + correlation glue | explicit `Receipt` object | ~100 | PMC-11 |

## Reference patterns to copy

| repo | path | pattern | where it applies here |
|---|---|---|---|
| attrs | `src/attr/_next_gen.py:431` | `frozen` value classes | `Install`, `Selection`, `ToolFact` (PMC-01/03/06) |
| attrs | `src/attr/_make.py:589` | `evolve` for derived values | `Install` for a borrowed home (PMC-03) |
| jupyter_client | `jupyter_client/session.py:651-700` | one typed message envelope for every request | worker protocol (PMC-02) |
| jupyter_client | `jupyter_client/provisioning/factory.py:164-170` | entry-point discovery | if plugin-defined packages are ever needed (PMC-08) |
| home-assistant-core | `homeassistant/requirements.py:96-137` | install manager with config passed in, explicit failure history | consent + receipts (PMC-04/07/11) |
| httpx | `httpx/_client.py:594`, `httpx/_config.py:72` | one client, typed timeout | `pm/http.py` shape (PMC-09) |
| stamina | `src/stamina/_core.py:119` | one retry context with typed `on=` | network + Windows-hold retries (PMC-09) |
| llm | `llm/cli.py:3321-3336` | install = one call in the CLI | lower bound for PMC-10 |

## Answer to the seam question

pm/ is not one package manager with one model. It has a good core: a pinned, hash-verified tool store
(`Lockfile`, `Store`, `Facts`, `Download`) and a single clean uv engine (`PythonEnvironment`). Around that
core sit four layers. Each solves a real problem, but each carries its own copy of the same idea:

- three generation stores (PMC-01);
- a hand-mirrored IPC layer with two code paths per operation (PMC-02, PMC-10);
- a plugin-config transaction system that belongs to the plugin layer (PMC-05);
- a path model rediscovered per call and patched at runtime (PMC-03).

The public API is wide: 42 facade names, plus 25 submodules imported directly. The names overlap too:

- "environment" names four modules: `environment.py`, `environments.py`, `environments_adopt.py` and
  `operations.py`;
- "operations" names three: `operations.py`, `build_operations.py` and `worker_operations.py`;
- the plugin logic is spread over five files: `plugin_inputs.py`, `plugin_declarations.py`,
  `plugin_eviction.py`, `plugins_state.py` and `publication.py`.

A simonw/hynek-quality version would have:

- one `Install` value;
- one `Store` of pinned tools;
- one `Generations` primitive, used by the app venv, PM's runtime and side environments;
- one `@operation` registry, reached through one transport;
- a 6-name runtime facade: `ensure`, `ensure_import`, `sync_venv`, `venv_is_current`, `ensure_python_tool`,
  `env_for`;
- `pm.environments` for boot;
- `pm.build` for CI.

Plugin config edits would arrive as opaque bytes, committed together with a selection.

What can be deleted:

- the definition marshalling (PMC-08);
- the client wrappers and the routing table (PMC-02);
- `pm/paths.py` and `StatePackage`;
- the legacy facts fallback;
- the stale bans.

The estimated total is about -1,300 lines in pm/ before test changes.

## Cross-seam notes

- 03-pm-flows: the PM half of boot and update lives in hermes_cli: `hermes_cli/venv_sync.py` (626), `_early_recovery.py` (684), `boot_bootstrap.py` (247) and `update_completion.py` (313). Publication recovery is in `hermes_cli/runtime_state.py:94-136`. `hermes_cli/venv_sync.py:139-145` duplicates the GC in `pm/cli.py:518-523`.
- 11-plugins: `pm/plugins_state.py:64-79` re-implements enabled/disabled semantics separately from `hermes_cli/plugins_discovery.py:112-122`. PM also adds `memory.provider` to the plugin union (`pm/plugins_state.py:124-160`).
- 07-config: PM writes user `config.yaml` with a ruamel round-trip outside the config system (`pm/publication.py:76-101`, `pm/plugin_eviction.py:90-125`).
- 12-cli: `hermes pm` skips argparse registration in `hermes_cli/main.py:677-680`; it sniffs argv (`sys.argv[1:2] == ["pm"]`).
- 09-concurrency: these spawns have no overall timeout (`notes/02-sub-uv-cli.md` §2): the worker Popen at `pm/client.py:116-178`, `run_cli` at `pm/runtime.py:272`, and the PowerShell spawn in `pm/native_build.py`.
- 14-errors-obs: `pm/extras.py:158-160` and `pm/extras.py:174-177` turn any marker-evaluation failure into "supported". `pm/install.py:189-190` turns any config error into "lazy installs refused".
- 01-layout: `pm/cli.py:766` imports `scripts.bundles.native`, so a runtime package imports from the out-of-scope build script tree.
- 06-tools: `pm/packages.py:894` imports `tools.computer_use.cua_backend`. `pm/security_packages.py:101,116` import `tools.tirith_security` and `agent.proxy_sources.iron_proxy`.
- 10-gateway/dashboard: `hermes_cli/web_routers/local_models.py:440-444` uses `pm.downloader.Download` for model files with no sha256.

## UNVERIFIED

- That side environments are never collected. The claim rests on `rg 'gen-\[|glob\("gen'` over the repo, which found only the validator at `pm/operations.py:141`. A collector reached through a name I did not search would refute it. Verify with `rg -n "environments|gen-" scripts hermes_cli pm`.
- Whether any pm-only bootstrap stage (Dockerfile `COPY pm/` + `hermes_constants.py`) actually reaches a `hermes_cli` import at runtime. Verify by running `python -I -m pm.cli install` from a tree that contains only those two paths.
- Which TLS trust store `pm/downloader.py` uses when PM runs standalone (child note §1).
- The `loc_delta` figures. They are estimates from function spans (`scripts/outline.py`), not from a prototype.
- Which `hermes_cli.runtime_state` names an in-flight old updater imports. `tests/compat/old_updater_surface.json:693,873` pins the file path, not the names. The names come from the comment at `hermes_cli/runtime_state.py:18-20`.
- How many PM fix commits a single `Generations` primitive would have prevented. I did not classify the commits one by one.
