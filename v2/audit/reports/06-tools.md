# 06 Tool registry, toolsets, tool runtime, MCP

Checkout `origin/main` = `ea81748579`. Reference SHAs: pydantic-ai c68786e, inspect_ai 9f6accd,
llm 764dc38, pluggy 7aa82ed, svcs 5d93cbc.

## TL;DR

- Most important structural problem: Hermes has no single tool abstraction. A tool can come from 7 sources (registry entry, inline agent executor, `delegate_task` special case, context-engine, memory provider, connector, Tool Search bridge). Each source has its own schema path and its own dispatch branch. The two agent-side dispatchers apply them in different orders (TLS-01, TLS-02).
- Biggest kill: the plugin-authorization layer inside `tools/registry.py`. It is about 250 lines and includes stack-frame inspection. `PluginContext.register_tool` already enforces the same rule (TLS-07). Also kill the import-time backward-compat surface in `model_tools.py` (TLS-08).
- Biggest simplification: give each `ToolEntry` a typed context, a `prepare()` hook and behaviour metadata (pydantic-ai `RunContext` / `ToolPrepareFunc` / `ToolDefinition.sequential`). Inline executors, the `_DYNAMIC_SCHEMA_REWRITERS` table, the four `skip_*` flags and about 20 hard-coded name lists in `agent/` then disappear (TLS-01, 05, 10).
- Low-hanging fruit: 5 findings (TLS-02, 03, 04, 05, 08).
- Answer to the seam question: there are several tool abstractions, not one. A pydantic-ai-style `Toolset` with a typed context deletes roughly 2,000–2,500 lines across `model_tools.py`, `agent/` and `tools/registry.py`.

## What this area is

Scope: `tools/` (342 files, 122,122 lines per `inputs/metrics/areas.json`), `model_tools.py` (996), `toolsets.py` (492), `toolset_distributions.py` (106), `mcp_serve.py` (728), plus the dispatch side of `agent/tool_executor.py` (1,929), `agent/inline_tool_executors.py` (312) and `agent/agent_runtime_helpers.py::invoke_tool`. In total about 126k lines.

Counts. Method: a stdlib AST script at `scripts/count_tools.py`, run with `cd / && uv run --no-project python ...`.
- There are 56 real `registry.register(` call sites in `tools/`. Several are loops over tables.
- Plugins have 3 `ctx.register_tool(` loops.
- Together these register 107 distinct tool names. MCP tools are registered at runtime and are not in that count.
- `TOOLSETS` has 61 keys naming 95 distinct tools. 23 of those keys are `hermes-*` bundles.

| module | lines | owns |
|---|---|---|
| `tools/registry.py` | 1,043 | `ToolEntry`, `ToolRegistry` singleton, AST-scan discovery + on-disk cache, check_fn TTL cache, plugin override policy, `dispatch()` |
| `model_tools.py` | 996 | import-time discovery, `get_tool_definitions()` (selection + rewrites + sanitize + tool search), `handle_function_call()` (hooks, middleware, bridge, connectors), `_run_async` |
| `toolsets.py` | 492 | `_HERMES_CORE_TOOLS`, static `TOOLSETS`, `resolve_toolset()` merged with registry, role/plugin-platform synthesis |
| `agent/tool_executor.py` | 1,929 | sequential/concurrent batch execution; `_resolve_sequential_dispatch` picks among 5 dispatch sources |
| `agent/inline_tool_executors.py` | 312 | `INLINE_TOOL_EXECUTORS` (15 names) for tools that need `AIAgent` state |
| `tools/mcp_tool.py` + 15 `mcp_tool_*.py` + 4 `mcp_oauth*.py` | 10,116 | MCP client: config, transport, background loop, discovery → registry, handlers, OAuth |
| `tools/browser_tool.py` + 11 siblings | ~4,400 | browser tools; siblings read facade state via `browser_tool_origin.origin` |
| `tools/process_registry.py` | 2,898 | background process registry singleton + systemd scopes + `process_manage` tool |
| `tools/environments/` | 7,276 (20 files) | terminal backends; one `BaseEnvironment(ABC)` (`base.py:225`), table-selected (`terminal_tool_backends.py:233-252`) |
| `tools/delegate_tool*.py`, `tools/async_delegation.py` | 5,594 | subagent spawn; registered handler is a "mirror" of the inline path |

Positive notes, so they are not proposed for change: terminal backends already have one ABC and a dict factory with a plugin fallback (`tools/terminal_tool_backends.py:233-252`). MCP transport selection is a 2–3-way branch, not a ladder (`tools/mcp_tool_transport.py:608-614`).

## How it works end to end

### Flow A — the agent's tool schema list is built (`schema-assembly`)

Inputs: `quiet_mode` (true for gateway/TUI agents), `oneshot` (`hermes -q`), `tool_search_active` (deferrable MCP/plugin surface exceeds its context share), `memory_provider_configured`, `context_engine_active`.

1. `agent/agent_init.py:1139` calls `model_tools.get_tool_definitions(enabled_toolsets, disabled_toolsets, quiet_mode)`.
2. When `quiet_mode` is set, `model_tools.py::_tool_defs_cache_key` (`model_tools.py:256`) builds a 10-field memo key. The key includes the registry generation, the `config.yaml` stat, `HERMES_KANBAN_TASK`, the delegation context and the profile scope (TLS-05).
3. `model_tools.py::_select_tool_names` (`model_tools.py:315`) calls `toolsets.py::resolve_toolset` (`toolsets.py:375`). That calls `get_toolset` (`toolsets.py:299`), which unions the static `TOOLSETS` list with `registry.get_tool_names_for_toolset()` (TLS-03).
4. `toolsets.py::profile_role_toolsets` strips role-reserved toolsets (`model_tools.py:332-334`). Then `_apply_toolset_selection(disable=True)` subtracts the disabled toolsets (`model_tools.py:339-340`).
5. `tools/registry.py::ToolRegistry.get_definitions` (`registry.py:843`) filters by `check_fn` through the TTL cache (`registry.py:325`). It then merges `ToolEntry.dynamic_schema_overrides` (`registry.py:860-869`) (TLS-05).
6. `model_tools.py::_apply_dynamic_schemas` (`model_tools.py:483`) applies a second, name-keyed rewriter table (`model_tools.py:469-480`) (TLS-05).
7. `tools/schema_sanitizer.py::sanitize_tool_schemas` (`model_tools.py:523-527`).
8. When `tool_search_active`: `tools/tool_search.py::assemble_tool_defs` swaps deferrable tools for the bridge (`model_tools.py:533-545`).
9. When `oneshot`: `agent/oneshot_footprint.py::prune_oneshot_tools` (`agent/agent_init.py:1145`).
10. `tools/connectors/turn.py::side_agent_tool_drops` (`agent/agent_init.py:1146-1149`).
11. When `memory_provider_configured`: `agent/memory_manager.py::inject_memory_provider_tools` (`agent/agent_init.py:1402`, body at `agent/memory_manager.py:115`) appends provider schemas (TLS-01).
12. When `context_engine_active`: `agent/agent_init.py::_inject_context_engine_tools` (`agent/agent_init.py:2129`). This is a copy of step 11 for a different source (TLS-01).

