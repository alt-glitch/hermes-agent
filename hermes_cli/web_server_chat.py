"""Chat/terminal WebSocket plumbing: PTY bridge selection and registry, WS
client/origin/auth gates, chat argv resolution, gateway/sidecar URL building.
"""

import logging
import asyncio
import atexit
import concurrent.futures
import contextlib
import hmac
import os
import re
import sys
import tempfile
import threading
import urllib.request
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pathlib import Path
from typing import Optional
from hermes_cli.pty_session import PtySessionRegistry

# Same logger the code used before extraction (record parity).
_log = logging.getLogger("hermes_cli.web_server")


# /api/pty spawns ``hermes --tui`` behind a pseudo-terminal and forwards bytes +
# resize escapes to xterm.js.  POSIX uses pty_bridge (fcntl/termios); native
# Windows uses win_pty_bridge (pywinpty/ConPTY); same surface, no handler guards.
try:
    if sys.platform.startswith("win"):
        from hermes_cli.win_pty_bridge import WinPtyBridge as PtyBridge, PtyUnavailableError
    else:
        from hermes_cli.pty_bridge import PtyBridge, PtyUnavailableError
    _PTY_BRIDGE_AVAILABLE = True
except ImportError:  # pragma: no cover - pywinpty / ptyprocess missing
    PtyBridge = None  # type: ignore[assignment]
    _PTY_BRIDGE_AVAILABLE = False

    class PtyUnavailableError(RuntimeError):  # type: ignore[no-redef]
        """Stub when the platform PTY bridge cannot be imported."""
_RESIZE_RE = re.compile(rb"\x1b\[RESIZE:(\d+);(\d+)\]")
_PTY_READ_CHUNK_TIMEOUT = 0.2

# Back-off between idle PTY reads so a quiet terminal does not spin the event
# loop (keeps dashboard idle CPU low).
# A positive sleep lets other coroutines run and keeps dashboard idle CPU low (#42627).
_PTY_IDLE_BACKOFF = 0.05
PTY_REGISTRY = PtySessionRegistry(
    ttl=30 * 60, max_sessions=16, buffer_cap=1 * 1024 * 1024, read_timeout=_PTY_READ_CHUNK_TIMEOUT)


async def _close_stalled_pty_input(ws: "WebSocket", *, path: str) -> None:
    """Close only the terminal socket when its child stops accepting input."""
    _log.warning("pty input stalled path=%s; recycling terminal session", path)
    try:
        await ws.close(code=1013, reason="PTY input stalled")
    except Exception:
        pass


async def _legacy_pump(ws: "WebSocket", bridge) -> None:
    """Original 1:1 socket<->PTY pump: stream until disconnect, then close the
    bridge. Used when no ``?attach=`` token is supplied (keep-alive opt-in).

    Behavior is identical to the pre-keep-alive ``pty_ws`` body, including the 54028 half-open-socket
    protection (reader EOF → close the WS so the writer's ``ws.receive()`` unparks) and the #53227
    ``to_thread`` offloads for the blocking ``bridge.close()``.
    """
    loop = asyncio.get_running_loop()

    async def pump_pty_to_ws() -> None:
        try:
            while True:
                chunk = await loop.run_in_executor(None, bridge.read, _PTY_READ_CHUNK_TIMEOUT)
                if chunk is None:  # EOF
                    return
                if not chunk:  # no data this tick; yield control and retry
                    await asyncio.sleep(_PTY_IDLE_BACKOFF)
                    continue
                try:
                    await ws.send_bytes(chunk)
                except Exception:
                    return
        finally:
            # Close the WS so the writer's ``ws.receive()`` returns instead of
            # blocking forever on a half-open browser socket (fds would leak and
            # auto-reconnect stacks a fresh PTY on each orphan).  Reap the bridge
            # here too (idempotent): cancelling the handler the instant the WS
            # closes can skip the writer's ``finally``.
            with contextlib.suppress(Exception):
                # The child has exited (EOF) or the send side broke. Closing from the EOF path makes the
                # reap independent of that cancellation race (#54028).
                await asyncio.to_thread(bridge.close)
            with contextlib.suppress(Exception):
                await ws.close()

    reader_task = asyncio.create_task(pump_pty_to_ws())

    try:
        while True:
            try:
                msg = await ws.receive()
            except RuntimeError:
                # ws.receive() after the socket is already disconnected
                # (e.g. closed by the reader task above).
                break
            if msg.get("type") == "websocket.disconnect":
                break
            raw = msg.get("bytes")
            if raw is None:
                text = msg.get("text")
                raw = text.encode("utf-8") if isinstance(text, str) else b""
            if not raw:
                continue
            # Resize escape is consumed locally, never written to the PTY.
            match = _RESIZE_RE.match(raw)
            if match and match.end() == len(raw):
                bridge.resize(cols=int(match.group(1)), rows=int(match.group(2)))
                continue
            if not await bridge.write(raw):
                await _close_stalled_pty_input(ws, path="legacy")
                break
    except WebSocketDisconnect:
        pass
    finally:
        reader_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await reader_task
        await asyncio.to_thread(bridge.close)


