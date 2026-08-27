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

import tools.async_delegation as ad
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


def test_enqueue_preserves_order_after_an_image_turn():
    session = _session()
    server._enqueue_prompt(session, "B", "ws-1")
    server._enqueue_prompt(session, "C", "ws-1", image_paths=["/tmp/c.png"])
    server._enqueue_prompt(session, "D", "ws-1")

    assert session["queued_prompt"] == {"text": "B", "transport": "ws-1"}
    assert session["queued_prompts"] == [
        {"text": "C", "transport": "ws-1", "image_paths": ["/tmp/c.png"]},
        {"text": "D", "transport": "ws-1"},
    ]




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


def test_enqueue_front_separate_envelope_keeps_submission_ids_isolated():
    """The promoted turn must not settle the still-queued turn's client id."""

    session = _session()
    server._enqueue_prompt(
        session,
        "later image prompt",
        "ws-later",
        client_submission_ids=["later-send"],
        image_paths=["/tmp/later.png"],
    )
    server._enqueue_prompt(
        session,
        "leftover steer",
        "ws-live",
        front=True,
        client_submission_ids=["steer-send"],
    )

    assert session["queued_prompt"]["client_submission_ids"] == ["steer-send"]
    assert session["queued_prompts"][0]["client_submission_ids"] == ["later-send"]


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


def test_image_envelopes_share_one_text_capacity_budget(monkeypatch):
    """Every queued envelope counts, not just the image-bearing head."""

    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "queue")
    monkeypatch.setattr(server, "_MAX_PENDING_INPUT_CHARS", 20)
    session = _session(running=True)

    for index, text in enumerate(("a" * 6, "b" * 6)):
        session["attached_images"] = [f"/tmp/{index}.png"]
        response = server._handle_busy_submit(
            f"r{index}",
            "sid",
            session,
            text,
            "ws-1",
            [f"send-{index}"],
        )
        assert response["result"]["status"] == "queued"

    session["attached_images"] = ["/tmp/overflow.png"]
    rejected = server._handle_busy_submit(
        "overflow",
        "sid",
        session,
        "c" * 6,
        "ws-1",
        ["send-overflow"],
    )

    assert rejected["error"]["code"] == 4009
    assert session["attached_images"] == ["/tmp/overflow.png"]
    envelopes = [
        session["queued_prompt"],
        *(session.get("queued_prompts") or []),
    ]
    assert [envelope["text"] for envelope in envelopes] == ["a" * 6, "b" * 6]


def test_image_envelopes_share_one_submission_id_budget(monkeypatch):
    """Tail IDs consume the same bounded budget as the queue head."""

    monkeypatch.setattr(server, "_MAX_QUEUED_SUBMISSION_IDS", 2)
    session = _session()
    server._enqueue_prompt(
        session,
        "A",
        "ws-1",
        image_paths=["/tmp/a.png"],
        client_submission_ids=["send-a"],
    )
    server._enqueue_prompt(
        session,
        "B",
        "ws-1",
        image_paths=["/tmp/b.png"],
        client_submission_ids=["send-b"],
    )

    with pytest.raises(OverflowError, match="submission count"):
        server._enqueue_prompt(
            session,
            "C",
            "ws-1",
            image_paths=["/tmp/c.png"],
            client_submission_ids=["send-c"],
        )

    envelopes = [session["queued_prompt"], *session["queued_prompts"]]
    assert [envelope["client_submission_ids"] for envelope in envelopes] == [
        ["send-a"],
        ["send-b"],
    ]


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