### Flow B — the model emits one tool call, sequential path (`tool-call`)

Inputs: `agent_level_tool` (todo_list, memory, clarify, desktop GUI tools, ...), `is_delegate`, `context_engine_tool`, `memory_provider_tool`, `bridge_call` (`tool_search`/`tool_describe`/`tool_call`), `is_async_handler`.

1. `agent/tool_executor.py::execute_tool_calls_sequential` (`tool_executor.py:1828`) parses the call and calls `_resolve_sequential_dispatch` (`tool_executor.py:1871`).
2. `agent/tool_executor.py::_resolve_sequential_dispatch` (`tool_executor.py:1648`). An agent-level tool goes to `INLINE_TOOL_EXECUTORS` (`tool_executor.py:1655-1659`) (TLS-01).
3. `delegate_task` goes to `agent._dispatch_delegate_task` (`tool_executor.py:1660-1663`).
4. A context-engine tool goes to `agent.context_compressor.handle_tool_call` (`tool_executor.py:1664`). A memory-provider tool goes to `agent._memory_manager.handle_tool_call` (`tool_executor.py:1671`).
5. Anything else calls `model_tools.handle_function_call(...)` with `skip_pre_tool_call_hook`, `skip_tool_request_middleware` and `skip_tool_execution_middleware` set, inside `suppress_post_tool_call_hook()` (`tool_executor.py:1680-1700`) (TLS-02).
6. `model_tools.py::handle_function_call` (`model_tools.py:876`): `coerce_tool_args` (`:892`), then legacy alias (`:896`).
7. On a bridge call: `_dispatch_bridge_tool` (`model_tools.py:707`). `tool_call` re-enters `handle_function_call` recursively (`:921`).
8. Connector gate: re-runs `_select_tool_names` to check `manage_connections` (`model_tools.py:930-934`).
9. `_AGENT_LOOP_TOOLS` stub rejects todo/memory/session_search/delegate_task (`model_tools.py:941-942`).
10. `_pre_dispatch_guards` (`model_tools.py:944`) runs the pre_tool_call hook (skipped by the flag here) and ACP edit approval.
11. `_execute_tool` (`model_tools.py:826`). `execute_code` gets `enabled_tools`, falling back to the process-global `_last_resolved_tool_names` (`:831-834`) (TLS-09).
12. `tools/registry.py::ToolRegistry.dispatch` (`registry.py:893`): signature-filtered kwargs (`:904`). When `is_async_handler`: `model_tools._run_async` (`:906-907`).
13. `ToolRegistry._normalize_handler_result` (`registry.py:876`) enforces a str or `_multimodal` dict.
14. `_apply_transform_tool_result_hook` (`model_tools.py:963`) returns to the executor, which emits post_tool_call itself.

## Findings

### TLS-01 — Seven tool sources, seven dispatch branches, two precedence orders (critical, XL, restructure)
- **Evidence:** `agent/tool_executor.py:1648-1700`, `agent/agent_runtime_helpers.py:2576-2660`, `agent/inline_tool_executors.py:237-312`, `model_tools.py:613`, `model_tools.py:941-942`, `agent/memory_manager.py:115-158`, `agent/agent_init.py:2129-2166`, `tools/delegate_tool.py:771-772`.
- **Problem (today):**
  - A "tool" is not one thing.
    - Registry entries go through `handle_function_call`.
    - 15 agent-state tools go through `INLINE_TOOL_EXECUTORS`. Most of them are *also* registered with registry handlers that the agent path never calls. `model_tools.py:941` stubs 4 of them out, and `delegate_tool.py:771` calls its handler "a mirror for the rare case the intercept is bypassed".
    - Context-engine tools and memory-provider tools are not in the registry. They are appended to `agent.tools` by two copy-pasted injectors, and each has its own dispatch branch.
    - Connectors and the Tool Search bridge are special-cased inside `handle_function_call`.
  - The sequential resolver orders the sources as inline → delegate → context-engine → memory-provider → registry (`tool_executor.py:1648-1651`). The concurrent `invoke_tool` orders them as todo/session_search/memory → memory-provider → inline except `message_agent` → registry (`inline_tool_executors.py:299-312`), and it has no context-engine branch at all.
  - It is safe today only because `_PARALLEL_SAFE_TOOLS` (`agent/tool_dispatch_helpers.py:33`) never admits a context-engine name.
  - Who pays: every contributor adding an agent-aware tool, and every reviewer checking that two paths agree.
- **Move (proposal):**
  - Give handlers a typed `ToolContext`: agent handle, session/turn/call ids, messages, UI callbacks, enabled tool names. This is the pydantic-ai `RunContext` shape.
  - Register inline tools as ordinary `ToolEntry`s whose handler takes `ctx`.
  - Memory providers and context engines expose their tools as a toolset object, combined at agent build with the registry view. This is the `CombinedToolset` shape.
  - Delete `INLINE_TOOL_EXECUTORS`, `INVOKE_TOOL_PRE_MEMORY_MANAGER_NAMES`, `_AGENT_LOOP_TOOLS`, `_resolve_sequential_dispatch`'s five branches, the duplicated injectors and the delegate "mirror" handler.
  - One dispatcher remains.
