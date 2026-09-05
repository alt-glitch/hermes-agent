"""Real child callbacks and gateway framing keep branch data independent of chrome."""

from types import SimpleNamespace

import pytest


class _Transport:
    def __init__(self):
        self.frames = []

    def write(self, frame):
        self.frames.append(frame["params"])
        return True


@pytest.mark.parametrize("mode", ["all", "off"])
@pytest.mark.parametrize("nested", [False, True])
def test_branch_stream_preserves_owner_identity_and_child_mirror(monkeypatch, mode, nested):
    from tui_gateway import server
    from tools.delegate_tool_child_run import _ChildRun
    from tools.delegate_tool_progress import _build_child_progress_callback
    from agent.turn_response_intake import _relay_thinking

    parent_wire, child_wire, unrelated_wire = _Transport(), _Transport(), _Transport()
    monkeypatch.setattr(server, "_sessions", {
        "parent": {"transport": parent_wire, "tool_progress_mode": mode},
        "watch": {"session_key": "child-session", "agent": None, "transport": child_wire},
        "unrelated": {"session_key": "other-session", "agent": None, "transport": unrelated_wire},
    })
    monkeypatch.setattr(server, "_child_mirrors", {})
    monkeypatch.setattr(server, "_active_child_runs", {})
    parent = SimpleNamespace(tool_progress_callback=server._agent_cbs("parent")["tool_progress_callback"])
    if nested:
        outer = _build_child_progress_callback(
            0, "Outer task", parent, subagent_id="outer", depth=0,
            session_ref={"session_id": "outer-session", "task_label": "Outer label"},
        )
        parent = SimpleNamespace(tool_progress_callback=outer)
    identity = {"session_id": "child-session", "delegation_id": "batch-child", "started_at": 1234.5}
    callback = _build_child_progress_callback(
        1, "Inspect the parser", parent, task_count=2, subagent_id="child",
        parent_id="outer" if nested else None, depth=int(nested), session_ref=identity,
    )
    run = _ChildRun(None, parent, 1, "Inspect the parser", "child", callback)
    callback("subagent.spawn_requested", preview="Inspect the parser")
    callback("subagent.start", preview="Inspect the parser")
    callback("tool.started", "read_file", "parser.py")
    callback("_thinking", "Working...")
    _relay_thinking(SimpleNamespace(_delegate_depth=1, tool_progress_callback=callback), "Supplied preview\nSecond line")
    reasoning = ["Compare", " ", "the paths"]
    for chunk in reasoning:
        callback("subagent.reasoning", preview=chunk)
    chunks = ["First", " ", "line", "\n", "  next"]
    for chunk in chunks:
        run.relay_text(chunk)
    callback("subagent.complete", status="completed", summary="First line\n  next")

    frames = parent_wire.frames
    types = [frame["type"] for frame in frames]
    assert types == ["subagent.spawn_requested", "subagent.start", "subagent.tool", "subagent.thinking", "subagent.thinking",
                     *["subagent.reasoning" for _ in reasoning],
                     *["subagent.text" for _ in chunks], "subagent.complete"]
    for frame in frames:
        assert frame["session_id"] == "parent"
        payload = frame["payload"]
        assert payload["subagent_id"] == "child"
        assert payload.get("parent_id") == ("outer" if nested else None)
        assert payload["child_session_id"] == "child-session"
        assert payload["delegation_id"] == "batch-child"
        assert payload["goal"] == "Inspect the parser"
        assert payload["task_index"] == 1
        assert payload["started_at"] == identity["started_at"]
        assert "task_label" not in payload  # never borrow a nested parent's label
    assert [f["payload"]["text"] for f in frames if f["type"] == "subagent.text"] == chunks
    mirrored = [f["payload"]["text"] for f in child_wire.frames if f["type"] == "message.delta"]
    assert mirrored == ["Inspect the parser\n", *chunks]
    assert [f["payload"]["text"] for f in frames if f["type"] == "subagent.reasoning"] == reasoning
    assert [f["payload"]["text"] for f in child_wire.frames if f["type"] == "reasoning.delta"] == reasoning
    assert [f["payload"]["text"] for f in child_wire.frames if f["type"] == "thinking.delta"] == ["Working...", "Supplied preview"]
    assert child_wire.frames[-1]["type"] == "message.complete"
    assert server._child_mirrors == {}
    assert server._active_child_runs == {}
    assert unrelated_wire.frames == []
    assert len({f["seq"] for f in frames}) == len(frames)

    before = len(frames)
    server._on_tool_progress("parent", "reasoning.available", "_thinking", "ordinary chrome")
    assert len(frames) == before + (mode != "off")


