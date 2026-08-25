"""Behavior tests for the connector leg of the tool_search bridge.

DI-callable idiom (test_managed_tool_gateway.py precedent): remote legs are
injected as plain callables; no module mocks, no network. Local-only behavior
is pinned byte-identical when the remote leg fails (D32).
"""

import json

import pytest

from agent.tool_dispatch_helpers import _peel_bridge_call
from tools.tool_gateway.bridge import connector_describe, dispatch_calls
from tools.tool_search import (
    CONNECTOR_BATCH_SENTINEL,
    dispatch_tool_describe,
    dispatch_tool_search,
    normalize_tool_call_entries,
    resolve_underlying_call,
)


def _local_defs():
    """One deferrable (mcp-toolset) tool, one core-shaped tool."""
    return [
        {
            "type": "function",
            "function": {
                "name": "mcp__github__create_issue",
                "description": "Create a GitHub issue",
                "parameters": {"type": "object", "properties": {}, "required": ["title"]},
            },
        },
    ]


# ---------------------------------------------------------------------------
# resolve_underlying_call: batch shapes
# ---------------------------------------------------------------------------


def test_resolve_single_connector_entry_returns_sentinel():
    name, args, err = resolve_underlying_call(
        {"calls": [{"name": "connectors__gmail__GMAIL_SEND_EMAIL", "arguments": {"to": "x"}}]}
    )
    assert err is None
    assert name == CONNECTOR_BATCH_SENTINEL
    assert args["calls"][0]["name"] == "connectors__gmail__GMAIL_SEND_EMAIL"
    assert args["calls"][0]["arguments"] == {"to": "x"}


def test_resolve_multi_entry_batch_returns_sentinel_even_all_local():
    name, args, err = resolve_underlying_call(
        {"calls": [
            {"name": "some_local_tool", "arguments": {}},
            {"name": "another_local", "arguments": {}},
        ]}
    )
    assert err is None
    assert name == CONNECTOR_BATCH_SENTINEL
    assert [e["name"] for e in args["calls"]] == ["some_local_tool", "another_local"]


def test_resolve_legacy_single_shape_unchanged_for_local_names():
    # Non-deferrable local name keeps the historical rejection message.
    name, args, err = resolve_underlying_call({"name": "not_a_real_tool", "arguments": {}})
    assert name is None
    assert "not a deferrable tool" in (err or "")


def test_resolve_legacy_connector_single_shape_routes_to_sentinel():
    name, args, err = resolve_underlying_call(
        {"name": "connectors__gmail__GMAIL_CREATE_EMAIL_DRAFT", "arguments": {}}
    )
    assert err is None
    assert name == CONNECTOR_BATCH_SENTINEL
    assert len(args["calls"]) == 1


@pytest.mark.parametrize(
    "bad,expected_fragment",
    [
        ({}, "requires 'calls'"),
        ({"calls": []}, "non-empty array"),
        ({"calls": [{"arguments": {}}]}, "requires a 'name'"),
        ({"calls": [{"name": "tool_search"}]}, "itself a bridge tool"),
        ({"calls": [{"name": "x", "arguments": "not json {"}]}, "not valid JSON"),
        ({"calls": [{"name": "x", "arguments": 42}]}, "must be an object"),
        ({"calls": "nope"}, "non-empty array"),
    ],
)
def test_normalize_rejects_malformed_batches(bad, expected_fragment):
    entries, err = normalize_tool_call_entries(bad)
    assert entries == []
    assert expected_fragment in (err or "")


# ---------------------------------------------------------------------------
# dispatch_tool_search: remote merge
# ---------------------------------------------------------------------------


def _fake_connector_search(queries):
    assert queries == [{"use_case": "send an email"}]
    return {
        "results": [
            {"index": 1, "use_case": "send an email", "tools": ["GMAIL_SEND_EMAIL", "ORPHAN_TOOL"]},
        ],
        "schemas": {
            "GMAIL_SEND_EMAIL": {
                "connector": "gmail",
                "tool": "GMAIL_SEND_EMAIL",
                "description": "Send an email via gmail",
                "input_schema": {"type": "object", "required": ["to", "subject"]},
            },
            # ORPHAN_TOOL deliberately has no schema entry: without a
            # connector it cannot compose a callable name and must be dropped.
        },
        "connections": [{"connector": "gmail", "connected": False, "description": ""}],
    }


