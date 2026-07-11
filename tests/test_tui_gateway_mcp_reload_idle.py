"""Idle-admission regressions for the process-global MCP reload RPC."""

import threading
import time
import types

from tui_gateway import server


class _CaptureTransport:
    def __init__(self):
        self.frames: list[dict] = []
        self.written = threading.Event()

    def write(self, obj):
        self.frames.append(obj)
        self.written.set()
        return True

    def close(self):
        return None


def test_reload_mcp_rejects_live_turns_before_mutation_then_retries(monkeypatch):
    from tools import mcp_tool

    calls: list[str] = []
    emitted: list[tuple[str, str, dict]] = []
    agent = object()
    requested = {"agent": agent, "running": True}
    other = {"agent": object(), "running": False}
    server._sessions["reload-requested"] = requested
    server._sessions["reload-other"] = other

    monkeypatch.setattr(
        mcp_tool, "shutdown_mcp_servers", lambda: calls.append("shutdown")
    )
    monkeypatch.setattr(
        mcp_tool, "discover_mcp_tools", lambda: calls.append("discover")
    )

    def refresh(live_agent, *, enabled_override, quiet_mode):
        assert live_agent is agent
        assert enabled_override == ["hermes"]
        assert quiet_mode is True
        calls.append("refresh")

    monkeypatch.setattr(mcp_tool, "refresh_agent_mcp_tools", refresh)
    monkeypatch.setattr(server, "_load_enabled_toolsets", lambda: ["hermes"])
    monkeypatch.setattr(
        server,
        "_session_info",
        lambda _agent, session: {"running": bool(session.get("running"))},
    )
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, sid, payload: emitted.append((event, sid, payload)),
    )

    params = {
        "confirm": True,
        "session_id": "reload-requested",
    }
    try:
        during_requested_turn = server._methods["reload.mcp"]("r1", params)
        assert during_requested_turn["error"]["code"] == 4009
        assert calls == []

        # The registry is process-global: an idle requester must also defer for
        # a different session's live turn.
        requested["running"] = False
        other["running"] = True
        during_other_turn = server._methods["reload.mcp"]("r2", params)
        assert during_other_turn["error"]["code"] == 4009
        assert calls == []

        other["running"] = False
        after_idle = server._methods["reload.mcp"]("r3", params)
        assert after_idle["result"] == {"status": "reloaded"}
        assert calls == ["shutdown", "discover", "refresh"]
        assert emitted == [
            (
                "session.info",
                "reload-requested",
                {"running": False},
            )
        ]
    finally:
        server._sessions.pop("reload-requested", None)
        server._sessions.pop("reload-other", None)


def test_reload_mcp_admission_fence_blocks_a_new_turn_until_discovery_finishes(
    monkeypatch,
):
    from tools import mcp_tool

    reload_entered = threading.Event()
    release_reload = threading.Event()
    turn_ran = threading.Event()
    responses: list[dict] = []
    session = {
        "history_lock": threading.RLock(),
        "queued_prompt": {"text": "after reload", "transport": None},
        "running": False,
    }
    server._sessions["reload-admission"] = session

    def shutdown():
        reload_entered.set()
        assert release_reload.wait(1)

    monkeypatch.setattr(mcp_tool, "shutdown_mcp_servers", shutdown)
    monkeypatch.setattr(mcp_tool, "discover_mcp_tools", lambda: None)
    monkeypatch.setattr(
        server,
        "_run_prompt_submit",
        lambda *_args, **_kwargs: turn_ran.set(),
    )

    def reload():
        responses.append(
            server._methods["reload.mcp"](
                "reload-race",
                {"confirm": True, "session_id": ""},
            )
        )

    reload_thread = threading.Thread(target=reload)
    turn_thread = threading.Thread(
        target=lambda: server._drain_queued_prompt(
            "queued-race", "reload-admission", session
        )
    )
    try:
        reload_thread.start()
        assert reload_entered.wait(1)
        turn_thread.start()

        # _drain_queued_prompt has started, but its running=True claim is fenced
        # behind the process-global shutdown/discovery transaction.
        assert not turn_ran.wait(0.05)
        assert session["running"] is False

        release_reload.set()
        reload_thread.join(1)
        turn_thread.join(1)
        assert not reload_thread.is_alive()
        assert not turn_thread.is_alive()
        assert responses == [
            {
                "jsonrpc": "2.0",
                "id": "reload-race",
                "result": {"status": "reloaded"},
            }
        ]
        assert turn_ran.is_set()
        assert session["running"] is True
    finally:
        release_reload.set()
        if reload_thread.ident is not None:
            reload_thread.join(1)
        if turn_thread.ident is not None:
            turn_thread.join(1)
        server._sessions.pop("reload-admission", None)


