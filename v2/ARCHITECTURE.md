# v2 architecture: where Hermes is, where it should be, and how to get there

Draft. The current-state half is evidence from the code-health audit (`v2/audit/`, anchored at
`ea81748579`) and from the trace lab. The end-state half is a proposal that v2 experiments are meant
to test and change. Rules referenced as `PY-NN` are in `v2/PRINCIPLES.md`.

## 1. How to grasp the codebase (reading order)

1. `v2/audit/hermes-agent-code-health-map.html`: the overview diagram, the area map and the flow
   debugger (six real request paths, step by step with `file:line`).
2. Trace a few things you actually do (`v2/lab/README.md`) and read the report: which packages each
   command enters, in what order, and which modules nothing you did has touched.
3. The audit report for the area you are about to change (`v2/audit/reports/NN-*.md`), which ends with
   a "how it works end to end" section and the area's kill list.

## 2. Current architecture

**What gets installed.** One wheel installs 11 packages (`agent`, `tools`, `hermes_cli`, `gateway`,
`tui_gateway`, `cron`, `plugins`, `pm`, `acp_adapter`, `providers`, `hermes_platform`) plus every
loose root module as a top-level name (`setup.py:87` `_root_py_modules`; 52 root `.py` files today,
including 33 `hermes_state*` modules and the RL/datagen runners). Three console scripts:
`hermes = hermes_cli.main:main`, `hermes-agent = agent.legacy_cli:main`,
`hermes-acp = acp_adapter.entry:main`.

**How a command starts (observed on Sid's install).** `hermes` is `~/.local/bin/hermes` (a bash shim
that unsets inherited Python variables) → `~/.hermes/hermes-agent/venv/bin/hermes` (console script on
a 3.11 venv) → `hermes_cli.main` → `hermes_bootstrap` (puts the tree on `sys.path`, activates PM's
dependency generation) → `hermes_cli/venv_sync.py:338 prepare_launch` may `os.execv` into PM's managed
3.14 runtime with `-I -c "import sys, runpy; sys.path.insert(0, ...); ..."`
(`venv_sync.py:572 relaunch_command`). A second launcher, `.hermes/bin/hermes`, runs that 3.14 `-I -c`
program directly. So the same tree runs under two interpreters depending on which `hermes` is first on
`PATH`, and four layers of launch code decide it.

**How a request runs.** Six surfaces (CLI REPL, TUI via `tui_gateway`, messaging gateway, cron,
dashboard, ACP) each build an `AIAgent` (`run_agent.py`) with their own callbacks and slash handling.
`AIAgent` is a flat object with 371 attributes written from 57 files (AGT-01). One turn is
`agent/conversation_loop.py` driving the `agent/turn_*.py` phases; tool calls go through
`agent/tool_executor.py`; the model wire is chosen by `api_mode` string comparisons (102 sites, PRV-01);
side tasks use `agent/auxiliary_client.py`, an 8,407-line second provider stack (PRV-02); sessions are
written to SQLite through `SessionDB`, 15 mixins over 33 root modules (STA-02).

**What holds it together.** Configuration is a dict described by `DEFAULT_CONFIG` plus side tables
(CFG-02); profile scope is 6 ContextVars, 3 globals and `os.environ` (CFG-01); `hermes_cli` is the de
facto core library that everything imports (LAY-02, CLI-06: 23% of it is CLI); 16 of 17 package groups
are one import cycle, kept importable by 14,121 function-level imports (LAY-01, PY-07); threads,
event loops and shutdown have no owner (CON-01/02).

**Questions the audit did not ask, and v2 should.** Why `hermes_constants.py` (1,411 lines),
`hermes_constants_scratch.py`, `hermes_logging.py`, `hermes_time.py`, `hermes_yaml.py` (a 98-line YAML
1.1 policy over ruamel, not a parser) and `hermes_bootstrap.py` are six root modules instead of one core
package. Why `AIAgent(` is constructed at 62 call sites outside tests (most in `evals/`, but also
`cron/scheduler.py`, `acp_adapter/session.py`, `agent/curator.py`, `agent/background_review.py`, …)
instead of through one factory. What a toolset is as a product concept, and who decides which ones a
session gets. Which of the 16 SQLite databases and 30+ JSON state files (STA) a user's session actually
needs. What each `*queue.py` module (`agent/review_idle_queue.py`, `cron/delivery_queue.py`,
`gateway/run_delivery_queue_watch.py`, a WeCom send queue) is for and whether they share a primitive.

## 3. End state (proposal)

