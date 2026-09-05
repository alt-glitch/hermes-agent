"""Real admission/resume paths settle even when preparation loses a race or refuses input."""

import threading
import time
from types import SimpleNamespace

import pytest

from hermes_state import SessionDB
from tui_gateway import server


@pytest.mark.parametrize("correlated", [False, True])
@pytest.mark.parametrize("hosted", [False, True])
@pytest.mark.parametrize("resumed", [False, True])
def test_context_refusal_finishes_accepted_turn(monkeypatch, tmp_path, correlated, hosted, resumed):
    from agent import context_references, model_metadata

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(server, "_hermes_home", tmp_path)
    monkeypatch.setattr(server, "_CRASH_LOG", str(tmp_path / "crash.log"))
    invoked = []
    agent = SimpleNamespace(model="test", clear_interrupt=lambda: None, _session_messages=[],
                            run_conversation=lambda *a, **k: invoked.append(True))
    history = ([{"role": "user", "content": "Earlier question"},
                {"role": "assistant", "content": "Earlier answer"}] if resumed else [])
    session = {"session_key": "refused-context", "agent": agent, "running": True,
               "history": list(history), "history_lock": threading.RLock(), "attached_images": []}
    monkeypatch.setattr(server, "_sessions", {"live": session})
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_: None)
    for name in ("_wire_callbacks", "_apply_pending_model_switch", "_sync_agent_model_with_config",
                 "_sync_agent_compression_with_config", "_sync_bot_capabilities", "_register_session_cwd",
                 "_emit_settled_session_info", "_run_post_turn_followups"):
        monkeypatch.setattr(server, name, lambda *a, **k: None)
    monkeypatch.setattr(server, "_session_cwd", lambda _: str(tmp_path))
    monkeypatch.setattr(server, "_get_usage", lambda _: {})
    monkeypatch.setattr(server, "make_stream_renderer", lambda _: None)
    monkeypatch.setattr(server, "render_message", lambda *a: "")
    monkeypatch.setattr(model_metadata, "get_model_context_length", lambda *a, **k: 1000)
    monkeypatch.setattr(context_references, "preprocess_context_references",
                        lambda *a, **k: SimpleNamespace(blocked=True, warnings=["Context exceeds budget"]))
    events, receipts = [], []
    monkeypatch.setattr(server, "_emit", lambda kind, sid, payload=None: events.append((kind, payload)))
    ids = ["user-send"] if correlated else []
    assert server._run_prompt_submit("request", "live", session, "@oversized", client_submission_ids=ids,
                                     terminal_callback=receipts.append if hosted else None)
    session["_run_thread"].join(timeout=5)
    assert not session["_run_thread"].is_alive()
    assert invoked == []
    assert session["history"] == history
    assert [kind for kind, _ in events].count("message.start") == 1
    completed = [payload for kind, payload in events if kind == "message.complete"]
    assert len(completed) == 1
    assert completed[0]["status"] == "error"
    assert completed[0]["error"] == "Context exceeds budget"
    assert completed[0].get("client_submission_ids", []) == ids
    assert receipts == ([{"status": "failed", "text": "", "error": "Context exceeds budget"}] if hosted else [])
    assert session["running"] is False
    assert session["_active_client_submission_ids"] == []
    assert session["inflight_turn"]["status"] == "error"


def test_concurrent_eager_resumes_reuse_winner_without_reentering_lock(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session("stored", source="tui", model="test")
    barrier = threading.Barrier(2)
    closed, results, errors = [], [], []
    sessions = {}

    class BoundedLock:
        """Keep a regression failure bounded instead of stranding a pytest thread."""
        def __init__(self):
            self.lock = threading.Lock()

        def __enter__(self):
            assert self.lock.acquire(timeout=2), "resume lock reacquired by its owner"

        def __exit__(self, *args):
            self.lock.release()

    def make_agent(sid, *args, **kwargs):
        barrier.wait(timeout=3)
        return SimpleNamespace(model="test", close=lambda: closed.append(sid))

    def init_session(sid, key, agent, history, **kwargs):
        sessions[sid] = {"agent": agent, "session_key": key, "created_at": time.time()}

    monkeypatch.setattr(server, "_sessions", sessions)
    monkeypatch.setattr(server, "_session_resume_lock", BoundedLock())
    monkeypatch.setattr(server, "_profile_session_db", lambda _: (db, False))
    monkeypatch.setattr(server, "_make_agent_in_context", make_agent)
    monkeypatch.setattr(server, "_init_session", init_session)
    monkeypatch.setattr(server, "_session_info", lambda *a: {})
    monkeypatch.setattr(server, "_live_session_payload", lambda sid, *a, **k: {"session_id": sid})
    monkeypatch.setattr(server, "_enable_gateway_prompts", lambda: None)
    monkeypatch.setattr(server, "_maybe_schedule_auto_continue", lambda *a: None)
    monkeypatch.setattr(server, "_cancel_ws_orphan_reap", lambda *a: None)
    monkeypatch.setattr(server, "_find_live_session_by_key",
                        lambda key, *_: next(((sid, row) for sid, row in sessions.items()
                                              if row["session_key"] == key), None))

    def resume():
        try:
            results.append(server.handle_request({"id": "resume", "method": "session.resume",
                                                   "params": {"session_id": "stored", "eager_build": True}}))
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=resume, daemon=True) for _ in range(2)]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        assert all(not thread.is_alive() for thread in threads)
        assert errors == []
        assert len(results) == 2
        assert all("result" in result for result in results), results
        assert results[0]["result"]["session_id"] == results[1]["result"]["session_id"]
        assert len(sessions) == 1
        assert len(closed) == 1
    finally:
        db.close()
