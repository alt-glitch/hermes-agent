"""Ordered deferred batches re-enter dispatch under each entry's real name."""

import json
import logging
from collections.abc import Mapping, Sequence
from dataclasses import asdict
from typing import Any

from tools.registry import tool_error
from tools.tool_gateway.config import MAX_CALLS_PER_DISPATCH
from tools.tool_gateway.merge import assemble_results, partition_calls

logger = logging.getLogger(__name__)


def dispatch_connector_call(name, arguments, tool_call_id):
    """Transport leg only; the caller owns the normal tool policy pipeline.

    Execution middleware wraps the actual I/O, so connector entries execute
    individually rather than queuing side effects after a policy callback returns.
    """
    from tools.tool_gateway.bridge import run_remote

    partition = partition_calls([{"name": name, "arguments": arguments}])
    entries = run_remote(partition.remote, tool_call_id, availability=None, client_factory=None)
    entry = entries[0]
    return json.dumps({key: value for key, value in entry.items() if key in {"response", "error"}},
                      ensure_ascii=False)


def dispatch_connector_batch(calls, ids, *, user_task, enabled_tools,
                             middleware_trace, enabled_toolsets, disabled_toolsets):
    """Execute local, remote, or mixed entries through their current owners.

    Local scope and schema validation happen before recursive core dispatch.
    Connector entries recurse directly, so request middleware, hooks, approval,
    execution middleware, and transport all see the composed entry name. A
    local handler result is a successful dispatch even when its payload has an
    ``error`` field; only dispatcher-owned refusals become error slots.
    """
    try:
        return _dispatch_connector_batch(
            calls,
            ids,
            user_task=user_task,
            enabled_tools=enabled_tools,
            middleware_trace=middleware_trace,
            enabled_toolsets=enabled_toolsets,
            disabled_toolsets=disabled_toolsets,
        )
    except Exception as exc:
        logger.warning("Deferred batch dispatch %s failed: %s", ids.tool_call_id, exc)
        return tool_error(f"tool_call batch dispatch failed internally: {exc}")


def _dispatch_connector_batch(calls, ids, *, user_task, enabled_tools,
                              middleware_trace, enabled_toolsets, disabled_toolsets):
    from model_tools import get_tool_definitions, handle_function_call
    from tools.interrupt import is_interrupted
    from tools import tool_search

    if not isinstance(calls, Sequence) or isinstance(calls, (str, bytes)) or not calls:
        return tool_error("calls is required and must contain at least one entry")
    if len(calls) > MAX_CALLS_PER_DISPATCH:
        return tool_error(f"too many calls: {len(calls)} > max {MAX_CALLS_PER_DISPATCH}. "
                          "Retry with fewer calls per batch.")
    partition = partition_calls(calls)
    entries = list(partition.errors)
    claimed = {entry["index"] for entry in entries}
    local_by_position = dict(partition.local)
    remote_by_position = {plan.position: plan for plan in partition.remote}
    current_defs = get_tool_definitions(
        enabled_toolsets=enabled_toolsets,
        disabled_toolsets=disabled_toolsets,
        quiet_mode=True,
        skip_tool_search_assembly=True,
    ) or []
    scoped_local = tool_search.scoped_deferrable_names(current_defs)
    defer_tools = tool_search.load_config_readonly().effective_defer_tools

    for position in range(len(calls)):
        if position in claimed:
            continue
        if is_interrupted():
            entries.extend(
                _interrupted_entries(calls, position, claimed)
            )
            break
        if position in local_by_position:
            entries.append(
                _dispatch_local(
                    position,
                    local_by_position[position],
                    scoped_local=scoped_local,
                    defer_tools=defer_tools,
                    ids=ids,
                    user_task=user_task,
                    enabled_tools=enabled_tools,
                    middleware_trace=middleware_trace,
                    enabled_toolsets=enabled_toolsets,
                    disabled_toolsets=disabled_toolsets,
                )
            )
        else:
            plan = remote_by_position[position]
            _executed, payload = _dispatch_entry(
                handle_function_call,
                plan.name,
                plan.arguments,
                ids=ids,
                user_task=user_task,
                enabled_tools=enabled_tools,
                middleware_trace=middleware_trace,
                enabled_toolsets=enabled_toolsets,
                disabled_toolsets=disabled_toolsets,
            )
            entries.append(_remote_entry(position, plan.name, payload))
    return json.dumps(assemble_results(len(calls), entries), ensure_ascii=False)


