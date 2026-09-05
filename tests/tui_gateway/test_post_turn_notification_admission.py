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
    monkeypatch.setattr(server, "_emit", lambda *_: None)
    monkeypatch.setattr(server, "_get_usage", lambda _: {})
    monkeypatch.setattr(process_registry, "completion_queue", queue.Queue())
    event = {
        "type": "completion", "session_id": "synthetic-completed-process",
        "origin_ui_session_id": sid, "session_key": session["session_key"],
        "command": "echo synthetic", "exit_code": 0, "output": "synthetic result",
    }
    process_registry.completion_queue.put(event)
    attempts, accepted = [], []

    def submit(_rid, live_sid, owned_session, text):
        attempts.append(text)
        if refusal == "exception" and len(attempts) == 1:
            raise RuntimeError("synthetic dispatch failure")
        admitted = server._admit_prompt_turn(live_sid, owned_session, text, None, None, [])
        if admitted is not None:
            accepted.append(text)
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
    assert "synthetic result" in accepted[0]
    assert process_registry.completion_queue.empty()
