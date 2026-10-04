# Parent verification of load-bearing reader claims

Checked by the parent on `origin/main` `ea81748579`, 2026-10-04, by opening the cited lines or
re-running the search. "confirmed" = the cited code says what the report says. "premise
confirmed" = the code supports the reasoning, but the proposed fix's effect still needs a run.

| finding | claim | how checked | verdict |
|---|---|---|---|
| LAY-02 | `hermes_cli.config` has ~836 import sites and imports `agent.secret_scope` back | `rg -c 'from hermes_cli\.config import\|import hermes_cli\.config\|from hermes_cli import config'` over in-scope code: 877 matches in 437 files; `hermes_cli/config.py:1589` late-imports `agent.secret_scope` | confirmed |
| LAY-08 | library modules insert the repo root into `sys.path` at import time | module-level inserts at `cron/scheduler.py:36`, `pm/launch.py:7`, `gateway/platforms/base.py:424`, `plugins/platforms/whatsapp/adapter.py:208`, `plugins/platforms/slack/adapter.py:34`, `plugins/platforms/raft/adapter.py:37` | confirmed |
| AGT-09 | `_cached_system_prompt` is written at 13 sites in 9 files, including gateway and TUI | `rg '_cached_system_prompt\s*=[^=]'`: 13 hits in agent/{conversation_compression,background_review,chat_completion_helpers,agent_runtime_helpers,conversation_loop,system_prompt}.py, gateway/run.py, tui_gateway/{server,synthetic_turn}.py | confirmed |
| PRV-02 | the main agent builds its client through `auxiliary_client` | `agent/agent_init.py:853-854` imports and calls `resolve_provider_client` | confirmed |
| PRV-09 | `auxiliary_is_nous` is read only by `get_auxiliary_extra_body`, which no production code calls | `rg 'auxiliary_is_nous\|get_auxiliary_extra_body'` outside tests: writes at `auxiliary_client.py:954,2428,2431,4702`, one read at `:5763` inside the function defined at `:5761`, no callers | confirmed |
| TLS-03 | browser tools register under pseudo-toolsets | `tools/browser_cdp_tool.py:398` and `tools/browser_dialog_tool.py:103` use `toolset="browser-cdp"`, `tools/browser_use_cli.py:830` uses `"browser-use"`; neither key is in the `TOOLSETS` list in `tools/AGENTS.md` | confirmed |
| TLS-07 | the registry inspects the caller's stack frame | `tools/registry.py:662` `sys._getframe(2).f_globals` | confirmed |
| CFG-03 | the classic CLI defaults to 500 turns; the shared default is unlimited | `hermes_cli/cli_config_load.py:201` `"max_turns": 500` vs `hermes_cli/config_defaults.py:78` `"max_turns": None`; `hermes_cli/cli_init_mixin.py:206` takes the CLI value first | confirmed statically (no run) |
| PMF-01 | PM syncs and the updater both replace the same `latest.json` | `pm/receipt.py:129` and `hermes_cli/update_receipt.py:198` both resolve `<home>/logs/update_receipts`; `pm/receipt.py:311` and `hermes_cli/update_receipt.py:345` both write `latest.json` | confirmed |
| STA-01 | the WAL-guard stack exists because 3.11 cannot arm `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE`, and 3.11 is not a runtime | commit `75e155ab09` body lines 16-17 ("Works on Python 3.11 (where sqlite3 cannot arm SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE)"); `pyproject.toml:608-610` ("3.11 is an install bridge ... never a runtime") | premise confirmed; the fix needs a two-process repro on 3.14 before deletion |
| GWY-01 | runner and adapter reach into each other's private state | `gateway/run_busy.py:382` `getattr(adapter, "_pending_messages")`; `gateway/platforms/base.py:4147` `getattr(self, "gateway_runner")` | confirmed |
| TUI-01 | `bind_module` rebinds ~45 sibling modules | `rg -l 'bind_module\('` in `tui_gateway/`: 44 files call it (plus `method_ctx.py` itself) | confirmed |
| CON-11 | importing `tui_gateway/server.py` starts a thread pool | `tui_gateway/server.py:194` module-level `ThreadPoolExecutor(...)` | confirmed |
| CON-01 | runtimes end in `os._exit` | `os._exit(` in `hermes_cli/cli_shutdown.py` (5), `cli_single_query.py` (4), `tui_gateway/entry.py` (2), `gateway/shutdown_watchdog.py` (2), `hermes_cli/main.py`, `hermes_startup_watchdog.py`, `tui_gateway/slash_worker.py`, `tui_gateway/compute_host.py` | confirmed |
| ERR-03 | `tenacity` is a pinned core dependency with zero importers | `pyproject.toml:53` `tenacity==9.1.4`; no `import tenacity` / `from tenacity` in the tree | confirmed |
| ERR-07 | `tool_calls.log` is a separate process-wide file pipeline | `gateway/run_turn.py:55-69`: one process-wide `hermes.tool_calls` logger with one `RotatingFileHandler` | mechanism confirmed; the cross-profile write needs a multiplex run |
| CLI-01 | `slash_exec.EXECUTORS` exists as the start of a surface-independent layer | `hermes_cli/slash_exec.py:172` | location confirmed; "6 of 102 commands" not recounted |

Not re-checked by the parent: per-report counts produced by reader scripts (371 AIAgent
attributes, 246 threads, 113 adapter probes, 26 slash collections, 95 retry loops). The
scripts that produced them are in `scripts/` and re-runnable. Every `loc_delta` is a reader
estimate, not a measured diff.