def test_search_composes_lowercase_connector_from_vendor_cased_schema():
    # The gateway search surface leaks vendor-cased connector slugs for
    # custom toolkits; the composed name must carry the lowercase catalog
    # form or the gateway's own policy gates refuse the call.
    def cased_search(queries):
        return {
            "results": [{"index": 1, "tools": ["CUSTOM_X_READ"]}],
            "schemas": {
                "CUSTOM_X_READ": {
                    "connector": "CUSTOM_X",
                    "tool": "CUSTOM_X_READ",
                    "description": "d",
                    "input_schema": {},
                }
            },
        }

    out = json.loads(
        dispatch_tool_search(
            {"queries": ["anything"]},
            current_tool_defs=_local_defs(),
            connector_search=cased_search,
        )
    )
    assert "connectors__custom_x__CUSTOM_X_READ" in out["results"][0]["matches"]


def test_search_merges_remote_hits_tagged_as_connectors():
    out = json.loads(
        dispatch_tool_search(
            {"queries": ["send an email"]},
            current_tool_defs=_local_defs(),
            connector_search=_fake_connector_search,
        )
    )
    matches = out["results"][0]["matches"]
    composed = "connectors__gmail__GMAIL_SEND_EMAIL"
    assert composed in matches
    assert all("ORPHAN_TOOL" not in m for m in matches)
    record = out["tools"][composed]
    assert record["source"] == "connectors"
    assert record["source_name"] == "gmail"
    assert record["required"] == ["to", "subject"]


def test_search_remote_leg_respects_per_query_limit_and_counts_total():
    def many_hits(queries):
        slugs = [f"CUSTOM_X_TOOL_{i}" for i in range(9)]
        return {
            "results": [{"index": 1, "tools": slugs}],
            "schemas": {
                s: {"connector": "custom_x", "tool": s, "description": "d", "input_schema": {}}
                for s in slugs
            },
        }

    out = json.loads(
        dispatch_tool_search(
            {"queries": ["anything"], "limit": 3},
            current_tool_defs=_local_defs(),
            connector_search=many_hits,
        )
    )
    matches = out["results"][0]["matches"]
    assert len(matches) == 3  # limit is the per-query cap across BOTH legs
    assert all(m.startswith("connectors__") for m in matches)
    # total_available counts merged remote tools on top of the local catalog
    # (empty here: the fake def is not registry-backed in this test env).
    assert out["total_available"] == 3


def test_search_drops_remote_group_with_mismatched_use_case_echo():
    def misaligned(queries):
        return {
            "results": [{"index": 1, "use_case": "SOMETHING ELSE", "tools": ["CUSTOM_X_READ"]}],
            "schemas": {
                "CUSTOM_X_READ": {"connector": "custom_x", "tool": "CUSTOM_X_READ", "description": "d", "input_schema": {}}
            },
        }

    out = json.loads(
        dispatch_tool_search(
            {"queries": ["send an email"]},
            current_tool_defs=_local_defs(),
            connector_search=misaligned,
        )
    )
    assert not any(m.startswith("connectors__") for m in out["results"][0]["matches"])


def test_search_identical_to_local_only_when_remote_leg_fails():
    def exploding_search(queries):
        raise RuntimeError("gateway exploded")

    local_only = dispatch_tool_search(
        {"queries": ["send an email"]},
        current_tool_defs=_local_defs(),
        connector_search=lambda queries: {},
    )
    with_failure = dispatch_tool_search(
        {"queries": ["send an email"]},
        current_tool_defs=_local_defs(),
        connector_search=exploding_search,
    )
    assert local_only == with_failure  # byte-identical: D32


# ---------------------------------------------------------------------------
# dispatch_tool_describe: remote merge
# ---------------------------------------------------------------------------


def test_describe_merges_remote_schema_and_leaves_misses_in_not_found():
    composed = "connectors__gmail__GMAIL_SEND_EMAIL"
    stale = "connectors__gmail__GMAIL_GONE_TOOL"

    def fake_describe(names):
        assert set(names) == {composed, stale}
        return {"tools": {composed: {"description": "Send an email", "parameters": {"type": "object"}}}}

    out = json.loads(
        dispatch_tool_describe(
            {"names": [composed, stale]},
            current_tool_defs=_local_defs(),
            connector_describe=fake_describe,
        )
    )
    assert out["tools"][composed]["parameters"] == {"type": "object"}
    assert stale in out["not_found"]
    assert "errors" not in out  # a connector miss is stale/unknown, not an error


