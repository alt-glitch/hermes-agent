from __future__ import annotations

import threading
import time

import pytest

from tools import approval, approval_context


def _data(label: str) -> dict:
    return {
        "command": f"synthetic protected operation {label}",
        "description": label,
        "pattern_key": f"protected:{label}",
        "pattern_keys": [f"protected:{label}"],
    }


def _wait_for_request(requests: list[dict], previous_count: int) -> dict:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if len(requests) > previous_count:
            return requests[-1]
        time.sleep(0.001)
    raise AssertionError("approval request was not presented")


def _start_wait(session_key: str, requests: list[dict], result: dict, label: str):
    previous_count = len(requests)
    thread = threading.Thread(
        target=lambda: result.update(
            decision=approval._await_gateway_decision(
                session_key, approval._gateway_notify_cbs[session_key], _data(label)
            )
        )
    )
    thread.start()
    return thread, _wait_for_request(requests, previous_count)


@pytest.fixture(autouse=True)
def _approval_state():
    approval._gateway_queues.clear()
    approval._gateway_notify_cbs.clear()
    approval._gateway_lifecycle_cbs.clear()
    approval._gateway_surface_ids.clear()
    yield
    for session_key in list(approval._gateway_notify_cbs):
        approval.unregister_gateway_notify(session_key)
    approval._gateway_queues.clear()
    approval._gateway_lifecycle_cbs.clear()
    approval._gateway_surface_ids.clear()


def test_deadline_and_reply_lifecycles_are_request_scoped(monkeypatch):
    session_key = "approval-lifecycle"
    requests: list[dict] = []
    terminal: list[dict] = []
    approval.register_gateway_notify(
        session_key,
        requests.append,
        lifecycle_cb=terminal.append,
        surface_session_id="ui-lifecycle",
    )

    monkeypatch.setattr(approval_context, "_get_approval_timeout", lambda: 0.2)
    before: dict = {}
    thread, request = _start_wait(session_key, requests, before, "before")
    assert approval.resolve_gateway_approval(
        session_key, "once", request_id=request["request_id"]
    ) == 1
    thread.join(timeout=2)
    assert before["decision"]["resolved"] is True
    assert terminal == [{"request_id": request["request_id"], "status": "resolved"}]

    terminal.clear()
    requests.clear()
    monkeypatch.setattr(approval_context, "_get_approval_timeout", lambda: 0.02)
    after: dict = {}
    thread, request = _start_wait(session_key, requests, after, "after")
    thread.join(timeout=2)
    assert after["decision"]["resolved"] is False
    assert terminal == [{"request_id": request["request_id"], "status": "expired"}]
    assert approval.resolve_gateway_approval(
        session_key, "once", request_id=request["request_id"]
    ) == 0
    assert approval.resolve_gateway_approval(
        session_key, "once", request_id=request["request_id"]
    ) == 0
    assert len(terminal) == 1


def test_timeout_and_consent_have_one_atomic_winner(monkeypatch):
    """A reply placed on the deadline may win or lose, but the two views must agree."""
    monkeypatch.setattr(approval_context, "_get_approval_timeout", lambda: 0.01)
    outcomes: set[str] = set()
    for index in range(20):
        session_key = f"deadline-race-{index}"
        requests: list[dict] = []
        terminal: list[dict] = []
        result: dict = {}
        approval.register_gateway_notify(
            session_key, requests.append, lifecycle_cb=terminal.append
        )
        waiter, request = _start_wait(session_key, requests, result, str(index))
        time.sleep(0.01)
        resolved = approval.resolve_gateway_approval(
            session_key, "once", request_id=request["request_id"]
        )
        waiter.join(timeout=2)
        assert not waiter.is_alive()
        decision = result["decision"]
        assert decision["resolved"] is (resolved == 1)
        assert decision["choice"] == ("once" if resolved else None)
        expected = "resolved" if resolved else "expired"
        assert terminal == [{"request_id": request["request_id"], "status": expected}]
        outcomes.add(expected)
        approval.unregister_gateway_notify(session_key)
    assert outcomes <= {"resolved", "expired"}


@pytest.mark.parametrize("clear", [False, True], ids=["unregister", "session-clear"])
def test_session_cancellation_releases_waiter(monkeypatch, clear):
    monkeypatch.setattr(approval_context, "_get_approval_timeout", lambda: 30)
    session_key = f"cancel-{clear}"
    requests: list[dict] = []
    terminal: list[dict] = []
    result: dict = {}
    approval.register_gateway_notify(
        session_key, requests.append, lifecycle_cb=terminal.append
    )
    thread, request = _start_wait(session_key, requests, result, "cancel")

    if clear:
        approval.clear_session(session_key)
    else:
        approval.unregister_gateway_notify(session_key)
    thread.join(timeout=2)

    assert not thread.is_alive()
    assert result["decision"]["choice"] in {None, "deny"}
    assert terminal == [{"request_id": request["request_id"], "status": "cancelled"}]


def test_late_a_cannot_resolve_newer_b(monkeypatch):
    session_key = "approval-a-b"
    requests: list[dict] = []
    terminal: list[dict] = []
    approval.register_gateway_notify(
        session_key, requests.append, lifecycle_cb=terminal.append
    )

    monkeypatch.setattr(approval_context, "_get_approval_timeout", lambda: 0.02)
    result_a: dict = {}
    thread_a, request_a = _start_wait(session_key, requests, result_a, "a")
    thread_a.join(timeout=2)
    assert result_a["decision"]["resolved"] is False

    monkeypatch.setattr(approval_context, "_get_approval_timeout", lambda: 30)
    result_b: dict = {}
    thread_b, request_b = _start_wait(session_key, requests, result_b, "b")
    assert request_a["request_id"] != request_b["request_id"]
    assert approval.resolve_gateway_approval(
        session_key, "once", request_id=request_a["request_id"]
    ) == 0
    assert [item["request_id"] for item in approval.list_gateway_approvals(session_key)] == [
        request_b["request_id"]
    ]
    assert approval.resolve_gateway_approval(
        session_key, "once", request_id=request_b["request_id"]
    ) == 1
    thread_b.join(timeout=2)
    assert result_b["decision"]["choice"] == "once"
    assert terminal == [
        {"request_id": request_a["request_id"], "status": "expired"},
        {"request_id": request_b["request_id"], "status": "resolved"},
    ]