def test_successful_redirect_drops_queued_duplicate_of_inflight_user(monkeypatch):
    """#84417: correcting a live turn must not re-fire the original prompt from queue.

    When the live turn's original user text is also sitting in the server queue
    (e.g. a second prompt.submit of the same text while redirect was not yet
    possible), a later successful redirect of a *new* correction Q must purge
    that self-duplicate. Otherwise post-turn ``_drain_queued_prompt`` starts a
    second agent turn with the old prompt P after Q has already been handled.
    """
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda text: True,
        interrupt=lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("redirect must not hard-interrupt")
        ),
    )
    session = _session(agent=agent, running=True)
    original = "deepseek released a new flash model — I changed all settings to flash"
    session["inflight_turn"] = {
        "user": original,
        "assistant": "partial",
        "streaming": True,
        "error": "",
    }
    # Stale self-duplicate of the live turn (would re-fire after settle).
    session["queued_prompt"] = {"text": original, "transport": "ws-1"}
    session["queued_prompts"] = [
        {"text": original, "transport": "ws-1"},
        {"text": "unrelated later task", "transport": "ws-1"},
    ]

    resp = server._handle_busy_submit(
        "r1", "sid", session, "what about the pricing instead?", "ws-1"
    )

    assert resp["result"]["status"] == "redirected"
    # Self-duplicates of the live original must be gone.
    assert session.get("queued_prompt") == {
        "text": "unrelated later task",
        "transport": "ws-1",
    }
    assert not session.get("queued_prompts")


def test_successful_redirect_preserves_unrelated_queued_followups(monkeypatch):
    """A legitimate next-turn queue entry must survive a mid-turn redirect."""
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda text: True,
        interrupt=lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("redirect must not hard-interrupt")
        ),
    )
    session = _session(agent=agent, running=True)
    session["inflight_turn"] = {
        "user": "live turn P",
        "assistant": "",
        "streaming": True,
        "error": "",
    }
    session["queued_prompt"] = {"text": "run this after", "transport": "ws-1"}

    resp = server._handle_busy_submit("r1", "sid", session, "correction Q", "ws-1")

    assert resp["result"]["status"] == "redirected"
    assert session.get("queued_prompt") == {
        "text": "run this after",
        "transport": "ws-1",
    }


def test_enqueue_skips_text_duplicate_of_inflight_user():
    """#84417 defense: do not admit a self-duplicate of the live user prompt."""
    session = _session()
    session["inflight_turn"] = {
        "user": "live turn P",
        "assistant": "",
        "streaming": True,
        "error": "",
    }

    server._enqueue_prompt(session, "live turn P", "ws-1")
    assert session.get("queued_prompt") is None

    server._enqueue_prompt(session, "different follow-up", "ws-1")
    assert session["queued_prompt"] == {
        "text": "different follow-up",
        "transport": "ws-1",
    }


def test_enqueue_followup_does_not_merge_stale_inflight_self_duplicate():
    """#84417: scrub P before merging so drain cannot re-fire ``P\\n\\nQ``."""
    session = _session()
    session["inflight_turn"] = {
        "user": "P",
        "assistant": "",
        "streaming": True,
        "error": "",
    }
    # Pre-existing stale self-duplicate (e.g. admitted before inflight was set).
    session["queued_prompt"] = {"text": "P", "transport": "ws-1"}

    server._enqueue_prompt(session, "Q", "ws-1")

    assert session.get("queued_prompt") == {"text": "Q", "transport": "ws-1"}
    assert not session.get("queued_prompts")


def test_drop_rewrites_merged_inflight_prefix_to_followup_only():
    """Already-merged ``P\\n\\nQ`` slots keep Q and drop the live original."""
    session = _session()
    session["inflight_turn"] = {
        "user": "P",
        "assistant": "",
        "streaming": True,
        "error": "",
    }
    session["queued_prompt"] = {"text": "P\n\nQ", "transport": "ws-1"}

    server._drop_queued_duplicates_of_inflight_user(session)

    assert session.get("queued_prompt") == {"text": "Q", "transport": "ws-1"}


