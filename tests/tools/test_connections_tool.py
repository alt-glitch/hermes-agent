"""Behavior tests for manage_connections.

DI-callable idiom: a fake client injected through manage_connections'
seams; no module mocks, no network.
"""

import json
from unittest.mock import patch

import tools.connections_tool  # registers the tool
from tools.connections_tool import MANAGE_CONNECTIONS_SCHEMA, manage_connections


class FakeClient:
    def __init__(self):
        self.calls = []

    def list_connectors(self):
        self.calls.append(("list",))
        return [
            {"connector": "gmail", "enabled": True, "connected": False},
            {"connector": "linear", "enabled": True, "connected": True},
        ]

    def connections(self, connectors, *, reinitiate=False):
        self.calls.append(("connections", tuple(connectors), reinitiate))
        return {
            "results": [
                {
                    "connector": c,
                    "status": "initiated",
                    "connect_url": f"https://connect.example/{c}",
                    "instruction": f"finish authorizing {c} in the browser",
                    "reinitiated": reinitiate,
                }
                for c in connectors
            ],
            "summary": {"total": len(connectors), "initiated": len(connectors)},
        }


def test_status_lists_and_filters_connectors():
    client = FakeClient()
    out = json.loads(
        manage_connections(
            {"action": "status", "connectors": ["GMAIL"]},
            client_factory=lambda: client,
        )
    )
    assert out["connectors"] == [
        {"connector": "gmail", "enabled": True, "connected": False}
    ]


def test_connect_returns_link_and_instruction_once_per_session():
    client = FakeClient()
    seen = set()
    first = json.loads(
        manage_connections(
            {"action": "connect", "connectors": ["gmail"]},
            client_factory=lambda: client,
            seen_instructions=seen,
        )
    )
    entry = first["results"][0]
    assert entry["connect_url"] == "https://connect.example/gmail"
    assert "instruction" in entry

    second = json.loads(
        manage_connections(
            {"action": "connect", "connectors": ["gmail"]},
            client_factory=lambda: client,
            seen_instructions=seen,
        )
    )
    assert "instruction" not in second["results"][0]  # shown once per session
    assert ("connections", ("gmail",), False) in client.calls

    # A DIFFERENT session sharing the process still gets the guidance.
    other_session = json.loads(
        manage_connections(
            {"action": "connect", "connectors": ["gmail"]},
            client_factory=lambda: client,
            seen_instructions=seen,
            session_id="other-session",
        )
    )
    assert "instruction" in other_session["results"][0]


def test_reconnect_sets_reinitiate():
    client = FakeClient()
    manage_connections(
        {"action": "reconnect", "connectors": ["gmail"]},
        client_factory=lambda: client,
        seen_instructions=set(),
    )
    assert ("connections", ("gmail",), True) in client.calls


def test_connect_without_connectors_is_a_usage_error():
    out = json.loads(
        manage_connections({"action": "connect"}, client_factory=FakeClient)
    )
    assert "requires 'connectors'" in out["error"]


def test_unknown_action_mentions_dashboard_for_deauth():
    out = json.loads(
        manage_connections({"action": "de-authenticate"}, client_factory=FakeClient)
    )
    assert "dashboard" in out["error"]


def test_gateway_failure_is_a_model_actionable_error():
    def exploding():
        raise RuntimeError("gateway on fire")

    out = json.loads(
        manage_connections({"action": "status"}, client_factory=exploding)
    )
    assert "connector gateway request failed" in out["error"]


def test_mcp_actions_are_not_this_tools_business():
    # Local MCP setup belongs to setup_mcp, which owns the desktop consent
    # callback. Folding those actions in here promised a flow this tool has no
    # way to reach, so they are rejected as unknown actions.
    out = json.loads(
        manage_connections({"action": "install", "server": "linear"})
    )
    assert "action must be one of" in out["error"]
    assert "install" not in MANAGE_CONNECTIONS_SCHEMA["parameters"]["properties"]["action"]["enum"]


# ---------------------------------------------------------------------------
# reachability: a registered tool nobody enables is a tool nobody can call
# ---------------------------------------------------------------------------


def test_tool_is_enabled_for_platform_sessions_not_just_registered():
    # The registered toolset ("connections") is registry-only: absent from
    # TOOLSETS, from _gui_surface_toolsets, and — before this fix — from
    # _HERMES_CORE_TOOLS. Every real session passes enabled_toolsets, so the
    # tool resolved into no bundle and no session could ever call it.
    from toolsets import TOOLSETS, resolve_toolset

    assert "connections" not in TOOLSETS  # still registry-only; nothing to enable
    for bundle in ("hermes-cli", "hermes-cron", "hermes-gateway", "hermes-telegram"):
        assert "manage_connections" in resolve_toolset(bundle), bundle


def test_entitled_session_sees_the_tool_in_its_definitions():
    from model_tools import get_tool_definitions
    from tools.registry import invalidate_check_fn_cache

    def _defs():
        invalidate_check_fn_cache()
        return {
            d["function"]["name"]
            for d in get_tool_definitions(enabled_toolsets=["hermes-cli"], quiet_mode=True)
        }

    with patch("tools.tool_gateway.config.connectors_available", return_value=True):
        entitled = _defs()
    with patch("tools.tool_gateway.config.connectors_available", return_value=False):
        signed_out = _defs()
    invalidate_check_fn_cache()

    # Present and NOT collapsed into the tool_search catalog: connection
    # trouble is what the model reaches for when a connector call fails.
    assert "manage_connections" in entitled
    # check_fn keeps it off non-entitled sessions — today's behavior, unchanged.
    assert "manage_connections" not in signed_out


def test_tool_is_never_deferrable():
    from tools.tool_search import is_deferrable_tool_name

    # Core names short-circuit before the toolset check, so listing
    # "connections" in _DIRECT_SURFACE_TOOLSETS would be redundant.
    assert is_deferrable_tool_name("manage_connections") is False