- **Reference:** pydantic-ai `pydantic_ai_slim/pydantic_ai/tools.py:106` (`ToolPrepareFunc` takes `RunContext`), `pydantic_ai_slim/pydantic_ai/toolsets/combined.py:27` (`CombinedToolset`), `pydantic_ai_slim/pydantic_ai/_run_context.py:169` (`RunContext`).
- **Estimated lines:** about −900.
- **Risk:** prompt-cache stability. The tool list order and bytes must stay identical for a given config. Desktop GUI callbacks (`read_terminal_callback`, ...) must still be bound per agent. The memory-provider "gated off by toolset" rule (`agent/memory_manager.py:115-135`) must survive. Tests patch `INLINE_TOOL_EXECUTORS` and `_resolve_sequential_dispatch`, so those test seams move.
- **Depends on:** TLS-02.

### TLS-02 — The tool-call pipeline runs at three layers, and four `skip_*` flags turn the inner ones off (high, M, collapse, low-hanging)
- **Evidence:** `model_tools.py:876-969`, `model_tools.py:30-40`, `agent/tool_executor.py:1680-1700`, `agent/agent_runtime_helpers.py:2576-2660`, `hermes_cli/plugins.py:705-714`.
- **Problem (today):**
  - These phases are implemented in `model_tools.handle_function_call`: arg coercion, aliasing, request middleware, pre_tool_call hook, ACP edit approval, execution middleware, post_tool_call, transform_tool_result.
  - They are implemented again in `agent/tool_executor.py`, and a third time in `agent_runtime_helpers.invoke_tool`.
  - The outer layers suppress the inner ones with `skip_pre_tool_call_hook`, `skip_tool_request_middleware`, `skip_tool_execution_middleware` and the `_post_tool_call_hook_suppressed` ContextVar.
  - Count: `rg -c "skip_pre_tool_call_hook|skip_tool_request_middleware|skip_tool_execution_middleware|suppress_post_tool_call_hook"` gives 13 in `model_tools.py`, 7 in `agent_runtime_helpers.py`, 6 in `tool_executor.py` and 2 in `tools/connectors/dispatch.py`.
  - Meanwhile `PluginContext.dispatch_tool` calls `registry.dispatch` directly (`hermes_cli/plugins.py:714`). A plugin-initiated call therefore skips every hook, middleware, alias and edit-approval guard.
  - Who pays: anyone adding a pipeline phase must add it in up to 3 places and thread a new skip flag. "Hook fired twice / fired zero times" is the resulting bug class (the docstring at `model_tools.py:777-778` exists for it).
- **Move (proposal):**
  - One `tools/tool_pipeline.py::call_tool(entry, args, ctx)` owns every phase exactly once, in order.
  - `handle_function_call`, the sequential executor, `invoke_tool` and `PluginContext.dispatch_tool` all call it.
  - The executor keeps only display, timeout and parallelism.
  - Delete the skip flags and the ContextVar.
- **Reference:** pydantic-ai `pydantic_ai_slim/pydantic_ai/tool_manager.py:1078` (`ToolManager.handle_call` is the single call path); pluggy `src/pluggy/_callers.py` (wrappers compose middleware in one place).
- **Estimated lines:** about −350.
- **Risk:**
  - Hook single-fire contract: pre_tool_call fires exactly once per execution.
  - Ordering: request middleware → pre hook → ACP approval → execution middleware → post hook → transform.
  - Whether plugin `dispatch_tool` *should* run guards is a behaviour change to decide (UNVERIFIED intent).
- **Depends on:** none.

### TLS-03 — Toolset membership is declared twice, and the two declarations disagree (high, M, boundary, low-hanging)
- **Evidence:** `toolsets.py:12-41`, `toolsets.py:115-119`, `toolsets.py:299-327`, `tools/browser_cdp_tool.py:398`, `tools/browser_dialog_tool.py:103`, `tools/browser_use_cli.py:830`, `tools/apply_layout_tool.py:47`, `tools/kanban_tools.py:1300`.
- **Problem (today):**
  - Every `registry.register(toolset=...)` declares membership. The static `TOOLSETS` dict declares it again. `get_toolset` unions the two at runtime (`toolsets.py:308-315`).
  - They disagree:
    - `browser_cdp` and `browser_dialog` register toolset `browser-cdp`, and `browser_exec` registers `browser-use`, but `TOOLSETS["browser"]` lists all three.
    - Because `_get_plugin_toolset_names` treats any registry toolset absent from `TOOLSETS` as a plugin toolset (`toolsets.py:420-422`), `browser-cdp` and `browser-use` show up in `get_all_toolsets()` as "Plugin toolset: browser-cdp" (`toolsets.py:317-321`).
    - `apply_layout` (desktop_ui) and `kanban_schedule` are registered but in no static list. They exist only through the merge.
    - `yb_*` register `toolset="hermes-yuanbao"`, a platform bundle name.
  - `_HERMES_CORE_TOOLS` is a third list. The `browser` and `kanban` toolsets are derived from it by prefix (`toolsets.py:118`, `:171`).
  - The contract tests that `tools/AGENTS.md:153-154` cites ("every registered tool has a toolset") do not exist (`tests/tools/test_toolsets.py`, `tests/tools/test_registry.py` read).
- **Move (proposal):**
  - Membership is declared once, on `ToolEntry.toolset`.
  - "Core" becomes a `core=True` field on the entry, and `_HERMES_CORE_TOOLS` is derived from it.
  - `TOOLSETS` keeps only composites (`includes`) and descriptions.
  - Fix the three browser registrations to `browser`.
  - One invariant test: every static toolset name resolves to ≥1 registered tool, and every built-in entry's toolset is a known key.
