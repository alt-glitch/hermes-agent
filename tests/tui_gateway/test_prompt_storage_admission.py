"""Every accepted input receives a terminal correlation, even before agent startup."""

import errno
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from tui_gateway import server


@pytest.fixture
def registered_session(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(server, "_load_cfg", lambda: {"dashboard": {}})
    monkeypatch.setattr(server, "_voice_mode_enabled", lambda: False)
    monkeypatch.setattr(server, "_persist_branch_seed", lambda _session: None)
    events = []
    monkeypatch.setattr(server, "_emit", lambda kind, sid, payload=None: events.append((kind, sid, payload)))
    ready = threading.Event()
    ready.set()
    session = {
        "session_key": "storage-admission", "profile_home": str(tmp_path),
        "running": False, "history": [], "history_lock": threading.RLock(),
        "agent": SimpleNamespace(), "agent_ready": ready, "agent_build_started": True,
        "active_session_lease": object(), "attached_images": [], "cols": 80,
    }
    sid = "storage-admission-live"
    with server._sessions_lock:
        server._sessions[sid] = session
    try:
        yield sid, session, events
    finally:
        ready.set()
        worker = session.get("_run_thread")
        if worker is not None:
            worker.join(2)
        with server._sessions_lock:
            server._sessions.pop(sid, None)


def _submit(sid, client_id, *, queued=False):
    return server.handle_request({
        "id": client_id, "method": "prompt.submit",
        "params": {
            "session_id": sid, "client_submission_id": client_id,
            "text": f"synthetic {client_id}", "queued": queued,
        },
    })


@pytest.mark.parametrize("failure, code", [(False, 5072), (RuntimeError("synthetic storage failure"), 5071),
                                          (OSError(errno.ENOSPC, "synthetic full disk"), 5070)])
@pytest.mark.parametrize("with_queued_input", [False, True])
def test_storage_rejection_settles_concurrent_queue_without_retaining_rejected_turn(
    monkeypatch, registered_session, failure, code, with_queued_input,
):
    sid, session, events = registered_session
    entered, release = threading.Event(), threading.Event()
    attempts, responses, errors = [], [], []

    def persist(_session):
        attempts.append(True)
        if len(attempts) == 1:
            entered.set()
            assert release.wait(3), "test did not release storage admission"
            if isinstance(failure, Exception):
                raise failure
            return failure
        return True

    def first_submit():
        try:
            responses.append(_submit(sid, "original"))
        except BaseException as exc:
            errors.append(exc)

    monkeypatch.setattr(server, "_ensure_session_db_row", persist)
    run = Mock(return_value=True)
    monkeypatch.setattr(server, "_run_prompt_submit", run)
    worker = threading.Thread(target=first_submit, daemon=True)
    worker.start()
    try:
        assert entered.wait(2), "first RPC did not reach persistence"
        if with_queued_input:
            queued = _submit(sid, "queued", queued=True)
            assert queued["result"]["status"] == "queued"
            assert not responses
    finally:
        release.set()
        worker.join(2)

    assert not worker.is_alive()
    assert not errors
    assert responses[0]["error"]["code"] == code
    assert session["running"] is False
    assert session["inflight_turn"] is None
    assert session.get("queued_prompt") is None
    assert not session.get("queued_prompts")
    assert session["_active_client_submission_ids"] == []
    assert session["_pending_steer_submission_ids"] == []
    run.assert_not_called()
    terminal = [payload for kind, _, payload in events if kind == "message.complete"]
    if with_queued_input:
        assert len(terminal) == 1
        assert terminal[0]["client_submission_ids"] == ["queued"]
        assert terminal[0]["status"] == "error"
        assert terminal[0]["error"] == responses[0]["error"]["message"]
    else:
        assert terminal == []

    retry = _submit(sid, "retry")
    assert retry["result"]["status"] == "streaming"
    session["_run_thread"].join(2)
    assert not session["_run_thread"].is_alive()
    run.assert_called_once()
    assert run.call_args.args[3] == "synthetic retry"
    assert run.call_args.kwargs["client_submission_ids"] == ["retry"]


@pytest.mark.parametrize("cancel_requested", [True, False])
def test_agent_ready_cancellation_settles_original_and_queued_receipts(
    monkeypatch, registered_session, cancel_requested,
):
    sid, session, events = registered_session
    session["agent_ready"].clear()
    monkeypatch.setattr(server, "_ensure_session_db_row", lambda _session: True)
    run = Mock(return_value=True)
    monkeypatch.setattr(server, "_run_prompt_submit", run)
    original = _submit(sid, "original")
    assert original["result"]["status"] == "streaming"
    queued = _submit(sid, "queued", queued=True)
    assert queued["result"]["status"] == "queued"
    with session["history_lock"]:
        if cancel_requested:
            session["_turn_cancel_requested"] = True
        else:
            session["running"] = False
    session["agent_ready"].set()
    session["_run_thread"].join(2)

    assert not session["_run_thread"].is_alive()
    run.assert_not_called()
    terminal = [payload for kind, _, payload in events if kind == "message.complete"]
    assert len(terminal) == 1
    assert terminal[0]["client_submission_ids"] == ["original", "queued"]
    assert terminal[0]["status"] == "error"
    assert not any(kind == "error" for kind, _, _ in events)
    assert session["running"] is False
    assert session.get("queued_prompt") is None
    assert session["_active_client_submission_ids"] == []
    assert session["inflight_turn"] is None