def test_hard_interrupt_queue_path_scrubs_stale_inflight_self_duplicate(monkeypatch):
    """#84417: interrupt+queue of Q must not leave P ahead of Q in the FIFO."""
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    interrupts = []
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda text: False,  # force hard-interrupt fallback
        interrupt=lambda *a, **k: interrupts.append(True),
    )
    session = _session(agent=agent, running=True)
    session["inflight_turn"] = {
        "user": "P",
        "assistant": "",
        "streaming": True,
        "error": "",
    }
    session["queued_prompt"] = {"text": "P", "transport": "ws-1"}

    resp = server._handle_busy_submit("r1", "sid", session, "Q", "ws-1")

    assert resp["result"]["status"] == "queued"
    assert session.get("queued_prompt") == {"text": "Q", "transport": "ws-1"}
    assert not session.get("queued_prompts")
    # Interrupt is async-threaded; policy still enqueued Q after scrubbing P.


def test_redirect_then_drain_does_not_re_fire_original_p(monkeypatch):
    """#84417 drain-level: after redirect(Q), settle must not start a second P."""
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    fired = []
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda text: True,
        interrupt=lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("redirect must not hard-interrupt")
        ),
    )
    session = _session(agent=agent, running=True)
    session["inflight_turn"] = {
        "user": "P",
        "assistant": "partial",
        "streaming": True,
        "error": "",
    }
    session["queued_prompt"] = {"text": "P", "transport": "ws-1"}

    resp = server._handle_busy_submit("r1", "sid", session, "Q", "ws-1")
    assert resp["result"]["status"] == "redirected"
    assert session.get("queued_prompt") is None

    # Turn settles (running cleared in finally) — drain must be a no-op.
    session["running"] = False
    monkeypatch.setattr(
        server,
        "_run_prompt_submit",
        lambda rid, sid, session, text, **kwargs: fired.append(text),
    )
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda _s: False)

    assert server._drain_queued_prompt("r2", "sid", session) is False
    assert fired == []


def test_compress_session_rotation_bumps_queued_prompt_generation(monkeypatch):
    """#84417 belt: rotation invalidates in-flight drain claims on the parent key.

    Queue *contents* survive (a legitimate follow-up must still run after
    compression); only the generation counter advances so a drain that claimed
    under the pre-rotation key cannot dispatch after re-anchor.
    """
    monkeypatch.setattr(server, "_transfer_active_session_slot", lambda *a, **k: True)
    monkeypatch.setattr(server, "_restart_slash_worker", lambda *a, **k: None)
    agent = types.SimpleNamespace(session_id="child-after-rotation")
    session = _session(agent=agent, session_key="parent-before-rotation")
    session["_queued_prompt_generation"] = 3
    session["queued_prompt"] = {"text": "run after compress", "transport": "ws-1"}

    server._sync_session_key_after_compress("sid", session, clear_pending_title=False)

    assert session["session_key"] == "child-after-rotation"
    assert session["_queued_prompt_generation"] == 4
    # Follow-up kept — only the claim generation bumped.
    assert session["queued_prompt"] == {
        "text": "run after compress",
        "transport": "ws-1",
    }


def test_compress_no_rotation_does_not_bump_queue_generation(monkeypatch):
    """No-op when agent.session_id already matches session_key."""
    monkeypatch.setattr(
        server,
        "_transfer_active_session_slot",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("no transfer")),
    )
    agent = types.SimpleNamespace(session_id="same-key")
    session = _session(agent=agent, session_key="same-key")
    session["_queued_prompt_generation"] = 2

    server._sync_session_key_after_compress("sid", session)

    assert session["_queued_prompt_generation"] == 2








