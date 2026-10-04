# v2 principles: the idioms Hermes code should follow

These are the rules the v2 branch is built toward. Each one comes from a structural problem the
code-health audit found (`v2/audit/`), and each points to a reference project in `.repos/` that
follows it. Counts are from `v2/idioms/sweep.py` + `v2/idioms/ruff.sh` over the product tree
(1,958 files, 799,689 lines; tests, scripts, evals, skills, desktop and website excluded) at the
v2 branch point. `v2/idioms/SUMMARY.md` has the full table; `v2/idioms/hits/PY-NN.txt` (regenerated
by the sweep, not committed) has every location.

**Detect** says how a violation is found: *mechanical* (the sweep counts it), *proxy* (the sweep
counts a signal that needs a reader to confirm), or *judgment* (needs a reader; a subagent sweep).

## A. Language baseline

| ID | Idiom | Why | Reference | Detect | Today |
|---|---|---|---|---|---|
| PY-01 | `requires-python` states the runtime that actually ships. One floor, no per-dependency version markers. | `pyproject.toml` says `>=3.11,<3.15`, but all 45 dependencies carry `python_version >= '3.14'`, so a 3.11–3.13 install gets no dependencies. The metadata says one thing and the runtime another. | any of `.repos/*/pyproject.toml` | mechanical | 45/45 deps gated |
| PY-02 | No `from __future__ import annotations`. | 3.14 evaluates annotations lazily by default (PEP 649/749). The import is dead weight and changes `__annotations__` to strings for tools that introspect. | PEP 649, PEP 749 | mechanical | 1,414 of 1,958 files |
| PY-03 | Builtin generics and `X \| None`; nothing from `typing` that has a builtin or `collections.abc` form. | One spelling. `typing.Dict/List/Optional/Union` are aliases kept for old Pythons. | ruff `UP006/UP007/UP035/UP045` | mechanical | 27,821 |
| PY-04 | Modes are `Enum`s or `Literal` types, dispatched through a table or a class, never string ladders (`if x.api_mode == "codex_responses"`). | String ladders scatter one decision over many files (PRV-01: 102 `api_mode` comparisons in 28 files). | `.repos/pydantic-ai/.../models/__init__.py:454` (`Model`, one subclass per wire format) | proxy (`==` on `mode/api_mode/provider/kind/platform/transport/backend` attributes) | 514 |
| PY-05 | Boundaries carry typed values (frozen dataclass, attrs, pydantic model), not `dict[str, Any]`. | Untyped dicts move validation to every reader (CFG-02: `load_config()` called 496 times, guarded with `.get`). | `.repos/attrs/src/attr/_next_gen.py:431` (`frozen`), `.repos/pydantic-settings` | proxy (`dict[str, Any]` annotations) | 4,677 |
| PY-27 | Source compiles without warnings. | Invalid escape sequences become errors in a future Python. | — | mechanical | 1 (`pm/shell.py:13`) |

## B. Modules and layout

| ID | Idiom | Why | Reference | Detect | Today |
|---|---|---|---|---|---|
| PY-06 | One top-level package. No loose modules at the repository root. | 48 root modules (`run_agent.py`, `cli.py`, 33 `hermes_state*.py`, `hermes_constants.py` …) install as top-level names into every environment. | `.repos/httpx/httpx/` (one package) | mechanical | 48 |
| PY-07 | Imports at module top. A function-level import is allowed only for an optional dependency, and those are listed in one place. | 14,121 function-level imports exist mainly to hide the import cycle (LAY-01). They make the dependency graph invisible to tools and readers. | ruff `PLC0415` | mechanical | 14,121 |
| PY-08 | Only the launcher touches `sys.path`. | `sys.path.insert` in library modules (LAY-08) makes import resolution depend on which file ran first. | — | mechanical | 29 in 26 files |
| PY-09 | No import-time side effects in library modules: no I/O, threads, env writes, logging config or network at module scope. | Import order becomes behaviour. Tests and tools cannot import a module to inspect it. | `.repos/httpx`, `.repos/structlog` (configuration is an explicit call) | judgment | — |
| PY-10 | Packages are layered. A layer imports only layers below it, enforced by import-linter in CI. | Today 16 of 17 package groups form one import cycle (LAY-01); 1,135 import edges point upward against the five-layer contract in `v2/ARCHITECTURE.md`. | import-linter `layers` contract | mechanical (import-linter) | 1,135 upward edges |
| PY-11 | Files stay under 1,000 lines; functions under cyclomatic complexity 15. | Size and branching are where readers lose the thread. | ruff `C901` | mechanical | 154 files > 1k lines; 333 functions > C15 |
| PY-12 | Private modules and names start with `_`. Each package states its public API in `__init__.py` / `__all__`. Other packages import only that API. | Without it every module is public, so nothing can move. | `.repos/httpx/httpx/__init__.py:29` (`__all__`), `httpx/_client.py`, `structlog/_*.py` | judgment | — |

## C. State and lifecycle

