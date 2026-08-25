"""Behavior tests for tool_manage_connections.

DI-callable idiom: a fake client injected through manage_connections'
seams; no module mocks, no network.
"""

import json

from tools.connections_tool import manage_connections


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


def test_mcp_actions_delegate_to_setup_flow_without_callback():
    out = json.loads(
        manage_connections({"action": "install", "server": "linear"})
    )
    # No desktop callback in this context -> the existing terminal guidance.
    assert "hermes mcp install" in out["error"]