def _dispatch_local(position, call, *, scoped_local, defer_tools, ids, user_task,
                    enabled_tools, middleware_trace, enabled_toolsets, disabled_toolsets):
    from model_tools import _AGENT_LOOP_TOOLS, handle_function_call
    from tools import tool_search

    name = str(call.get("name") or "") if isinstance(call, Mapping) else ""
    arguments = call.get("arguments") if isinstance(call, Mapping) else None
    arguments = dict(arguments) if isinstance(arguments, Mapping) else {}
    if not tool_search.is_deferrable_tool_name(name, defer_tools):
        return _refusal_entry(
            position,
            name,
            tool_error(
                f"'{name}' is not a deferrable tool. If it appears in the model-facing "
                "tools list already, call it directly instead of via tool_call."
            ),
        )
    if name not in scoped_local:
        return _refusal_entry(
            position,
            name,
            tool_error(
                f"'{name}' is not available in this session. "
                "Use tool_search to find tools you can call."
            ),
        )
    validation_error = tool_search.validate_deferred_call_args(name, arguments)
    if validation_error is not None:
        return _refusal_entry(position, name, validation_error)
    if name in _AGENT_LOOP_TOOLS:
        return _refusal_entry(
            position,
            name,
            tool_error(f"{name} must be handled by the agent loop"),
        )
    executed, payload = _dispatch_entry(
        handle_function_call,
        name,
        arguments,
        ids=ids,
        user_task=user_task,
        enabled_tools=enabled_tools,
        middleware_trace=middleware_trace,
        enabled_toolsets=enabled_toolsets,
        disabled_toolsets=disabled_toolsets,
    )
    if not executed:
        return _refusal_entry(position, name, payload)
    return {"index": position, "name": name, "response": _parse_payload(payload)}


def _dispatch_entry(handle_function_call, name, arguments, *, ids, user_task,
                    enabled_tools, middleware_trace, enabled_toolsets, disabled_toolsets):
    # Wrapper-level skip flags describe only the wrapper, never its entries.
    execution_observed = []
    payload = handle_function_call(
        name,
        arguments,
        **asdict(ids),
        user_task=user_task,
        enabled_tools=enabled_tools,
        tool_request_middleware_trace=list(middleware_trace),
        skip_pre_tool_call_hook=False,
        skip_tool_request_middleware=False,
        skip_tool_execution_middleware=False,
        enabled_toolsets=enabled_toolsets,
        disabled_toolsets=disabled_toolsets,
        _execution_observed=execution_observed,
    )
    return bool(execution_observed), payload


def _remote_entry(position: int, name: str, payload: Any) -> dict[str, Any]:
    value = _parse_payload(payload)
    if isinstance(value, Mapping) and "error" in value:
        return {"index": position, "name": name, "error": _error_slot(value)}
    if isinstance(value, Mapping) and "response" in value:
        value = value["response"]
    return {"index": position, "name": name, "response": value}


def _refusal_entry(position: int, name: str, payload: Any) -> dict[str, Any]:
    return {
        "index": position,
        "name": name,
        "error": _error_slot(_parse_payload(payload)),
    }


def _error_slot(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, Mapping):
        return {"code": "TOOL_ERROR", "message": str(payload)}
    error = payload.get("error")
    if isinstance(error, Mapping):
        return dict(error)
    slot = dict(payload)
    slot.setdefault("message", str(error or "The tool call failed."))
    slot.setdefault("code", "TOOL_ERROR")
    return slot


def _parse_payload(payload: Any) -> Any:
    if isinstance(payload, str):
        try:
            return json.loads(payload)
        except ValueError:
            return payload
    return payload


def _interrupted_entries(calls, start: int, claimed: set[int]) -> list[dict[str, Any]]:
    entries = []
    for position in range(start, len(calls)):
        if position in claimed:
            continue
        call = calls[position]
        name = str(call.get("name") or "") if isinstance(call, Mapping) else ""
        entries.append(
            {
                "index": position,
                "name": name,
                "error": {
                    "code": "INTERRUPTED",
                    "message": "Stopped by the user before this call was made.",
                },
            }
        )
    return entries
