"""Local and mixed batches retain local policy and live-agent boundaries."""

import json
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("short_circuit", [False, True])
def test_local_only_batch_does_not_require_connections_scope(monkeypatch, short_circuit):
    import model_tools
    from tools import tool_search

    config = tool_search.ToolSearchConfig.from_raw(
        {"enabled": "on", "defer": ["process_manage"]}
    )
    calls = [
        {"name": "process_manage", "arguments": {"action": "list"}},
        {"name": "process_manage", "arguments": {"action": "list"}},
    ]
    monkeypatch.setattr(tool_search, "load_config", lambda: config)
    monkeypatch.setattr(tool_search, "load_config_readonly", lambda: config)
    dispatched = []

    def dispatch(name, arguments, **kwargs):
        dispatched.append((name, arguments))
        return json.dumps(
            {"error": "two stale rows", "processes": [], "listed": True}
        )

    monkeypatch.setattr(model_tools.registry, "dispatch", dispatch)
    if short_circuit:
        from hermes_cli.plugins import get_plugin_manager

        # Middleware may serve a cached result without entering the handler.
        monkeypatch.setattr(get_plugin_manager(), "_middleware", {
            "tool_execution": [lambda **kwargs: json.dumps(
                {"error": "two stale rows", "processes": [], "listed": True}
            )],
        })
    result = json.loads(
        model_tools.handle_function_call(
            "tool_call", {"calls": calls}, enabled_toolsets=["terminal"]
        )
    )
    assert dispatched == ([] if short_circuit else [("process_manage", {"action": "list"})] * 2)
    assert [entry["response"] for entry in result["results"]] == [
        {"error": "two stale rows", "processes": [], "listed": True},
        {"error": "two stale rows", "processes": [], "listed": True},
    ]
    assert result["success_count"] == 2 and result["error_count"] == 0


def test_mixed_batch_reports_denied_entries_and_runs_allowed_siblings(monkeypatch):
    import model_tools
    from tools import tool_search
    from tools.registry import invalidate_check_fn_cache, registry
    from tools.tool_gateway import bridge, config as gateway_config

    search_config = tool_search.ToolSearchConfig.from_raw(
        {"enabled": "on", "defer": None}
    )
    monkeypatch.setattr(tool_search, "load_config", lambda: search_config)
    monkeypatch.setattr(tool_search, "load_config_readonly", lambda: search_config)
    monkeypatch.setattr(gateway_config, "connectors_available", lambda: True)
    monkeypatch.setattr(bridge, "connectors_available", lambda: True)
    invalidate_check_fn_cache()
    unavailable_name = "mcp_batch_scope_denied"
    registry.register(
        name=unavailable_name,
        handler=lambda args, **kwargs: json.dumps({"must_not": "run"}),
        schema={
            "name": unavailable_name,
            "description": "Out-of-scope batch test tool",
            "parameters": {"type": "object", "properties": {}},
        },
        toolset="mcp-batch-scope-denied",
    )
    local_dispatches = []
    original_dispatch = registry.dispatch

    def dispatch(name, arguments, **kwargs):
        local_dispatches.append(name)
        return original_dispatch(name, arguments, **kwargs)

    remote_dispatches = []

    class Client:
        def execute(self, planned):
            remote_dispatches.extend(plan.name for plan in planned)
            return [{"data": "remote-ok", "error": None} for _ in planned]

    monkeypatch.setattr(model_tools.registry, "dispatch", dispatch)
    monkeypatch.setattr(bridge, "_default_client_factory", Client)
    calls = [
        {"name": "process_manage", "arguments": {"action": "list"}},
        {"name": unavailable_name, "arguments": {}},
        {"name": "connectors__gmail__SEND_EMAIL", "arguments": {}},
    ]
    try:
        result = json.loads(
            model_tools.handle_function_call(
                "tool_call",
                {"calls": calls},
                enabled_toolsets=["terminal", "connections"],
                skip_pre_tool_call_hook=True,
                skip_tool_request_middleware=True,
                skip_tool_execution_middleware=True,
            )
        )
        restricted = json.loads(
            model_tools.handle_function_call(
                "tool_call",
                {"calls": calls},
                enabled_toolsets=["terminal"],
                skip_pre_tool_call_hook=True,
                skip_tool_request_middleware=True,
                skip_tool_execution_middleware=True,
            )
        )
    finally:
        registry.deregister(unavailable_name)
    assert local_dispatches == ["process_manage", "process_manage"]
    assert remote_dispatches == ["connectors__gmail__SEND_EMAIL"]
    assert result["results"][0]["response"]["processes"] == []
    assert "not available in this session" in result["results"][1]["error"]["message"]
    assert result["results"][2]["response"] == "remote-ok"
    assert result["success_count"] == 2 and result["error_count"] == 1
    assert restricted["results"][0]["response"]["processes"] == []
    assert "not available in this session" in restricted["results"][1]["error"]["message"]
    assert "Connectors are not available in this session" in restricted["results"][2]["error"]["message"]
    assert restricted["success_count"] == 1 and restricted["error_count"] == 2


