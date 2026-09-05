"""Fork display contracts retained across the upstream gateway extraction."""

import copy
import threading

import pytest

from tools import async_delegation
from tui_gateway import server


@pytest.mark.parametrize("event_type", ["completion", "async_delegation"])
def test_notification_dispatch_has_one_start_and_retains_model_detail(monkeypatch, event_type):
    events, submissions, settled = [], [], []
    session = {"running": True, "history_lock": threading.RLock()}
    event = {
        "type": event_type, "session_id": "proc-test", "command": "echo done", "exit_code": 0,
        "delegation_id": "deleg-test", "status": "completed",
    }
    detail = "Full synthetic result retained for the model"
    claim = object()
    monkeypatch.setattr(server, "_emit", lambda kind, sid, payload=None: events.append((kind, payload)))
    monkeypatch.setattr(async_delegation, "claim_event_delivery", lambda *_: claim)
    monkeypatch.setattr(async_delegation, "complete_event_delivery", lambda *args: settled.append(args))

    def submit(rid, sid, owned_session, text, **kwargs):
        server._emit("message.start", sid)
        submissions.append((owned_session, text, kwargs))

    monkeypatch.setattr(server, "_run_prompt_submit", submit)
    server._notif_dispatch_event("s1", session, event, detail)

    assert [kind for kind, _ in events] == ["notification.show", "message.start"]
    assert submissions[0][:2] == (session, detail)
    assert settled == [(event, claim)]
    if event_type == "async_delegation":
        assert submissions[0][2]["display_kind"] == "async_delegation_complete"
        assert events[0][1]["detail"] == detail


def test_native_history_projection_preserves_upstream_metadata_and_raw_history():
    history = [
        {"role": "user", "content": "hello", "timestamp": 123, "_row_id": 7},
        {"role": "user", "content": "internal", "display_kind": "hidden"},
        {"role": "assistant", "content": "", "reasoning": "reasoning retained"},
        {"role": "assistant", "tool_calls": [{"id": "t1", "function": {
            "name": "terminal", "arguments": '{"command":"echo result"}',
        }}]},
        {"role": "tool", "tool_call_id": "t1", "content": "result"},
    ]
    original = copy.deepcopy(history)

    native = server._history_to_messages(history, include_tool_output=True, include_ui_chrome=True)
    assert native[0] == {"role": "user", "text": "hello", "timestamp": 123.0, "row_id": 7}
    assert native[1]["reasoning"] == "reasoning retained"
    assert native[2]["args"] == {"command": "echo result"}
    assert native[2]["result_text"] == "result"
    desktop = server._history_to_messages(history)
    assert desktop[2]["args"] == native[2]["args"]
    assert "result_text" not in desktop[2]
    assert history == original
