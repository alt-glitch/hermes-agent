"""A prompt that lands mid-turn is redirected or queued, never dropped.

Before this, ``prompt.submit`` on a running session returned ``session busy``,
forcing clients into a deadline-bounded busy-retry. When turn teardown outlived
the deadline — e.g. a slow, non-interruptible tool (``web_search``) still
running when the user hit stop — the resubmitted message was silently dropped
("it just doesn't listen"). The gateway now applies the ``busy_input_mode``
policy: queue the message by default, with explicit interrupt and steer modes.
Interrupt mode redirects capable core agents in place and retains the legacy
interrupt + queue path as a compatibility fallback.
"""

import threading
import time
import types

import pytest

from tui_gateway import server


def _session(agent=None, **extra):
    return {
        "agent": agent if agent is not None else types.SimpleNamespace(),
        "session_key": "session-key",
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": False,
        "transport": None,
        "attached_images": [],
        **extra,
    }


def _drain_registered(rid, sid, session):
    with server._sessions_lock:
        previous = server._sessions.get(sid)
        server._sessions[sid] = session
    try:
        return server._drain_queued_prompt(rid, sid, session)
    finally:
        with server._sessions_lock:
            if previous is None:
                if server._sessions.get(sid) is session:
                    server._sessions.pop(sid, None)
            else:
                server._sessions[sid] = previous


# ── _enqueue_prompt ────────────────────────────────────────────────────────

def test_enqueue_pins_text_and_transport():
    session = _session()
    server._enqueue_prompt(session, "hello", "ws-1")
    assert session["queued_prompt"] == {"text": "hello", "transport": "ws-1"}


def test_enqueue_merges_second_arrival_losslessly():
    session = _session()
    server._enqueue_prompt(session, "first", "ws-1")
    server._enqueue_prompt(session, "second", "ws-2")
    assert session["queued_prompt"]["text"] == "first\n\nsecond"
    # Latest transport wins so the drain streams to the most recent client.
    assert session["queued_prompt"]["transport"] == "ws-2"


def test_enqueue_preserves_correlations_until_the_merged_turn_starts(monkeypatch):
    session = _session()
    server._enqueue_prompt(session, "first", "ws-1", client_submission_ids=["send-1"])
    server._enqueue_prompt(session, "second", "ws-2", client_submission_ids=["send-2"])
    fired = {}
    monkeypatch.setattr(
        server,
        "_run_prompt_submit",
        lambda rid, sid, current, text, **kwargs: fired.update(
            rid=rid, sid=sid, text=text, **kwargs
        ),
    )

    assert _drain_registered("r1", "sid", session) is True
    assert fired["text"] == "first\n\nsecond"
    assert fired["client_submission_ids"] == ["send-1", "send-2"]
    assert session["queued_prompt"] is None


def test_enqueue_front_preserves_leftover_steer_before_later_prompt():
    session = _session()
    server._enqueue_prompt(session, "later prompt", "ws-later")
    server._enqueue_prompt(session, "leftover steer", "ws-live", front=True)

    queued = session["queued_prompt"]
    assert queued["text"].splitlines() == [
        "leftover steer",
        "",
        "later prompt",
    ]
    assert queued["transport"] == "ws-live"


def test_busy_retry_is_best_effort_and_can_queue_duplicate(monkeypatch):
    """A lost ACK is ambiguous: retrying may enqueue the body twice."""

    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "queue")
    session = _session(running=True)

    first = server._handle_busy_submit("r1", "sid", session, "same", "ws-1")
    retry = server._handle_busy_submit("r2", "sid", session, "same", "ws-1")

    assert first["result"]["status"] == "queued"
    assert retry["result"]["status"] == "queued"
    assert session["queued_prompt"]["text"].count("same") == 2


def test_enqueue_text_capacity_rejects_overflow_without_mutation():
    session = _session()
    exact = "x" * server._MAX_PENDING_INPUT_CHARS
    server._enqueue_prompt(session, exact, "ws-1")

    before = dict(session["queued_prompt"])
    with pytest.raises(OverflowError, match="capacity"):
        server._enqueue_prompt(session, "y", "ws-2")

    assert session["queued_prompt"] == before


def test_leftover_promotion_restores_agent_when_queue_is_full():
    session = _session(
        queued_prompt={
            "text": "x" * server._MAX_PENDING_INPUT_CHARS,
            "transport": "ws-old",
        }
    )
    agent = types.SimpleNamespace(
        _pending_steer=None,
        _pending_steer_lock=threading.Lock(),
    )

    assert server._promote_leftover_steer(session, agent, "leftover") is False
    assert agent._pending_steer == "leftover"
    assert len(session["queued_prompt"]["text"]) == server._MAX_PENDING_INPUT_CHARS