# Starlette's TestClient reports the peer as "testclient"; treat it as
# loopback so tests don't need to rewrite request scope.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost", "testclient"})


def _ws_client_reason(ws: "WebSocket") -> Optional[str]:
    """Return a rejection reason token for the peer IP, or None when allowed.

    Loopback bind: only loopback peers (the legacy ``?token=`` is the only auth,
    LAN hosts must not get to guess it); an empty peer fails closed.  Explicit
    non-loopback bind (``--insecure``) or gated mode: any peer — DNS-rebinding is
    blocked by :func:`_ws_host_origin_reason`, and in gated mode
    ``ws.client.host`` is the X-Forwarded-For value anyway.
    """
    from hermes_cli.web_server import app
    if getattr(app.state, "auth_required", False):
        return None
    bound_host = (getattr(app.state, "bound_host", "") or "").strip().lower()
    if bound_host and bound_host not in _LOOPBACK_HOSTS:
        return None
    client_host = ws.client.host if ws.client else ""
    if not client_host:
        return f"missing_or_empty_peer bound={bound_host or '?'}"
    if client_host in _LOOPBACK_HOSTS:
        return None
    return f"peer_not_loopback peer={client_host} bound={bound_host or '?'}"


def _ws_client_is_allowed(ws: "WebSocket") -> bool:
    """True when the peer IP passes :func:`_ws_client_reason`."""
    return _ws_client_reason(ws) is None


def _ws_host_origin_reason(ws: "WebSocket") -> Optional[str]:
    """Return ``host_mismatch …`` / ``origin_mismatch …``, or None when allowed.

    HTTP middleware does not run for WebSocket routes, so the DNS-rebinding
    Host check is repeated here; an Origin header, when present, must target the
    bound host.  Non-web origins (packaged Electron: file://, null, app://) are
    trusted — the credential check is the real auth boundary there.
    """
    from hermes_cli.web_server import _is_accepted_host, app
    bound_host = getattr(app.state, "bound_host", None)
    if not bound_host:
        return None
    trusted_public_hosts = getattr(app.state, "trusted_public_hosts", frozenset())
    host_header = ws.headers.get("host", "")
    if not _is_accepted_host(host_header, bound_host, trusted_public_hosts):
        return f"host_mismatch host={host_header or '?'} bound={bound_host}"
    origin = ws.headers.get("origin", "")
    if not origin:
        return None
    parsed = urllib.parse.urlparse(origin)
    if parsed.scheme not in {"http", "https"}:
        return None
    if not parsed.netloc or not _is_accepted_host(parsed.netloc, bound_host, trusted_public_hosts):
        return f"origin_mismatch origin={origin} bound={bound_host}"
    return None


def _ws_host_origin_is_allowed(ws: "WebSocket") -> bool:
    """True when the upgrade passes the dashboard Host/Origin guard."""
    return _ws_host_origin_reason(ws) is None


def _ws_request_is_allowed(ws: "WebSocket") -> bool:
    """Return True when the WebSocket upgrade matches dashboard boundaries."""
    return _ws_host_origin_is_allowed(ws) and _ws_client_is_allowed(ws)


_GATEWAY_WS_PROTOCOL = "hermes-gateway-v1"
_GATEWAY_WS_TICKET_PROTOCOL_PREFIX = "hermes-gateway-ticket."


