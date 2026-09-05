"""Accepted input gets a terminal correlation even when turn admission fails."""

import threading
from types import SimpleNamespace

import pytest

from tui_gateway import server
from tui_gateway.turn_marker import read_turn_marker


@pytest.fixture
def admission(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(server, "_hermes_home", tmp_path)
    session = {
        "session_key": "admission-test", "profile_home": str(tmp_path),
        "history_lock": threading.RLock(), "running": True,
        "agent": SimpleNamespace(clear_interrupt=lambda: None),
        "attached_images": [], "_active_client_submission_ids": ["active"],
        "_pending_steer_submission_ids": ["steer"], "pending_steer_chars": 5,
        "queued_prompt": {"text": "next", "client_submission_ids": ["queued"]},
        "_auto_continue_attempt": 2, "_auto_continue_prompt": "old interrupted prompt",
    }
    monkeypatch.setattr(server, "_sessions", {"live": session})
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_: None)
    events = []
    monkeypatch.setattr(server, "_emit", lambda kind, sid, payload=None: events.append((kind, payload)))
    monkeypatch.setattr(server, "_get_usage", lambda _: {})
    return session, events, tmp_path


@pytest.mark.parametrize("refusal", ["closed", "ownership", "cancelled", "generation"])
def test_admission_refusal_settles_all_accepted_ids_and_clears_recovery_metadata(monkeypatch, admission, refusal):
    session, events, home = admission
    generation = None
    if refusal == "closed":
        session["_closing"] = True
    elif refusal == "ownership":
        monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_: "owned elsewhere")
    elif refusal == "cancelled":
        session["_turn_cancel_requested"] = True
    else:
        session["_queued_prompt_generation"] = 3
        generation = 2

    assert server._admit_prompt_turn("live", session, "accepted", None, generation, ["direct"]) is None
    assert not any(kind == "message.start" for kind, _ in events)
    terminal = [payload for kind, payload in events if kind == "message.complete"]
    assert len(terminal) == 1
    assert terminal[0]["status"] == "error"
    assert set(terminal[0]["client_submission_ids"]) == {"direct", "active", "steer", "queued"}
    assert session["running"] is False
    assert session["inflight_turn"] is None
    assert session["queued_prompt"] is None
    assert session["_active_client_submission_ids"] == []
    assert session["_pending_steer_submission_ids"] == []
    assert "_auto_continue_attempt" not in session
    assert "_auto_continue_prompt" not in session

    # A subsequent real user turn cannot inherit the interrupted prompt or retry budget.
    server._record_turn_marker(session, "fresh user prompt")
    marker = read_turn_marker(home, session["session_key"])
    assert marker["prompt"] == "fresh user prompt"
    assert marker["attempts"] == 0
