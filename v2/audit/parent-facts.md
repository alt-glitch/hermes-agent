# Parent-verified facts and decisions (read before your seam)

Verified by the parent on `origin/main` = `ea81748579`, 2026-10-04. Do not re-derive these.

## Decisions already made (do not reopen)

- Tests, `scripts/`, `evals/`, `environments/`, `tinker-atropos/`, `skills/`, `optional-skills/`,
  `apps/desktop/`, website/docs are out of scope (Sid). Tests must still pass after any change we
  propose, so a move that breaks test seams must say so in `risk`.
- Python standards are the bar. Reference taste: simonw (llm, sqlite-utils, datasette), hynek
  (attrs, structlog, svcs, stamina), httpx, textual; lifecycle/concurrency: home-assistant core,
  pydantic-ai, cpython logging/futures/taskgroups, anyio, trio, blinker; plugins: pluggy,
  inspect_ai, jupyter_client; config: pydantic-settings.
- `pm/` gets two seams (02, 03). Sid called it extremely important.

## Facts

1. **Size.** In-scope Python is ~804k lines in 1,968 files (`inputs/metrics/areas.json`).
   `hermes_cli/` alone is 260k lines / 644 files. 48 in-scope files exceed 2,000 lines; 154
   exceed 1,000. 105 functions have CC > 20.
2. **Function-level imports: 14,018** across the in-scope tree (5,776 in `hermes_cli/`). The
   cross-package import matrix in `SUMMARY.md` shows lazy edges in both directions between
   most package pairs (agent↔hermes_cli, agent↔tools, tools↔hermes_cli, gateway↔hermes_cli).
   The package layering stated in AGENTS.md is not reflected in the import graph.
3. **Broad excepts: 8,014** (`except Exception|BaseException|bare`); 836 have a body of only
   `pass`/`continue`; 1,883 only `return`. ruff BLE001 alone: 6,960.
4. **Module-level mutable globals: 748** (dict/list/set/Lock assigned at module scope with a
   non-CAPS name). 406 `global` statements. 247 raw `threading.Thread(...)` constructions.
5. **tui_gateway globals rebinding.** `tui_gateway/method_ctx.py::bind_module`
   (`tui_gateway/method_ctx.py:78`) copies every function defined in a `methods_*.py` sibling
   onto `server.py`'s module dict and rebinds its `__globals__` to `server.py`'s globals. The
   siblings therefore use `_ok`, `_err`, `_sessions`, `logger`, even `os`, as bare names they
   never import. ruff reports 2,979 F821 "undefined name" in the in-scope tree; ~2,700 are in
   `tui_gateway/methods_*.py`. Docstring at `tui_gateway/methods_session.py:1-5` states this is
   intentional (so tests can monkeypatch `server.X`).
6. **Packaging ships every root `.py` as a top-level module.** `setup.py:87-99`
   (`_root_py_modules`) lists `os.listdir(<repo root>)` at build time and passes all `*.py`
   except `setup.py` as `py_modules`. Installed wheels therefore contain top-level modules
   named `cli`, `utils`, `toolsets`, `run_agent`, `model_tools`, 33 `hermes_state*`, plus the
   off-path `batch_runner`, `mini_swe_runner`, `trajectory_compressor`,
   `toolset_distributions`, `hermes_constants_scratch`. It also ships any untracked `.py`
   lying in a dev checkout root.
7. **Entry points** (`pyproject.toml:566-569`): `hermes = hermes_cli.main:main`,
   `hermes-agent = agent.legacy_cli:main`, `hermes-acp = acp_adapter.entry:main`.
8. **Ruff config** selects only `PLW1514, ASYNC210/220/221/251, TID251`
   (`pyproject.toml:900`). TID251 bans importing PM internals (`pm.uv`, `pm.environment`,
   ...) outside `pm/` (`pyproject.toml:902-908`).
9. **AGENTS.md sizes:** root 38.4k chars (over the 32k loader cap; truncated every session),
   `hermes_cli/` 24k, `gateway/` 21k, `tools/` 13k, `plugins/` 13k, `cron/` 12k.
10. **Untracked in this checkout, absent on main:** `environments/`, `tinker-atropos/`,
    `mini-swe-agent/`, `hermes/`, `docs/`. Tracked off-path root modules: `batch_runner.py`
    (1,018), `trajectory_compressor.py` (869), `mini_swe_runner.py` (406),
    `toolset_distributions.py`, `hermes_constants_scratch.py` (198).
11. **The facade + siblings decomposition** (root AGENTS.md § "Facade + siblings layout")
    split former god files into `<stem>_<topic>.py` siblings that late-import the facade.
    `hermes_state.py` has 32 siblings at repo root. Evaluate whether this produced modules
    (cohesive units with a narrow interface) or a god file spread over many files
    (siblings reaching back into the facade's namespace). That question is in several seams.

## The gist (maintainer's ratchet plan) in one paragraph

`inputs/gist/0-plan.md`: one ratchet engine (`scripts/ci/code_health.py`) with per-function and
per-file caps that only go down; Phase 1 rules: CC ≤ 20, file ≤ 2,000 lines, swallowed excepts,
profile-scope patterns, hang/timeout lint, F821/F841; later phases: test hygiene, dead code,
duplication, deps, ty per file, import-linter layering, prompt-prefix stability, PR-shape gates.
Bug-class evidence from 22k fix commits: windows 645, profile-scope leak 366, race/TOCTOU 245,
new env var 217, secret leak 145, encoding 144, sqlite locking 131, hangs 119, blocking in
async 117, swallowed exceptions 106, missing timeout 85.
