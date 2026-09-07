from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest

from tools import approval, approval_context
from tools.approval_gateway_wait import _ApprovalEntry
from tui_gateway import server


def _wait_for_event(events: list[tuple[str, str, dict]], kind: str) -> tuple[str, str, dict]:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if match := next((event for event in events if event[0] == kind), None):
            return match
        time.sleep(0.001)
    raise AssertionError(f"{kind} was not emitted")


@pytest.fixture(autouse=True)
def _state(monkeypatch):
    approval._gateway_queues.clear()
    approval._gateway_notify_cbs.clear()
    approval._gateway_lifecycle_cbs.clear()
    approval._gateway_surface_ids.clear()
    monkeypatch.setattr(server, "_wire_callbacks", lambda _sid: None)
    yield
    for session_key in list(approval._gateway_notify_cbs):
        approval.unregister_gateway_notify(session_key)
    approval._gateway_queues.clear()
    approval._gateway_lifecycle_cbs.clear()
    approval._gateway_surface_ids.clear()
    server._sessions.clear()


def test_tui_emits_exact_terminal_event_for_resolution_and_teardown(monkeypatch):
    events: list[tuple[str, str, dict]] = []
    monkeypatch.setattr(
        server,
        "_emit",
        lambda kind, sid, payload=None: events.append((kind, sid, payload or {})),
    )
    monkeypatch.setattr(approval_context, "_get_approval_timeout", lambda: 30)
    sid, session_key = "ui-approval", "stored-approval"
    session = {
        "agent": SimpleNamespace(session_id=session_key, model="test", platform="tui"),
        "history": [],
        "history_lock": threading.Lock(),
        "session_key": session_key,
    }
    server._sessions[sid] = session
    assert server._wire_session_agent(sid, session_key, session["agent"]) is True

    first: dict = {}
    waiter = threading.Thread(
        target=lambda: first.update(
            decision=approval._await_gateway_decision(
                session_key,
                approval._gateway_notify_cbs[session_key],
                {
                    "command": "protected operation",
                    "description": "first",
                    "pattern_key": "protected:first",
                    "pattern_keys": ["protected:first"],
                },
            )
        )
    )
    waiter.start()
    request = _wait_for_event(events, "approval.request")
    request_id = request[2]["request_id"]
    response = server.handle_request(
        {
            "id": "resolve",
            "method": "approval.respond",
            "params": {
                "session_id": sid,
                "request_id": request_id,
                "choice": "deny",
            },
        }
    )
    waiter.join(timeout=2)
    assert response["result"] == {"resolved": 1}
    assert ("approval.resolved", sid, {"request_id": request_id, "status": "resolved"}) in events

    events.clear()
    second: dict = {}
    waiter = threading.Thread(
        target=lambda: second.update(
            decision=approval._await_gateway_decision(
                session_key,
                approval._gateway_notify_cbs[session_key],
                {
                    "command": "protected operation two",
                    "description": "second",
                    "pattern_key": "protected:second",
                    "pattern_keys": ["protected:second"],
                },
            )
        )
    )
    waiter.start()
    request = _wait_for_event(events, "approval.request")
    request_id = request[2]["request_id"]
    replay_sid = "ui-approval-replay"
    replay_agent = SimpleNamespace(session_id=session_key, model="test", platform="tui")
    server._sessions[replay_sid] = {
        "agent": replay_agent,
        "history": [],
        "history_lock": threading.Lock(),
        "session_key": session_key,
    }
    assert server._wire_session_agent(replay_sid, session_key, replay_agent) is True
    acknowledged = server.handle_request(
        {
            "id": "received-on-replay",
            "method": "approval.received",
            "params": {"session_id": replay_sid, "request_id": request_id},
        }
    )
    assert acknowledged["result"] == {"acknowledged": True}
    server._teardown_session(session, end_reason="test_teardown")
    waiter.join(timeout=2)
    assert not waiter.is_alive()
    assert [event for event in events if event[0] == "approval.resolved"] == [
        ("approval.resolved", sid, {"request_id": request_id, "status": "cancelled"}),
        (
            "approval.resolved",
            replay_sid,
            {"request_id": request_id, "status": "cancelled"},
        ),
    ]