| ID | Idiom | Why | Reference | Detect | Today |
|---|---|---|---|---|---|
| PY-13 | No mutable module globals for runtime state. State lives on objects passed explicitly. A `ContextVar` is allowed only behind one owner module. | Profile scope lives in 6 ContextVars + 3 globals + `os.environ`, set by 7 hand-written binders (CFG-01; 366 fix commits). | `.repos/svcs/src/svcs/_core.py:573` (`Container`), `.repos/structlog/src/structlog/contextvars.py:119` | mechanical (`global`) + judgment | 406 `global` statements |
| PY-14 | Every thread and task has an owner that stops and joins it. No fire-and-forget `daemon=True`. | 246 bare threads, 243 daemon, 126 never referenced again (CON-02). Shutdown cannot be reasoned about. | `.repos/cpython/Lib/asyncio/taskgroups.py:13`, `cpython/Lib/concurrent/futures/thread.py:254` (`shutdown(wait=True)`), `.repos/anyio` task groups | mechanical | 246 threads, 243 daemon |
| PY-15 | `os._exit` only in the entry point. Shutdown is staged and registered. | Each runtime hand-lists its teardown, then skips `atexit` with `os._exit` (CON-01). | `.repos/home-assistant-core/homeassistant/core.py:111-114` (named stages with timeouts) | mechanical | 11 |
| PY-16 | The environment is read at one boundary (settings) and never used to pass configuration between modules. | 940 env reads in 384 files and 173 env writes in 64 files: `os.environ` is a global config bus. | `.repos/pydantic-settings/pydantic_settings/main.py:330` (`settings_customise_sources`) | mechanical | 940 reads, 173 writes |

## D. Errors, logging, I/O

| ID | Idiom | Why | Reference | Detect | Today |
|---|---|---|---|---|---|
| PY-17 | No broad `except Exception` that swallows. Catch specific types; when a boundary must catch everything, log with `exc_info` and either re-raise or return a typed failure. | 8,018 broad handlers; 849 of them only `pass` or `continue`. | `.repos/httpx/httpx/_exceptions.py:74,107,123` (`HTTPError` → `RequestError` → `TransportError`) | mechanical (count) + judgment (which are boundaries) | 8,018 broad, 849 silent |
| PY-18 | Errors are typed. Nothing classifies a failure by searching `str(e)`. | 9+ substring classifiers with 5 vocabularies (ERR-01). | `.repos/httpx/httpx/_exceptions.py` | proxy (`"..." in str(x)`) + judgment | 31 direct sites (narrow proxy) |
| PY-19 | `logger = logging.getLogger(__name__)` per module, lazy `%`-formatting, no `print` outside the CLI's output layer. | Logs are the debugging surface for a long-running agent. | `.repos/cpython/Lib/logging/handlers.py:1493` (`QueueHandler`), `.repos/structlog` | mechanical (ruff `G004`, `T201`; CLI prints need a reader) | 4,905 |
| PY-20 | One retry primitive. No hand-written retry loops. | ~95 hand-rolled loops while `tenacity` is a core dependency with no importers (ERR-03). | `.repos/stamina/src/stamina/_core.py:119` (`retry_context`) | proxy (`for attempt in range`) | 79 |
| PY-21 | One configured HTTP client per concern, with explicit timeouts. Every subprocess and network call has a timeout. | 101 client constructions, 4 HTTP stacks (ERR-08); 3 `hermes update` git wrappers can hang (KIL-04). | `.repos/httpx/httpx/_config.py:72` (`Timeout`) | mechanical | 85 subprocess calls without `timeout`; 202 ad-hoc clients |
| PY-22 | `pathlib`, not `os.path`. | One path model. | ruff `PTH` | mechanical | 1,584 |

## E. Composition

| ID | Idiom | Why | Reference | Detect | Today |
|---|---|---|---|---|---|
| PY-23 | Composition over mixins. A class's collaborators are constructor arguments. | `HermesCLI` (17 mixins), `GatewayRunner` (18), `SessionDB` (15): the mixins share one namespace, so the split into files did not split the object (LAY-04, AGT-01). | `.repos/pydantic-ai/.../_agent_graph.py:342,428` (`GraphAgentState`, `GraphAgentDeps`) | mechanical | 107 `*Mixin` classes; 7 classes with ≥ 5 bases |
| PY-24 | One canonical helper per job. A re-implementation is a lint error, not a style choice. | ~53 atomic writers, 31 truthy parsers, ~17 PID-liveness checks, 24 git wrappers, ~17 `HERMES_HOME` resolutions (KIL-02…12). One copy re-implements the SSRF check without DNS resolution (KIL-06). | `.repos/sqlite-utils` (one `Database` owns connection policy) | judgment (sweep per helper, then a ratchet rule) | see `v2/audit/reports/15-kill.json` |
| PY-25 | Registries, not ladders and not parallel lists. A concept (tool, command, provider, platform) is declared once; everything else is derived. | ~26 hand-written slash-name lists restate `COMMAND_REGISTRY` and have drifted (CLI-02); 7 tool sources with 2 precedence orders (TLS-01). | `.repos/pluggy/src/pluggy/_decorators.py:30` (`HookspecMarker`), `.repos/llm/llm/hookspecs.py:8` | judgment | — |
| PY-26 | Production code is not shaped for monkeypatching. Dependencies are injected; tests replace a service, not a module attribute. | Facades re-export and siblings late-import "so tests can patch" (LAY-04, TUI-01). | `.repos/svcs/src/svcs/_core.py:279,375` (`register_factory`, `register_value`) | proxy (comments about patching) + judgment | 103 comments |

## Using this list

- **Mechanical idioms** become ratchet rules (the maintainer's gist engine): the count may only go down.
- **Judgment idioms** need readers. The plan is one subagent per idiom × area, each given this file,
  the hit list for its idiom (when there is one) and the reference file, and asked for: confirmed
  violations with `file:line`, the canonical replacement, and the codemod or hand-edit it needs.
- When a v2 experiment changes the shape of the code, re-run the sweep and record the delta in the
  experiment's notes.
