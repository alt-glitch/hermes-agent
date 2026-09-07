"""Task labels and supplied stream chunks survive the real delegation lifecycle."""

import copy
import json
import os
from pathlib import Path

import pytest


@pytest.mark.parametrize("shape", ["single", "batch", "background", "nested", "legacy", "failed", "label_limit"])
def test_task_metadata_survives_dispatch_registry_callbacks_and_completion(monkeypatch, shape):
    from run_agent import AIAgent
    from tools import delegate_tool as dt
    from tools import delegate_tool_registry as records
    from tools.registry import registry

    home = Path(os.environ["HERMES_HOME"])
    (home / "config.yaml").write_text("delegation:\n  max_spawn_depth: 3\n", encoding="utf-8")
    schema_before = copy.deepcopy(dt.DELEGATE_TASK_SCHEMA)
    events, observations, nested_results, scheduled = [], [], [], []
    parent = AIAgent(
        api_key="test-key", base_url="http://127.0.0.1:1/v1", provider="openai-compat", model="test-model",
        enabled_toolsets=["file"], quiet_mode=True, skip_context_files=True, skip_memory=True,
        save_trajectories=False, session_id="observability-parent",
        tool_progress_callback=lambda event, name=None, preview=None, args=None, **kw: events.append(
            {"event": event, "preview": preview, **kw}),
    )
    # Only the model call and detached scheduling are replaced. Construction,
    # callbacks, worker execution, registry ownership and completion stay real.
    def supplied_conversation(child, user_message, task_id, stream_callback):
        from types import SimpleNamespace
        from agent.chat_completion_helpers import _assistant_reasoning_text
        from agent.turn_response_intake import _relay_thinking

        child._stream_callback = stream_callback
        live = next(r for r in records.list_active_subagents() if r["subagent_id"] == child._subagent_id)
        observations.append((child, live, child.ephemeral_system_prompt))
        child.thinking_callback("Working...")
        for chunk in ("Compare", " ", "paths"):
            child._fire_reasoning_delta(chunk)
        child._fire_streamed_codex_commentary("AGENTS42_MIDTASK")
        child._fire_streamed_codex_commentary("AGENTS42_MIDTASK")
        child._fire_stream_delta("Draft before tool")
        interim = {"role": "assistant", "content": "Draft before tool"}
        child._emit_interim_assistant_message(interim)
        child._emit_interim_assistant_message(interim)
        for chunk in ("Answer", "\n", "  body"):
            stream_callback(chunk)
        # Post-stream response intake must not repeat the assembled reasoning.
        message = SimpleNamespace(content="Answer\n  body", reasoning_content="Compare paths")
        assert _assistant_reasoning_text(child, message) == "Compare paths"
        _relay_thinking(child, message.content)
        if shape == "nested" and user_message == "Inspect the parser":
            nested_results.append(json.loads(dt.delegate_task(
                tasks=[{"goal": "Inspect parser edge cases", "task_label": "Check edge cases"}], parent_agent=child)))
        if shape == "failed":
            raise RuntimeError("supplied failure")
        return {"final_response": "Answer\n  body", "completed": True, "api_calls": 1, "messages": []}

    def defer_batch(**kwargs):
        scheduled.append(kwargs)
        return {"status": "dispatched", "delegation_id": kwargs["delegation_id"]}

    monkeypatch.setattr(AIAgent, "run_conversation", supplied_conversation)
    monkeypatch.setattr("tools.async_delegation.dispatch_async_delegation_batch", defer_batch)
    tasks = [{"goal": "Inspect the parser", "task_label": "Scan sources"}]
    if shape == "label_limit":
        tasks[0]["task_label"] = "x" * 120
    if shape in {"batch", "background"}:
        tasks.append({"goal": "Review the parser tests"})
    original_tasks = copy.deepcopy(tasks)
    try:
        if shape == "legacy":
            result = json.loads(dt.delegate_task(goal="Inspect the parser", parent_agent=parent))
        elif shape == "background":
            # Exercise the actual registered model-tool handler with a routable owner.
            handle = json.loads(registry.dispatch("delegate_task", {"tasks": tasks}, parent_agent=parent))
            assert handle["task_labels"] == ["Scan sources", None]
            assert not observations
            assert all(unit["parent_session_id"] == parent.session_id for unit in scheduled)
            unit_results = [unit["runner"]() for unit in scheduled]
            result = {
                "results": sorted(
                    [entry for unit in unit_results for entry in unit["results"]],
                    key=lambda entry: entry["task_index"],
                ),
                "live_transcripts": [
                    path for unit in unit_results for path in unit.get("live_transcripts", [])
                ],
            }
        else:
            result = json.loads(dt.delegate_task(tasks=tasks, parent_agent=parent))

        assert "error" not in result, result
        assert all(r["status"] == ("error" if shape == "failed" else "completed") for r in result["results"]), result
        expected = {} if shape == "legacy" else {"Inspect the parser": tasks[0]["task_label"]}
        if shape == "nested":
            expected["Inspect parser edge cases"] = "Check edge cases"
            assert "error" not in nested_results[0], nested_results[0]
            assert nested_results[0]["results"][0]["task_label"] == "Check edge cases"
        for child, live, prompt in observations:
            child_id = child._subagent_id
            label = expected.get(live["goal"])
            assert live.get("task_label") == label
            branch = [e for e in events if e.get("subagent_id") == child_id]
            assert branch[0]["event"] == "subagent.spawn_requested"
            assert branch[-1]["event"] == "subagent.complete"
            assert all(e.get("task_label") == label for e in branch)
            assert all(e.get("parent_id") == live["parent_id"] for e in branch)
            assert next(e for e in branch if e["event"] == "subagent.start")["started_at"] == live["started_at"]
            assert [e["preview"] for e in branch if e["event"] == "subagent.reasoning"] == ["Compare", " ", "paths"]
            text_events = [e for e in branch if e["event"] == "subagent.text"]
            assert [(e["preview"], e.get("already_streamed")) for e in text_events] == [
                ("AGENTS42_MIDTASK", None),
                ("Draft before tool", None),
                ("Answer", None),
                ("\n", None),
                ("  body", None),
            ]
            assert sum(e["event"] == "subagent.complete" for e in branch) == 1
            assert not any(e["preview"] == "Answer\n  body" for e in text_events)
            assert [e["preview"] for e in branch if e["event"] == "subagent.thinking"] == ["Working...", "Answer"]
            assert records.get_subagent_attribution(child_id).get("task_label") == label
            assert label is None or label not in prompt  # display metadata never changes the child prompt
        assert result["results"][0].get("task_label") == expected.get("Inspect the parser")
        if shape in {"batch", "background"}:
            assert "task_label" not in result["results"][1]
        assert all(Path(path).is_relative_to(Path(os.environ["HERMES_HOME"])) for path in result["live_transcripts"])
        assert not records.list_active_subagents()
        assert tasks == original_tasks
        assert dt.DELEGATE_TASK_SCHEMA == schema_before
        event_count = len(events)
        for child, _, _ in observations:
            child._fire_streamed_codex_commentary("Late after completion")
        assert len(events) == event_count
    finally:
        parent.close()


@pytest.mark.parametrize("label", [None, 42, "", "   ", "x" * 121, "two\nlines", "two\twords", "escape\x1b", "two\x85lines"])
def test_invalid_task_labels_are_rejected_before_child_construction(monkeypatch, label):
    from types import SimpleNamespace
    from tools import delegate_tool as dt
    from tools.registry import registry

    built = []
    monkeypatch.setattr(dt, "_build_child_agent", lambda **kwargs: built.append(kwargs))
    parent = SimpleNamespace(_delegate_depth=0, model="test-model", provider="openai-compat", base_url="http://127.0.0.1:1/v1")
    result = json.loads(registry.dispatch("delegate_task", {
        "tasks": [{"goal": "Inspect the parser", "task_label": label}],
    }, parent_agent=parent))
    assert "task_label" in result["error"]
    assert not built