def test_busy_interrupt_mode_ignores_completed_background_delegation(monkeypatch):
    """A terminal delegation must not suppress normal busy-turn interruption."""
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    calls = {"interrupt": 0}
    agent = types.SimpleNamespace(
        interrupt=lambda *a, **k: calls.__setitem__("interrupt", calls["interrupt"] + 1)
    )
    session = _session(agent=agent, running=True)

    with ad._records_lock:
        ad._records["deleg_completed"] = {
            "delegation_id": "deleg_completed",
            "status": "completed",
            "session_key": "session-key",
            "origin_ui_session_id": "sid",
        }

    try:
        resp = server._handle_busy_submit("r1", "sid", session, "continue", "ws-1")
    finally:
        with ad._records_lock:
            ad._records.clear()

    assert resp["result"]["status"] == "queued"
    assert calls["interrupt"] == 1
    assert session["queued_prompt"]["text"] == "continue"




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

# ── steer-mode burst preservation (#86134) ─────────────────────────────────

def test_busy_steer_fallthrough_queues_without_interrupting(monkeypatch):
    """A steer-mode fall-through must keep queue semantics, never interrupt.

    #86134: ``AIAgent.interrupt()`` drops the pending steer buffer, so a hard
    interrupt fired for a fall-through message destroyed the earlier
    (successfully steered) messages of a burst AND killed the live turn.
    """
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")
    interrupted = threading.Event()
    agent = types.SimpleNamespace(
        steer=lambda text: False,  # steer rejected → falls through to queue
        interrupt=lambda *a, **k: interrupted.set(),
    )
    session = _session(agent=agent, running=True)

    resp = server._handle_busy_submit("r1", "sid", session, "follow-up", "ws-1")

    assert resp["result"]["status"] == "queued"
    assert session["queued_prompt"]["text"] == "follow-up"
    # _interrupt_busy_session runs on a worker thread — give it a beat.
    assert not interrupted.wait(0.2), "steer-mode fall-through must not hard-interrupt"


def test_busy_steer_exception_falls_back_to_queue_without_interrupting(monkeypatch):
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")
    interrupted = threading.Event()
    agent = types.SimpleNamespace(
        steer=lambda text: (_ for _ in ()).throw(RuntimeError("boom")),
        interrupt=lambda *a, **k: interrupted.set(),
    )
    session = _session(agent=agent, running=True)

    resp = server._handle_busy_submit("r1", "sid", session, "still here?", "ws-1")

    assert resp["result"]["status"] == "queued"
    assert session["queued_prompt"]["text"] == "still here?"
    assert not interrupted.wait(0.2), "steer failure must not escalate to interrupt"