def test_timed_out_worker_cannot_reopen_child_mirror(monkeypatch):
    import json
    import threading

    from run_agent import AIAgent
    from tools import delegate_tool as dt
    from tools.delegate_tool_progress import _build_child_progress_callback
    from tui_gateway import server

    parent_wire, child_wire = _Transport(), _Transport()
    watch = {"session_key": "pending", "agent": None, "transport": child_wire}
    monkeypatch.setattr(server, "_sessions", {
        "parent": {"transport": parent_wire, "tool_progress_mode": "off"}, "watch": watch,
    })
    monkeypatch.setattr(server, "_child_mirrors", {})
    monkeypatch.setattr(server, "_active_child_runs", {})
    monkeypatch.setattr(dt, "_get_child_timeout", lambda: 0.2)
    release, closed = threading.Event(), threading.Event()
    observed = {}

    def blocked_provider(child, user_message, task_id, stream_callback):
        observed["child"] = child
        watch["session_key"] = child.session_id
        original_close = child.close

        def close():
            try:
                original_close()
            finally:
                closed.set()

        child.close = close
        child._stream_callback = stream_callback
        child._claim_stream_writer()
        child._fire_reasoning_delta("Early reasoning")
        stream_callback("Early answer")
        assert release.wait(timeout=5)
        observed["superseded"] = child._stream_writer_superseded()
        child._fire_reasoning_delta("Late reasoning")
        stream_callback("Late answer")
        child.thinking_callback("Late activity")
        return {"final_response": "Late answer", "completed": True, "api_calls": 1, "messages": []}

    monkeypatch.setattr(AIAgent, "run_conversation", blocked_provider)
    parent = AIAgent(
        api_key="test-key", base_url="http://127.0.0.1:1/v1", provider="openai-compat", model="test-model",
        enabled_toolsets=["file"], quiet_mode=True, skip_context_files=True, skip_memory=True,
        save_trajectories=False, session_id="timeout-parent",
        tool_progress_callback=server._agent_cbs("parent")["tool_progress_callback"],
    )
    try:
        result = json.loads(dt.delegate_task(goal="Inspect timeout ownership", parent_agent=parent))
        assert result["results"][0]["status"] == "timeout", result
        assert child_wire.frames[-1]["type"] == "message.complete"
        parent_count, child_count = len(parent_wire.frames), len(child_wire.frames)
        release.set()
        assert closed.wait(timeout=5)
        assert observed["superseded"] is False  # stop != newer stream attempt
        assert len(parent_wire.frames) == parent_count
        assert len(child_wire.frames) == child_count
        assert not server._child_run_active(watch["session_key"])
        assert not server._child_mirrors

        # A fresh owner for the same session remains free to stream and complete.
        fresh = _build_child_progress_callback(
            0, "New run", parent, subagent_id="new-child",
            session_ref={"session_id": watch["session_key"]},
        )
        fresh("subagent.start")
        fresh("subagent.reasoning", preview="New reasoning")
        assert server._child_run_active(watch["session_key"])
        fresh("subagent.complete", status="completed", summary="New answer")
        assert child_wire.frames[-1]["payload"]["text"] == "New answer"
        assert not server._child_run_active(watch["session_key"])
    finally:
        release.set()
        if "child" in observed:
            assert closed.wait(timeout=5)
        parent.close()