# ── _handle_busy_submit (policy) ───────────────────────────────────────────

def test_tui_gateway_busy_mode_defaults_to_queue_but_honors_explicit_modes(
    monkeypatch,
):
    for configured, expected in [
        ({}, "queue"),
        ({"display": {}}, "queue"),
        ({"display": {"busy_input_mode": "bogus"}}, "queue"),
        ({"display": {"busy_input_mode": "interrupt"}}, "interrupt"),
        ({"display": {"busy_input_mode": "steer"}}, "steer"),
    ]:
        monkeypatch.setattr(server, "_load_cfg", lambda value=configured: value)
        assert server._load_busy_input_mode() == expected


def test_busy_interrupt_mode_redirects_active_turn(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    seen = []
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda text: seen.append(text) or True,
        interrupt=lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("redirect must not hard-interrupt")
        ),
    )
    session = _session(agent=agent, running=True)
    session["inflight_turn"] = {"user": "original request", "assistant": "partial reply"}

    resp = server._handle_busy_submit("r1", "sid", session, "redirect", "ws-1")

    assert resp["result"]["status"] == "redirected"
    assert seen == ["redirect"]
    # Appended, not overwritten: the original prompt must stay recoverable.
    assert session["inflight_turn"]["user"] == "original request"
    assert session["inflight_turn"]["corrections"] == ["redirect"]
    assert session.get("queued_prompt") is None


