"""Notification delivery is acknowledged only when a prompt turn is admitted."""

import queue
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from tools import async_delegation
from tui_gateway import server


@pytest.fixture
def session(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(server, "_emit", Mock())
    return {"session_key": "notification-admission", "running": False, "history_lock": threading.RLock()}


@pytest.mark.parametrize("event_type", ["completion", "async_delegation"])
@pytest.mark.parametrize("outcome", [False, True, "exception"])
def test_event_receipt_and_retry_follow_actual_admission(monkeypatch, session, event_type, outcome):
    event = {
        "type": event_type, "session_id": "synthetic-process", "delegation_id": "synthetic-delegation",
        "origin_ui_session_id": "live-notification", "command": "echo synthetic", "exit_code": 0,
    }
    registry = SimpleNamespace(completion_queue=queue.Queue(), is_completion_consumed=lambda _sid: False)
    complete, release = Mock(), Mock()
    monkeypatch.setattr(async_delegation, "claim_event_delivery", lambda *_: "delivery-claim")
    monkeypatch.setattr(async_delegation, "complete_event_delivery", complete)
    monkeypatch.setattr(async_delegation, "release_event_delivery", release)
    submit = Mock(return_value=outcome, side_effect=RuntimeError("synthetic refusal") if outcome == "exception" else None)
    monkeypatch.setattr(server, "_run_prompt_submit", submit)

    keep_draining = server._notif_handle_event(
        "live-notification", session, event, set(), registry, lambda _event: "synthetic result", [],
    )

    submit.assert_called_once()
    if outcome is True:
        assert keep_draining is True
        assert registry.completion_queue.empty()
        complete.assert_called_once_with(event, "delivery-claim")
        release.assert_not_called()
    else:
        assert keep_draining is False
        assert session["running"] is False
        assert registry.completion_queue.get_nowait() == event
        assert registry.completion_queue.empty()
        release.assert_called_once_with(event, "delivery-claim")
        complete.assert_not_called()


@pytest.mark.parametrize("outcome", [False, "exception"])
def test_kanban_claimed_batch_survives_refusal_and_retries_in_order(monkeypatch, session, outcome):
    collect = Mock(side_effect=[["first event", "second event"], []])
    monkeypatch.setattr(server, "_collect_kanban_notifications", collect)
    submissions = []

    def submit(_rid, _sid, owned_session, text, **_kwargs):
        submissions.append(text)
        if len(submissions) == 1:
            with owned_session["history_lock"]:
                owned_session.setdefault("_kanban_pending", []).append("later event")
            if outcome == "exception":
                raise RuntimeError("synthetic refusal")
            return False
        return True

    monkeypatch.setattr(server, "_run_prompt_submit", submit)
    server._notif_poll_kanban("live-notification", session)
    assert session["running"] is False
    assert session["_kanban_pending"] == ["first event", "second event", "later event"]

    server._notif_poll_kanban("live-notification", session)
    assert submissions == ["first event\nsecond event", "first event\nsecond event\nlater event"]
    assert session["_kanban_pending"] == []
    assert session["running"] is True


@pytest.mark.parametrize("prompt", ["check the synthetic build", "/synthetic-skill"])
@pytest.mark.parametrize("outcome", [False, True, "exception"])
def test_loop_claim_settles_only_after_admission(monkeypatch, session, prompt, outcome):
    from hermes_cli import loops

    monkeypatch.setattr(loops, "goal_blocks_loop_tick", lambda _sid: False)
    monkeypatch.setattr(server, "read_turn_marker", lambda *_: None)
    monkeypatch.setitem(
        server._methods, "command.dispatch",
        lambda *_: {"result": {"type": "send", "message": "resolved synthetic skill"}},
    )
    manager = loops.LoopManager(session["session_key"])
    manager.set(prompt, interval_seconds=60)
    submit = Mock(return_value=outcome, side_effect=RuntimeError("synthetic refusal") if outcome == "exception" else None)
    monkeypatch.setattr(server, "_run_prompt_submit", submit)

    server._maybe_fire_tui_loop_tick("live-notification", session)

    submit.assert_called_once()
    state = loops.LoopManager(session["session_key"]).state
    assert state is not None
    assert state.status == "active"
    if outcome is True:
        assert state.awaiting_response is True
        assert state.ticks_fired == 1
        assert state.claim_id == submit.call_args.kwargs["loop_claim_id"]
        assert session["running"] is True
    else:
        assert state.awaiting_response is False
        assert state.ticks_fired == 0
        assert state.claim_id == ""
        assert session["running"] is False
