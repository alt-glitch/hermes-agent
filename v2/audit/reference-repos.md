# Reference repos (read-only, shallow clones)

Root: `/Users/sid/main-quests/nous-research/hermes-agent/.repos/` (gitignored). Cite as
`.repos/<name>/<path>:<line>` and give the SHA prefix once per report. Never install or execute
anything from these trees; read source only.

| name | SHA | use it for | start at |
|---|---|---|---|
| llm | 764dc38 | taste: small core, pluggy plugins, model registry, click CLI, dataclass-ish models | `llm/plugins.py`, `llm/hookspecs.py`, `llm/models.py`, `llm/cli.py`, `llm/default_plugins/` |
| sqlite-utils | 6bc1d33 | taste: SQLite access layer, one `Database`/`Table` object, migrations-free schema ops | `sqlite_utils/db.py`, `sqlite_utils/cli.py` |
| datasette | cec5e6b | taste: pluggy hookspecs for a server app, app object owning lifecycle, internal DB | `datasette/app.py`, `datasette/plugins.py`, `datasette/hookspecs.py` |
| attrs | a602f78 | typed value objects, frozen classes, validators, `evolve` | `src/attrs/__init__.py`, `src/attr/_make.py` |
| structlog | 91f44ae | logging: processors pipeline, bound context, contextvars, configure-once | `src/structlog/_config.py`, `src/structlog/contextvars.py`, `src/structlog/processors.py` |
| svcs | 5d93cbc | service locator / DI instead of module globals; per-request containers; health pings | `src/svcs/_core.py` |
| stamina | 7836f46 | retries done once: decorator + context manager, typed `on=`, testing switch | `src/stamina/_core.py` |
| httpx | b5addb6 | one long-lived client, transports, timeouts as a typed object, event hooks | `httpx/_client.py`, `httpx/_config.py`, `httpx/_transports/` |
| textual | 06dbeef | message pump, workers (thread/async) with lifecycle, app-owned tasks | `src/textual/message_pump.py`, `src/textual/worker.py`, `src/textual/app.py` |
| pydantic-ai | c68786e | agent loop as an explicit graph, model adapters behind one `Model` ABC, toolsets, typed deps | `pydantic_ai_slim/pydantic_ai/_agent_graph.py`, `.../agent/`, `.../models/__init__.py`, `.../toolsets/`, `.../tools.py` |
| anyio | eef3a15 | structured concurrency (task groups, cancel scopes), `to_thread`, `from_thread` | `src/anyio/_core/_tasks.py`, `src/anyio/to_thread.py`, `src/anyio/from_thread.py` |
| trio | 8f6343f | nurseries, cancellation semantics, no orphan tasks | `src/trio/_core/_run.py` |
| blinker | c336405 | in-process signals/events, weak refs, named signals | `src/blinker/base.py` |
| pluggy | 7aa82ed | hookspecs/hookimpls, entry-point plugin loading, firstresult, wrappers | `src/pluggy/_manager.py`, `src/pluggy/_hooks.py`, `src/pluggy/_callers.py` |
| inspect_ai | 9f6accd | registry decorators, model providers, tool + agent loop, typed config, large-codebase layout | `src/inspect_ai/_util/registry.py`, `src/inspect_ai/model/_model.py`, `src/inspect_ai/model/_providers/`, `src/inspect_ai/tool/`, `src/inspect_ai/agent/` |
| jupyter_client | 978361b | entry-point provisioners, kernel/session lifecycle, JSON message protocol with typed headers | `jupyter_client/provisioning/factory.py`, `jupyter_client/session.py`, `jupyter_client/manager.py` |
| pydantic-settings | 5927b44 | config: typed settings model, ordered sources (init > env > dotenv > file), nested delimiters, secrets dir | `pydantic_settings/main.py`, `pydantic_settings/sources/` |
| cpython (sparse) | 9d22a53 | `Lib/logging/handlers.py` (QueueHandler/QueueListener), `Lib/concurrent/futures/thread.py` (executor shutdown/atexit), `Lib/asyncio/taskgroups.py` | those three files |
| home-assistant-core (sparse) | 0f3081e | big-app lifecycle: `hass` core object, event bus, config entries (setup/unload/reload state machine), integration loader, bootstrap stages, `async_create_task` tracking | `homeassistant/core.py`, `homeassistant/config_entries.py`, `homeassistant/loader.py`, `homeassistant/setup.py`, `homeassistant/bootstrap.py`, `homeassistant/helpers/` |

Sparse checkouts: cpython has only `Lib/logging`, `Lib/concurrent`, `Lib/asyncio`. home-assistant-core
has `homeassistant/*.py` plus `helpers/`, `util/`, `auth/`. Anything else is absent, not missing.
