"""Closing one session must not monopolize the registry while waiting on it."""

import threading
import uuid
from unittest.mock import Mock

import pytest

from tui_gateway import server


class _ObservedMutationLock:
    """A real mutex with a deterministic signal before the close waiter blocks."""

    def __init__(self):
        self.lock = threading.RLock()
        self.waiting = threading.Event()

    def __enter__(self):
        self.waiting.set()
        self.lock.acquire()
        return self

    def __exit__(self, *_exc):
        self.lock.release()


@pytest.fixture
def registered_sessions(monkeypatch):
    sid = f"close-lock-{uuid.uuid4().hex}"
    other_sid = f"{sid}-unrelated"
    mutation = _ObservedMutationLock()
    session = {
        "session_key": sid,
        "history_lock": threading.Lock(),
        "_mutation_lock": mutation,
        "running": False,
        "transport": server._detached_ws_transport,
    }
    unrelated = {"session_key": other_sid, "history_lock": threading.Lock()}
    teardown = Mock()
    monkeypatch.setattr(server, "_teardown_session", teardown)
    with server._sessions_lock:
        server._sessions[sid] = session
        server._sessions[other_sid] = unrelated
    try:
        yield sid, session, other_sid, unrelated, mutation, teardown
    finally:
        with server._sessions_lock:
            server._sessions.pop(sid, None)
            server._sessions.pop(other_sid, None)


def _close_in_thread(sid, results, errors, *, transport=None, action=None, **kwargs):
    def close():
        try:
            if action is not None:
                results.append(action())
            elif transport is None:
                results.append(server._close_session_by_id(sid, **kwargs))
            else:
                results.append(server._close_sessions_for_transport(transport))
        except BaseException as exc:
            errors.append(exc)

    worker = threading.Thread(target=close, daemon=True)
    worker.start()
    return worker


@pytest.mark.parametrize("transport_close", [False, True])
def test_waiting_session_close_leaves_unrelated_registry_read_available(registered_sessions, transport_close):
    sid, session, other_sid, unrelated, mutation, teardown = registered_sessions
    results, errors = [], []
    read_finished = threading.Event()
    reads = []

    def read_unrelated():
        reads.append(server._session_registry_matches(other_sid, unrelated))
        read_finished.set()

    reader = threading.Thread(target=read_unrelated, daemon=True)
    mutation.lock.acquire()
    session["close_on_disconnect"] = True
    closer = _close_in_thread(
        sid, results, errors, transport=session["transport"] if transport_close else None)
    try:
        assert mutation.waiting.wait(2), "close never reached the owned mutation lock"
        assert not results, "close bypassed the owned mutation lock"
        reader.start()
        assert read_finished.wait(2), "waiting close held the global session registry lock"
        assert reads == [True]
        teardown.assert_not_called()
    finally:
        mutation.lock.release()
        closer.join(2)
        if reader.ident is not None:
            reader.join(2)

    assert not closer.is_alive()
    assert not reader.is_alive()
    assert not errors
    assert results == ([(1, 0)] if transport_close else [True])
    assert not server._session_registry_matches(sid, session)
    teardown.assert_called_once_with(session, end_reason="ws_disconnect" if transport_close else "tui_close")


def test_transport_close_rechecks_rebound_owner_after_mutation_wait(registered_sessions):
    sid, session, _other_sid, _unrelated, mutation, teardown = registered_sessions
    session["close_on_disconnect"] = True
    old_transport = session["transport"]
    results, errors = [], []
    mutation.lock.acquire()
    closer = _close_in_thread(sid, results, errors, transport=old_transport)
    try:
        assert mutation.waiting.wait(2)
        session["transport"] = object()
    finally:
        mutation.lock.release()
        closer.join(2)

    assert not closer.is_alive()
    assert not errors
    assert results == [(0, 0)]
    assert server._session_registry_matches(sid, session)
    teardown.assert_not_called()


def test_close_revalidates_orphan_predicate_after_waiting_for_mutation(registered_sessions):
    sid, session, _other_sid, _unrelated, mutation, teardown = registered_sessions
    results, errors = [], []
    assert server._ws_session_is_orphaned(session)

    mutation.lock.acquire()
    closer = _close_in_thread(
        sid, results, errors,
        end_reason="ws_orphan_reap", predicate=server._ws_session_is_orphaned,
    )
    try:
        assert mutation.waiting.wait(2), "close never reached the owned mutation lock"
        assert not results, "close bypassed the owned mutation lock"
        session["transport"] = object()
        assert not server._ws_session_is_orphaned(session)
    finally:
        mutation.lock.release()
        closer.join(2)

    assert not closer.is_alive()
    assert not errors
    assert results == [False]
    assert server._session_registry_matches(sid, session)
    assert "_closing" not in session
    teardown.assert_not_called()


@pytest.mark.parametrize("path", ["idle_reaper", "idle_started", "forced_reaper", "supersession"])
def test_sibling_close_rechecks_reconnected_transport(monkeypatch, registered_sessions, path):
    sid, session, _other_sid, _unrelated, mutation, teardown = registered_sessions
    callbacks = []

    class PendingTimer:
        def __init__(self, _delay, callback):
            callbacks.append(callback)

        def start(self):
            pass

        def cancel(self):
            pass

    monkeypatch.setattr(server.threading, "Timer", PendingTimer)
    monkeypatch.setattr(server, "_WS_ORPHAN_REAP_GRACE_S", 1)
    monkeypatch.setattr(server, "_session_has_active_delegations", lambda *_: False)
    monkeypatch.setattr(server, "_pending_ws_reaps", {})
    if path == "supersession":
        def action():
            return server._claim_parked_runtimes(session["session_key"], keep_sid="new-runtime")
    else:
        if path == "forced_reaper":
            session.update(running=True, _client_gone_interrupt_requested=True,
                           _client_gone_interrupt_polls=server._WS_ORPHAN_INTERRUPT_REAP_MAX_POLLS)
        server._schedule_ws_orphan_reap(sid)
        action = callbacks[0]
    results, errors = [], []
    mutation.lock.acquire()
    closer = _close_in_thread(sid, results, errors, action=action)
    try:
        assert mutation.waiting.wait(2)
        if path == "idle_started":
            session["running"] = True
        else:
            session["transport"] = object()
    finally:
        mutation.lock.release()
        closer.join(2)

    assert not closer.is_alive()
    assert not errors
    assert server._session_registry_matches(sid, session)
    assert "_closing" not in session
    teardown.assert_not_called()
    if path == "idle_started":
        assert len(callbacks) == 2, "new detached work lost its orphan monitor"