def _gateway_ws_ticket_from_subprotocol(ws: "WebSocket") -> tuple[str, str]:
    """Return ``(ticket, reason)`` from an unambiguous gateway protocol set."""
    raw = str(ws.headers.get("sec-websocket-protocol", "") or "")
    protocols = [value.strip() for value in raw.split(",") if value.strip()]
    ticket_protocols = [
        value for value in protocols if value.startswith(_GATEWAY_WS_TICKET_PROTOCOL_PREFIX)]
    if not ticket_protocols:
        return "", "none"
    if _GATEWAY_WS_PROTOCOL not in protocols or len(ticket_protocols) != 1:
        return "", "invalid"
    ticket = ticket_protocols[0][len(_GATEWAY_WS_TICKET_PROTOCOL_PREFIX):]
    return (ticket, "ok") if ticket else ("", "invalid")


def _ws_auth_reason(ws: "WebSocket") -> tuple[Optional[str], str]:
    """Validate WS-upgrade auth; return ``(reason, credential)``.

    ``reason`` is None when accepted, else a short token (``no_credential``,
    ``token_mismatch``, ``ticket_invalid``, ``internal_invalid``);
    ``credential`` names what was presented so the accept path can log *how*.

    Loopback / ``--insecure``: legacy ``?token=`` (constant-time compared).
    Gated: ``?ticket=`` (browser-minted, single-use, 30s TTL) or ``?internal=``
    (process-lifetime, multi-use, only for server-spawned WS clients so the PTY
    child can reconnect; never injected into the SPA).  The legacy token is
    rejected in gated mode: a leaked ``_SESSION_TOKEN`` must not grant access.
    """
    from hermes_cli.web_server import _SESSION_TOKEN, app
    auth_required = bool(getattr(app.state, "auth_required", False))
    if auth_required:
        # Lazy import — keeps this function importable in test harnesses
        # that don't bring in the dashboard_auth layer.
        from hermes_cli.dashboard_auth.audit import AuditEvent, audit_log
        from hermes_cli.dashboard_auth.ws_tickets import (
            TicketInvalid, consume_internal_credential, consume_ticket)

        def _reject(reason: str) -> None:
            audit_log(
                AuditEvent.WS_TICKET_REJECTED, reason=reason,
                ip=(ws.client.host if ws.client else ""), path=ws.url.path)

        def _stamp_identity(info) -> None:
            # Server-minted {user_id, provider} stamped onto the WS object is the
            # sole identity authority downstream (gateway transport / controller
            # registration); a client can never supply it through RPC params.
            # Only the two identity fields are carried — bookkeeping such as
            # ``minted_at`` is not part of the identity contract.
            ws._hermes_auth_identity = {
                "user_id": info.get("user_id"), "provider": info.get("provider")}

        internal = ws.query_params.get("internal", "")
        if internal:
            try:
                _stamp_identity(consume_internal_credential(internal))
                return None, "internal"
            except TicketInvalid as exc:
                _reject(f"internal: {exc}")
                return "internal_invalid", "internal"

        protocol_ticket, protocol_reason = _gateway_ws_ticket_from_subprotocol(ws)
        if protocol_reason == "invalid":
            return "ticket_invalid", "ticket-subprotocol"
        ticket = protocol_ticket or ws.query_params.get("ticket", "")
        if not ticket:
            return "no_credential", "none"

        try:
            _stamp_identity(consume_ticket(ticket))
            if protocol_ticket:
                # Select only the stable public protocol during accept. The
                # ticket-bearing protocol is a credential and must never be
                # reflected back to the browser or retained after admission.
                ws._hermes_ws_subprotocol = _GATEWAY_WS_PROTOCOL
                return None, "ticket-subprotocol"
            return None, "ticket"
        except TicketInvalid as exc:
            _reject(str(exc))
            return "ticket_invalid", "ticket"

    token = ws.query_params.get("token", "")
    if not token:
        return "no_credential", "none"
    if hmac.compare_digest(token.encode(), _SESSION_TOKEN.encode()):
        return None, "token"
    return "token_mismatch", "token"


