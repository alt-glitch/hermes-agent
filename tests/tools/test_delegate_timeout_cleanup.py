"""Regression coverage for timed-out delegation teardown."""

from __future__ import annotations

import threading
from types import SimpleNamespace

from tools import delegate_tool


class _SlowUnwindingChild:
    def __init__(self) -> None:
        self.tool_progress_callback = None
        self._credential_pool = None
        self._delegate_saved_tool_names = []
        self._delegate_role = "leaf"
        self._delegate_depth = 1
        self._subagent_id = None
        self.model = "test-model"
        self.session_prompt_tokens = 0
        self.session_completion_tokens = 0
        self.session_estimated_cost_usd = 0.0
        self.session_cost_status = "unknown"
        self.started = threading.Event()
        self.interrupted = threading.Event()
        self.unwinding = threading.Event()
        self.allow_finish = threading.Event()
        self.finished = threading.Event()
        self.closed = threading.Event()
        self.close_while_running = False

    def run_conversation(self, **_kwargs):
        self.started.set()
        assert self.interrupted.wait(timeout=1)
        # Model the real child turn's finally path: it still performs session
        # activity/SQLite cleanup after the parent requests interruption.
        self.unwinding.set()
        assert self.allow_finish.wait(timeout=2)
        self.finished.set()
        return {
            "final_response": "",
            "completed": False,
            "interrupted": True,
            "api_calls": 1,
            "messages": [],
        }

    def hard_interrupt(self, _reason=None):
        self.interrupted.set()

    def get_activity_summary(self):
        return {"api_call_count": 1}

    def close(self):
        if not self.finished.is_set():
            self.close_while_running = True
        self.closed.set()


class _StalledUntilInterruptedChild(_SlowUnwindingChild):
    """Frozen child whose real hard-interrupt boundary unwinds its worker."""

    def run_conversation(self, **_kwargs):
        self.started.set()
        assert self.interrupted.wait(timeout=2)
        self.finished.set()
        return {
            "final_response": "",
            "completed": False,
            "interrupted": True,
            "api_calls": 1,
            "messages": [],
        }

    def hard_interrupt(self, _reason=None):
        self.interrupted.set()

    def get_activity_summary(self):
        return {
            "api_call_count": 1,
            "current_tool": None,
            "max_iterations": 10,
            "last_activity_ts": 1000.0,
            "last_activity_desc": "waiting for provider response",
        }


def test_timeout_does_not_close_child_while_worker_is_unwinding(monkeypatch):
    child = _SlowUnwindingChild()
    parent = SimpleNamespace(
        session_id="parent-timeout-test",
        _current_task_id=None,
        _active_children=[child],
        _active_children_lock=threading.Lock(),
    )
    monkeypatch.setattr(delegate_tool, "_get_child_timeout", lambda: 0.5)
    monkeypatch.setattr(delegate_tool, "_get_worktree_isolation", lambda: False)

    result = delegate_tool._run_single_child(
        task_index=0,
        goal="exercise timeout teardown",
        child=child,
        parent_agent=parent,
    )

    assert result["status"] == "timeout"
    assert child.unwinding.wait(timeout=1)
    try:
        assert not child.closed.is_set(), (
            "timed-out child.close() ran before its conversation thread unwound"
        )
    finally:
        child.allow_finish.set()
    assert child.finished.wait(timeout=1)
    assert child.closed.wait(timeout=1)
    assert not child.close_while_running, (
        "timed-out child.close() raced its still-running conversation thread"
    )


def test_no_timeout_stalled_child_is_interrupted_and_joined(monkeypatch):
    """The progress monitor, not a generic wall clock, bounds a frozen child."""
    child = _StalledUntilInterruptedChild()
    parent = SimpleNamespace(
        session_id="parent-stall-test",
        _current_task_id=None,
        _active_children=[child],
        _active_children_lock=threading.Lock(),
        _touch_activity=lambda _desc: None,
    )
    monkeypatch.setattr(delegate_tool, "_get_child_timeout", lambda: None)
    monkeypatch.setattr(delegate_tool, "_get_worktree_isolation", lambda: False)
    monkeypatch.setattr(delegate_tool, "_HEARTBEAT_INTERVAL", 0.01)
    monkeypatch.setattr(delegate_tool, "_HEARTBEAT_STALE_CYCLES_IDLE", 2)

    result = delegate_tool._run_single_child(
        task_index=0,
        goal="exercise stalled-child cancellation",
        child=child,
        parent_agent=parent,
    )

    assert result["status"] == "interrupted"
    assert child.interrupted.is_set()
    assert child.finished.is_set()
    assert child.closed.is_set()
    assert not child.close_while_running
    assert child not in parent._active_children