def test_reload_mcp_pool_keeps_prompt_rejection_and_interrupt_responsive(monkeypatch):
    from tools import mcp_tool

    reload_entered = threading.Event()
    release_reload = threading.Event()
    interrupted = threading.Event()
    ready = threading.Event()
    ready.set()
    session = {
        "agent": types.SimpleNamespace(interrupt=interrupted.set),
        "agent_error": None,
        "agent_ready": ready,
        "history_lock": threading.RLock(),
        "queued_prompt": None,
        "running": False,
        "session_key": "mcp-responsive",
        "transport": None,
    }
    server._sessions["mcp-responsive"] = session

    def shutdown():
        reload_entered.set()
        assert release_reload.wait(2)

    monkeypatch.setattr(mcp_tool, "shutdown_mcp_servers", shutdown)
    monkeypatch.setattr(mcp_tool, "discover_mcp_tools", lambda: None)
    transport = _CaptureTransport()

    try:
        assert (
            server.dispatch(
                {
                    "id": "reload-held",
                    "method": "reload.mcp",
                    "params": {"confirm": True, "session_id": ""},
                },
                transport=transport,
            )
            is None
        )
        assert reload_entered.wait(1)

        started = time.monotonic()
        prompt = server.dispatch(
            {
                "id": "prompt-during-reload",
                "method": "prompt.submit",
                "params": {"session_id": "mcp-responsive", "text": "hello"},
            }
        )
        assert time.monotonic() - started < 0.5
        assert prompt["error"]["code"] == 4009
        assert "MCP reload" in prompt["error"]["message"]
        assert session["running"] is False

        started = time.monotonic()
        interrupt = server.dispatch(
            {
                "id": "interrupt-during-reload",
                "method": "session.interrupt",
                "params": {"session_id": "mcp-responsive"},
            }
        )
        assert time.monotonic() - started < 0.5
        assert interrupt["result"] == {"status": "interrupted"}

        release_reload.set()
        assert transport.written.wait(1)
        assert transport.frames[-1]["result"] == {"status": "reloaded"}
    finally:
        release_reload.set()
        server._sessions.pop("mcp-responsive", None)