def test_busy_steer_mode_multimodal_payload_queues_without_interrupting(monkeypatch):
    """Image-bearing payloads are not steerable; they must queue, not kill."""
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")
    rich = [
        {"type": "text", "text": "look at this"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
    ]
    steered = []
    interrupted = threading.Event()
    agent = types.SimpleNamespace(
        steer=lambda text: steered.append(text) or True,
        interrupt=lambda *a, **k: interrupted.set(),
    )
    session = _session(agent=agent, running=True)

    resp = server._handle_busy_submit("r1", "sid", session, rich, "ws-1")

    assert resp["result"]["status"] == "queued"
    assert steered == []
    assert session["queued_prompt"]["text"] == rich
    assert not interrupted.wait(0.2), "multimodal steer fall-through must not interrupt"


def test_busy_steer_burst_mix_preserves_accepted_steers_and_queue(monkeypatch):
    """Burst of N messages: accepted steers survive a later fall-through.

    Models the real ``AIAgent`` contract: ``steer()`` concatenates into a
    pending buffer that ``interrupt()`` would clear. A rejected message later
    in the burst must not clear the buffer or stop the turn (#86134).
    """
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")

    class _Agent:
        def __init__(self):
            self._pending_steer = None
            self.accept = True
            self.interrupted = threading.Event()

        def steer(self, text):
            if not self.accept:
                return False
            self._pending_steer = (
                f"{self._pending_steer}\n{text}" if self._pending_steer else text
            )
            return True

        def interrupt(self, *a, **k):
            self._pending_steer = None  # what the real interrupt() does
            self.interrupted.set()

    agent = _Agent()
    session = _session(agent=agent, running=True)
    session["inflight_turn"] = {"user": "original ask"}

    r1 = server._handle_busy_submit("r1", "sid", session, "first note", "ws-1")
    r2 = server._handle_busy_submit("r2", "sid", session, "second note", "ws-1")
    agent.accept = False  # third message loses the steer race
    r3 = server._handle_busy_submit("r3", "sid", session, "third note", "ws-1")

    assert r1["result"]["status"] == "steered"
    assert r2["result"]["status"] == "steered"
    assert r3["result"]["status"] == "queued"
    # No hard interrupt fired for the fall-through message...
    assert not agent.interrupted.wait(0.2), "burst fall-through must not hard-interrupt"
    # ...so earlier steers are preserved, distinct, in order.
    assert agent._pending_steer == "first note\nsecond note"
    # Fall-through preserved for the turn-end drain.
    assert session["queued_prompt"]["text"] == "third note"


def test_busy_steer_fallthrough_burst_drains_all_texts_fifo(monkeypatch):
    """Every fall-through text of a burst reaches the model after turn end."""
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")
    interrupted = threading.Event()
    agent = types.SimpleNamespace(
        steer=lambda text: False,
        interrupt=lambda *a, **k: interrupted.set(),
    )
    session = _session(agent=agent, running=True)
    for text in ("msg A", "msg B", "msg C"):
        resp = server._handle_busy_submit("r", "sid", session, text, "ws-1")
        assert resp["result"]["status"] == "queued"
    assert not interrupted.wait(0.2), "queue fall-through burst must not interrupt"

    dispatched = []
    monkeypatch.setattr(
        server,
        "_run_prompt_submit",
        lambda rid, sid, _session, text, **kwargs: dispatched.append(text),
    )
    session["running"] = False
    while server._drain_queued_prompt("drain", "sid", session):
        session["running"] = False
        if not session.get("queued_prompt"):
            break

    joined = "\n".join(str(t) for t in dispatched)
    for text in ("msg A", "msg B", "msg C"):
        assert text in joined, f"burst message dropped: {text!r}"




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


def test_busy_prompt_rpc_honors_explicit_queue_drain_override(monkeypatch):
    """A client-drained queue item must never steer or interrupt a live turn."""

    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "steer")
    calls = {"steer": 0, "interrupt": 0}
    session = _session(
        agent=types.SimpleNamespace(
            steer=lambda _text: calls.__setitem__("steer", calls["steer"] + 1)
            or True,
            interrupt=lambda: calls.__setitem__(
                "interrupt", calls["interrupt"] + 1
            ),
        ),
        running=True,
    )
    server._sessions["sid"] = session

    try:
        response = server.handle_request(
            {
                "id": "r-queued",
                "method": "prompt.submit",
                "params": {
                    "client_submission_id": "send-queued",
                    "session_id": "sid",
                    "text": "run after the current turn",
                    "queued": True,
                },
            }
        )
    finally:
        server._sessions.pop("sid", None)

    assert response["result"]["status"] == "queued"
    assert calls == {"steer": 0, "interrupt": 0}
    assert session["queued_prompt"] == {
        "client_submission_ids": ["send-queued"],
        "text": "run after the current turn",
        "transport": None,
    }


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


def test_busy_submit_claims_attached_image_for_queued_turn(monkeypatch):
    """A pasted image belongs to its submitted prompt, not ambient session state."""
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    redirected = []
    interrupted = threading.Event()
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda text: redirected.append(text) or True,
        interrupt=interrupted.set,
    )
    session = _session(agent=agent, running=True, attached_images=["/tmp/b.png"])
    server._sessions["sid"] = session
    try:
        response = server._methods["prompt.submit"](
            "r1", {"session_id": "sid", "text": "is this B?"}
        )
    finally:
        server._sessions.pop("sid", None)

    assert response["result"]["status"] == "queued"
    assert redirected == []
    assert not interrupted.wait(0.1)
    assert session["attached_images"] == []
    assert session["queued_prompt"] == {
        "text": "is this B?",
        "image_paths": ["/tmp/b.png"],
        "transport": None,
    }


