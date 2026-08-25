#!/usr/bin/env python3
"""Manage remote connector accounts and local MCP servers.

``tool_manage_connections`` is the never-deferred surface for connection
lifecycle:

- ``status`` — which connectors exist for this account and whether each is
  connected (read-only).
- ``connect`` / ``reconnect`` — start (or restart) an authorization flow.
  The gateway returns a connect link, passed through UN-redacted: the model
  shows it to the user, who opens it in a browser. Each connector's
  ``instruction`` text is surfaced once per session, not on every call.
- ``install`` / ``enable`` / ``authorize`` — the existing local MCP setup
  flows, folded in from ``setup_mcp`` (desktop consent card; on other
  surfaces the same terminal guidance as before).

De-authentication is deliberately NOT exposed to the model: disconnecting
an account is a user decision, made in the portal dashboard.

Availability: gated by the portal sign-in the managed tools already use
(``check_fn``), so signed-out sessions see exactly today's behavior.
"""

import json
import logging
import threading
from typing import Any, Callable, Dict, List, Optional

from tools.registry import registry, tool_error

logger = logging.getLogger(__name__)

_CONNECTOR_ACTIONS = ("status", "connect", "reconnect")
_MCP_ACTIONS = ("install", "enable", "authorize")

# (session_id, connector) pairs whose `instruction` text has already been
# shown. Keyed per session, not per process: the gateway multiplexes many
# sessions through one process, and guidance suppressed for session A must
# still reach session B. Module-level dict + lock is the house idiom
# (browser_use `_pending_create_keys` precedent); an unknown session keys
# on "" and degrades to per-process, never crashes.
_seen_instructions: set = set()
_seen_instructions_lock = threading.Lock()


def _connectors_available() -> bool:
    try:
        from tools.tool_gateway.config import connectors_available

        return connectors_available()
    except Exception:
        return False


def _default_client():
    from tools.tool_gateway.client import ConnectorClient

    return ConnectorClient()


def manage_connections(
    args: Dict[str, Any],
    *,
    callback: Optional[Callable] = None,
    client_factory: Optional[Callable[[], Any]] = None,
    seen_instructions: Optional[set] = None,
    session_id: Optional[str] = None,
) -> str:
    """Dispatch one ``tool_manage_connections`` action. Returns a JSON string."""
    action = str(args.get("action") or "status").strip().lower()

    if action in _MCP_ACTIONS:
        from tools.setup_mcp_tool import setup_mcp_tool

        return setup_mcp_tool(
            server=str(args.get("server") or ""),
            action=action,
            reason=str(args.get("reason") or ""),
            callback=callback,
        )

    if action not in _CONNECTOR_ACTIONS:
        return tool_error(
            f"action must be one of {', '.join(_CONNECTOR_ACTIONS + _MCP_ACTIONS)}. "
            "Disconnecting an account is done by the user in the Nous Portal "
            "dashboard, not through this tool."
        )

    raw_connectors = args.get("connectors")
    if isinstance(raw_connectors, str):
        raw_connectors = [raw_connectors]
    connectors: List[str] = []
    if isinstance(raw_connectors, list):
        for c in raw_connectors:
            c = str(c or "").strip().lower()
            if c and c not in connectors:
                connectors.append(c)

    try:
        client = (client_factory or _default_client)()
        if action == "status":
            items = client.list_connectors()
            if connectors:
                wanted = set(connectors)
                items = [i for i in items if str(i.get("connector", "")).lower() in wanted]
            return json.dumps(
                {
                    "connectors": items,
                    "hint": (
                        "connected=false means calls to that connector will return "
                        "CONNECTION_REQUIRED. Use action 'connect' to get an "
                        "authorization link for the user."
                    ),
                },
                ensure_ascii=False,
            )

        if not connectors:
            return tool_error(
                f"'{action}' requires 'connectors': the connector slugs to authorize "
                "(e.g. [\"gmail\"]). Use action 'status' to list them."
            )
        response = client.connections(connectors, reinitiate=(action == "reconnect"))
        seen = seen_instructions if seen_instructions is not None else _seen_instructions
        results = []
        for entry in response.get("results", []):
            connector = str(entry.get("connector") or "")
            rendered: Dict[str, Any] = {
                "connector": connector,
                "status": entry.get("status"),
            }
            if entry.get("connect_url"):
                rendered["connect_url"] = entry["connect_url"]
                rendered["note"] = (
                    "Show this link to the user; they open it in a browser to "
                    "authorize. Retry the tool call after they finish."
                )
            instruction = entry.get("instruction")
            if instruction:
                seen_key = (str(session_id or ""), connector)
                with _seen_instructions_lock:
                    if seen_key not in seen:
                        seen.add(seen_key)
                        rendered["instruction"] = instruction
            results.append(rendered)
        return json.dumps(
            {"results": results, "summary": response.get("summary", {})},
            ensure_ascii=False,
        )
    except Exception as exc:
        # Registered tools go through the registry's catch-wrap, but keep the
        # message model-actionable rather than a raw traceback.
        logger.debug("manage_connections %s failed: %s", action, exc)
        return tool_error(
            f"The connector gateway request failed: {exc}. "
            "If this persists, the user can manage connections in the Nous Portal."
        )


TOOL_MANAGE_CONNECTIONS_SCHEMA = {
    "name": "tool_manage_connections",
    "description": (
        "Manage remote connector accounts (Gmail, Linear, Notion, ...) served "
        "through the tool gateway, and set up local MCP servers. Actions: "
        "'status' lists connectors and whether each is connected; 'connect' "
        "starts an authorization for the given connectors and returns a link "
        "for the USER to open in a browser (never open it yourself); "
        "'reconnect' restarts a broken authorization. When a connector tool "
        "call returns CONNECTION_REQUIRED, use 'connect' and show the link. "
        "For local MCP servers, 'install'/'enable'/'authorize' run the same "
        "flows as before (desktop consent card, or terminal guidance). "
        "Disconnecting accounts is done by the user in the Nous Portal."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": list(_CONNECTOR_ACTIONS + _MCP_ACTIONS),
                "description": "Defaults to status.",
            },
            "connectors": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Connector slugs for connect/reconnect (e.g. [\"gmail\"]); "
                    "optional filter for status."
                ),
            },
            "server": {
                "type": "string",
                "description": "MCP server name, for install/enable/authorize.",
            },
            "reason": {
                "type": "string",
                "description": "One short sentence shown on the MCP consent card.",
            },
        },
        "required": [],
    },
}


registry.register(
    name="tool_manage_connections",
    toolset="connections",
    schema=TOOL_MANAGE_CONNECTIONS_SCHEMA,
    handler=lambda args, **kw: manage_connections(
        args, callback=kw.get("callback"), session_id=kw.get("session_id")
    ),
    check_fn=_connectors_available,
    emoji="🔗",
)