def test_slash_reload_mcp_fence_rejects_other_session_prompt_while_mutating(
    monkeypatch,
):
    """The slash mirror shares reload.mcp's process-global admission fence."""
    from tools import mcp_tool

    reload_entered = threading.Event()
    release_reload = threading.Event()
    calls: list[str] = []
    warnings: list[str] = []
    slash_agent = object()
    slash_session = {
        "agent": slash_agent,
        "history_lock": threading.RLock(),
        "running": False,
        "session_key": "slash-reload-owner",
    }
    other_session = {
        "agent": object(),
        "history_lock": threading.RLock(),
        "running": False,
        "session_key": "slash-reload-other",
        "transport": None,
    }
    server._sessions["slash-reload-owner"] = slash_session
    server._sessions["slash-reload-other"] = other_session

    def shutdown():
        calls.append("shutdown")
        reload_entered.set()
        assert release_reload.wait(2)

    monkeypatch.setattr(mcp_tool, "shutdown_mcp_servers", shutdown)
    monkeypatch.setattr(
        mcp_tool, "discover_mcp_tools", lambda: calls.append("discover")
    )

    def refresh(live_agent, *, enabled_override, quiet_mode):
        assert live_agent is slash_agent
        assert enabled_override == ["hermes"]
        assert quiet_mode is True
        calls.append("refresh")

    monkeypatch.setattr(mcp_tool, "refresh_agent_mcp_tools", refresh)
    monkeypatch.setattr(server, "_load_enabled_toolsets", lambda: ["hermes"])
    monkeypatch.setattr(server, "_session_info", lambda *_args: {"running": False})
    monkeypatch.setattr(server, "_emit", lambda *_args: None)

    reload_thread = threading.Thread(
        target=lambda: warnings.append(
            server._mirror_slash_side_effects(
                "slash-reload-owner", slash_session, "/reload-mcp"
            )
        )
    )
    try:
        reload_thread.start()
        assert reload_entered.wait(1)

        started = time.monotonic()
        prompt = server._methods["prompt.submit"](
            "other-prompt",
            {"session_id": "slash-reload-other", "text": "hello"},
        )
        assert time.monotonic() - started < 0.5
        assert prompt["error"]["code"] == 4009
        assert "MCP reload" in prompt["error"]["message"]
        assert other_session["running"] is False

        release_reload.set()
        reload_thread.join(1)
        assert not reload_thread.is_alive()
        assert warnings == [""]
        assert calls == ["shutdown", "discover", "refresh"]
    finally:
        release_reload.set()
        if reload_thread.ident is not None:
            reload_thread.join(1)
        server._sessions.pop("slash-reload-owner", None)
        server._sessions.pop("slash-reload-other", None)


def test_other_session_prompt_wins_before_slash_reload_mcp_mutation(monkeypatch):
    """A claimed turn makes the later slash mirror fail before MCP mutation."""
    from tools import mcp_tool

    turn_entered = threading.Event()
    release_turn = threading.Event()
    turn_done = threading.Event()
    ready = threading.Event()
    ready.set()
    calls: list[str] = []
    slash_session = {
        "agent": object(),
        "history_lock": threading.RLock(),
        "running": False,
        "session_key": "prompt-first-slash",
    }
    turn_session = {
        "agent": object(),
        "agent_error": None,
        "agent_ready": ready,
        "history": [],
        "history_lock": threading.RLock(),
        "queued_prompt": None,
        "running": False,
        "session_key": "prompt-first-turn",
        "transport": None,
    }
    server._sessions["prompt-first-slash"] = slash_session
    server._sessions["prompt-first-turn"] = turn_session

    def run_prompt(*_args, **_kwargs):
        turn_entered.set()
        try:
            assert release_turn.wait(2)
        finally:
            with turn_session["history_lock"]:
                turn_session["running"] = False
            turn_done.set()

    monkeypatch.setattr(server, "_ensure_session_db_row", lambda *_args: None)
    monkeypatch.setattr(server, "_persist_branch_seed", lambda *_args: None)
    monkeypatch.setattr(server, "_start_agent_build", lambda *_args: None)
    monkeypatch.setattr(server, "_run_prompt_submit", run_prompt)
    monkeypatch.setattr(
        mcp_tool, "shutdown_mcp_servers", lambda: calls.append("shutdown")
    )
    monkeypatch.setattr(
        mcp_tool, "discover_mcp_tools", lambda: calls.append("discover")
    )
    monkeypatch.setattr(
        mcp_tool,
        "refresh_agent_mcp_tools",
        lambda *_args, **_kwargs: calls.append("refresh"),
    )

    try:
        prompt = server._methods["prompt.submit"](
            "prompt-first",
            {"session_id": "prompt-first-turn", "text": "hello"},
        )
        assert prompt["result"] == {"status": "streaming"}
        assert turn_entered.wait(1)
        assert turn_session["running"] is True

        warning = server._mirror_slash_side_effects(
            "prompt-first-slash", slash_session, "/reload-mcp"
        )
        assert "wait for every live turn" in warning
        assert calls == []
    finally:
        release_turn.set()
        assert turn_done.wait(1)
        server._sessions.pop("prompt-first-slash", None)
        server._sessions.pop("prompt-first-turn", None)


