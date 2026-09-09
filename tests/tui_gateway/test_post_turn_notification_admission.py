"""Post-turn process completions survive a rejected synthesized turn."""

import queue
import threading
from types import SimpleNamespace

import pytest

from tools.process_registry import process_registry
from tui_gateway import server


@pytest.mark.parametrize("refusal", ["previous_stop", "ownership", "exception"])
def test_post_turn_completion_is_admitted_or_requeued(monkeypatch, tmp_path, refusal):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    sid = "post-turn-live"
    session = {
        "session_key": "post-turn-stored", "history_lock": threading.RLock(),
        "history": [], "running": False, "agent": SimpleNamespace(),
        "active_session_lease": SimpleNamespace(release=lambda: None), "attached_images": [],
        "_turn_cancel_requested": refusal == "previous_stop",
    }
    monkeypatch.setattr(server, "_sessions", {sid: session})
    emitted = []
    monkeypatch.setattr(server, "_emit", lambda *args: emitted.append(args))
    monkeypatch.setattr(server, "_get_usage", lambda _: {})
    monkeypatch.setattr(process_registry, "completion_queue", queue.Queue())
    event = {
        "type": "completion", "session_id": "synthetic-completed-process",
        "origin_ui_session_id": sid, "session_key": session["session_key"],
        "command": "echo synthetic", "exit_code": 0, "output": "synthetic result",
    }
    process_registry.completion_queue.put(event)
    attempts, accepted = [], []

    def submit(_rid, live_sid, owned_session, text, **kwargs):
        attempts.append(text)
        if refusal == "exception" and len(attempts) == 1:
            raise RuntimeError("synthetic dispatch failure")
        admitted = server._admit_prompt_turn(
            live_sid, owned_session, text, None, None, [], kwargs.get("display_notification")
        )
        if admitted is not None:
            accepted.append((text, kwargs))
            kwargs["history_commit_callback"](server._HistoryCommitOutcome(True, True, True))
        return admitted is not None

    if refusal == "ownership":
        original = server._ensure_active_session_slot
        monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *args: (
            "temporarily owned elsewhere" if len(attempts) == 1 else original(*args)))
    monkeypatch.setattr(server, "_run_prompt_submit", submit)

    server._run_post_turn_followups("turn", sid, session, {}, None)
    if refusal != "previous_stop":
        assert not accepted
        assert session["running"] is False
        assert process_registry.completion_queue.qsize() == 1
        server._run_post_turn_followups("retry", sid, session, {}, None)

    assert len(accepted) == 1
    assert "synthetic result" in accepted[0][0]
    assert accepted[0][1]["display_kind"] == "process_complete"
    assert accepted[0][1]["display_metadata"]["kind"] == "process.complete"
    cards = [args[2] for args in emitted if args[0] == "notification.show"]
    assert len(cards) == 1
    assert cards[0]["detail"] == accepted[0][0]
    assert process_registry.completion_queue.empty()


def test_post_turn_batch_settles_each_claim_only_after_history_commit(monkeypatch):
    """A completion batch keeps every event tied to its own commit-time claim."""
    from tools import async_delegation

    session = {"session_key": "stored", "history_lock": threading.RLock(), "running": False}
    first = {"type": "completion", "session_id": "first", "command": "first"}
    second = {"type": "completion", "session_id": "second", "command": "second"}
    monkeypatch.setattr(server, "_drain_queued_prompt", lambda *_: False)
    monkeypatch.setattr(process_registry, "completion_queue", queue.Queue())
    monkeypatch.setattr(process_registry, "drain_notifications", lambda **_: [(first, "first"), (second, "second")])
    monkeypatch.setattr(
        async_delegation,
        "claim_event_delivery",
        lambda event, _owner: f"{event['session_id']}-claim",
    )
    completed, callbacks = [], []
    monkeypatch.setattr(async_delegation, "complete_event_delivery", lambda event, claim: completed.append((event, claim)))

    def submit(*_args, **kwargs):
        callbacks.append(kwargs["history_commit_callback"])
        return True

    monkeypatch.setattr(server, "_run_prompt_submit", submit)
    server._run_post_turn_followups("turn", "live", session, {}, None)
    assert process_registry.completion_queue.empty()
    assert len(callbacks) == 1
    assert not completed
    callbacks[0](server._HistoryCommitOutcome(True, True, True))
    assert completed == [
        (first, "first-claim"),
        (second, "second-claim"),
    ]