def _ws_auth_ok(ws: "WebSocket") -> bool:
    """True when the WS-upgrade credential is accepted. See _ws_auth_reason."""
    return _ws_auth_reason(ws)[0] is None


def _resolve_chat_argv(
    resume: Optional[str] = None,
    sidecar_url: Optional[str] = None,
    profile: Optional[str] = None,
    active_session_file: Optional[str] = None,
) -> tuple[list[str], Optional[str], Optional[dict]]:
    """Resolve the argv + cwd + env for the chat PTY.

    Default: whatever ``hermes --tui`` would run.  Tests monkeypatch this
    function to inject a tiny fake command (``cat``, ``sh -c 'printf …'``)
    so nothing has to build Node or the TUI bundle.

    Session resume is propagated via the ``HERMES_TUI_RESUME`` env var —
    matching what ``hermes_cli.main._launch_tui`` does for the CLI path.
    Appending ``--resume <id>`` to argv doesn't work because ``ui-tui`` does
    not parse its argv.

    ``HERMES_TUI_GATEWAY_URL`` is injected so the PTY child can attach to
    this process's in-memory ``tui_gateway`` instance instead of spawning
    its own Python gateway subprocess.

    `sidecar_url` (when set) is forwarded as ``HERMES_TUI_SIDECAR_URL`` so
    the spawned ``tui_gateway.entry`` can mirror dispatcher emits to the
    dashboard's ``/api/pub`` endpoint (see :func:`pub_ws`).

    `active_session_file` (when set) is forwarded as
    ``HERMES_TUI_ACTIVE_SESSION_FILE``. The TUI writes the current session id
    there whenever it creates/resumes/switches sessions, giving the dashboard a
    small cross-process breadcrumb for reconnecting after an unexpected browser
    WebSocket close.

    `profile` (when set) scopes the ENTIRE chat to that profile by pointing
    ``HERMES_HOME`` at the profile dir in the child env. Every spawned
    process (the TUI and the ``tui_gateway.entry`` it launches) resolves
    ``get_hermes_home()`` from that env var at its own import, so the child
    binds the profile's config, skills, memory, and state.db from the start
    — the same propagation ``hermes -p <name>`` performs. The in-process
    ``HERMES_TUI_GATEWAY_URL`` attach is SKIPPED for scoped chats: the
    dashboard's in-memory gateway runs under the dashboard's own profile,
    so a profile-scoped chat must spawn its own gateway subprocess.
    """
    from hermes_cli.web_server_profiles import _resolve_profile_dir
    from hermes_cli.web_server_sessions import _open_session_db_for_profile, _session_latest_descendant
    from hermes_cli.main import PROJECT_ROOT
    from hermes_cli.main_tui_launch import (
        _apply_opentui_native_env, _apply_tui_heap_env, _apply_tui_python_env, _make_tui_argv,
    )
    from hermes_cli.config import (
        apply_terminal_config_to_env, read_raw_config, terminal_config_owned_env_vars,
    )
    from tools.environments.local import build_subprocess_env
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override

    profile_dir: Optional[Path] = None
    requested = (profile or "").strip()
    if requested and requested.lower() != "current":
        profile_dir = _resolve_profile_dir(requested)

    raw_launch_terminal = None
    profile_token = None
    if profile_dir is not None:
        try:
            launch_config = read_raw_config()
            raw_launch_terminal = (
                launch_config.get("terminal")
                if isinstance(launch_config, dict)
                else None
            )
        except Exception:
            _log.warning(
                "Failed to read launch-profile terminal config for dashboard chat",
                exc_info=True,
            )
        profile_token = set_hermes_home_override(profile_dir)
    try:
        if profile_dir is None:
            argv, cwd = _make_tui_argv(PROJECT_ROOT / "ui-tui", tui_dev=False)
        else:
            argv, cwd = _make_tui_argv(
                PROJECT_ROOT / "ui-tui",
                tui_dev=False,
                opentui_runtime_state_dir=(
                    profile_dir / "cache" / "opentui-runtime"
                ),
            )
        # Hermes TUI child: build via the single spawn-env factory. Keep
        # provider credentials, inherit the context-local profile selected
        # above, and then pin an explicit requested profile defensively.
        env = build_subprocess_env(
            scrub_secrets=False,
            inherit_profile_home=True,
        )
        if profile_dir is not None:
            env["HERMES_HOME"] = str(profile_dir)
        try:
            if profile_dir is not None:
                # The server inherited the launch profile's terminal bridge.
                # Remove only values owned by that profile, then apply the
                # selected profile while its context-local home is active.
                # Operator exports for omitted/placeholder keys remain valid.
                for env_var in terminal_config_owned_env_vars(raw_launch_terminal):
                    env.pop(env_var, None)
            apply_terminal_config_to_env(env=env)
        except Exception:
            _log.warning(
                "Failed to apply terminal config bridge for dashboard chat",
                exc_info=True,
            )
        _apply_tui_heap_env(env)
    finally:
        if profile_token is not None:
            reset_hermes_home_override(profile_token)
    _apply_tui_python_env(env)
    _apply_opentui_native_env(argv, cwd, env)
    env.setdefault("NODE_ENV", "production")
    # Browser-embedded chat should prefer stable wheel-based scrollback over
    # native terminal mouse tracking. When mouse tracking is enabled, wheel
    # events are consumed by the TUI and forwarded as terminal input, which
    # makes browser-side transcript scrolling feel broken. Keep the terminal
    # build unchanged for native CLI usage; only disable mouse tracking for
    # the dashboard PTY path.
    env.setdefault("HERMES_TUI_DISABLE_MOUSE", "1")
    env.setdefault("HERMES_TUI_INLINE", "1")
    # The dashboard terminal is xterm.js, which always renders 24-bit RGB.
    # But chalk inside the TUI child decides its color depth from the
    # SERVER process env — and hosted/cloud deploys run the dashboard under
    # a process manager (container init, systemd) with no COLORTERM, so
    # chalk downgrades every hex color to the xterm 256 palette. The skin's
    # bronze border #CD7F32 snaps to palette 173 (#D7875F, salmon-red) and
    # the banner reads red/yellow instead of gold. Local launches dodge
    # this only because the operator's interactive terminal leaks
    # COLORTERM=truecolor into os.environ. Backfill it for the PTY child;
    # setdefault so an explicit operator value still wins.
    env.setdefault("COLORTERM", "truecolor")
    env["HERMES_TUI_DASHBOARD"] = "1"

    if resume:
        _resume_db = _open_session_db_for_profile(
            requested if profile_dir is not None else None,
            read_only=True,
        )
        try:
            latest_resume, _latest_path = _session_latest_descendant(resume, _resume_db)
        finally:
            _resume_db.close()
        if latest_resume:
            resume = latest_resume
        env["HERMES_TUI_RESUME"] = resume

    if sidecar_url:
        env["HERMES_TUI_SIDECAR_URL"] = sidecar_url

    if active_session_file:
        env["HERMES_TUI_ACTIVE_SESSION_FILE"] = active_session_file

    # Profile-scoped chats must NOT attach to the dashboard's in-memory
    # gateway — it runs under the dashboard's own profile. Without the
    # attach URL, gatewayClient spawns its own `tui_gateway.entry`, which
    # inherits the profile HERMES_HOME set above.
    if profile_dir is None:
        if gateway_ws_url := _build_gateway_ws_url():
            env["HERMES_TUI_GATEWAY_URL"] = gateway_ws_url

    return list(argv), str(cwd) if cwd else None, env