def test_agent_registry_snapshot_completes_before_reload_mutates(monkeypatch):
    from tools import mcp_tool

    build_entered = threading.Event()
    release_build = threading.Event()
    reload_entered = threading.Event()
    built: list[object] = []
    reload_responses: list[dict] = []

    def make_agent(*_args, **_kwargs):
        build_entered.set()
        assert release_build.wait(2)
        return object()

    monkeypatch.setattr(server, "_make_agent", make_agent)
    monkeypatch.setattr(
        mcp_tool, "shutdown_mcp_servers", lambda: reload_entered.set()
    )
    monkeypatch.setattr(mcp_tool, "discover_mcp_tools", lambda: None)

    build_thread = threading.Thread(
        target=lambda: built.append(
            server._make_agent_with_mcp_registry_fence("build-sid", "build-key")
        )
    )
    reload_thread = threading.Thread(
        target=lambda: reload_responses.append(
            server._methods["reload.mcp"](
                "reload-after-build",
                {"confirm": True, "session_id": ""},
            )
        )
    )

    try:
        build_thread.start()
        assert build_entered.wait(1)
        reload_thread.start()

        # Reload cannot mutate the process-global registry while an agent is
        # snapshotting it, but the distinct prompt-admission lock stays free.
        assert not reload_entered.wait(0.05)
        with server._try_mcp_turn_admission(
            {"history_lock": threading.RLock()}
        ) as admitted:
            assert admitted is True

        release_build.set()
        build_thread.join(1)
        reload_thread.join(1)
        assert not build_thread.is_alive()
        assert not reload_thread.is_alive()
        assert len(built) == 1
        assert reload_entered.is_set()
        assert reload_responses == [
            {
                "jsonrpc": "2.0",
                "id": "reload-after-build",
                "result": {"status": "reloaded"},
            }
        ]
    finally:
        release_build.set()
        if build_thread.ident is not None:
            build_thread.join(1)
        if reload_thread.ident is not None:
            reload_thread.join(1)


def test_tools_configure_waits_for_reload_on_the_rpc_pool(monkeypatch):
    from tools import mcp_tool

    reload_entered = threading.Event()
    release_reload = threading.Event()
    reload_responses: list[dict] = []
    configure_responses: list[dict] = []

    def shutdown():
        reload_entered.set()
        assert release_reload.wait(2)

    monkeypatch.setattr(mcp_tool, "shutdown_mcp_servers", shutdown)
    monkeypatch.setattr(mcp_tool, "discover_mcp_tools", lambda: None)

    reload_thread = threading.Thread(
        target=lambda: reload_responses.append(
            server._methods["reload.mcp"](
                "reload-before-tools",
                {"confirm": True, "session_id": ""},
            )
        )
    )
    configure_thread = threading.Thread(
        target=lambda: configure_responses.append(
            server._methods["tools.configure"](
                "tools-during-reload",
                {"action": "invalid", "names": ["web"]},
            )
        )
    )

    try:
        assert "tools.configure" in server._LONG_HANDLERS
        reload_thread.start()
        assert reload_entered.wait(1)
        configure_thread.start()

        # The entire tools transaction, including validation/config writes, is
        # fenced behind reload and therefore cannot overlap global teardown.
        configure_thread.join(0.05)
        assert configure_thread.is_alive()
        assert configure_responses == []

        release_reload.set()
        reload_thread.join(1)
        configure_thread.join(1)
        assert not reload_thread.is_alive()
        assert not configure_thread.is_alive()
        assert reload_responses[0]["result"] == {"status": "reloaded"}
        assert configure_responses[0]["error"]["code"] == 4017
    finally:
        release_reload.set()
        if reload_thread.ident is not None:
            reload_thread.join(1)
        if configure_thread.ident is not None:
            configure_thread.join(1)
