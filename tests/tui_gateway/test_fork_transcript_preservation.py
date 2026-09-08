"""Fork display contracts retained across the upstream gateway extraction."""

import copy
import threading

import pytest

from tools import async_delegation
from tui_gateway import server


@pytest.mark.parametrize("event_type", ["completion", "async_delegation"])
def test_notification_dispatch_has_one_start_and_retains_model_detail(monkeypatch, event_type):
    events, submissions, settled = [], [], []
    session = {
        "running": True, "history_lock": threading.RLock(), "agent": object(),
        "attached_images": [],
    }
    event = {
        "type": event_type, "session_id": "proc-test", "command": "echo done", "exit_code": 0,
        "delegation_id": "deleg-test", "status": "completed",
    }
    detail = "Full synthetic result retained for the model"
    claim = object()
    monkeypatch.setattr(server, "_emit", lambda kind, sid, payload=None: events.append((kind, payload)))
    monkeypatch.setattr(server, "_session_is_detached", lambda *_: False)
    monkeypatch.setattr(server, "_session_registry_matches", lambda *_: True)
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_: None)
    monkeypatch.setattr(async_delegation, "claim_event_delivery", lambda *_: claim)
    monkeypatch.setattr(async_delegation, "complete_event_delivery", lambda *args: settled.append(args))

    def submit(rid, sid, owned_session, text, **kwargs):
        submissions.append((owned_session, text, kwargs))
        return server._admit_prompt_turn(
            sid, owned_session, text, None, None, [], kwargs.get("display_notification")
        ) is not None

    monkeypatch.setattr(server, "_run_prompt_submit", submit)
    server._notif_dispatch_event("s1", session, event, detail)

    assert [kind for kind, _ in events] == ["notification.show", "message.start"]
    assert submissions[0][:2] == (session, detail)
    assert settled == [(event, claim)]
    if event_type == "async_delegation":
        assert submissions[0][2]["display_kind"] == "async_delegation_complete"
        assert events[0][1]["detail"] == detail
    else:
        assert submissions[0][2]["display_kind"] == "process_complete"
        assert submissions[0][2]["display_metadata"]["kind"] == "process.complete"


def test_busy_process_completion_emits_one_expandable_card_without_raw_status(monkeypatch):
    events = []
    session = {"running": True, "history_lock": threading.RLock(), "session_key": "owned"}
    event = {
        "type": "completion", "session_id": "proc-test", "session_key": "owned",
        "command": "printf full-result", "exit_code": 0, "output": "full-result",
    }
    registry = type("Registry", (), {
        "completion_queue": __import__("queue").Queue(),
        "is_completion_consumed": staticmethod(lambda _sid: False),
    })()
    monkeypatch.setattr(server, "_emit", lambda kind, sid, payload=None: events.append((kind, payload)))

    emitted = set()
    assert server._notif_handle_event(
        "s1", session, event, emitted, registry,
        lambda _event: "FULL MODEL DETAIL", None,
    ) is True
    assert [kind for kind, _ in events] == ["status.update"]
    status = events[0][1]
    assert status["kind"] == "status"
    assert status["text"].endswith("· proc-test")
    assert registry.completion_queue.get_nowait() == event

    assert server._notif_handle_event(
        "s1", session, event, emitted, registry,
        lambda _event: "FULL MODEL DETAIL", None,
    ) is True
    assert len(events) == 1


def test_native_history_projection_preserves_upstream_metadata_and_raw_history():
    history = [
        {"role": "user", "content": "hello", "timestamp": 123, "_row_id": 7},
        {"role": "user", "content": "internal", "display_kind": "hidden"},
        {"role": "assistant", "content": "", "reasoning": "reasoning retained"},
        {"role": "user", "content": "FULL PROCESS DETAIL", "display_kind": "process_complete",
         "display_metadata": {"always_visible": True, "key": "proc:p1", "kind": "process.complete",
                              "level": "success", "text": "echo result · completed · p1"}},
        {"role": "assistant", "tool_calls": [{"id": "t1", "function": {
            "name": "terminal", "arguments": '{"command":"echo result"}',
        }}]},
        {"role": "tool", "tool_call_id": "t1", "content": "result"},
    ]
    original = copy.deepcopy(history)

    native = server._history_to_messages(history, include_tool_output=True, include_ui_chrome=True)
    assert native[0] == {"role": "user", "text": "hello", "timestamp": 123.0, "row_id": 7}
    assert native[1]["reasoning"] == "reasoning retained"
    assert native[2]["role"] == "notification"
    assert native[2]["notification"]["detail"] == "FULL PROCESS DETAIL"
    assert native[2]["notification"]["always_visible"] is True
    assert native[3]["args"] == {"command": "echo result"}
    assert native[3]["result_text"] == "result"
    desktop = server._history_to_messages(history)
    assert desktop[2]["role"] == "user"
    assert desktop[3]["args"] == native[3]["args"]
    assert "result_text" not in desktop[3]
    assert history == original