def test_busy_interrupt_mode_falls_back_for_legacy_agent(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    calls = {"interrupt": 0}
    agent = types.SimpleNamespace(interrupt=lambda *a, **k: calls.__setitem__("interrupt", calls["interrupt"] + 1))
    session = _session(agent=agent, running=True)

    resp = server._handle_busy_submit("r1", "sid", session, "redirect", "ws-1")

    assert resp["result"]["status"] == "queued"
    deadline = time.monotonic() + 1
    while calls["interrupt"] != 1 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert calls["interrupt"] == 1
    assert session["queued_prompt"]["text"] == "redirect"


def test_busy_queue_mode_queues_without_interrupting(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "queue")
    calls = {"interrupt": 0}
    agent = types.SimpleNamespace(interrupt=lambda *a, **k: calls.__setitem__("interrupt", calls["interrupt"] + 1))
    session = _session(agent=agent, running=True)

    resp = server._handle_busy_submit("r1", "sid", session, "later", "ws-1")

    assert resp["result"]["status"] == "queued"
    assert calls["interrupt"] == 0
    assert session["queued_prompt"]["text"] == "later"


def test_busy_steer_mode_injects_when_accepted(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")
    agent = types.SimpleNamespace(steer=lambda text: True, interrupt=lambda *a, **k: None)
    session = _session(agent=agent, running=True)

    resp = server._handle_busy_submit("r1", "sid", session, "nudge", "ws-1")

    assert resp["result"]["status"] == "steered"
    assert session.get("queued_prompt") is None


def test_busy_steer_correlates_the_current_turn_until_completion(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")
    agent = types.SimpleNamespace(
        steer=lambda text: True,
        interrupt=lambda *a, **k: None,
    )
    session = _session(
        agent=agent,
        running=True,
        _active_client_submission_ids=["turn-owner"],
    )

    response = server._handle_busy_submit(
        "r1",
        "sid",
        session,
        "nudge",
        "ws-1",
        ["steer-send"],
    )

    assert response["result"]["status"] == "steered"
    assert session["_active_client_submission_ids"] == ["turn-owner"]
    assert session["_pending_steer_submission_ids"] == ["steer-send"]


def test_busy_prompt_rpc_reuses_the_admission_lock_without_deadlock(monkeypatch):
    """prompt.submit already owns history_lock when it enters busy policy."""

    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")
    session = _session(
        agent=types.SimpleNamespace(
            steer=lambda text: True,
            interrupt=lambda *a, **k: None,
        ),
        running=True,
    )
    server._sessions["sid"] = session
    response = {}

    def submit():
        response.update(
            server.handle_request(
                {
                    "id": "r-lock",
                    "method": "prompt.submit",
                    "params": {
                        "client_submission_id": "send-lock",
                        "session_id": "sid",
                        "text": "nudge",
                    },
                }
            )
        )

    worker = threading.Thread(target=submit, daemon=True)
    try:
        worker.start()
        worker.join(timeout=1)
        assert not worker.is_alive(), "prompt.submit reacquired its history lock"
        assert response["result"]["status"] == "steered"
        assert session["_pending_steer_submission_ids"] == ["send-lock"]
    finally:
        server._sessions.pop("sid", None)


def test_busy_steer_rejects_before_correlation_id_capacity(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")
    monkeypatch.setattr(server, "_MAX_QUEUED_SUBMISSION_IDS", 3)
    steers = []
    session = _session(
        agent=types.SimpleNamespace(
            steer=lambda text: steers.append(text) or True,
            interrupt=lambda *a, **k: None,
        ),
        running=True,
        _active_client_submission_ids=["turn"],
        _pending_steer_submission_ids=["first-steer"],
    )

    accepted = server._handle_busy_submit(
        "r1", "sid", session, "second", "ws-1", ["second-steer"]
    )
    rejected = server._handle_busy_submit(
        "r2", "sid", session, "third", "ws-1", ["third-steer"]
    )

    assert accepted["result"]["status"] == "steered"
    assert rejected["error"]["code"] == 4009
    assert steers == ["second"]
    assert session["_pending_steer_submission_ids"] == [
        "first-steer",
        "second-steer",
    ]


def test_terminal_gap_routes_steer_mode_to_queue_without_interrupt(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")
    calls = {"interrupt": 0, "steer": 0}
    session = _session(
        agent=types.SimpleNamespace(
            interrupt=lambda: calls.__setitem__(
                "interrupt", calls["interrupt"] + 1
            ),
            steer=lambda _text: calls.__setitem__("steer", calls["steer"] + 1)
            or True,
        ),
        running=True,
        _steer_admission_closed=True,
    )

    response = server._handle_busy_submit(
        "r1", "sid", session, "next turn", "ws-1", ["next-send"]
    )

    assert response["result"]["status"] == "queued"
    assert calls == {"interrupt": 0, "steer": 0}
    assert session["queued_prompt"] == {
        "client_submission_ids": ["next-send"],
        "text": "next turn",
        "transport": "ws-1",
    }


def test_terminal_gap_rejects_direct_session_steer():
    calls = []
    session = _session(
        agent=types.SimpleNamespace(steer=lambda text: calls.append(text) or True),
        running=True,
        _steer_admission_closed=True,
    )
    server._sessions["sid"] = session
    try:
        response = server.handle_request(
            {
                "id": "r1",
                "method": "session.steer",
                "params": {"session_id": "sid", "text": "too late"},
            }
        )
    finally:
        server._sessions.pop("sid", None)

    assert response["result"]["status"] == "rejected"
    assert calls == []


def test_busy_steer_mode_falls_back_to_queue_when_rejected(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")
    agent = types.SimpleNamespace(steer=lambda text: False, interrupt=lambda *a, **k: None)
    session = _session(agent=agent, running=True)

    resp = server._handle_busy_submit("r1", "sid", session, "nudge", "ws-1")

    assert resp["result"]["status"] == "queued"
    assert session["queued_prompt"]["text"] == "nudge"


def test_busy_interrupt_does_not_hold_history_lock_or_delay_queue(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    interrupt_started = threading.Event()
    release_interrupt = threading.Event()

    def blocking_interrupt():
        interrupt_started.set()
        release_interrupt.wait(timeout=2)

    session = _session(
        agent=types.SimpleNamespace(interrupt=blocking_interrupt),
        running=True,
    )

    started = time.monotonic()
    resp = server._handle_busy_submit("r1", "sid", session, "keep this", "ws-1")

    assert resp["result"]["status"] == "queued"
    assert time.monotonic() - started < 0.25
    assert session["queued_prompt"]["text"] == "keep this"
    assert interrupt_started.wait(timeout=1)
    assert session["history_lock"].acquire(timeout=0.25)
    session["history_lock"].release()
    release_interrupt.set()


def test_delayed_busy_interrupt_blocks_early_drain(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *_args: False)
    interrupt_started = threading.Event()
    release_interrupt = threading.Event()
    successor_started = threading.Event()

    def blocking_interrupt():
        interrupt_started.set()
        release_interrupt.wait(timeout=2)

    monkeypatch.setattr(
        server,
        "_run_prompt_submit",
        lambda *_args, **_kwargs: successor_started.set(),
    )
    session = _session(
        agent=types.SimpleNamespace(interrupt=blocking_interrupt),
        running=True,
    )
    server._sessions["sid"] = session
    try:
        response = server._handle_busy_submit(
            "r1", "sid", session, "run after interrupt", "ws-1"
        )
        assert response["result"]["status"] == "queued"
        assert interrupt_started.wait(timeout=1)

        with session["history_lock"]:
            session["running"] = False
        assert server._drain_queued_prompt("r1", "sid", session) is False
        assert not successor_started.is_set()
        assert session["queued_prompt"]["text"] == "run after interrupt"

        release_interrupt.set()
        assert successor_started.wait(timeout=1)
        assert session.get("_busy_interrupt_pending") is False
        assert session["queued_prompt"] is None
        assert session["running"] is True
    finally:
        release_interrupt.set()
        server._sessions.pop("sid", None)


@pytest.mark.parametrize("lifecycle", ["close", "replace"])
def test_delayed_busy_interrupt_cannot_dispatch_detached_session(
    monkeypatch, lifecycle
):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *_args: False)
    interrupt_started = threading.Event()
    release_interrupt = threading.Event()
    drain_finished = threading.Event()
    successor_started = threading.Event()

    def blocking_interrupt():
        interrupt_started.set()
        release_interrupt.wait(timeout=2)

    monkeypatch.setattr(
        server,
        "_run_prompt_submit",
        lambda *_args, **_kwargs: successor_started.set(),
    )
    monkeypatch.setattr(
        server,
        "_teardown_session",
        lambda current, **_kwargs: current.__setitem__("_finalized", True),
    )
    real_drain = server._drain_queued_prompt

    def observed_drain(*args, **kwargs):
        try:
            return real_drain(*args, **kwargs)
        finally:
            drain_finished.set()

    monkeypatch.setattr(server, "_drain_queued_prompt", observed_drain)
    session = _session(
        agent=types.SimpleNamespace(interrupt=blocking_interrupt),
        running=True,
    )
    server._sessions["sid"] = session
    try:
        response = server._handle_busy_submit(
            "r1", "sid", session, "never resurrect", "ws-1"
        )
        assert response["result"]["status"] == "queued"
        assert interrupt_started.wait(timeout=1)

        with session["history_lock"]:
            session["running"] = False
        if lifecycle == "close":
            assert server._close_session_by_id("sid") is True
            assert session["_finalized"] is True
        else:
            with server._sessions_lock:
                server._sessions["sid"] = _session()

        release_interrupt.set()
        assert drain_finished.wait(timeout=1)
        assert not successor_started.is_set()
        assert session["running"] is False
        assert session["queued_prompt"]["text"] == "never resurrect"
    finally:
        release_interrupt.set()
        server._sessions.pop("sid", None)


def test_idle_submit_joins_pending_interrupt_queue_with_correlations(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda *_args: False)
    interrupt_started = threading.Event()
    release_interrupt = threading.Event()
    successor_started = threading.Event()
    dispatched = {}

    def blocking_interrupt():
        interrupt_started.set()
        release_interrupt.wait(timeout=2)

    def run_successor(rid, sid, current, text, **kwargs):
        dispatched.update(
            rid=rid,
            sid=sid,
            session=current,
            text=text,
            **kwargs,
        )
        successor_started.set()

    monkeypatch.setattr(server, "_run_prompt_submit", run_successor)
    session = _session(
        agent=types.SimpleNamespace(interrupt=blocking_interrupt),
        running=True,
    )
    server._sessions["sid"] = session
    try:
        first = server._handle_busy_submit(
            "r1",
            "sid",
            session,
            "first accepted",
            "ws-1",
            ["send-1"],
        )
        assert first["result"]["status"] == "queued"
        assert interrupt_started.wait(timeout=1)

        with session["history_lock"]:
            session["running"] = False
        second = server.handle_request(
            {
                "id": "r2",
                "method": "prompt.submit",
                "params": {
                    "client_submission_id": "send-2",
                    "session_id": "sid",
                    "text": "second accepted",
                },
            }
        )

        assert second["result"]["status"] == "queued"
        assert not successor_started.is_set()
        assert session["running"] is False
        assert session["queued_prompt"]["text"] == (
            "first accepted\n\nsecond accepted"
        )
        assert session["queued_prompt"]["client_submission_ids"] == [
            "send-1",
            "send-2",
        ]

        release_interrupt.set()
        assert successor_started.wait(timeout=1)
        assert dispatched["text"] == "first accepted\n\nsecond accepted"
        assert dispatched["client_submission_ids"] == ["send-1", "send-2"]
    finally:
        release_interrupt.set()
        server._sessions.pop("sid", None)


def test_busy_helper_retries_when_turn_finished(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    session = _session(running=False)

    assert server._handle_busy_submit("r1", "sid", session, "run now", "ws-1") is None
    assert session.get("queued_prompt") is None


def test_busy_interrupt_mode_normalizes_rich_text_before_redirect(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    seen = []
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda text: seen.append(text) or True,
        interrupt=lambda *a, **k: None,
    )
    session = _session(agent=agent, running=True)
    rich = [{"type": "text", "text": "  redirect me  "}]

    resp = server._handle_busy_submit(
        "r1",
        "sid",
        session,
        rich,
        "ws-1",
    )

    assert resp["result"]["status"] == "redirected"
    assert seen == ["redirect me"]
    assert session.get("queued_prompt") is None


def test_busy_queue_fallback_preserves_original_structured_text(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    rich = [{"type": "text", "text": "  keep me  "}]
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda text: False,
        interrupt=lambda *a, **k: None,
    )
    session = _session(agent=agent, running=True)

    resp = server._handle_busy_submit("r1", "sid", session, rich, "ws-1")

    assert resp["result"]["status"] == "queued"
    assert session["queued_prompt"]["text"] == rich


def test_busy_interrupt_mode_queues_multimodal_payload_instead_of_redirect(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    seen = []
    rich = [
        {"type": "text", "text": "caption"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
    ]
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda text: seen.append(text) or True,
        interrupt=lambda *a, **k: None,
    )
    session = _session(agent=agent, running=True)

    resp = server._handle_busy_submit("r1", "sid", session, rich, "ws-1")

    assert resp["result"]["status"] == "queued"
    assert seen == []
    assert session["queued_prompt"]["text"] == rich


# ── _drain_queued_prompt ───────────────────────────────────────────────────

def test_drain_fires_queued_prompt_and_claims_running(monkeypatch):
    fired = {}
    monkeypatch.setattr(
        server, "_run_prompt_submit",
        lambda rid, sid, session, text: fired.update(rid=rid, sid=sid, text=text),
    )
    session = _session(queued_prompt={"text": "go", "transport": "ws-9"})

    assert _drain_registered("r1", "sid", session) is True
    assert fired == {"rid": "r1", "sid": "sid", "text": "go"}
    assert session["running"] is True
    assert session["queued_prompt"] is None
    assert session["transport"] == "ws-9"


def test_drain_noop_when_nothing_queued(monkeypatch):
    monkeypatch.setattr(server, "_run_prompt_submit", lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not fire")))
    session = _session()
    assert _drain_registered("r1", "sid", session) is False
    assert session["running"] is False


def test_drain_noop_when_session_already_running(monkeypatch):
    """A fresh turn that claimed the session beats a stale queued entry —
    the drain leaves it for that turn's own tail."""
    monkeypatch.setattr(server, "_run_prompt_submit", lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not fire")))
    session = _session(running=True, queued_prompt={"text": "go", "transport": None})
    assert _drain_registered("r1", "sid", session) is False
    assert session["queued_prompt"]["text"] == "go"


def test_unrelated_turn_then_queued_ack_keeps_client_correlation_until_drain(monkeypatch):
    """The queued ACK is not durable; its own later start is acceptance proof."""

    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "queue")
    session = _session(running=True)
    response = server._handle_busy_submit(
        "r-user",
        "sid",
        session,
        "recover me",
        "ws-user",
        ["send-user"],
    )

    assert response["result"]["status"] == "queued"
    assert session["queued_prompt"]["client_submission_ids"] == ["send-user"]
    # A gateway exit here loses only server memory; the client still owns the
    # body because the unrelated turn carried no matching correlation id.
    fired = {}
    session["running"] = False
    monkeypatch.setattr(server, "_run_prompt_submit", lambda *args, **kwargs: fired.update(kwargs))
    assert _drain_registered("r-user", "sid", session) is True
    assert fired["client_submission_ids"] == ["send-user"]


def test_drain_releases_running_on_dispatch_failure(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("dispatch failed")
    monkeypatch.setattr(server, "_run_prompt_submit", _boom)
    session = _session(queued_prompt={"text": "go", "transport": None})

    assert _drain_registered("r1", "sid", session) is True
    # Failure must not leave the session wedged as running.
    assert session["running"] is False
