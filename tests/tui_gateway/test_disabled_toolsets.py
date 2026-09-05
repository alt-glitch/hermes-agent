"""TUI tool suppression survives composite expansion and background handoff."""

from types import SimpleNamespace

import pytest


@pytest.fixture
def gateway_tools(monkeypatch):
    from tui_gateway import server
    import model_tools

    cfg = {"agent": {"disabled_toolsets": '["search"]'}}
    monkeypatch.setattr(server, "_load_cfg", lambda: cfg)
    # `debugging` survives config pruning because it also contains file/terminal tools.
    monkeypatch.setattr(server, "_load_enabled_toolsets", lambda *_: ["debugging"])

    def definitions(enabled_toolsets=None, disabled_toolsets=None, **_):
        names = model_tools._select_tool_names(enabled_toolsets, disabled_toolsets, True)
        return [{"function": {"name": name, "description": name}} for name in sorted(names)]

    # Keep real composite resolution; avoid credential-dependent discovery/check_fn filtering.
    monkeypatch.setattr(model_tools, "get_tool_definitions", definitions)
    return server, cfg, definitions


def test_agent_and_background_preserve_partial_composite_suppression(gateway_tools, monkeypatch):
    server, cfg, definitions = gateway_tools
    monkeypatch.setattr(server, "_resolve_agent_model_runtime", lambda *_: ("test/model", {}))
    monkeypatch.setattr(server, "_startup_system_prompt", lambda *_: "")
    monkeypatch.setattr(server, "_load_provider_routing", lambda: {})
    monkeypatch.setattr(server, "_load_reasoning_config", lambda *_: {})
    monkeypatch.setattr(server, "_load_service_tier", lambda: None)
    monkeypatch.setattr(server, "_get_db", lambda: None)
    monkeypatch.setattr("hermes_cli.mcp_startup.wait_for_mcp_discovery", lambda: None)
    monkeypatch.setattr("tui_gateway.entry.wait_for_mcp_discovery", lambda: None)

    def build_agent(**kwargs):
        return SimpleNamespace(**kwargs, tools=definitions(**kwargs))

    monkeypatch.setattr("run_agent.AIAgent", build_agent)
    agent = server._make_agent("suppressed", "suppressed-key")
    names = {tool["function"]["name"] for tool in agent.tools}
    assert "web_search" not in names
    assert {"terminal", "read_file", "web_extract"} <= names

    # A running parent's policy remains stable if config changes before detachment.
    cfg["agent"]["disabled_toolsets"] = []
    detached = server._background_agent_kwargs(agent, "background-key")
    preview = server._ephemeral_preview_agent_kwargs(agent, "preview-key")
    assert detached["disabled_toolsets"] == preview["disabled_toolsets"] == ["search"]
    assert "web_search" not in {tool["function"]["name"] for tool in definitions(**detached)}


def test_tools_show_applies_cold_config_and_live_agent_policy(gateway_tools, monkeypatch):
    server, cfg, _ = gateway_tools

    def shown_names(session_id):
        response = server._methods["tools.show"]("tools-request", {"session_id": session_id})
        assert "error" not in response
        return {tool["name"] for section in response["result"]["sections"] for tool in section["tools"]}

    monkeypatch.setattr(server, "_sessions", {})
    cold_names = shown_names("not-built")
    assert "web_search" not in cold_names
    assert {"terminal", "web_extract"} <= cold_names

    agent = SimpleNamespace(enabled_toolsets=["debugging"], disabled_toolsets=["terminal"])
    server._sessions["live"] = {"agent": agent}
    # Live inspection follows the established agent, not the now-different saved config.
    cfg["agent"]["disabled_toolsets"] = ["search"]
    live_names = shown_names("live")
    assert "terminal" not in live_names
    assert {"web_search", "read_file"} <= live_names