def test_busy_image_prompts_keep_b_and_c_attachments_in_submission_order(monkeypatch):
    """A later paste must not replace the image already claimed by B."""
    monkeypatch.setattr(server, "_load_busy_input_mode", lambda: "interrupt")
    monkeypatch.setattr(
        server,
        "_run_prompt_submit",
        lambda rid, sid, _session, text, **kwargs: dispatched.append((rid, sid, text, kwargs)),
    )
    agent = types.SimpleNamespace(
        _supports_active_turn_redirect=True,
        redirect=lambda _text: (_ for _ in ()).throw(AssertionError("images must queue")),
        interrupt=lambda: None,
    )
    session = _session(agent=agent, running=True, attached_images=["/tmp/b.png"])
    dispatched = []
    server._sessions["sid"] = session
    try:
        server._methods["prompt.submit"]("b", {"session_id": "sid", "text": "B"})
        session["attached_images"] = ["/tmp/c.png"]
        server._methods["prompt.submit"]("c", {"session_id": "sid", "text": "C"})

        assert session["queued_prompt"]["image_paths"] == ["/tmp/b.png"]
        assert session["queued_prompts"] == [
            {"text": "C", "image_paths": ["/tmp/c.png"], "transport": None}
        ]

        session["running"] = False
        assert server._drain_queued_prompt("drain-b", "sid", session) is True
        session["running"] = False
        assert server._drain_queued_prompt("drain-c", "sid", session) is True
    finally:
        server._sessions.pop("sid", None)

    assert dispatched == [
        (
            "drain-b",
            "sid",
            "B",
            {"image_paths": ["/tmp/b.png"], "queued_prompt_generation": 0},
        ),
        (
            "drain-c",
            "sid",
            "C",
            {"image_paths": ["/tmp/c.png"], "queued_prompt_generation": 0},
        ),
    ]


# ── _drain_queued_prompt ───────────────────────────────────────────────────

def test_drain_fires_queued_prompt_and_claims_running(monkeypatch):
    fired = {}
    monkeypatch.setattr(
        server, "_run_prompt_submit",
        lambda rid, sid, session, text, **kwargs: fired.update(rid=rid, sid=sid, text=text),
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
def test_drain_compute_host_forwards_queued_image_paths(monkeypatch):
    captured = {}
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda _session: True)
    monkeypatch.setattr(
        server,
        "_submit_prompt_to_compute_host",
        lambda rid, sid, session, text, **kwargs: captured.update(
            rid=rid, sid=sid, text=text, image_paths=kwargs.get("image_paths")
        )
        or {"result": {"status": "started"}},
    )
    session = _session(
        queued_prompt={"text": "inspect", "image_paths": ["/tmp/b.png"], "transport": "ws-9"}
    )

    assert server._drain_queued_prompt("r1", "sid", session) is True
    assert captured == {
        "rid": "r1",
        "sid": "sid",
        "text": "inspect",
        "image_paths": ["/tmp/b.png"],
    }




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


def test_drain_preserves_queued_prompt_when_session_is_closing(monkeypatch):
    """A compute-host completion must not dispatch a successor after close."""
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda _session: True)
    monkeypatch.setattr(
        server,
        "_submit_prompt_to_compute_host",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("closing session must not dispatch")
        ),
    )
    queued = {"text": "queued-after-close", "transport": "ws-9"}
    session = _session(_closing=True, queued_prompt=queued)

    assert server._drain_queued_prompt("r1", "sid", session) is False
    assert session["queued_prompt"] is queued
    assert session["running"] is False