One distribution, one package, five layers. A layer imports only layers below it (import-linter
`layers` contract, PY-10). Each package exports its public API from `__init__.py` (PY-12).

```
src/hermes/
  _base/      L0  paths, platform facts, time, YAML policy, logging setup. Imports nothing from hermes.
  core/       L1  HermesSettings (typed config), ProfileScope (home, settings, secrets, terminal policy),
                  errors (one exception hierarchy), lifecycle (staged shutdown, owned threads/tasks)
  state/      L2  one SQLite connection factory + one write-transaction helper; the session store
  models/     L2  Model interface, one class per wire format, a resolver that returns a typed route,
                  fallback as a Model that wraps Models
  runtime/    L3  agent (turn loop over typed turn state), tools (Tool + Toolset + one dispatcher),
                  skills, delegation (subagents)
  commands/   L4  one registry: CLI subcommands and slash commands declared once, rendered per surface
  surfaces/   L4  cli, tui (JSON-RPC server), gateway (+ one typed adapter contract), acp, cron, dashboard
  plugins/    L5  bundled plugins, written only against public hookspecs
  __main__.py     the launcher: the only code allowed to touch sys.path, write os.environ or call os._exit
```

`pm/` stays a separate tool and is out of scope for the first vectors (it is already being reworked).

## 4. Restructure or rewrite?

Restructure first, then rewrite vector by vector.

1. **Restructure (mechanical, behaviour-preserving).** A codemod moves every module to its layer under
   `src/hermes/`, rewrites imports, and deletes the root-module install list. No logic changes. After it,
   the layer contract can be written down, and every cycle becomes a named, countable import-linter
   violation (1,135 today) instead of a hidden function-level import.
2. **Rewrite per vector.** Each vector introduces one missing abstraction in its layer, converts every
   caller, and deletes the duplicates in the same change. No compatibility shims (v2 rule).
3. **Not a ground-up rewrite.** Rewriting before restructuring means designing new modules with no
   agreed place to put them and re-deriving 800k lines of behaviour without the trace lab's evidence of
   what actually runs.

The restructure alone fixes nothing about the cycles or the god objects. It makes them visible and
gives every later rewrite a destination.

## 5. Attack vectors

Each vector is a pattern applied across the whole repo, with a guideline (a `PY-NN` rule), a codemod
where the change is mechanical, and the code converted end to end. Ordered by what each one unlocks.

| # | Vector | Introduces | Deletes or collapses | Audit |
|---|---|---|---|---|
| V0 | Package restructure | `src/hermes/<layer>/`, import-linter contract | 48 root modules, root-module install list, `sys.path` edits (PY-06/08/10) | LAY-01/02/08 |
| V1 | Startup and core | `_base` + `core`, one `bootstrap()`, one launcher | the six root core modules, two-interpreter launch chain | LAY-03, KIL-08/12 |
| V2 | Settings and profile | `HermesSettings`, `ProfileScope` | dict config + side tables, 9 scope channels, 7 binders, env-as-config (PY-13/16) | CFG-01/02/03 |
| V3 | Agent construction and turn state | one agent factory; typed `TurnState`/`SessionState`/… | 62 `AIAgent(` call sites' bespoke wiring, 371-attribute flat object | AGT-01/03/04 |
| V4 | Model interface | `Model` + one class per wire format + typed route | `api_mode` ladders, the auxiliary second stack | PRV-01/02/04 |
| V5 | Tools and toolsets as a product | `Tool`, `Toolset`, one dispatcher, one source precedence | 7 tool sources with 2 orders, toolset tables that miss tools | TLS-01/03/04 |
| V6 | Commands | one command registry rendered by each surface | ~26 slash-name lists, `/help` × 4, the TUI's shadow CLI | CLI-01/02 |
| V7 | Lifecycle | owned threads/tasks, staged shutdown | 246 bare threads, per-runtime teardown lists, `os._exit` (PY-14/15) | CON-01/02/06 |
| V8 | Errors, retries, HTTP | exception hierarchy, one retry primitive, configured clients | string classifiers, ~95 retry loops, 101 client constructions (PY-17/18/20/21) | ERR-01/03/08 |
| V9 | Storage | one connection factory + write helper | 3 disagreeing write helpers, per-store SQLite machinery | STA-01/05 |
| VK | Kill list | — | RL/datagen root runners, vendor plugins in tree, verified dead code | KIL-07/10, PLG-07 |

The 80/20: V0 and V1 change where everything lives; V2 removes the largest bug class in the history
(366 profile-scope fix commits); V3 + V4 + V5 are the agent core a user's session runs through.