# Wildcard bind hosts an in-container client must NOT dial: behind a forward
# proxy (HTTPS_PROXY without 0.0.0.0 in NO_PROXY) the handshake gets MITM'd.
_WILDCARD_HOSTS = frozenset({"0.0.0.0", "::"})


def _resolve_client_ws_host() -> Optional[str]:
    """Host the in-container WS client should dial: ``HERMES_DASHBOARD_WS_HOST``
    wins always; a wildcard bind becomes ``127.0.0.1``; others verbatim."""
    from hermes_cli.web_server import app
    explicit = os.environ.get("HERMES_DASHBOARD_WS_HOST", "").strip()
    if explicit:
        return explicit
    host = getattr(app.state, "bound_host", None)
    if not host:
        return None
    return "127.0.0.1" if host in _WILDCARD_HOSTS else host


def _server_internal_ws_url(path: str, **extra_qs) -> Optional[str]:
    """``ws://<host>:<port><path>?<auth>&<extra>`` for server-spawned WS clients,
    or None when unbound.

    Gated mode uses the process-lifetime internal credential, NOT a single-use
    browser ticket: the child reads the URL once and reuses it on every
    reconnect, and a 30s-TTL ticket can expire before a slow cold boot dials.
    """
    from hermes_cli.web_server import _SESSION_TOKEN, app
    host = _resolve_client_ws_host()
    port = getattr(app.state, "bound_port", None)
    if not host or not port:
        return None
    netloc = f"[{host}]:{port}" if ":" in host and not host.startswith("[") else f"{host}:{port}"
    if getattr(app.state, "auth_required", False):
        from hermes_cli.dashboard_auth.ws_tickets import internal_ws_credential

        auth = {"internal": internal_ws_credential()}
    else:
        auth = {"token": _SESSION_TOKEN}
    return f"ws://{netloc}{path}?{urllib.parse.urlencode({**auth, **extra_qs})}"