def test_drain_releases_running_on_dispatch_failure(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("dispatch failed")
    monkeypatch.setattr(server, "_run_prompt_submit", _boom)
    session = _session(queued_prompt={"text": "go", "transport": None})

    assert _drain_registered("r1", "sid", session) is True
    # Failure must not leave the session wedged as running.
    assert session["running"] is False


def test_drain_does_not_dispatch_a_prompt_cancelled_after_claim(monkeypatch):
    """Generation cancel aborts dispatch but must restore the claimed head.

    Compress re-anchor / Stop bump generation between claim and check. Dropping
    the envelope would silently lose a legitimate follow-up (#84417 belt).
    """
    session = _session(
        queued_prompt={"text": "B", "transport": "ws-1"},
        queued_prompts=[{"text": "C", "transport": "ws-1"}],
    )
    monkeypatch.setattr(
        server,
        "_session_uses_compute_host",
        lambda _session: session.__setitem__("_queued_prompt_generation", 1) or False,
    )
    monkeypatch.setattr(
        server,
        "_run_prompt_submit",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("must not dispatch")),
    )

    assert server._drain_queued_prompt("r1", "sid", session) is True
    assert session["running"] is False
    # Claimed B restored first; C that advanced into the slot is behind it.
    assert session.get("queued_prompt") == {"text": "B", "transport": "ws-1"}
    assert session.get("queued_prompts") == [{"text": "C", "transport": "ws-1"}]


def test_drain_restores_claimed_prompt_when_generation_bumps_mid_claim(monkeypatch):
    """Single-item queue: generation cancel must not empty the queue."""
    session = _session(queued_prompt={"text": "follow-up Q", "transport": None})
    monkeypatch.setattr(
        server,
        "_session_uses_compute_host",
        lambda _session: session.__setitem__("_queued_prompt_generation", 1) or False,
    )
    monkeypatch.setattr(
        server,
        "_run_prompt_submit",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("must not dispatch")),
    )

    assert server._drain_queued_prompt("r1", "sid", session) is True
    assert session["running"] is False
    assert session.get("queued_prompt") == {"text": "follow-up Q", "transport": None}
    assert not session.get("queued_prompts")


def test_drain_does_not_clear_stop_after_its_final_generation_check(monkeypatch):
    class _Agent:
        clear_calls = 0

        def clear_interrupt(self):
            self.clear_calls += 1

    agent = _Agent()
    session = _session(agent=agent, queued_prompt={"text": "B", "transport": None})
    original_run = server._run_prompt_submit

    def stop_before_run(*args, **kwargs):
        session["_queued_prompt_generation"] = 1
        return original_run(*args, **kwargs)

    monkeypatch.setattr(server, "_session_uses_compute_host", lambda _session: False)
    monkeypatch.setattr(server, "_run_prompt_submit", stop_before_run)

    assert server._drain_queued_prompt("r1", "sid", session) is True
    assert agent.clear_calls == 0
    assert session["running"] is False


def test_drain_continues_with_later_queued_prompt_after_dispatch_failure(monkeypatch):
    calls = []

    def _run(_rid, _sid, session, text, **_kwargs):
        calls.append(text)
        if text == "broken":
            raise RuntimeError("dispatch failed")
        session["running"] = False

    monkeypatch.setattr(server, "_run_prompt_submit", _run)
    emitted = []
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, sid, payload=None: emitted.append(
            (event, sid, payload or {})
        ),
    )
    session = _session(
        queued_prompt={
            "text": "broken",
            "transport": None,
            "client_submission_ids": ["broken-send"],
        },
        queued_prompts=[{"text": "next", "image_paths": ["/tmp/next.png"], "transport": None}],
    )

    assert server._drain_queued_prompt("r1", "sid", session) is True
    assert calls == ["broken", "next"]
    assert session["queued_prompt"] is None
    assert session.get("queued_prompts") is None
    failed = next(
        payload
        for event, _sid, payload in emitted
        if event == "message.complete" and payload.get("status") == "error"
    )
    assert failed["client_submission_ids"] == ["broken-send"]