- **Reference:** pydantic-ai `pydantic_ai_slim/pydantic_ai/toolsets/function.py:50` (a `FunctionToolset` owns its tools; membership is where the tool is added); inspect_ai `src/inspect_ai/_util/registry.py:127` (`registry_add` stores identity + info once).
- **Estimated lines:** about −120.
- **Risk:** prompt-cache stability of the sorted tool list. `hermes tools` config keys must keep working. `disabled_toolsets: [browser]` must still strip `browser_cdp` (#17309, #64503 semantics).
- **Depends on:** none.

### TLS-04 — 20 `hermes-<platform>` bundles are copies of the core list (high, S, collapse, low-hanging)
- **Evidence:** `toolsets.py:58-60`, `toolsets.py:212-255`, `toolsets.py:355-372`, `hermes_cli/platforms.py:15-16`, `hermes_cli/toolset_validation.py:33-35`.
- **Problem (today):**
  - 17 of the 23 `hermes-*` entries are `_bundle(description)`: `_HERMES_CORE_TOOLS` plus nothing. Three add the platform's own toolset tools: discord, feishu, yuanbao. `hermes-yuanbao` is hand-written with a dead `"module"` key (`toolsets.py:240`).
  - `hermes-gateway` re-lists 19 bundle names by hand (`toolsets.py:248-254`).
  - Plugin platforms already get the same bundle synthesized on demand (`_plugin_platform_bundle`, `toolsets.py:355-372`).
  - `hermes_cli/platforms.py` repeats each `default_toolset="hermes-<name>"` (and `toolset_validation.py:35` already falls back to `f"hermes-{platform}"`).
  - Who pays: adding a platform means editing 3 lists.
- **Move (proposal):**
  - Built-in platforms use the plugin path: `hermes-<p>` = core ∪ tools whose toolset is owned by platform `<p>`.
  - Delete the 20 static entries, the `hermes-gateway` include list and the per-platform `default_toolset` strings.
- **Reference:** llm `llm/hookspecs.py:33` (`register_tools`: a plugin registers into one place and bundles derive from it).
- **Estimated lines:** about −60.
- **Risk:**
  - Users' `config.yaml` refers to `hermes-telegram` etc.; `validate_toolset` must keep accepting every name.
  - Descriptions shown in UI must move to `PLATFORMS`.
  - `hermes-webhook`, `hermes-api-server` and `hermes-acp` are not core supersets and stay explicit.
- **Depends on:** TLS-03.

### TLS-05 — Schema assembly has 12 stages, and two competing dynamic-schema mechanisms (high, M, collapse, low-hanging)
- **Evidence:** `tools/registry.py:195-197`, `tools/registry.py:860-869`, `model_tools.py:469-494`, `model_tools.py:256-279`, `tools/delegate_tool.py:798`, `tools/browser_use_cli.py:838`, `agent/agent_init.py:1139-1149`.
- **Problem (today):**
  - Per-entry `dynamic_schema_overrides` is used by 9 tools (`rg -n "dynamic_schema_overrides=" tools`). The name-keyed `_DYNAMIC_SCHEMA_REWRITERS` covers 10 names. `delegate_task` and `browser_exec` are in both.
  - Discord's rewriter reaches a schema function by `getattr(module, string)` (`model_tools.py:361-370`).
  - After `get_tool_definitions` returns, `agent_init` prunes, drops and appends four more times (Flow A steps 9–12).
  - Because the inputs are implicit, the memo key needs 10 fields, including an env var and a `config.yaml` stat (`model_tools.py:274-279`).
  - Who pays: anyone asking "what schema does the model see?" must read 4 modules. Every new input is a new silent cache-key field. Prompt-cache breaks (gist: I 333, C 44) live here.
- **Move (proposal):**
  - One `prepare(ctx, tool_def) -> tool_def | None` on `ToolEntry`. `ctx` carries the available-name set, config and session facts.
  - Toolset-level `prepare` handles pruning (oneshot, side-agent).
  - Delete `dynamic_schema_overrides`, `_DYNAMIC_SCHEMA_REWRITERS` and `_compose_rewriters`.
  - The memo key becomes `hash(ctx)`.
  - This also makes the gist's Phase-5 "prompt-prefix stability" check a pure function test.
- **Reference:** pydantic-ai `pydantic_ai_slim/pydantic_ai/tools.py:106` (`ToolPrepareFunc`), `pydantic_ai_slim/pydantic_ai/toolsets/prepared.py:15-40` (`PreparedToolset` may drop but not add/rename tools).
- **Estimated lines:** about −250.
- **Risk:** byte-identical schemas for an unchanged config (cache invariant). The rewriters' "never name an absent tool" rule (`tools/AGENTS.md:42-45`) must hold.
- **Depends on:** TLS-01.

### TLS-06 — `mcp_tool` and `browser_tool` siblings read facade globals through call-time proxies (high, L, restructure)
- **Evidence:** `tools/mcp_tool_common.py:14-27`, `tools/browser_tool_origin.py:43-88`, `tools/mcp_tool.py:419-540`, `tools/mcp_tool_loop.py:255-257`.
- **Problem (today):**
  - The Sep-2026 split moved code out of `mcp_tool.py` and `browser_tool.py` but left all state in the facade.
  - Siblings read it through proxies that resolve the facade module on every attribute access:
    - MCP: 362 `_core.`/`_origin.` reads (`rg -o "\b_core\.\w+|\b_origin\.\w+" tools/mcp_tool_*.py | wc -l`). The top two are `_core._lock` ×58 and `_core._servers` ×38.
    - Browser: 268 `_bt.`/`origin.` reads.
  - The browser proxy walks the call stack with `sys._getframe` on each read and write (`browser_tool_origin.py:49-70`).
  - `mcp_tool.py` keeps 17 module-level dicts, 3 sets and 3 locks of server state. Siblings also write facade globals (`mcp_tool_loop.py:255-257` sets `_origin._mcp_loop`).
  - The stated reason is test patching: `mock.patch("tools.mcp_tool.X")` appears in 106 test sites, and `tools.browser_tool.X` in 125.
  - This is the same mechanism class as `tui_gateway` `bind_module` (parent fact 5): one module's namespace spread across files, invisible to static analysis.
- **Move (proposal):**
  - Put the state in an object: `tools/mcp_state.py::McpClientPool` (servers, locks, breakers, loop) and `tools/browser_sessions.py::BrowserSessions`, created once.
  - Siblings import the instance directly. Tests patch attributes on that instance.
  - Delete `_OriginProxy`, `browser_tool_origin.py` and the PEP 562 `__getattr__`/`globals().update` SDK loader in `mcp_tool.py:115-146`.
- **Reference:** pydantic-ai `pydantic_ai_slim/pydantic_ai/mcp.py:717` (`MCPToolset` keeps connection state on the instance); svcs `src/svcs/_core.py` (registry-owned services instead of module globals).
- **Estimated lines:** about −300 (proxies plus `_core.` prefixes); large diff.
- **Risk:** 231 test patch sites must move to the object. Profile-scoped MCP trust (`mcp_tool_registration.py::_record_scope_trust`) and reconnect/refresh semantics must be preserved.
- **Depends on:** none.

### TLS-07 — The registry embeds plugin authorization, with stack-frame inspection (medium, M, kill)
- **Evidence:** `tools/registry.py:200-212`, `tools/registry.py:547-664`, `tools/registry.py:686-730`, `tools/registry.py:745-801`, `hermes_cli/plugins.py:471-483`, `tools/registry.py:271-291`.
- **Problem (today):**
  - About 250 of the registry's 1,043 lines are plugin policy:
    - an identity-bearing `_PluginOverridePolicy` with CAS restore;
    - module→scope maps;
    - an ownership walk through `__globals__`, `partial`, `__func__` and `__wrapped__` (`registry.py:596-615`);
    - `sys._getframe(2)` to learn who called `deregister` (`registry.py:656-664`).
  - `PluginContext.register_tool` already enforces override opt-in and the shadow check before calling the registry (`hermes_cli/plugins.py:471-483`). Two code paths enforce one rule.
  - In-tree plugins never call `registry.register` directly (`rg -n "registry\.register\(" plugins` = 0). The frame check defends a path that root AGENTS.md says is not API ("internal paths are not API: plugins build on `ctx`", `AGENTS.md:276-278`).
  - The registry also late-imports `gateway.session_context`, `gateway.browser_control_broker` (`registry.py:271-278`), `agent.secret_scope` and `model_tools` (`registry.py:906`, `:917`). Its docstring (`registry.py:4`) and `tools/AGENTS.md:9` say it has no deps.
- **Move (proposal):**
  - The registry is a scope-keyed store: `register(entry, scope)`, `deregister(name, scope)`, `restore(name, current, previous, scope)`.
  - All plugin authorization lives in `PluginContext`, which knows the plugin identity without frame inspection.
  - Callers pass the check_fn cache scope in, instead of the registry reaching into `gateway`.
- **Reference:** llm `llm/hookspecs.py:33` (`register_tools(register)`: the host hands the plugin a bound `register` callable, so identity is known by construction); pluggy `src/pluggy/_manager.py` (registration policy lives in the manager, not the hook store).
- **Estimated lines:** about −220.
- **Risk:** the security property (a plugin cannot replace or remove a built-in without `allow_tool_override`; profile isolation of plugin tools) must hold for `ctx` callers. Third-party plugins that import `tools.registry` directly lose the guard; that is consistent with the stated API boundary, but it is a policy call (UNVERIFIED: how many external plugins do this).
- **Depends on:** none.

### TLS-08 — Import-time backward-compat surface in `model_tools.py` and the registry state that feeds it (high, S, kill, low-hanging)
- **Evidence:** `model_tools.py:167-188`, `model_tools.py:972-996`, `tools/registry.py:439`, `tools/registry.py:737-742`, `tools/registry.py:978-989`, `hermes_cli/banner.py:475-490`, `toolsets.py:240`.
- **Problem (today):**
  - `TOOL_TO_TOOLSET_MAP` and `TOOLSET_REQUIREMENTS` are snapshots taken at import, before MCP or late plugins register.
  - `TOOL_TO_TOOLSET_MAP` has one importer, the off-path `batch_runner.py:32`.
  - `TOOLSET_REQUIREMENTS` has two (`hermes_cli/banner.py:490`, `hermes_cli/doctor_tools.py:513`). Banner reads only whether a `check_fn` exists.
  - To serve that one boolean, the registry maintains `_toolset_checks` through register, deregister and restore (`registry.py:439`, `:741-742`, `:797-799`, `:821-836`). The comment at `:737-740` admits it no longer gates anything.
  - Five pass-through functions (`model_tools.py:976-996`) wrap registry methods one-to-one.
  - `_LEGACY_TOOLSET_MAP` (`:177-188`) keeps pre-rename `*_tools` names.
  - The `"module"` key on `hermes-yuanbao` is never read (`rg '\["module"\]|\.get\("module"'` over the toolset readers: 0 hits).
  - Who pays: every reader of `registry.py`, and every change to registration paths.
- **Move (proposal):**
  - Delete `_toolset_checks`, `get_toolset_requirements`, both constants and the pass-throughs.
  - Banner/doctor call `registry.get_available_toolsets()`. Callers use `registry.*` directly.
  - Drop the `"module"` key.
  - Keep `_LEGACY_TOOLSET_MAP` only if config migration has not rewritten old names (UNVERIFIED).
- **Reference:** none needed (plain deletion).
- **Estimated lines:** about −110.
- **Risk:** banner's "lazy-init vs disabled" classification must keep the same output. `batch_runner` moves with seam 15's decision.
- **Depends on:** none.

### TLS-09 — `_last_resolved_tool_names` is a process-global channel for `execute_code`'s allowed tools (medium, S, kill)
- **Evidence:** `model_tools.py:173`, `model_tools.py:249-250`, `model_tools.py:515-516`, `model_tools.py:831-834`, `tools/delegate_tool_results.py:305-309`, `tools/delegate_tool_child_run.py:1038-1040`, `tools/AGENTS.md:62-63`.
- **Problem (today):**
  - Every `get_tool_definitions()` call overwrites a module global with the last list it computed. This includes cache hits, other sessions' agents in the gateway, and the bridge's catalog reads.
  - `execute_code` falls back to it when the caller passes no `enabled_tools`.
  - Delegation saves and restores it around child runs. `tools/AGENTS.md` admits "readers may see it stale mid-delegation".
  - In a multi-session gateway the fallback can grant one session's sandbox another session's tool set.
  - The agent paths always pass `enabled_tools=list(agent.valid_tool_names)` (`agent/tool_executor.py:1691`). The global serves only non-agent callers: `tools/code_kernel.py:277`, `tools/code_execution_rpc.py:30`, `agent/transports/hermes_tools_mcp_server.py:106`.
- **Move (proposal):** make `enabled_tools` part of `ToolContext` (TLS-01). Non-agent callers pass their explicit catalog. Delete the global and the save/restore.
- **Reference:** pydantic-ai `pydantic_ai_slim/pydantic_ai/_run_context.py:169` (per-run state travels in the context, not module globals).
- **Estimated lines:** about −20.
- **Risk:** sandbox stubs must see the same names as before for agent calls. Check the RPC path's catalog for nested `execute_code` inside a delegated child.
- **Depends on:** TLS-01.

### TLS-10 — Tool behaviour metadata lives in name lists scattered across `agent/` (medium, M, collapse)
- **Evidence:** `agent/tool_dispatch_helpers.py:30-49`, `agent/tool_guardrails.py:20-66`, `agent/tool_result_classification.py:15`, `agent/agent_runtime_helpers.py:87`, `tools/code_execution_tool.py:43-45`, `agent/transports/hermes_tools_mcp_server.py:56`, `acp_adapter/tools.py:21-36`, `tools/send_message_tool.py:22`.
- **Problem (today):**
  - Parallel-safety, idempotency, mutation, failure tolerance and "progress reset" are properties of a tool. They are kept as hand-written frozensets keyed on names.
  - A census found 115 literals with ≥2 tool names in 44 non-test files (`scripts/find_tool_lists.py`).
  - The lists drift:
    - `IDEMPOTENT_TOOL_NAMES` hard-codes eight `mcp_filesystem_*` names from one third-party MCP server (`tool_guardrails.py:20-26`).
    - `MUTATING_TOOL_NAMES` and `PROGRESS_RESET_TOOL_NAMES` list `send_message`, which is deliberately never registered (`send_message_tool.py:22`).
    - They also list the legacy aliases `cronjob`, `todo` and `process` next to the canonical names, because aliasing happens later in `handle_function_call` (`model_tools.py:896`).
  - MCP already carries this information per tool (`_tool_read_only_hints`, `mcp_tool.py:487`; `is_mcp_tool_parallel_safe`) but has to be consulted through a side channel (`agent/tool_dispatch_helpers.py:110-114`).
- **Move (proposal):**
  - Add typed fields on `ToolEntry`: `read_only`, `idempotent`, `sequential` (barrier), `failure_is_output`.
  - MCP fills them from tool annotations at registration.
  - The guardrail and parallel planners read `registry.get_entry(name)`.
  - Display/verb tables stay; they are presentation, not behaviour.
- **Reference:** pydantic-ai `pydantic_ai_slim/pydantic_ai/tools.py:626-650` (`ToolDefinition.sequential`, `kind`, `metadata` carrying MCP annotations), `pydantic_ai_slim/pydantic_ai/tool_manager.py:286-293` (`is_sequential` reads the definition).
- **Estimated lines:** about −120.
- **Risk:** parallel batching decisions must not widen. Path-scoped reader/writer overlap rules (`tool_dispatch_helpers.py:46-49`) stay code, keyed on the new fields.
- **Depends on:** TLS-03.

### TLS-11 — `process_registry.py` mixes a 2,034-line service class, systemd plumbing and a model tool (medium, M, restructure)
- **Evidence:** `tools/process_registry.py:42`, `tools/process_registry.py:98-485`, `tools/process_registry.py:675`, `tools/process_registry.py:2709`, `tools/process_registry.py:2715-2898`, `tui_gateway/methods_tools.py:265-275`, `tui_gateway/prompt_turn.py:466`.
- **Problem (today):**
  - One file holds:
    - systemd-scope probing and argv building (lines 98-485);
    - `ProcessSession`;
    - the `ProcessRegistry` class (675-2709, 29 public methods);
    - the module singleton (2709);
    - the `process_manage` model-tool schema and handler (2715-2898).
  - 45 non-test files import the singleton. `tui_gateway` and `gateway` call `kill_all`, `list_sessions` and `drain_notifications` on it directly.
  - `CHECKPOINT_PATH = get_hermes_home() / "processes.json"` is captured at import (line 42). That is the profile-scope bug class root AGENTS.md describes (`AGENTS.md:299-311`), although `_checkpoint_path()` at line 46 exists beside it.
- **Move (proposal):**
  - Split along topics:
    - `tools/process_tool.py` (schema + handler, the only part that is a tool);
    - `tools/process_systemd.py` (scope plumbing);
    - `tools/process_registry.py` (the service).
  - Delete the import-time `CHECKPOINT_PATH` constant.
  - Seam 09 owns the concurrency inside.
- **Reference:** svcs `src/svcs/_core.py` (a registered service fetched from a container rather than a module singleton).
- **Estimated lines:** about −30, mostly moves.
- **Risk:** test patch seams on `tools.process_registry.*`. Teardown ordering in `_terminate_host_pid` (`tools/AGENTS.md:111-120`).
- **Depends on:** none.

### TLS-12 — Discovery AST-parses source text and runs plugin discovery as an import side effect (medium, M, restructure)
- **Evidence:** `tools/registry.py:59-141`, `tools/registry.py:144-178`, `model_tools.py:149-164`, `cli.py:393-398`.
- **Problem (today):**
  - `discover_builtin_tools` finds tool modules by `ast.parse`-ing every `tools/*.py` and looking for a literal `registry.register(` at module level or inside a module-level `for`.
  - The verdicts are cached on disk under `HERMES_HOME/cache` keyed on `(mtime_ns, size)` to save ~145 ms (`registry.py:96-100`).
  - Importing `model_tools` for any reason runs that discovery plus `hermes_cli.plugins.discover_plugins()` (`model_tools.py:149-164`). That is why `cli.py:393` wraps `get_tool_definitions` lazily.
  - A tool that registers through a helper function is silently skipped. Root AGENTS.md calls the no-list design deliberate (`AGENTS.md:251-252`, `tools/AGENTS.md:12`); I argue against it.
  - The text-scan cache is a second source of truth that lives in each profile's home.
- **Move (proposal):**
  - Replace the scan with an explicit, generated-or-literal tuple of built-in tool modules in `tools/__init__.py`. A one-line invariant test checks it against the tree.
  - Move plugin discovery to the explicit startup of each entry point that already runs MCP discovery (`model_tools.py:151-153` lists them).
  - `model_tools` import becomes side-effect free.
- **Reference:** llm `llm/plugins.py` (default plugins are an explicit list; third-party ones come via entry points) and pluggy `src/pluggy/_manager.py` (`load_setuptools_entrypoints` is an explicit call).
- **Estimated lines:** about −90.
- **Risk:** import order changes when tools register, so duplicate-name resolution (`registry.py:89-91` sorts for that reason) must stay deterministic. Every entry point (CLI, gateway, TUI, ACP, cron, batch) must call discovery.
- **Depends on:** none.

### TLS-13 — `tools/AGENTS.md` makes claims the code does not back (medium, S, hygiene)
- **Evidence:** `tools/AGENTS.md:9`, `tools/AGENTS.md:16-17`, `tools/AGENTS.md:69-72`, `tools/AGENTS.md:152-154`, `toolsets.py:77-256`.
- **Problem (today):**
  - "registry.py has no deps": false (TLS-07).
  - "the registry handles … dispatch (`handle_function_call()`)": `handle_function_call` is in `model_tools.py:876`.
  - The toolset key list names `moa`, `rl` and `messaging`, which are not `TOOLSETS` keys. It omits about 25 that are (x_search, video_gen, computer_use, connections, project, desktop_ui, setup, coding, context_engine, bot_room, ...).
  - The "every registered tool has a toolset" and "no schema description names a tool from another toolset" tests do not exist. Gist lane A says the same.
  - Agents trust this file as the map of the area.
- **Move (proposal):** after TLS-03, the first claim becomes a real invariant test. Cut the toolset key list (the file says "don't assert the list"). Correct the dependency and dispatch sentences.
- **Reference:** none needed.
- **Estimated lines:** about −10.
- **Risk:** none.
- **Depends on:** TLS-03, TLS-07.

## Kill list

| target | why | importers/callers | evidence |
|---|---|---|---|
| `tools/registry.py::_toolset_checks` + `get_toolset_requirements` | feeds one presence check in banner | 2 (banner, doctor via `TOOLSET_REQUIREMENTS`) | `registry.py:439,737-742,978-989`; `hermes_cli/banner.py:490` |
| `model_tools.py::TOOL_TO_TOOLSET_MAP` | import-time snapshot, off-path only | 1 (`batch_runner.py:32`) | `model_tools.py:168` |
| `model_tools.py` 5 pass-throughs | one-line registry wrappers | ~17 call sites (`get_toolset_for_tool` 11) | `model_tools.py:976-996` |
| `model_tools.py::_last_resolved_tool_names` | process-global channel | 3 readers/writers outside the module | `model_tools.py:173,834`; `tools/delegate_tool_results.py:305` |
| `model_tools.py::_AGENT_LOOP_TOOLS` + the registered "mirror" handlers for agent-loop tools | handler never reached via the model path | `model_tools.py:941` | `tools/delegate_tool.py:771-772` |
| `model_tools.py::_DYNAMIC_SCHEMA_REWRITERS` (after TLS-05) | second dynamic-schema mechanism | internal | `model_tools.py:469-494` |
| `tools/registry.py::_caller_module` + `_PluginOverridePolicy` machinery | duplicates `PluginContext` checks; frame inspection | in-tree plugin direct callers: 0 | `registry.py:200-212,547-664` |
| `tools/browser_tool_origin.py` (whole file) and `mcp_tool_common._OriginProxy` | call-time facade proxies | 268 + 362 reads | `browser_tool_origin.py:43-88`; `mcp_tool_common.py:14-27` |
| `toolsets.py` 17 `_bundle(...)` platform entries + `hermes-gateway` list | copies of core list | config users via names (keep the names valid) | `toolsets.py:212-255` |
| `toolsets.py` `"module": "tools.yuanbao_tools"` | never read | 0 | `toolsets.py:240` |
| `toolset_distributions.py` | only `batch_runner` imports it (off-path) | 1 file (2 lines) | `batch_runner.py:34,940` |
| `tools/process_registry.py::CHECKPOINT_PATH` import-time constant | profile-scope capture; `_checkpoint_path()` exists | UNVERIFIED count | `process_registry.py:42-50` |

## Simplify list

| what N things | become what 1 thing | lines saved | evidence |
|---|---|---|---|
| registry handler, `INLINE_TOOL_EXECUTORS`, delegate branch, context-engine branch, memory-provider branch | `ToolEntry(handler(args, ctx))` + combined toolsets | ~900 | `agent/tool_executor.py:1648-1700`; `agent/inline_tool_executors.py:237-312` |
| pipeline in `handle_function_call`, `tool_executor`, `invoke_tool` (+4 skip flags + ContextVar) | `tools/tool_pipeline.py::call_tool` | ~350 | `model_tools.py:876-969`; `agent/agent_runtime_helpers.py:2576-2660` |
| `dynamic_schema_overrides`, `_DYNAMIC_SCHEMA_REWRITERS`, agent_init prune/drop/inject steps | `ToolEntry.prepare` + toolset `prepare` | ~250 | `registry.py:860-869`; `model_tools.py:469-494`; `agent/agent_init.py:1139-1149` |
| `memory_manager.inject_memory_provider_tools` + `agent_init._inject_context_engine_tools` | one "add toolset" call | ~45 | `agent/memory_manager.py:115-158`; `agent/agent_init.py:2129-2166` |
| `ToolEntry.toolset`, `TOOLSETS[*].tools`, `_HERMES_CORE_TOOLS` | `ToolEntry.toolset` + `core` flag | ~120 | `toolsets.py:12-41,77-256` |
| ~20 behaviour name-sets in `agent/` | `ToolEntry` metadata fields | ~120 | `agent/tool_guardrails.py:20-66`; `agent/tool_dispatch_helpers.py:30-49` |
| `PluginContext` override check + registry override policy | `PluginContext` only | ~220 | `hermes_cli/plugins.py:471-483`; `registry.py:547-801` |

## Reference patterns to copy

| repo | path | pattern | where it applies here |
|---|---|---|---|
| pydantic-ai | `pydantic_ai_slim/pydantic_ai/_run_context.py:169` | `RunContext[Deps]` passed to every tool | replaces `INLINE_TOOL_EXECUTORS` and `_last_resolved_tool_names` (TLS-01, 09) |
| pydantic-ai | `pydantic_ai_slim/pydantic_ai/tools.py:106` | `ToolPrepareFunc(ctx, tool_def) -> tool_def \| None` | one dynamic-schema hook (TLS-05) |
| pydantic-ai | `pydantic_ai_slim/pydantic_ai/toolsets/combined.py:27`, `filtered.py:14`, `prepared.py:15` | compose sources, filter by selection, prepare per run | registry + memory provider + context engine + MCP (TLS-01, 05) |
| pydantic-ai | `pydantic_ai_slim/pydantic_ai/tools.py:626-650` | `ToolDefinition.sequential`, `kind`, `metadata` | behaviour metadata on the entry (TLS-10) |
| pydantic-ai | `pydantic_ai_slim/pydantic_ai/tool_manager.py:1078` | single `handle_call` path | one tool pipeline (TLS-02) |
| pydantic-ai | `pydantic_ai_slim/pydantic_ai/mcp.py:717` | `MCPToolset` owns server state on an instance | MCP state object (TLS-06) |
| inspect_ai | `src/inspect_ai/_util/registry.py:127` | `registry_add(obj, RegistryInfo)` stores identity once | single membership declaration (TLS-03) |
| llm | `llm/hookspecs.py:33` | `register_tools(register)`: host-bound register callable | plugin identity without frame inspection (TLS-07) |
| pluggy | `src/pluggy/_manager.py` | explicit `load_setuptools_entrypoints`, policy in manager | explicit discovery; policy outside the store (TLS-07, 12) |
| svcs | `src/svcs/_core.py` | services in a container, not module singletons | `process_registry`, MCP pool (TLS-06, 11) |

## Answer to the seam question

There is no single tool abstraction. `ToolEntry` (`tools/registry.py:181-197`) carries schema, handler, `check_fn` and a toolset name. But:
- membership is declared a second and third time in `TOOLSETS` and `_HERMES_CORE_TOOLS`;
- 15 tools' real handlers live in `agent/inline_tool_executors.py`;
- memory-provider and context-engine tools bypass the registry entirely;
- the schema the model sees is rewritten by two separate mechanisms and four more agent-side passes;
- behaviour facts (parallel-safe, idempotent, mutating) live in name lists in `agent/`;
- the call pipeline exists three times.

A pydantic-ai toolsets shape would delete most of that. The shape is a `ToolEntry` whose handler takes a typed `RunContext`, carries a `prepare()` hook and `sequential`/`read_only` metadata, and is composed by a `CombinedToolset` (registry ∪ memory ∪ context engine ∪ MCP) filtered by the session's selection.

What disappears: `INLINE_TOOL_EXECUTORS`, `_AGENT_LOOP_TOOLS`, the five-branch dispatch resolver, the skip-flag protocol, `_DYNAMIC_SCHEMA_REWRITERS`, the static per-tool lists in `TOOLSETS`, about 20 behaviour name-sets and the process-global `_last_resolved_tool_names`. My estimate is −2,000 to −2,500 lines net, and one place to answer "what can the model call and what happens when it does". inspect_ai's registry adds the "declare once, look up by name" half. The plugin-authorization policy that grew inside the registry belongs in `PluginContext`.

## Cross-seam notes

- 09-concurrency: `model_tools.py:93-145` `_run_async` builds a fresh `ThreadPoolExecutor` and a fresh event loop per async call when a loop is already running. MCP runs a separate long-lived loop thread (`tools/mcp_tool_loop.py:255-257`). These are two async bridges for one need.
- 07-config: `tools/process_registry.py:42` captures `get_hermes_home()` at import (profile-scope bug class).
- 11-plugins: `hermes_cli/plugins.py:705-714` `ctx.dispatch_tool` calls `registry.dispatch` directly. It skips pre/post hooks, middleware, aliases and ACP edit approval.
- 11-plugins: `toolsets.py:178-182` hard-codes a `spotify` toolset in core, while its tools come from `plugins/spotify/__init__.py:31` (plugin knowledge in core; gist lists spotify among the disputed in-tree third-party plugins).
- 04-agent-loop: `agent/agent_init.py:1139-1149` and `:2129-2166` post-process `agent.tools` after `get_tool_definitions`. The tool list is owned in two layers.
- 01-layout: tools import `hermes_cli` eagerly at module level: `tools/process_registry.py:29,33`, `tools/tool_search.py:19`, `tools/approval_context.py:12`, `tools/kanban_tools.py:19-21`, `tools/delegate_tool_config.py:9`. `tools/registry.py:271-278` reaches into `gateway`.
- 15-kill: `toolset_distributions.py` is imported only by `batch_runner.py:34,940`. `TOOL_TO_TOOLSET_MAP` exists only for `batch_runner.py:32,45`.
- 14-errors-obs: `model_tools.py:308,312,519,539` prints to stdout from library code when `quiet_mode=False`.
- 10-gateway: `tools/registry.py:263-291` `check_fn_cache_scope` reads gateway session env (`HERMES_BROWSER_CONTROL_*`) to decide cache bypass. This is a session property read through a process-level cache API.

## UNVERIFIED

- Whether `browser-cdp` / `browser-use` actually appear as "Plugin toolset" rows in `hermes tools` or the banner. The code path (`toolsets.py:317-321`, `:440-451`) says yes; verify by running `toolsets.get_all_toolsets()` after discovery against a temp `HERMES_HOME`.
- Whether `kanban_schedule` being absent from `_HERMES_CORE_TOOLS` (so absent from `hermes-*` bundles but present in `kanban` via the registry merge) is intended. Verify with `git log -S kanban_schedule -- toolsets.py`.
- Whether plugin `ctx.dispatch_tool` is meant to bypass pre_tool_call hooks and middleware (intent). Verify with `git log -S dispatch_tool -- hermes_cli/plugins.py` and `plugins/AGENTS.md`.
- How many third-party plugins call `tools.registry.registry.register` directly (TLS-07 risk). Verify via the plugin-catalog repos.
- Whether config migration has rewritten the `*_tools` legacy toolset names, which would make `_LEGACY_TOOLSET_MAP` dead. Verify in `hermes_cli/config*` migrations.
- Line-count estimates (`loc_delta`) are rough and were not prototyped.
- The test patch-site counts (106 / 125) come from a single `rg` pattern each and may miss `monkeypatch.setattr(module, ...)` forms.
- The census counts (107 registered names, 115 name-list literals) come from `scripts/count_tools.py` / `scripts/find_tool_lists.py`, written by a sub-worker. I spot-checked the toolset mismatches and missing entries against the source, but not every list entry.
- `process_registry` importer count (45) comes from an `rg -l` run by a sub-worker, not re-run by me.