def test_local_batch_entries_use_real_name_policies_and_honest_results(monkeypatch):
    import hermes_cli.plugins as plugins
    import model_tools
    from tools import tool_search

    search_config = tool_search.ToolSearchConfig.from_raw(
        {"enabled": "on", "defer": ["process_manage"]}
    )
    monkeypatch.setattr(tool_search, "load_config", lambda: search_config)
    monkeypatch.setattr(tool_search, "load_config_readonly", lambda: search_config)
    events = []

    def request(**kwargs):
        events.append(("request", kwargs["tool_name"], kwargs["args"]["marker"]))
        return None

    def hook(name, arguments, **kwargs):
        events.append(("hook", name, arguments["marker"]))
        if arguments["marker"] == "denied":
            return "blocked locally", None
        return None, None

    def execution(**kwargs):
        events.append(("execution", kwargs["tool_name"], kwargs["args"]["marker"]))
        return kwargs["next_call"]()

    monkeypatch.setattr(
        plugins.get_plugin_manager(),
        "_middleware",
        {"tool_request": [request], "tool_execution": [execution]},
    )
    monkeypatch.setattr(plugins, "_dispatch_pre_tool_call_hooks", hook)
    monkeypatch.setattr(
        model_tools.registry,
        "dispatch",
        lambda name, arguments, **kwargs: json.dumps(
            {"error": "one stale process", "processes": [], "listed": True}
        ),
    )
    calls = [
        {
            "name": "process_manage",
            "arguments": {"action": "list", "marker": "denied"},
        },
        {
            "name": "process_manage",
            "arguments": {"action": "list", "marker": "allowed"},
        },
    ]
    result = json.loads(
        model_tools.handle_function_call(
            "tool_call",
            {"calls": calls},
            enabled_toolsets=["terminal"],
            skip_pre_tool_call_hook=True,
            skip_tool_request_middleware=True,
            skip_tool_execution_middleware=True,
        )
    )
    assert "blocked locally" in result["results"][0]["error"]["message"]
    assert result["results"][1]["response"] == {
        "error": "one stale process",
        "processes": [],
        "listed": True,
    }
    assert result["success_count"] == 1 and result["error_count"] == 1
    assert events == [
        ("request", "process_manage", "denied"),
        ("hook", "process_manage", "denied"),
        ("request", "process_manage", "allowed"),
        ("hook", "process_manage", "allowed"),
        ("execution", "process_manage", "allowed"),
    ]


@pytest.mark.parametrize("flatten_probe", [False, True])
def test_single_local_unwrap_keeps_session_db_todo_store_and_setup_callback(tmp_path, flatten_probe):
    from agent.tool_executor import _unwrap_tool_search_call
    from agent.agent_runtime_helpers import invoke_tool
    from hermes_state import SessionDB
    from tools.todo_tool import TodoStore

    db = SessionDB(tmp_path / "recall.db")
    db.create_session("past-session", source="cli")
    db.append_message("past-session", role="user", content="live-db-proof")
    callbacks = []
    def setup(server, action, reason):
        callbacks.append((server, action, reason))
        return json.dumps({"status": "declined", "server": server})

    agent = SimpleNamespace(
        enabled_toolsets=["todo", "session_search", "desktop_ui"], disabled_toolsets=[],
        session_id="current-session", _todo_store=TodoStore(), _memory_manager=None,
        _get_session_db_for_recall=lambda: db, setup_mcp_callback=setup,
    )
    calls = [
        {"name": "session_search", "arguments": {"session_id": "past-session"}},
        {"name": "todo_list", "arguments": {"todos": [{"id": "a", "content": "live-store-proof", "status": "pending"}]}},
        {"name": "setup_mcp", "arguments": {"server": "example", "action": "install", "reason": "live-callback-proof"}},
    ]
    results = []
    try:
        for entry in calls:
            name, args, error = _unwrap_tool_search_call(
                agent, "tool_call", {"calls": [entry]}, flatten_probe=flatten_probe)
            assert name == entry["name"] and error is None
            results.append(json.loads(invoke_tool(
                agent, name, args, "task", tool_call_id="call", pre_tool_block_checked=True)))
        assert "live-db-proof" in json.dumps(results[0])
        assert agent._todo_store.read()[0]["content"] == "live-store-proof"
        assert results[2] == {"status": "declined", "server": "example"}
        assert callbacks == [("example", "install", "live-callback-proof")]
    finally:
        db.close()
