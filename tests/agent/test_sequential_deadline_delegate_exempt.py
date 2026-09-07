"""``delegate_task`` runs a nested orchestrator's whole batch inside one tool call by design, so it must not
sit under the generic sequential-call deadline: with it, every batch longer than the deadline "timed out"
while its children kept running as orphans and the orchestrator polled transcripts for hours."""
import concurrent.futures
import threading
import time
from types import SimpleNamespace

from agent import tool_executor as te
from tools import delegate_tool


class _ProgressingChild:
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
        self.samples = 0
        self.finished = threading.Event()
        self.closed = threading.Event()

    def run_conversation(self, **_kwargs):
        assert self.finished.wait(timeout=2)
        return {
            "final_response": "healthy child completed",
            "completed": True,
            "api_calls": 1,
            "messages": [],
        }

    def get_activity_summary(self):
        self.samples += 1
        if self.samples >= 4:
            self.finished.set()
        return {
            "api_call_count": 1,
            "current_tool": None,
            "max_iterations": 10,
            "last_activity_ts": float(self.samples),
            "last_activity_desc": "receiving stream response",
        }

    def close(self):
        self.closed.set()


class _Parent:
    def __init__(self, child) -> None:
        self.session_id = "progressing-parent"
        self._current_task_id = None
        self._active_children = [child]
        self._active_children_lock = threading.Lock()
        self._tool_worker_threads = set()
        self._tool_worker_threads_lock = threading.Lock()
        self._interrupt_requested = False
        self.activity = []

    def _touch_activity(self, desc):
        self.activity.append(desc)


def test_progressing_delegate_task_can_outlive_generic_deadline(monkeypatch):
    child = _ProgressingChild()
    parent = _Parent(child)

    def _run_delegate(_agent, **_kwargs):
        return te._run_with_activity_heartbeat(
            parent,
            "delegate_task",
            lambda: te._ManagedToolResult(
                result=delegate_tool._run_single_child(
                    task_index=0,
                    goal="keep progressing",
                    child=child,
                    parent_agent=parent,
                ),
                args={},
                middleware_trace=[],
                blocked=False,
                dispatched=True,
            ),
        )

    monkeypatch.setattr(te, "_run_agent_tool_execution_middleware", _run_delegate)
    monkeypatch.setattr(te, "_resolve_sequential_tool_timeout", lambda: 0.005)
    monkeypatch.setattr(te, "_SEQUENTIAL_INTERRUPT_POLL_SECONDS", 0.002)
    monkeypatch.setattr(te, "_TOOL_ACTIVITY_HEARTBEAT_INTERVAL_S", 0.001)
    monkeypatch.setattr(delegate_tool, "_get_child_timeout", lambda: None)
    monkeypatch.setattr(delegate_tool, "_get_worktree_isolation", lambda: False)
    monkeypatch.setattr(delegate_tool, "_HEARTBEAT_INTERVAL", 0.01)
    monkeypatch.setattr(delegate_tool, "_HEARTBEAT_STALE_CYCLES_IDLE", 2)

    managed = te._run_sequential_tool_execution_middleware(
        parent,
        function_name="delegate_task",
        function_args={},
        effective_task_id="task",
        tool_call_id="call",
        execute=lambda _args: "unused",
    )

    assert managed.result["status"] == "completed"
    assert child.samples >= 4
    assert child.closed.is_set()
    assert not any(desc.startswith("tool running: delegate_task") for desc in parent.activity)


def test_exemption_is_narrow():
    assert "terminal" not in te._SEQUENTIAL_DEADLINE_EXEMPT_TOOLS
    assert "execute_code" not in te._SEQUENTIAL_DEADLINE_EXEMPT_TOOLS


def test_delegate_wait_does_not_mask_its_stale_monitor_with_parent_heartbeats(monkeypatch):
    class _OnePollFuture:
        calls = 0

        def result(self, timeout):
            self.calls += 1
            if self.calls == 1:
                raise concurrent.futures.TimeoutError
            return "done"

    parent = _Parent(None)
    monkeypatch.setattr(te, "_SEQUENTIAL_INTERRUPT_POLL_SECONDS", 0.001)

    state, result = te._poll_sequential_future(
        parent,
        _OnePollFuture(),
        "delegate_task",
        deadline=None,
        started=time.monotonic() - 31,
        authorization_gate=SimpleNamespace(excluded_seconds=lambda: 0),
    )

    assert (state, result) == ("done", "done")
    assert parent.activity == []