def test_session_close_interrupts_before_releasing_captured_clarify_callback(monkeypatch):
    """A detached turn cannot re-arm a captured callback or cancel another session."""
    sid, session_key = "ui-clarify", "stored-clarify"
    other_sid = "ui-other-clarify"
    events: list[tuple[str, str, dict]] = []
    result: dict[str, str] = {}
    other_result: dict[str, str] = {}
    monkeypatch.setattr(
        server,
        "_emit",
        lambda kind, owner, payload=None: events.append((kind, owner, payload or {})),
    )
    monkeypatch.setattr(server, "_TURN_SETTLE_BEFORE_CLOSE_SECONDS", 0.05)
    monkeypatch.setattr(server, "_finalize_session", lambda *_args, **_kwargs: None)
    server._pending.clear()
    server._answers.clear()

    class InterruptibleAgent:
        def __init__(self):
            self.interrupted = threading.Event()

        def hard_interrupt(self):
            self.interrupted.set()

        def close(self):
            return None

    agent = InterruptibleAgent()
    captured_clarify = lambda question: server._block(
        "clarify.request",
        sid,
        {"question": question, "choices": ["Yes", "No"]},
        timeout=None,
    )

    def run_turn():
        result["first"] = captured_clarify("Continue?")
        if not agent.interrupted.is_set():
            result["second"] = captured_clarify("Continue after close?")

    waiter = threading.Thread(target=run_turn)
    other_waiter = threading.Thread(
        target=lambda: other_result.update(
            answer=server._block(
                "clarify.request",
                other_sid,
                {"question": "Other session?", "choices": ["Yes", "No"]},
                timeout=None,
            )
        )
    )
    session = {
        "agent": agent,
        "history": [],
        "history_lock": threading.Lock(),
        "running": True,
        "session_key": session_key,
        "_run_thread": waiter,
    }
    server._sessions[sid] = session
    server._sessions[other_sid] = {
        "history": [],
        "history_lock": threading.Lock(),
        "session_key": "stored-other-clarify",
    }
    waiter.start()
    other_waiter.start()
    _wait_for_event(events, "clarify.request")
    deadline = time.monotonic() + 2
    while len([event for event in events if event[0] == "clarify.request"]) < 2:
        if time.monotonic() >= deadline:
            raise AssertionError("both clarification waits were not emitted")
        time.sleep(0.001)

    try:
        response = server.handle_request(
            {"id": "close", "method": "session.close", "params": {"session_id": sid}}
        )
        waiter.join(timeout=1)

        assert response["result"] == {"closed": True}
        assert not waiter.is_alive()
        assert agent.interrupted.is_set()
        assert result == {"first": ""}
        assert [event[2]["question"] for event in events if event[:2] == ("clarify.request", sid)] == [
            "Continue?"
        ]
        assert other_waiter.is_alive()
        assert {owner for owner, _event in server._pending.values()} == {other_sid}
    finally:
        server._clear_pending(other_sid)
        other_waiter.join(timeout=1)

    assert other_result == {"answer": ""}


def test_approval_fallback_requires_request_and_session_to_match():
    approval.register_gateway_notify(
        "stored-a", lambda _data: None, surface_session_id="stale-ui-a"
    )
    approval.register_gateway_notify(
        "stored-b", lambda _data: None, surface_session_id="stale-ui-b"
    )
    entry_a = _ApprovalEntry({"request_id": "request-a", "command": "a"})
    entry_b = _ApprovalEntry({"request_id": "request-b", "command": "b"})
    entry_a.surface_session_ids.add("stale-ui-a")
    entry_b.surface_session_ids.add("stale-ui-b")
    approval._gateway_queues.update({"stored-a": [entry_a], "stored-b": [entry_b]})
    server._sessions.update(
        {
            "current-ui-a": {"session_key": "stored-a", "history": []},
            "current-ui-b": {"session_key": "stored-b", "history": []},
        }
    )

    wrong = server.handle_request(
        {
            "id": "wrong",
            "method": "approval.respond",
            "params": {
                "session_id": "stale-ui-b",
                "request_id": "request-a",
                "choice": "once",
            },
        }
    )
    assert wrong["error"]["code"] == 4001
    assert approval.list_gateway_approvals("stored-a")
    assert approval.list_gateway_approvals("stored-b")

    right = server.handle_request(
        {
            "id": "right",
            "method": "approval.respond",
            "params": {
                "session_id": "stale-ui-a",
                "request_id": "request-a",
                "choice": "once",
            },
        }
    )
    assert right["result"] == {"resolved": 1}
    assert approval.list_gateway_approvals("stored-a") == []
    assert approval.list_gateway_approvals("stored-b")

    # Reusing the stored conversation on a new UI id must not authorize the old
    # id for a request it never received.
    approval.register_gateway_notify(
        "stored-a", lambda _data: None, surface_session_id="new-ui-a"
    )
    entry_a2 = _ApprovalEntry({"request_id": "request-a2", "command": "a2"})
    entry_a2.surface_session_ids.add("new-ui-a")
    approval._gateway_queues["stored-a"] = [entry_a2]
    stale = server.handle_request(
        {
            "id": "stale",
            "method": "approval.respond",
            "params": {
                "session_id": "stale-ui-a",
                "request_id": "request-a2",
                "choice": "once",
            },
        }
    )
    assert stale["error"]["code"] == 4001
    current = server.handle_request(
        {
            "id": "current",
            "method": "approval.respond",
            "params": {
                "session_id": "new-ui-a",
                "request_id": "request-a2",
                "choice": "once",
            },
        }
    )
    assert current["result"] == {"resolved": 1}