def _build_gateway_ws_url() -> Optional[str]:
    """ws:// URL the PTY child attaches to for JSON-RPC gateway traffic."""
    return _server_internal_ws_url("/api/ws")


def _build_sidecar_url(channel: str) -> Optional[str]:
    """ws:// URL the PTY child publishes events to, or None when unbound."""
    return _server_internal_ws_url("/api/pub", channel=channel)


async def _resolve_chat_argv_async(
    resume: Optional[str] = None, sidecar_url: Optional[str] = None, profile: Optional[str] = None,
    active_session_file: Optional[str] = None) -> tuple[list[str], Optional[str], Optional[dict]]:
    """Resolve chat argv off the event loop (it may run ``npm run build``); the
    async lock keeps one-build-at-a-time without parking worker threads."""
    from hermes_cli import subprocess_lifecycle as _subprocess_lifecycle
    from hermes_cli.web_server import (
        _get_chat_argv_lock, _get_chat_argv_scopes, _terminate_chat_argv_scope, app,
    )
    kwargs = {"resume": resume, "sidecar_url": sidecar_url, "profile": profile}
    if active_session_file is not None:
        kwargs["active_session_file"] = active_session_file

    scope = _subprocess_lifecycle.ProcessScope()
    scopes = _get_chat_argv_scopes(app)
    scopes.add(scope)
    try:
        async with _get_chat_argv_lock(app):
            with _subprocess_lifecycle.bind_process_scope(scope):
                return await asyncio.to_thread(_resolve_chat_argv, **kwargs)
    except asyncio.CancelledError:
        await _terminate_chat_argv_scope(scope)
        raise
    finally:
        scopes.discard(scope)


def _active_session_file_for_channel(app: "FastAPI", channel: str) -> Path:
    """Return the per-channel file where a dashboard TUI writes its active sid."""
    from hermes_cli.web_server import _get_pty_active_session_files
    files = _get_pty_active_session_files(app)
    if files.get(channel) is None:
        fd, raw_path = tempfile.mkstemp(prefix="hermes-pty-active-", suffix=".json")
        os.close(fd)
        files[channel] = Path(raw_path)
    return files[channel]


# On timeout asyncio cancels the awaitable but the console thread keeps running;
# a small dedicated pool caps the leak instead of exhausting the default pool.
_CONSOLE_EXECUTOR_MAX_WORKERS = 4
_console_executor: Optional[concurrent.futures.ThreadPoolExecutor] = None
_console_executor_lock = threading.Lock()


def _get_console_executor() -> concurrent.futures.ThreadPoolExecutor:
    """Lazily create the bounded console worker pool (once per process)."""
    global _console_executor
    if _console_executor is None:
        with _console_executor_lock:
            if _console_executor is None:
                _console_executor = concurrent.futures.ThreadPoolExecutor(
                    max_workers=_CONSOLE_EXECUTOR_MAX_WORKERS, thread_name_prefix="hermes-console")
                # Tear down on interpreter exit without waiting on in-flight
                # workers: a stuck 60s console command must not block shutdown.
                atexit.register(
                    lambda: _console_executor
                    and _console_executor.shutdown(wait=False, cancel_futures=True))
    return _console_executor
