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


def _session_tool_names(enabled_toolsets, *, connectors, disabled_toolsets=None):
    """Tool names a session would actually receive, through the real assembly.

    Skips the tool_search step so the assertion is about NAME resolution and
    check_fn, not about how many MCP servers the developer running the suite
    happens to have configured.
    """
    from model_tools import _compute_tool_definitions
    from tools.registry import invalidate_check_fn_cache

    with patch("tools.tool_gateway.config.connectors_available",
               return_value=connectors):
        invalidate_check_fn_cache()
        try:
            defs = _compute_tool_definitions(
                enabled_toolsets=enabled_toolsets,
                disabled_toolsets=disabled_toolsets,
                quiet_mode=True,
                skip_tool_search_assembly=True,
            )
        finally:
            invalidate_check_fn_cache()
    return {d["function"]["name"] for d in defs}


def test_bundle_membership_is_not_evidence_of_reachability():
    """Pins the trap that let the first fix ship broken.

    The tool registers into the toolset "connections", which lives only in the
    registry — never in TOOLSETS. Membership in _HERMES_CORE_TOOLS puts the
    NAME inside every hermes-* composite, and asserting that was mistaken for
    proof that sessions could call it. They could not: no production caller
    passes a composite name. Every reachability assertion below therefore goes
    through the real per-platform resolution instead.
    """
    from toolsets import TOOLSETS, resolve_toolset

    assert "connections" not in TOOLSETS  # registry-only; no platform can list it
    for bundle in ("hermes-cli", "hermes-cron", "hermes-gateway", "hermes-telegram"):
        assert "manage_connections" in resolve_toolset(bundle), bundle
    # And the narrow/posture bundles genuinely do not carry it — which is why
    # reachability cannot be a property of the bundle.
    for bundle in ("coding", "hermes-acp", "hermes-webhook", "hermes-api-server"):
        assert "manage_connections" not in resolve_toolset(bundle), bundle


def test_cli_session_gets_the_tool_outside_a_code_workspace(tmp_path, monkeypatch):
    """The path a plain `hermes` run takes: _get_platform_tools, no git cwd."""
    from hermes_cli.tools_config import _get_platform_tools

    monkeypatch.chdir(tmp_path)
    enabled = sorted(_get_platform_tools({}, "cli", include_default_mcp_servers=True))

    # The mechanism, pinned: the resolver hands back per-capability names and
    # cannot emit the registry-only "connections" toolset. If this ever starts
    # failing, reachability moved back into name resolution and the injection
    # in _compute_tool_definitions is no longer what is doing the work.
    assert "connections" not in enabled
    assert "manage_connections" in _session_tool_names(enabled, connectors=True)


def test_cli_session_gets_the_tool_inside_a_code_workspace(monkeypatch):
    """Same resolver, run from this repo — the surface the live miss was on."""
    from pathlib import Path

    from hermes_cli.tools_config import _get_platform_tools

    monkeypatch.chdir(Path(__file__).resolve().parents[2])
    enabled = sorted(_get_platform_tools({}, "cli", include_default_mcp_servers=True))
    assert "manage_connections" in _session_tool_names(enabled, connectors=True)


def test_tui_and_desktop_sessions_get_the_tool(monkeypatch):
    """The path the TUI/desktop gateway takes to build its selection."""
    from tui_gateway.server import _load_enabled_toolsets

    monkeypatch.delenv("HERMES_TUI_TOOLSETS", raising=False)
    for platform in ("tui", "desktop"):
        selection = _load_enabled_toolsets(platform)
        names = _session_tool_names(selection, connectors=True)
        assert "manage_connections" in names, platform


def test_focus_mode_coding_posture_gets_the_tool(monkeypatch):
    """An engineer pinned to the coding posture still sees their accounts."""
    from pathlib import Path

    from agent.coding_context import coding_selection

    repo = Path(__file__).resolve().parents[2]
    monkeypatch.chdir(repo)
    selection = coding_selection(
        platform="cli", cwd=str(repo), config={"agent": {"coding_context": "focus"}}
    )
    assert selection == ["coding"]  # posture collapse still collapses
    assert "manage_connections" in _session_tool_names(selection, connectors=True)


def test_signed_out_session_sees_nothing(tmp_path, monkeypatch):
    """check_fn is the only entitlement gate, on every surface."""
    from hermes_cli.tools_config import _get_platform_tools
    from tui_gateway.server import _load_enabled_toolsets

    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("HERMES_TUI_TOOLSETS", raising=False)
    selections = [
        sorted(_get_platform_tools({}, "cli", include_default_mcp_servers=True)),
        _load_enabled_toolsets("tui"),
        ["coding"],
    ]
    for selection in selections:
        assert "manage_connections" not in _session_tool_names(
            selection, connectors=False
        ), selection


def test_operator_can_still_turn_it_off(tmp_path, monkeypatch):
    """`agent.disabled_toolsets: [connections]` wins; a bundle name does not.

    The name is added before the disabled subtraction, so the toolset behaves
    like any other. Naming a platform composite instead must NOT strip it —
    that branch preserves core tools on purpose (#33924).
    """
    from hermes_cli.tools_config import _get_platform_tools

    monkeypatch.chdir(tmp_path)
    enabled = sorted(_get_platform_tools({}, "cli", include_default_mcp_servers=True))

    assert "manage_connections" not in _session_tool_names(
        enabled, connectors=True, disabled_toolsets=["connections"]
    )
    assert "manage_connections" in _session_tool_names(
        enabled, connectors=True, disabled_toolsets=["hermes-cli"]
    )


def test_tool_is_never_deferrable():
    from tools.tool_search import is_deferrable_tool_name

    # Core names short-circuit before the toolset check, so listing
    # "connections" in _DIRECT_SURFACE_TOOLSETS would be redundant.
    assert is_deferrable_tool_name("manage_connections") is False
