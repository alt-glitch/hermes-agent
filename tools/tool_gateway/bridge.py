"""The one module core code imports for connector dispatch.

Every entry point here is TOTAL: it catches its own exceptions and returns a
structured value, because the bridge branch in core dispatch bypasses the
registry's catch-wrap — an exception escaping this module is a bug, full
stop.

Per-entry policy runs through two injected seams: ``local_dispatch`` (local
entries recurse into core dispatch, where scope/probe/hook/middleware gates
fire against each real tool name) and ``pre_dispatch`` (remote entries get
the caller's hook/approval pass against their composed ``connectors__``
names; a block pre-fills that entry's ``USER_DENIED`` slot and its siblings
still run). The bridge itself only partitions, gates, dispatches, splices.

Dispatch shape (V1, decided 2026-08-25): local entries run via the injected
``local_dispatch``; ALL connector entries travel as ONE gateway execute
request. Split dispatch while approvals pend is a tracked follow-up, not
this code.

Silent degradation (D32): on the availability path (:func:`connector_search_hits`)
every failure returns ``{}`` — signed out, config off, or a dark gateway must
leave tool_search behaving exactly as it does today.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable, Optional, Sequence

from tools.tool_gateway.config import MAX_CALLS_PER_DISPATCH, connectors_available
from tools.tool_gateway.errors import GatewayUnavailable, ToolGatewayError
from tools.tool_gateway.merge import (
    assemble_results,
    fill_remote_failure,
    partition_calls,
    splice_remote_results,
)
from tools.tool_gateway.names import parse_connector_name

logger = logging.getLogger(__name__)

__all__ = ["connector_describe", "connector_search_hits", "dispatch_calls"]

# Signature of the injected local dispatcher: (name, arguments) -> result str.
LocalDispatch = Callable[[str, dict[str, Any]], str]


def _default_client_factory():
    from tools.tool_gateway.client import ConnectorClient

    return ConnectorClient()


def connector_search_hits(
    queries: Sequence[dict[str, Any]],
    *,
    availability: Optional[Callable[[], bool]] = None,
    client_factory: Optional[Callable[[], Any]] = None,
) -> dict[str, Any]:
    """Remote hits for tool_search, or ``{}`` on EVERY failure path (D32).

    A connector problem must never change local search behavior: the caller
    treats ``{}`` as "no remote results" and proceeds exactly as today.
    """
    try:
        available = (availability or connectors_available)()
        if not available or not queries:
            return {}
        client = (client_factory or _default_client_factory)()
        return client.search(list(queries)) or {}
    except GatewayUnavailable:
        # Connectors dark for this principal — the expected quiet path.
        logger.debug("Connector search skipped: gateway dark")
        return {}
    except Exception as exc:
        logger.debug("Connector search failed silently (D32): %s", exc)
        return {}


def connector_describe(
    names: Sequence[str],
    *,
    availability: Optional[Callable[[], bool]] = None,
    client_factory: Optional[Callable[[], Any]] = None,
) -> dict[str, Any]:
    """Schemas for ``connectors__*`` names, or ``{}`` on EVERY failure path (D32).

    Returns ``{"tools": {<composed name>: {"description", "parameters"}}}``
    keyed by the ORIGINAL composed names. Names the gateway does not resolve
    are simply absent — the caller's not_found handling covers them. The
    gateway's schemas route takes bare tool slugs; composition back to the
    ``connectors__`` name uses the caller's own parse, never the response.
    """
    try:
        available = (availability or connectors_available)()
        if not available:
            return {}
        by_slug: dict[str, str] = {}
        for name in names:
            parsed = parse_connector_name(name)
            if parsed is not None:
                # First composed name wins for a duplicated slug.
                by_slug.setdefault(parsed.tool, parsed.raw)
        if not by_slug:
            return {}
        client = (client_factory or _default_client_factory)()
        response = client.schemas(list(by_slug)) or {}
        schemas = response.get("schemas") if isinstance(response.get("schemas"), dict) else {}
        tools: dict[str, Any] = {}
        for slug, schema in schemas.items():
            composed = by_slug.get(slug)
            if composed is None or not isinstance(schema, dict):
                continue
            tools[composed] = {
                "description": str(schema.get("description") or ""),
                "parameters": schema.get("input_schema") or {},
            }
        return {"tools": tools}
    except GatewayUnavailable:
        logger.debug("Connector describe skipped: gateway dark")
        return {}
    except Exception as exc:
        logger.debug("Connector describe failed silently (D32): %s", exc)
        return {}


def dispatch_calls(
    calls: Sequence[Any],
    dispatch_id: Optional[str] = None,
    *,
    local_dispatch: LocalDispatch,
    pre_dispatch: Optional[Callable[[str, dict], Optional[str]]] = None,
    availability: Optional[Callable[[], bool]] = None,
    client_factory: Optional[Callable[[], Any]] = None,
) -> str:
    """Run a mixed ``calls[]`` batch and return the merged results envelope.

    Total: any internal failure becomes per-entry errors or an envelope-level
    ``{"error": ...}`` string — never an exception. ``local_dispatch`` is
    injected so this module never imports core dispatch code.

    ``pre_dispatch`` is the caller's per-REMOTE-entry gate (hooks/approval):
    called with (name, arguments) before the gateway request is built; a
    non-None return is that entry's block message — the entry is pre-filled
    as a ``USER_DENIED`` error slot and excluded from the remote batch while
    its siblings still run. Local entries gate inside ``local_dispatch``.
    """
    try:
        return _dispatch_calls_inner(
            calls,
            dispatch_id,
            local_dispatch=local_dispatch,
            pre_dispatch=pre_dispatch,
            availability=availability,
            client_factory=client_factory,
        )
    except Exception as exc:  # the bridge branch has no catch-wrap above us
        logger.warning("Connector dispatch %s failed: %s", dispatch_id, exc)
        return json.dumps(
            {"error": f"tool_call batch dispatch failed internally: {exc}"}
        )


def _dispatch_calls_inner(
    calls: Sequence[Any],
    dispatch_id: Optional[str],
    *,
    local_dispatch: LocalDispatch,
    pre_dispatch: Optional[Callable[[str, dict], Optional[str]]],
    availability: Optional[Callable[[], bool]],
    client_factory: Optional[Callable[[], Any]],
) -> str:
    if not isinstance(calls, Sequence) or isinstance(calls, (str, bytes)) or not calls:
        return json.dumps(
            {"error": "calls is required and must contain at least one entry"}
        )
    if len(calls) > MAX_CALLS_PER_DISPATCH:
        # Same refusal shape as tool_search's "too many queries".
        return json.dumps(
            {
                "error": (
                    f"too many calls: {len(calls)} > max {MAX_CALLS_PER_DISPATCH}. "
                    "Retry with fewer calls per batch."
                )
            }
        )

    partition = partition_calls(calls)

    local_entries = [
        _run_local(local_dispatch, position, call)
        for position, call in partition.local
    ]

    # The caller's per-entry gate (hooks/approval) runs before anything is
    # sent: a blocked entry becomes a USER_DENIED slot, siblings still run.
    denied_entries: list[dict[str, Any]] = []
    surviving = list(partition.remote)
    if pre_dispatch is not None and surviving:
        kept = []
        for plan in surviving:
            try:
                block = pre_dispatch(plan.name, dict(plan.arguments))
            except Exception as exc:
                logger.debug("pre_dispatch gate failed open for %s: %s", plan.name, exc)
                block = None
            if block is None:
                kept.append(plan)
            else:
                denied_entries.append(
                    {
                        "index": plan.position,
                        "name": plan.name,
                        "error": {"code": "USER_DENIED", "message": str(block)},
                    }
                )
        surviving = kept

    remote_entries: list[dict[str, Any]] = []
    if surviving:
        remote_entries = _run_remote(
            surviving,
            dispatch_id,
            availability=availability,
            client_factory=client_factory,
        )

    return json.dumps(
        assemble_results(
            len(calls), local_entries, remote_entries, denied_entries, partition.errors
        ),
        ensure_ascii=False,
    )


def _run_local(
    local_dispatch: LocalDispatch, position: int, call: Any
) -> dict[str, Any]:
    name = str(call.get("name") or "") if isinstance(call, dict) else ""
    arguments = call.get("arguments") if isinstance(call, dict) else None
    try:
        raw = local_dispatch(name, arguments if isinstance(arguments, dict) else {})
        parsed = _maybe_parse_json(raw)
        if isinstance(parsed, dict) and parsed.get("error") is not None:
            # A tool_error-shaped result (scope refusal, probe validation,
            # tool failure) is an ERROR slot — filing it under "response"
            # would count a denied call as a success.
            error_payload: dict[str, Any] = {
                "code": "TOOL_ERROR",
                "message": str(parsed.get("error")),
            }
            for extra in ("parameters", "hint"):
                if extra in parsed:
                    error_payload[extra] = parsed[extra]
            return {"index": position, "name": name, "error": error_payload}
        return {"index": position, "name": name, "response": parsed}
    except Exception as exc:
        # Core dispatch wraps its own errors; reaching here means the injected
        # dispatcher itself blew up. Keep it to this entry.
        return {
            "index": position,
            "name": name,
            "error": {"code": "TOOL_ERROR", "message": str(exc)},
        }


def _run_remote(
    planned,
    dispatch_id: Optional[str],
    *,
    availability: Optional[Callable[[], bool]],
    client_factory: Optional[Callable[[], Any]],
) -> list[dict[str, Any]]:
    try:
        available = (availability or connectors_available)()
    except Exception:
        available = False
    if not available:
        # The model addressed connector names while connectors are off/dark —
        # per-entry unknown-tool errors, exactly like any unknown tool name.
        return fill_remote_failure(
            planned,
            "Unknown tool: connectors are not available in this session.",
            code="TOOL_NOT_FOUND",
        )

    try:
        client = (client_factory or _default_client_factory)()
        remote_results = client.execute(planned)
        return splice_remote_results(planned, remote_results)
    except ToolGatewayError as exc:
        logger.debug(
            "Connector execute for dispatch %s failed (%s): %s",
            dispatch_id,
            exc.code,
            exc,
        )
        return fill_remote_failure(
            planned, f"The connector gateway request failed: {exc}"
        )
    except Exception as exc:
        logger.warning(
            "Connector execute for dispatch %s failed unexpectedly: %s",
            dispatch_id,
            exc,
        )
        return fill_remote_failure(
            planned, "The connector gateway request failed unexpectedly."
        )


def _maybe_parse_json(raw: Any) -> Any:
    """Embed structured tool results structurally; leave other strings alone."""
    if isinstance(raw, str):
        text = raw.strip()
        if text.startswith("{") or text.startswith("["):
            try:
                return json.loads(text)
            except ValueError:
                return raw
    return raw