def test_describe_connector_names_fall_to_not_found_when_dark():
    composed = "connectors__gmail__GMAIL_SEND_EMAIL"
    out = json.loads(
        dispatch_tool_describe(
            {"names": [composed]},
            current_tool_defs=_local_defs(),
            connector_describe=lambda names: {},
        )
    )
    assert out["not_found"] == [composed]


# ---------------------------------------------------------------------------
# planner admission: only PURE connector batches are parallel-safe
# ---------------------------------------------------------------------------


def test_peel_admits_pure_connector_batch_as_sentinel():
    name, args = _peel_bridge_call(
        "tool_call",
        {"calls": [
            {"name": "connectors__gmail__GMAIL_SEND_EMAIL", "arguments": {}},
            {"name": "connectors__slack__SLACK_POST_MESSAGE", "arguments": {}},
        ]},
    )
    assert name == CONNECTOR_BATCH_SENTINEL


def test_peel_keeps_mixed_and_local_batches_as_sequential_barrier():
    mixed = {"calls": [
        {"name": "connectors__gmail__GMAIL_SEND_EMAIL", "arguments": {}},
        {"name": "write_file", "arguments": {"path": "x"}},
    ]}
    name, args = _peel_bridge_call("tool_call", mixed)
    assert name == "tool_call"  # barrier: local entries never got admission

    all_local = {"calls": [
        {"name": "write_file", "arguments": {"path": "x"}},
        {"name": "read_file", "arguments": {"path": "x"}},
    ]}
    name, _ = _peel_bridge_call("tool_call", all_local)
    assert name == "tool_call"


# ---------------------------------------------------------------------------
# dispatch_calls: per-entry gates
# ---------------------------------------------------------------------------


def test_pre_dispatch_block_denies_one_remote_entry_and_siblings_run():
    class FakeClient:
        def execute(self, planned):
            assert [p.name for p in planned] == ["connectors__slack__SLACK_POST_MESSAGE"]
            return [{"data": "posted", "error": None}]

    out = json.loads(
        dispatch_calls(
            [
                {"name": "connectors__gmail__GMAIL_SEND_EMAIL", "arguments": {}},
                {"name": "connectors__slack__SLACK_POST_MESSAGE", "arguments": {}},
            ],
            local_dispatch=lambda n, a: "{}",
            pre_dispatch=lambda name, args: (
                "blocked by policy" if "gmail" in name else None
            ),
            availability=lambda: True,
            client_factory=lambda: FakeClient(),
        )
    )
    assert out["results"][0]["error"]["code"] == "USER_DENIED"
    assert out["results"][1]["response"] == "posted"
    assert out["success_count"] == 1 and out["error_count"] == 1


def test_local_tool_error_results_are_counted_as_errors():
    def local_dispatch(name, arguments):
        return json.dumps({"error": f"'{name}' is not available in this session."})

    out = json.loads(
        dispatch_calls(
            [
                {"name": "denied_tool", "arguments": {}},
                {"name": "another_denied", "arguments": {}},
            ],
            local_dispatch=local_dispatch,
        )
    )
    assert all(e["error"]["code"] == "TOOL_ERROR" for e in out["results"])
    assert out["error_count"] == 2 and out["success_count"] == 0


# ---------------------------------------------------------------------------
# bridge.connector_describe: composed-name round trip
# ---------------------------------------------------------------------------


def test_connector_describe_maps_slugs_back_to_composed_names():
    class FakeClient:
        def schemas(self, slugs):
            assert slugs == ["GMAIL_SEND_EMAIL"]
            return {
                "schemas": {
                    "GMAIL_SEND_EMAIL": {
                        "connector": "gmail",
                        "tool": "GMAIL_SEND_EMAIL",
                        "description": "Send an email",
                        "input_schema": {"type": "object"},
                    }
                },
                "not_found": [],
            }

    out = connector_describe(
        ["connectors__gmail__GMAIL_SEND_EMAIL", "connectors__broken"],
        availability=lambda: True,
        client_factory=lambda: FakeClient(),
    )
    assert out["tools"]["connectors__gmail__GMAIL_SEND_EMAIL"]["parameters"] == {"type": "object"}


def test_connector_describe_is_empty_on_unavailable_and_exploding_client():
    assert connector_describe(["connectors__g__T"], availability=lambda: False) == {}

    def boom():
        raise RuntimeError("boom")

    assert connector_describe(
        ["connectors__g__T"], availability=lambda: True, client_factory=boom
    ) == {}
