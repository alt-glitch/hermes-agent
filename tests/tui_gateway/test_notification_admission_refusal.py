"""Notification delivery is acknowledged only when its admitted turn is retained."""

import contextlib
import io
import queue
import threading
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from hermes_state import SessionDB
from run_agent import AIAgent
from tools import async_delegation
from tools.process_registry import process_registry
from tools.process_registry_notifications import format_process_notification
from tui_gateway import server


@pytest.fixture
def session(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(server, "_emit", Mock())
    return {"session_key": "notification-admission", "running": False, "history_lock": threading.RLock()}


def _stop_response(text="synthetic response"):
    message = SimpleNamespace(
        content=text, reasoning_content=None, reasoning=None, tool_calls=None,
    )
    choice = SimpleNamespace(message=message, finish_reason="stop")
    return SimpleNamespace(choices=[choice], model="test/model", usage=None)


def _real_agent(db, session_id):
    with (
        contextlib.redirect_stdout(io.StringIO()),
        patch("model_tools.get_tool_definitions", return_value=[]),
        patch("model_tools.check_toolset_requirements", return_value={}),
        patch("agent.process_bootstrap.OpenAI"),
    ):
        agent = AIAgent(
            api_key="test-key",
            base_url="https://example.invalid/v1",
            model="test/model",
            enabled_toolsets=[],
            disabled_toolsets=[],
            quiet_mode=True,
            skip_memory=True,
            skip_context_files=True,
            session_db=db,
            session_id=session_id,
        )
    agent._session_db_created = True
    agent._cached_system_prompt = "SYSTEM"
    agent._skip_mcp_refresh = True
    agent._use_prompt_caching = False
    agent._disable_streaming = True
    agent.tool_delay = 0
    agent.save_trajectories = False
    agent.client = Mock()
    agent.client.chat.completions.create.return_value = _stop_response()
    return agent


@pytest.mark.parametrize("event_type", ["completion", "async_delegation"])
def test_idle_notification_waits_for_accepted_user_prompt(monkeypatch, session, event_type):
    """The poller can wake after running clears but before the queued-user drain."""
    event = {
        "type": event_type, "session_id": "synthetic-process", "delegation_id": "synthetic-delegation",
        "origin_ui_session_id": "live-notification", "command": "echo synthetic", "exit_code": 0,
    }
    pending = {"text": "accepted user input", "images": []}
    session["queued_prompt"] = pending
    registry = SimpleNamespace(completion_queue=queue.Queue(), is_completion_consumed=lambda _sid: False)
    submit = Mock(return_value=True)
    monkeypatch.setattr(server, "_run_prompt_submit", submit)
    monkeypatch.setattr(async_delegation, "claim_event_delivery", lambda *_: "delivery-claim")

    assert server._notif_handle_event(
        "live-notification", session, event, set(), registry, lambda _event: "synthetic result", [],
    ) is False
    submit.assert_not_called()
    assert registry.completion_queue.get_nowait() is event
    assert session["queued_prompt"] is pending
    assert session["running"] is False


@pytest.mark.parametrize("event_type", ["completion", "async_delegation"])
@pytest.mark.parametrize("outcome", [False, True, "exception"])
def test_event_receipt_and_retry_follow_actual_admission(monkeypatch, session, event_type, outcome):
    event = {
        "type": event_type, "session_id": "synthetic-process", "delegation_id": "synthetic-delegation",
        "origin_ui_session_id": "live-notification", "command": "echo synthetic", "exit_code": 0,
    }
    registry = SimpleNamespace(completion_queue=queue.Queue(), is_completion_consumed=lambda _sid: False)
    monkeypatch.setattr(process_registry, "completion_queue", registry.completion_queue)
    complete, release = Mock(), Mock()
    monkeypatch.setattr(async_delegation, "claim_event_delivery", lambda *_: "delivery-claim")
    monkeypatch.setattr(async_delegation, "complete_event_delivery", complete)
    monkeypatch.setattr(async_delegation, "release_event_delivery", release)
    callbacks = []

    def submit(*_args, **kwargs):
        callbacks.append(kwargs.get("history_commit_callback"))
        if outcome == "exception":
            raise RuntimeError("synthetic refusal")
        return outcome

    monkeypatch.setattr(server, "_run_prompt_submit", submit)

    keep_draining = server._notif_handle_event(
        "live-notification", session, event, set(), registry, lambda _event: "synthetic result", [],
    )

    assert len(callbacks) == 1
    if outcome is True:
        assert keep_draining is True
        assert registry.completion_queue.empty()
        complete.assert_not_called()
        callbacks[0](server._HistoryCommitOutcome(True, True, True))
        complete.assert_called_once_with(event, "delivery-claim")
        release.assert_not_called()
    else:
        assert keep_draining is False
        assert session["running"] is False
        assert registry.completion_queue.get_nowait() == event
        assert registry.completion_queue.empty()
        release.assert_called_once_with(event, "delivery-claim")
        complete.assert_not_called()


@pytest.mark.parametrize("event_type", ["completion", "async_delegation"])
def test_admitted_event_retries_after_history_failure_without_a_second_card(
    monkeypatch, tmp_path, session, event_type,
):
    event = {
        "type": event_type, "session_id": "synthetic-process", "delegation_id": "synthetic-delegation",
        "origin_ui_session_id": "live-notification", "command": "echo synthetic", "exit_code": 0,
    }
    registry = SimpleNamespace(completion_queue=queue.Queue(), is_completion_consumed=lambda _sid: False)
    monkeypatch.setattr(process_registry, "completion_queue", registry.completion_queue)
    release = Mock()
    monkeypatch.setattr(async_delegation, "claim_event_delivery", lambda *_: "delivery-claim")
    monkeypatch.setattr(async_delegation, "complete_event_delivery", Mock())
    monkeypatch.setattr(async_delegation, "release_event_delivery", release)
    db = SessionDB(db_path=tmp_path / f"{event_type}.db")
    db.create_session(session["session_key"], source="tui", model="test/model")
    agent = _real_agent(db, session["session_key"])
    session.update({"agent": agent, "attached_images": [], "history": [], "history_version": 0})
    monkeypatch.setattr(server, "_sessions", {"live-notification": session})
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_: None)
    monkeypatch.setattr(server, "_record_turn_marker", lambda *_: "")

    preparation_attempts = 0

    def prepare(_sid, owned_session, st, text, _images):
        nonlocal preparation_attempts
        preparation_attempts += 1
        if preparation_attempts == 1:
            raise RuntimeError("synthetic preparation failure")
        st.history = list(owned_session["history"])
        st.history_version = owned_session["history_version"]
        return text, text, 80, None

    monkeypatch.setattr(server, "_prepare_turn_input", prepare)
    monkeypatch.setattr(server, "_recover_turn_exception", lambda *_: None)
    monkeypatch.setattr(server, "_finish_turn", lambda *_: None)
    monkeypatch.setattr(server, "_emit_settled_session_info", lambda *_: None)
    monkeypatch.setattr(server, "_run_post_turn_followups", lambda *_: None)
    monkeypatch.setattr(server, "_sync_session_key_after_compress", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_complete_turn_payload", lambda *_: ({}, "", "complete"))
    monkeypatch.setattr(server, "_goal_followup_after_turn", lambda *_: None)
    monkeypatch.setattr(server, "_settle_loop_claim", lambda *_: None)
    monkeypatch.setattr(server, "_after_complete_turn", lambda *_: None)
    monkeypatch.setattr(server, "_publish_session_control_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        server,
        "_start_usage_ticker",
        lambda *_: (SimpleNamespace(set=lambda: None), SimpleNamespace(join=lambda: None)),
    )
    monkeypatch.setattr("agent.turn_context._maybe_title_session_at_turn_start", lambda *_: None)

    emitted = set()
    assert server._notif_handle_event(
        "live-notification", session, event, emitted, registry, format_process_notification, [],
    ) is True
    session["_run_thread"].join(2)
    assert not session["_run_thread"].is_alive()

    assert release.call_args.args == (event, "delivery-claim")
    assert registry.completion_queue.get_nowait() is event
    assert "display_notification" not in server._notification_turn_display(
        event, "synthetic result", "live-notification")
    assert "display_notification" in server._notification_turn_display(
        event, "synthetic result", "resumed-notification")
    assert server._notif_handle_event(
        "live-notification", session, event, emitted, registry, format_process_notification, [],
    ) is True
    session["_run_thread"].join(2)
    assert not session["_run_thread"].is_alive()
    assert release.call_count == 1
    assert registry.completion_queue.empty()
    cards = [call for call in server._emit.call_args_list if call.args[0] == "notification.show"]
    assert len(cards) == 1
    assert agent.client.chat.completions.create.call_count == 1
    rows = db.get_messages_as_conversation(session["session_key"])
    synthetic_rows = [row for row in rows if row.get("role") == "user"]
    assert len(synthetic_rows) == 1
    assert synthetic_rows[0]["display_kind"] == (
        "async_delegation_complete" if event_type == "async_delegation" else "process_complete"
    )
    cold_messages = server._history_to_messages(rows, include_ui_chrome=True)
    assert [message["role"] for message in cold_messages].count("notification") == 1
    agent.close()
    db.close()


def test_preflight_refusal_cannot_stamp_an_older_identical_row(
    monkeypatch, tmp_path, session,
):
    """A no-row preflight result cannot borrow durability from an earlier turn."""
    from agent.turn_context import PreflightCompressionTimedOut

    text = "identical completion payload"
    db = SessionDB(db_path=tmp_path / "ownership.db")
    db.create_session(session["session_key"], source="tui", model="test/model")
    db.append_message(session["session_key"], "user", text)
    history = db.get_messages_as_conversation(session["session_key"])
    agent = _real_agent(db, session["session_key"])

    with patch(
        "agent.turn_context_compaction.run_turn_start_compaction",
        side_effect=PreflightCompressionTimedOut("fixture preflight timeout"),
    ):
        result = agent.run_conversation(
            text,
            conversation_history=history,
            persist_user_display_kind="process_complete",
            persist_user_display_metadata={"kind": "process.complete", "text": "job done"},
        )

    assert agent.client.chat.completions.create.call_count == 0
    assert result["turn_exit_reason"] == "context_compression_timeout"
    st = server._TurnRun(agent, None, None, True)
    st.history = list(history)
    st.history_version = 0
    st.invocation_started = True
    st.result = result
    session.update({"agent": agent, "history": list(history), "history_version": 0})

    _, outcome = server._absorb_turn_result(
        "live-notification",
        session,
        st,
        text,
        "process_complete",
        {"kind": "process.complete", "text": "job done"},
    )
    event = {
        "type": "completion", "session_id": "synthetic-process",
        "command": "echo synthetic", "exit_code": 0,
    }
    retry_queue = queue.Queue()
    monkeypatch.setattr(process_registry, "completion_queue", retry_queue)
    server._settle_notification_delivery("live-notification", event, "", outcome)

    [older_row] = db.get_messages_as_conversation(session["session_key"])
    assert older_row.get("display_kind") is None
    assert outcome.delivery_succeeded is False
    assert outcome.invocation_started is False
    assert retry_queue.get_nowait() is event
    agent.close()
    db.close()


@pytest.mark.parametrize("event_type", ["completion", "async_delegation"])
@pytest.mark.parametrize("history_case", ["no_db", "success", "missing", "preflight", False, "exception"])
def test_invoked_notification_settles_without_replaying_for_display_repair(
    monkeypatch, tmp_path, session, event_type, history_case,
):
    event = {
        "type": event_type, "session_id": "synthetic-process", "delegation_id": "synthetic-delegation",
        "origin_ui_session_id": "live-notification", "command": "echo synthetic", "exit_code": 0,
    }
    registry = SimpleNamespace(completion_queue=queue.Queue(), is_completion_consumed=lambda _sid: False)
    monkeypatch.setattr(process_registry, "completion_queue", registry.completion_queue)
    complete, release, drop = Mock(), Mock(), Mock(return_value=True)
    claim = "delivery-claim" if event_type == "async_delegation" else ""
    monkeypatch.setattr(async_delegation, "claim_event_delivery", lambda *_: claim)
    monkeypatch.setattr(async_delegation, "complete_event_delivery", complete)
    monkeypatch.setattr(async_delegation, "release_event_delivery", release)
    monkeypatch.setattr(async_delegation, "drop_completion_delivery", drop)

    class ControlledHistory:
        def set_message_display_kind(self, *_args, **_kwargs):
            if history_case == "exception":
                raise RuntimeError("synthetic persistence failure")
            return False

    db = None
    history = None if history_case in {"no_db", "missing"} else ControlledHistory()
    if history_case == "success":
        db = SessionDB(db_path=tmp_path / "state.db")
        db.create_session(session["session_key"], source="tui", model="fixture-model")
        history = db
    agent = SimpleNamespace(
        interim_assistant_callback=None, session_id=session["session_key"], _session_db=history,
        _persist_user_message_idx=None,
    )
    session.update({"agent": agent, "attached_images": [], "history": [], "history_version": 0})
    monkeypatch.setattr(server, "_sessions", {"live-notification": session})
    monkeypatch.setattr(server, "_ensure_active_session_slot", lambda *_: None)
    monkeypatch.setattr(server, "_record_turn_marker", lambda *_: "")

    def prepare(_sid, owned_session, st, text, _images):
        st.history = list(owned_session["history"])
        st.history_version = owned_session["history_version"]
        return text, text, 80, None

    def invoke(_sid, _session, st, prompt, *_args):
        st.invocation_started = True
        if history_case == "preflight":
            from agent.conversation_loop import _preflight_timeout_result
            from agent.turn_context import PreflightCompressionTimedOut
            st.result = _preflight_timeout_result(agent, PreflightCompressionTimedOut("fixture timeout"), st.history)
            return
        row_id = db.append_message(session["session_key"], "user", prompt) if db is not None else None
        missing = history_case == "missing"
        agent._persist_user_message_idx = None if missing else 0
        st.result = {
            "messages": ([{
                "role": "user", "content": prompt,
                **({"_row_id": row_id or 1} if history is not None else {}),
            }] if not missing else [])
            + [{"role": "assistant", "content": "synthetic response"}],
            "final_response": "synthetic response",
        }

    monkeypatch.setattr(server, "_prepare_turn_input", prepare)
    monkeypatch.setattr(server, "_invoke_agent", invoke)
    monkeypatch.setattr(server, "_sync_session_key_after_compress", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_complete_turn_payload", lambda *_: ({}, "", "complete"))
    monkeypatch.setattr(server, "_goal_followup_after_turn", lambda *_: None)
    monkeypatch.setattr(server, "_settle_loop_claim", lambda *_: None)
    monkeypatch.setattr(server, "_after_complete_turn", lambda *_: None)
    monkeypatch.setattr(server, "_publish_session_control_snapshot", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(server, "_finish_turn", lambda *_: None)
    monkeypatch.setattr(server, "_emit_settled_session_info", lambda *_: None)
    monkeypatch.setattr(server, "_run_post_turn_followups", lambda *_: None)

    emitted = set()
    assert server._notif_handle_event(
        "live-notification", session, event, emitted, registry, lambda _event: "synthetic result", [],
    ) is True
    session["_run_thread"].join(2)
    assert not session["_run_thread"].is_alive()

    cards = [call for call in server._emit.call_args_list if call.args[0] == "notification.show"]
    assert len(cards) == 1
    if history_case in {"no_db", "success"}:
        complete.assert_called_once_with(event, claim)
        release.assert_not_called()
        drop.assert_not_called()
        assert registry.completion_queue.empty()
        if db is not None:
            [persisted] = db.get_messages_as_conversation(session["session_key"])
            assert persisted["display_kind"] == (
                "async_delegation_complete" if event_type == "async_delegation" else "process_complete"
            )
        else:
            assert session["history"][0]["display_kind"] == (
                "async_delegation_complete" if event_type == "async_delegation" else "process_complete"
            )
    elif history_case == "preflight":
        complete.assert_not_called()
        drop.assert_not_called()
        release.assert_called_once_with(event, claim)
        assert registry.completion_queue.get_nowait() is event
    else:
        complete.assert_not_called()
        release.assert_not_called()
        assert registry.completion_queue.empty()
        warnings = [call.args[2]["text"] for call in server._emit.call_args_list
                    if call.args[0] == "status.update" and call.args[2].get("kind") == "warn"]
        assert len(warnings) == 1
        assert "could not be saved" in warnings[0]
        assert "Automatic delivery stopped" in warnings[0]
        assert "reached the model" not in warnings[0]  # Agent entry may fail in preflight, before a provider call.
        if event_type == "async_delegation":
            drop.assert_called_once_with("synthetic-delegation", claim)
            assert "delegate_task(action='list')" in warnings[0]
        else:
            drop.assert_not_called()
            assert "process_manage(action='log'" in warnings[0]
    if db is not None:
        db.close()


@pytest.mark.parametrize("outcome", [False, "exception"])
def test_kanban_claimed_batch_survives_refusal_and_retries_in_order(monkeypatch, session, outcome):
    collect = Mock(side_effect=[["first event", "second event"], []])
    monkeypatch.setattr(server, "_collect_kanban_notifications", collect)
    submissions = []

    def submit(_rid, _sid, owned_session, text, **_kwargs):
        submissions.append(text)
        if len(submissions) == 1:
            with owned_session["history_lock"]:
                owned_session.setdefault("_kanban_pending", []).append("later event")
            if outcome == "exception":
                raise RuntimeError("synthetic refusal")
            return False
        return True

    monkeypatch.setattr(server, "_run_prompt_submit", submit)
    server._notif_poll_kanban("live-notification", session)
    assert session["running"] is False
    assert session["_kanban_pending"] == ["first event", "second event", "later event"]

    server._notif_poll_kanban("live-notification", session)
    assert submissions == ["first event\nsecond event", "first event\nsecond event\nlater event"]
    assert session["_kanban_pending"] == []
    assert session["running"] is True


@pytest.mark.parametrize("prompt", ["check the synthetic build", "/synthetic-skill"])
@pytest.mark.parametrize("outcome", [False, True, "exception"])
def test_loop_claim_settles_only_after_admission(monkeypatch, session, prompt, outcome):
    from hermes_cli import loops

    monkeypatch.setattr(loops, "goal_blocks_loop_tick", lambda _sid: False)
    monkeypatch.setattr(server, "read_turn_marker", lambda *_: None)
    monkeypatch.setitem(
        server._methods, "command.dispatch",
        lambda *_: {"result": {"type": "send", "message": "resolved synthetic skill"}},
    )
    manager = loops.LoopManager(session["session_key"])
    manager.set(prompt, interval_seconds=60)
    submit = Mock(return_value=outcome, side_effect=RuntimeError("synthetic refusal") if outcome == "exception" else None)
    monkeypatch.setattr(server, "_run_prompt_submit", submit)

    server._maybe_fire_tui_loop_tick("live-notification", session)

    submit.assert_called_once()
    state = loops.LoopManager(session["session_key"]).state
    assert state is not None
    assert state.status == "active"
    if outcome is True:
        assert state.awaiting_response is True
        assert state.ticks_fired == 1
        assert state.claim_id == submit.call_args.kwargs["loop_claim_id"]
        assert session["running"] is True
    else:
        assert state.awaiting_response is False
        assert state.ticks_fired == 0
        assert state.claim_id == ""
        assert session["running"] is False
