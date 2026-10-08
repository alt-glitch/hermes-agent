"""Auto-continue: resume a turn killed by a process/machine death, plus queued-prompt drain and
busy-submit handling. Bodies are rebound onto server.py's globals at install time
(method_ctx.bind_module), so they reference server.py globals bare."""

from __future__ import annotations

import contextlib
import os

from .method_ctx import bind_module

# A concluded turn (success, handled error, interrupt) clears its durable marker (turn_marker.py) in _run_prompt_submit's
# finally; only a process death leaves it behind, so a marker at session.resume proves the turn never finished AND the
# client never saw a terminal frame. Fresh: re-submit automatically (as the messaging gateway does). Stale: clear it
# and let the partial transcript speak.
# If the interruption is fresh, re-submit the interrupted prompt automatically (the messaging gateway has
# done this for restart-interrupted sessions since #27856); if it's stale, clear the marker and let the
# recovered partial transcript speak for itself — the user can ask to continue manually.
_AUTO_CONTINUE_FRESHNESS_MINUTES_DEFAULT = 15


def _auto_continue_config() -> tuple[bool, float, int]:
    """(enabled, freshness window in seconds, max attempts) from ``desktop.auto_continue`` in config.yaml."""
    desktop = _load_cfg().get("desktop")
    cfg = desktop.get("auto_continue") if isinstance(desktop, dict) else None
    cfg = cfg if isinstance(cfg, dict) else {}
    try:
        minutes = float(cfg.get("freshness_minutes", _AUTO_CONTINUE_FRESHNESS_MINUTES_DEFAULT))
    except (TypeError, ValueError):
        minutes = float(_AUTO_CONTINUE_FRESHNESS_MINUTES_DEFAULT)
    return (is_truthy_value(cfg.get("enabled"), default=True), max(0.0, minutes) * 60.0,
            _coerce_int_config_value(cfg.get("max_attempts"), 2, min_value=0))


def _session_home(session: dict) -> Path:
    """The HERMES_HOME the session's durable state lives in (profile-aware)."""
    return Path(session.get("profile_home") or _hermes_home)


def _retire_turn_marker(session: dict, *keys: str) -> None:
    """Drop the crash marker right before the terminal frame (not at turn-thread end: post-turn work outlives the
    client's answer, and quitting in that window would leave a marker that re-runs a finished turn). Extra ``keys``
    cover a session_key that compression rotated mid-turn."""
    home = _session_home(session)
    for key in dict.fromkeys((*keys, str(session.get("session_key") or ""))):
        if key:
            clear_turn_marker(home, key)


def _auto_continue_note(prompt: str) -> str:
    # Same opening as the gateway's recovery notes (transcript tooling recognizes both). The prompt is embedded: a hard
    # crash persists nothing else of the turn.
    return (f"{_AUTO_CONTINUE_NOTE_PREFIX} — the app or its backend process stopped before the turn could finish. "
            "Some of the work may already be complete; check the current state before redoing anything, then "
            f"finish the task. The interrupted request was:]\n\n{prompt}")


def _maybe_schedule_auto_continue(sid: str, session: dict, session_key: str) -> dict | None:
    """Kick off a continuation turn for a crash-interrupted session (session.resume cold paths). Returns a descriptor
    for the resume payload when scheduled, else None. The turn runs on a background thread after the deferred agent
    build via _run_prompt_submit, so the client that just resumed streams it."""
    # Hosted room turns are recovered by their durable task/lease state machine; generic auto-continue would bypass
    # its execution generation and duplicate work.
    if session.get("source") == "bot_room":
        return None
    home = _session_home(session)
    if (marker := read_turn_marker(home, session_key)) is None:
        return None
    if not marker.get("auto_continue", True):
        return None  # The mailbox owns recovery and receipt identity for imported turns.
    # Ownership, not forensics: a sibling backend sharing this HERMES_HOME can be mid-turn on this very session, so
    # its live marker says "someone is working on it", never "someone crashed". Leave the marker for its writer —
    # clearing it would cancel the live turn's own account of itself. See #94778.
    writer_state = marker_writer_state(marker)
    if writer_state == "alive" and marker.get("writer_pid") != os.getpid():
        logger.info("auto-continue for %s held back: marker writer pid %s is still alive (reader pid %s); the "
                    "marker is ownership evidence and the owner clears it", session_key,
                    marker.get("writer_pid"), os.getpid())
        return None
    enabled, freshness_secs, max_attempts = _auto_continue_config()
    age = time.time() - marker["started_at"]
    if not enabled or age > freshness_secs or marker["attempts"] >= max_attempts:
        clear_turn_marker(home, session_key)  # stale/disabled/crash-looping: a manual message continues
        return None
    if session.get("_auto_continue_scheduled"):
        return None
    from hermes_cli.backend_retirement import retirement
    if not retirement.acquire():
        return None
    session["_auto_continue_scheduled"] = True
    attempt, text = marker["attempts"] + 1, _auto_continue_note(marker["prompt"])
    loop_claim_id = ""
    try:
        from hermes_cli.loops import LoopManager

        loop_state = LoopManager(session_id=session_key).state
        if loop_state is not None and loop_state.awaiting_response:
            loop_claim_id = loop_state.claim_id
    except Exception:
        pass

    def kickoff() -> None:
        rid = f"__auto_continue__{int(time.time() * 1000)}"
        try:
            _start_agent_build(sid, session)
            err = _wait_agent(session, rid, timeout=120.0)
        except Exception:
            logger.warning("auto-continue agent build failed for %s", sid, exc_info=True)
            err = {"error": {"message": "agent build failed"}}
        if err:  # leave the marker: the next resume retries (bounded by attempts)
            session["_auto_continue_scheduled"] = False
            retirement.release()
            return
        with session["history_lock"]:
            if session.get("running") or session.get("_turn_cancel_requested") or session.get("_finalized"):
                session["_auto_continue_scheduled"] = False  # a real user prompt beat us; it clears the marker
                retirement.release()
                return
            session["running"] = True
            session["last_active"] = time.time()
        # Ownership admission BEFORE message.start: a sibling backend sharing this HERMES_HOME may have written the
        # marker and still be mid-turn. Leave the marker so a later resume retries.
        # Running the continuation anyway would be the double-writer this fence exists to prevent. See
        # #94778.
        if _ensure_active_session_slot(sid, session) is not None:
            logger.info("auto-continue for %s refused: session has another live owner", session_key)
            with session["history_lock"]:
                session["running"] = False
                session["_auto_continue_scheduled"] = False
            retirement.release()
            return
        with session["history_lock"]:
            # Marker inputs read back by _run_prompt_submit: attempt count (crash breaker) and the ORIGINAL prompt (no
            # nested notes). Set here, not at schedule time, so a bail above leaves nothing for a racing user turn.
            session["_auto_continue_attempt"], session["_auto_continue_prompt"] = attempt, marker["prompt"]
        try:
            from gateway.warning_notifications import render_notification
            diagnostic = marker.get("notification_category") == "diagnostic"
            with _session_profile_runtime_scope(session):
                def announce():
                    _emit("status.update", sid, {"kind": "process", "text": "Resuming interrupted turn…"})
                render_notification(announce, platform="tui", diagnostic=diagnostic)
                submit_kwargs = {"display_kind": "auto_continue"}
                if diagnostic:
                    submit_kwargs["display_metadata"] = {"notification_category": "diagnostic"}
                if loop_claim_id:
                    submit_kwargs["loop_claim_id"] = loop_claim_id
                if _run_prompt_submit(rid, sid, session, text, **submit_kwargs) is False:
                    with session["history_lock"]:
                        session["_auto_continue_scheduled"] = False
                        session.pop("_auto_continue_attempt", None)
                        session.pop("_auto_continue_prompt", None)
                        session["running"] = False
        except Exception as exc:
            _notif_log_failure("auto-continue dispatch failed", exc)
            with session["history_lock"]:
                session["_auto_continue_scheduled"] = False
                session.pop("_auto_continue_attempt", None)
                session.pop("_auto_continue_prompt", None)
                session["running"] = False
        finally:
            retirement.release()
    try:
        from agent.memory_provider import spawn_context_thread
        thread = spawn_context_thread(kickoff, name=f"auto-continue-{sid}")
        session["_auto_continue_thread"] = thread
        thread.start()
    except BaseException:
        session["_auto_continue_scheduled"] = False
        retirement.release()
        raise
    logger.info("auto-continue scheduled for session %s (attempt %d, interrupted %.0fs ago, writer pid %s: %s, "
                "reader pid %s)", session_key, attempt, age, marker.get("writer_pid"), writer_state, os.getpid())
    return {"attempt": attempt, "interrupted_at": marker["started_at"]}


_MAX_PENDING_INPUT_CHARS = 4 * 1024 * 1024
_MAX_CLIENT_SUBMISSION_ID_CHARS = 128
_MAX_QUEUED_SUBMISSION_IDS = 1024


def _queued_prompt_envelopes(session: dict) -> list[dict]:
    """Return the complete pending queue in drain order."""
    envelopes: list[dict] = []
    if isinstance(head := session.get("queued_prompt"), dict):
        envelopes.append(head)
    if isinstance(tail := session.get("queued_prompts"), list):
        envelopes.extend(item for item in tail if isinstance(item, dict))
    return envelopes


def _queued_input_chars(session: dict, *, extra_queue_text: Any = None) -> int:
    """Conservative text footprint for the complete pending queue."""
    texts = [
        item.get("text")
        for item in _queued_prompt_envelopes(session)
        if isinstance(item.get("text"), str) and item.get("text")
    ]
    if extra_queue_text is not None:
        incoming = extra_queue_text if isinstance(extra_queue_text, str) else str(extra_queue_text)
        if incoming:
            texts.append(incoming)
    return sum(len(text) for text in texts) + max(0, len(texts) - 1) * 2


def _queued_submission_ids(session: dict) -> list[str]:
    """Unique accepted queue correlations across head and tail."""
    return list(dict.fromkeys(
        submission_id
        for item in _queued_prompt_envelopes(session)
        for submission_id in list(item.get("client_submission_ids") or [])
    ))


def _clear_queued_prompts_locked(session: dict) -> list[str]:
    """Clear the queue, fence already-claimed drains, and return correlations."""
    queued_ids = _queued_submission_ids(session)
    had_queue = bool(session.get("queued_prompt") or session.get("queued_prompts"))
    session["queued_prompt"] = None
    session.pop("queued_prompts", None)
    if had_queue:
        session["_queued_prompt_generation"] = int(session.get("_queued_prompt_generation", 0)) + 1
    return queued_ids


def _settle_pending_input_ids_locked(
    session: dict, direct_submission_ids: list[str] | None = None
) -> list[str]:
    """Clear all accepted pending-input correlations and return them once."""
    settled = list(dict.fromkeys([
        *list(direct_submission_ids or []),
        *_clear_queued_prompts_locked(session),
        *list(session.get("_pending_steer_submission_ids") or []),
        *list(session.get("_active_client_submission_ids") or []),
    ]))
    session["_active_client_submission_ids"] = []
    session["_pending_steer_submission_ids"] = []
    session["pending_steer_chars"] = 0
    return settled


def _pending_steer_chars(session: dict) -> int:
    try:
        return max(0, int(session.get("pending_steer_chars") or 0))
    except (TypeError, ValueError):
        return 0


def _pending_input_chars(
    session: dict, *, extra_queue_text: Any = None, extra_steer_text: Any = None
) -> int:
    """Worst-case queued text if every accepted steer misses the turn."""
    total = _queued_input_chars(session, extra_queue_text=extra_queue_text)
    steer_chars = _pending_steer_chars(session)
    if extra_steer_text is not None:
        incoming = extra_steer_text if isinstance(extra_steer_text, str) else str(extra_steer_text)
        steer_chars += len(incoming) + (1 if steer_chars and incoming else 0)
    if steer_chars:
        total += steer_chars + (2 if total else 0)
    return total


def _pending_input_capacity_allows(
    session: dict, *, extra_queue_text: Any = None, extra_steer_text: Any = None
) -> bool:
    return _pending_input_chars(
        session,
        extra_queue_text=extra_queue_text,
        extra_steer_text=extra_steer_text,
    ) <= _MAX_PENDING_INPUT_CHARS


def _accept_steer_locked(session: dict, agent: Any, text: Any) -> bool:
    """Best-effort steer admission; caller holds ``history_lock``."""
    if session.get("_steer_admission_closed"):
        return False
    steer_text = text if isinstance(text, str) else str(text)
    if not _pending_input_capacity_allows(session, extra_steer_text=steer_text):
        return False
    accepted = bool(agent.steer(text))
    if accepted:
        existing_chars = _pending_steer_chars(session)
        session["pending_steer_chars"] = existing_chars + (1 if existing_chars else 0) + len(steer_text)
    return accepted


def _ac_inflight_original(session: dict) -> str:
    turn = session.get("inflight_turn")
    return str(turn.get("user") or "").strip() if isinstance(turn, dict) else ""


def _enqueue_prompt(
    session: dict,
    text: Any,
    transport: Any,
    *,
    front: bool = False,
    client_submission_ids: list[str] | None = None,
    image_paths: list[str] | None = None,
    turn_author: dict | None = None,
) -> dict | None:
    """Stash a message as the next turn without losing order or correlation.

    Text-only arrivals share a slot and merge losslessly; image-bearing and authored
    (relay-sender) envelopes stay separate so attachment chronology and the sender survive.
    ``transport`` is pinned so the drained turn streams to its sender. Returns the envelope dict
    the text landed in (the merged head on a merge) so the caller can attach durable state to it;
    None when the text was dropped as a duplicate."""
    image_paths = list(image_paths or [])
    _drop_queued_duplicates_of_inflight_user(session)
    text_only = not image_paths and isinstance(text, str)
    # A text-only self-copy of the live prompt would restart it on drain; an authored copy is another sender's message.
    if text_only and not turn_author and text.strip() == _ac_inflight_original(session) != "":
        return None
    queued = {"text": text, "transport": transport}
    if image_paths:
        queued["image_paths"] = image_paths
    if turn_author:
        queued["turn_author"] = turn_author
    existing = session.get("queued_prompt")
    if _queued_input_chars(session, extra_queue_text=text) > _MAX_PENDING_INPUT_CHARS:
        raise OverflowError("queued input text capacity invariant exceeded")
    existing_ids = list(existing.get("client_submission_ids") or []) if isinstance(existing, dict) else []
    incoming_ids = list(dict.fromkeys(client_submission_ids or []))
    if len(list(dict.fromkeys([*_queued_submission_ids(session), *incoming_ids]))) > _MAX_QUEUED_SUBMISSION_IDS:
        raise OverflowError("queued input submission count capacity invariant exceeded")
    merged_ids = list(dict.fromkeys(
        [*incoming_ids, *existing_ids] if front else [*existing_ids, *incoming_ids]
    ))
    # Authored envelopes never merge: the sender's own words stay in their own slot.
    if (
        existing
        and text_only
        and not turn_author
        and isinstance(existing.get("text"), str)
        and not existing.get("image_paths")
        and not existing.get("turn_author")
        and not session.get("queued_prompts")
    ):
        prev = existing["text"]
        text = (f"{text}\n\n{prev}" if prev and text else (text or prev)) if front else (
            f"{prev}\n\n{text}" if prev and text else (prev or text)
        )
        queued = {"text": text, "transport": transport}
        # The merged head inherits the accept-time durable row so ``_persist_queued_user_row``
        # rewrites it in place instead of writing a second row for the same envelope.
        for key in ("_submit_user_row", "_queued_display_kind"):
            if key in existing:
                queued[key] = existing[key]
        if merged_ids:
            queued["client_submission_ids"] = merged_ids
        session["queued_prompt"] = queued
        return queued
    if existing:
        if incoming_ids:
            queued["client_submission_ids"] = incoming_ids
        if front:
            session.setdefault("queued_prompts", []).insert(0, existing)
            session["queued_prompt"] = queued
        else:
            session.setdefault("queued_prompts", []).append(queued)
        return queued
    if merged_ids:
        queued["client_submission_ids"] = merged_ids
    session["queued_prompt"] = queued
    return queued


def _sanitize_queued_entry_vs_inflight_user(entry: Any, original: str) -> dict | None:
    """Drop (``None``) a text-only self-duplicate of the live user text, or rewrite a merged slot
    ``"{original}\\n\\n{later}"`` to ``later`` so the correction survives without re-firing the original. Image-bearing
    and authored envelopes are left alone: chronology and the sender's own words are kept.

    Returns ``None`` to drop the envelope, or a (possibly rewritten) dict to keep. A merged slot
    ``"{original}\\n\\n{later}"`` (from ``_enqueue_prompt``'s consecutive text merge) is rewritten to just
    ``later`` so a later correction is not lost and the original is not re-fired (#84417).
    """
    if not isinstance(entry, dict):
        return None
    text = entry.get("text")
    if not original or entry.get("image_paths") or entry.get("turn_author") or not isinstance(text, str):
        return entry
    # A lossless text-merge may have glued the live original onto a later follow-up: keep the remainder.
    rest = next((text[len(original + sep):] for sep in ("\n\n", "\n") if text.startswith(original + sep)), text).strip()
    return None if not rest or rest == original else (entry if rest == text.strip() else {**entry, "text": rest})


def _drop_queued_duplicates_of_inflight_user(session: dict) -> None:
    """Remove server-queue copies of the live turn's original user text: a mid-turn ``prompt.submit`` of the same text
    queued while redirect was unavailable must not drain and restart the original.

    A mid-turn ``prompt.submit`` of the same text can land in ``queued_prompt`` when redirect is not yet
    available (model not active, build window, tool boundary). If the user then corrects the turn with a
    different prompt via redirect, that stale self-duplicate must not ``_drain_queued_prompt`` after the
    redirected turn completes — otherwise the original prompt restarts as a fresh agent turn (#84417).
    """
    if not (original := _ac_inflight_original(session)):
        return
    head = session.get("queued_prompt")
    cleaned = (_sanitize_queued_entry_vs_inflight_user(e, original)
               for e in ([head] if head else []) + list(session.get("queued_prompts") or []))
    _ac_set_queue(session, [c for c in cleaned if c is not None])


def _ac_set_queue(session: dict, entries: list) -> None:
    """Write ``entries`` back as queued_prompt (head) + queued_prompts (rest)."""
    session["queued_prompt"] = entries[0] if entries else None
    if len(entries) > 1:
        session["queued_prompts"] = entries[1:]
    else:
        session.pop("queued_prompts", None)


def _promote_leftover_steer(
    session: dict,
    agent: Any,
    text: str,
    client_submission_ids: list[str] | None = None,
) -> bool:
    """Queue a closed-turn steer or restore it to the agent on overflow."""
    try:
        _enqueue_prompt(
            session,
            text,
            session.get("transport"),
            front=True,
            client_submission_ids=client_submission_ids,
        )
        return True
    except OverflowError:
        lock = getattr(agent, "_pending_steer_lock", None)
        if lock is not None:
            with lock:
                existing = getattr(agent, "_pending_steer", None)
                agent._pending_steer = f"{text}\n{existing}" if existing else text
        else:
            existing = getattr(agent, "_pending_steer", None)
            agent._pending_steer = f"{text}\n{existing}" if existing else text
        return False


def _clear_agent_interrupt_for_turn(session: dict, agent: Any) -> None:
    """Clear a hard interrupt without discarding a queue-overflow steer."""
    preserve = bool(session.get("_pending_steer_submission_ids"))
    if not preserve:
        agent.clear_interrupt()
        return
    lock = getattr(agent, "_pending_steer_lock", None)
    if lock is not None:
        with lock:
            retained = getattr(agent, "_pending_steer", None)
    else:
        retained = getattr(agent, "_pending_steer", None)
    agent.clear_interrupt()
    if not retained:
        return
    if lock is not None:
        with lock:
            newer = getattr(agent, "_pending_steer", None)
            agent._pending_steer = f"{retained}\n{newer}" if newer else retained
    else:
        newer = getattr(agent, "_pending_steer", None)
        agent._pending_steer = f"{retained}\n{newer}" if newer else retained


def _interrupt_busy_session(
    sid: str, session: dict, agent: Any, *, history_lock_owned: bool = False
) -> None:
    """Interrupt a busy turn on one worker, outside ``history_lock``."""
    use_agent = agent is not None and hasattr(agent, "interrupt")
    use_compute_host = not use_agent and _session_uses_compute_host(session)
    if not use_agent and not use_compute_host:
        return

    def claim() -> bool:
        if session.get("_busy_interrupt_pending"):
            return False
        session["_busy_interrupt_pending"] = True
        return True

    if history_lock_owned:
        if not claim():
            return
    else:
        with session["history_lock"]:
            if not claim():
                return

    def interrupt() -> None:
        try:
            if use_agent:
                agent.interrupt()
            else:
                _get_compute_host_supervisor().interrupt(sid)
        except Exception:
            pass
        finally:
            with session["history_lock"]:
                session["_busy_interrupt_pending"] = False
                drain_after_interrupt = bool(session.get("queued_prompt") and not session.get("running"))
            if drain_after_interrupt:
                _drain_queued_prompt(None, sid, session)
    threading.Thread(target=interrupt, daemon=True, name=f"busy-interrupt-{sid}").start()


def _session_compression_in_flight(session: dict) -> bool:
    """True when a compression lock is held for this session's durable id.

    Context compression is interrupt-protected (#23975), but a correction that reaches the
    provider mid-compression still aborts it with ``explicit_interrupt`` — the user's
    follow-up kills the very turn that would answer it (#61042). The channel-side busy
    path demotes interrupt→queue for the same reason (gateway/run_busy.py
    ``_session_has_compression_in_flight``, #56391); this is the local-RPC twin. Both
    blocking reads run off the event loop so a large state.db never freezes the dispatcher.
    """
    if session.get("_manual_compress_active"):  # held before/after the DB lock row exists (#133504)
        return True
    agent = session.get("agent")
    sid = str(getattr(agent, "session_id", "") or "") or str(session.get("session_key") or "")
    if not sid:
        return False
    try:
        with _session_db(session) as db:
            get_holder = getattr(db, "get_compression_lock_holder", None)
            if not callable(get_holder):
                return False
            holder = get_holder(sid)
    except Exception:
        logger.debug("compression in-flight check failed for session %s", sid, exc_info=True)
        return False
    # Production returns Optional[str]. Reject non-strings so a MagicMock auto-attr cannot
    # look like a held lock and needlessly demote every submit (see #96953).
    return isinstance(holder, str) and bool(holder)


def _persist_queued_user_row(session: dict, envelope: dict, display_kind: str | None) -> None:
    """Make a queued prompt durable the moment it is accepted. Writes the user row through the same
    #111868 machinery as an idle submit (so a cold ``session.resume`` sees it and a restart cannot lose
    it) and attaches the durable dict to the QUEUE ENVELOPE — never ``session["_submit_user_row"]``, the
    shared slot a possibly-still-staged in-flight turn owns. A text-only merge into an existing envelope
    rewrites the already-written row (and the staged dict) to the merged text in place, so cold readers
    see the merged text and the drained turn's ``_adopt_submit_user_row`` content match keeps working.
    A failed write stages nothing on the envelope; the drained turn then writes its own row as before.
    Caller holds ``history_lock`` (the durable row, the envelope text and the queue must move together —
    a drain cannot claim between the merge and the write)."""
    # The queue path bypasses prompt.submit's lazy row creation: the first message of a draft session can
    # be a queued one, and the message insert needs its sessions row.
    # Isolated compute-host turns are EXCLUDED exactly as prompt.submit excludes them (an isolated
    # dispatch returns before ``_persist_session_row_for_submit``): the worker process owns that turn's
    # persistence, and a local accept-time row would double it on drain.
    if _session_uses_compute_host(session):
        return
    _ensure_session_db_row(session)
    staged = envelope.get("_submit_user_row")
    if isinstance(staged, dict) and isinstance(staged.get("_row_id"), int):
        # Merge sync: the envelope text grew; the already-written row must not lag it.
        if staged.get("content") != envelope.get("text"):
            with _session_db(session) as db:
                if db is None:
                    return
                try:
                    # The staged dict records the session its row was written under; a rotated-away
                    # ``session_key`` misses that row's session_id and the merge update no-ops. An
                    # in-place compaction of the live turn may also have re-sequenced the row to a
                    # new id (the original was deactivated and cloned): follow it or the update
                    # no-ops against the dead original (#123675).
                    key = _submit_row_owner_key(staged, session)
                    live_id = db.resolve_active_row_id(key, staged["_row_id"])
                    updated = live_id is not None and bool(
                        db.set_user_message_content(key, live_id, envelope["text"]))
                except Exception:
                    logger.debug("queued-prompt row merge update failed", exc_info=True)
                    return
            if not updated:
                # No live row carries the prompt any more (compaction re-sequenced it away):
                # drop the staged row so the drained turn writes its own, rather than letting
                # the envelope claim a durable row that no longer exists.
                envelope.pop("_submit_user_row", None)
                return
            staged["_row_id"], staged["content"] = live_id, envelope["text"]
        return
    # ``display_metadata`` marker: ``reopen_session`` retires still-marked rows after a restart
    # discarded the in-memory queue (#125577); the drain's replacement row is unmarked.
    from hermes_state_common import QUEUED_PROMPT_METADATA_KEY
    staged = _write_submit_user_row(
        session, envelope.get("text"), display_kind,
        accept_metadata={QUEUED_PROMPT_METADATA_KEY: True})
    if staged is not None:
        envelope["_submit_user_row"] = staged
        if display_kind:
            envelope["_queued_display_kind"] = display_kind


def _replace_queued_user_row_for_turn(session: dict, queued: dict, is_dispatching: bool = False) -> dict | None:
    """Re-place a queued prompt's accept-time row at the transcript END before dispatching its turn.

    The accept-time write lands BEFORE the in-flight turn's assistant rows (raw ``[uA, uB, aA]``), and
    ``repair_alternation`` would glue the two user turns into one. So on drain: write an identical row
    with a fresh timestamp at the end via the normal ``_persist_submit_user_row`` — it slots
    ``session["_submit_user_row"]``, so the turn's ``_adopt_submit_user_row`` adopts it and the flush
    writes no second row (the exact existing contract) — then deactivate the early row (durable
    history, never deleted). Steady-state raw order: ``[uA, aA, uB, aB]``. Caller holds
    ``history_lock`` so a concurrent submit cannot interleave its own row between the two writes.
    """
    early = queued.get("_submit_user_row")
    if not (isinstance(early, dict) and isinstance(early.get("_row_id"), int)):
        return None  # no accept-time row (write failed / pre-feature envelope): the turn persists as before
    # Append the replacement FIRST: if that write fails nothing is deactivated, the accept-time row
    # stays active (the message stays visible) and the turn's crash persist persists it as before.
    # The DISPATCHING envelope's replacement carries no marker (its turn adopts the row immediately);
    # still-queued envelopes keep the never-drained marker (#125577) so a restart between drains
    # retires the row rather than gluing the never-run prompt into the previous turn.
    if is_dispatching:
        _persist_submit_user_row(session, queued.get("text"), queued.get("_queued_display_kind"))
    else:
        from hermes_state_common import QUEUED_PROMPT_METADATA_KEY
        _persist_submit_user_row(session, queued.get("text"), queued.get("_queued_display_kind"),
                                 accept_metadata={QUEUED_PROMPT_METADATA_KEY: True})
    fresh = session.get("_submit_user_row")
    if not (isinstance(fresh, dict) and isinstance(fresh.get("_row_id"), int)):
        return None  # re-append wrote nothing: keep the accept-time row active
    queued["_submit_user_row"] = fresh  # the envelope follows the live row (a retry drains cleanly)
    with _session_db(session) as db:
        if db is None:
            return
        try:
            # The accept-time dict records the session its row was written under; a rotated-away
            # ``session_key`` would miss it and leave that row ACTIVE beside its replacement in the
            # continuation — the [uA, uB, aA] shape this function exists to prevent. An in-place
            # compaction of the live turn may also have re-sequenced the row to a new id: deactivate
            # the row that is live NOW, or the clone stays active beside its replacement and the
            # queued prompt is active twice after the drain (#123675).
            key = _submit_row_owner_key(early, session)
            live_id = db.resolve_active_row_id(key, early["_row_id"])
            if live_id is not None:
                db.deactivate_message(key, live_id)
        except Exception:
            # Both rows briefly active merges in projection but never loses the message; deleting or
            # losing text would be worse.
            logger.debug("queued-prompt row re-placement deactivate failed", exc_info=True)
    return fresh


def _handle_busy_submit(
    rid,
    sid: str,
    session: dict,
    text: Any,
    transport: Any,
    client_submission_ids: list[str] | None = None,
    *,
    history_lock_owned: bool = False,
    queued: bool = False,
    turn_author: dict | None = None,
    display_kind: str | None = None,
) -> dict | None:
    """Apply busy-input policy without dropping accepted prompt correlations.

    ``turn_author`` (a relay sender stamped by the gateway) rides the queued envelope so the
    drained turn stays attributed; ``queued=True`` already forces queue mode for it. A queued
    envelope is made durable at accept (``_persist_queued_user_row``) under the same history lock."""
    mode = "queue" if queued else _load_busy_input_mode()
    agent = session.get("agent")
    # Compression in flight demotes steer/interrupt to queue: a correction delivered
    # mid-compression aborts the compression instead of waiting for it (#61042). The
    # follow-up drains when compression finishes — the Discord-gateway contract.
    if mode in ("steer", "interrupt") and _session_compression_in_flight(session):
        mode = "queue"
    lock_context = contextlib.nullcontext() if history_lock_owned else session["history_lock"]
    should_interrupt = False
    with lock_context:
        interrupt_live_turn = bool(session.get("running"))
        deferred_boundary = bool(
            interrupt_live_turn
            or session.get("_busy_interrupt_pending")
            or session.get("queued_prompt")
        )
        if not deferred_boundary:
            return None
        steer_admission_closed = bool(session.get("_steer_admission_closed"))
        incoming = text if isinstance(text, str) else str(text)
        image_paths = list(session.get("attached_images", []))
        text_only = not image_paths and _is_text_only_busy_payload(text)
        plain_text = _coerce_message_text(text).strip() if text_only else ""

        if (
            interrupt_live_turn
            and mode == "interrupt"
            and text_only
            and plain_text
            and agent is not None
            and getattr(agent, "_supports_active_turn_redirect", False) is True
            and hasattr(agent, "redirect")
        ):
            redirect_ids = list(dict.fromkeys([
                *list(session.get("_active_client_submission_ids") or []),
                *list(client_submission_ids or []),
            ]))
            if len(redirect_ids) > _MAX_QUEUED_SUBMISSION_IDS:
                return _err(rid, 4009, "pending input submission count reached — retry after the current turn")
            try:
                if agent.redirect(plain_text):
                    _record_inflight_correction(session, plain_text)
                    _drop_queued_duplicates_of_inflight_user(session)
                    session["_active_client_submission_ids"] = redirect_ids
                    session["last_active"] = time.time()
                    return _ok(rid, {"status": "redirected"})
            except Exception:
                pass

        queue_capacity = _pending_input_capacity_allows(session, extra_queue_text=incoming)
        steer_capacity = _pending_input_capacity_allows(session, extra_steer_text=incoming)
        if not queue_capacity or (mode == "steer" and interrupt_live_turn and not steer_capacity):
            return _err(rid, 4009, "pending input text capacity reached — retry after the current turn")

        if (
            interrupt_live_turn
            and mode == "steer"
            and not steer_admission_closed
            and text_only
            and plain_text
            and agent is not None
            and hasattr(agent, "steer")
        ):
            try:
                correlated_ids = list(dict.fromkeys([
                    *list(session.get("_active_client_submission_ids") or []),
                    *list(session.get("_pending_steer_submission_ids") or []),
                    *list(client_submission_ids or []),
                ]))
                if len(correlated_ids) > _MAX_QUEUED_SUBMISSION_IDS:
                    return _err(rid, 4009, "pending input submission count reached — retry after the current turn")
                accepted = _accept_steer_locked(session, agent, plain_text)
                if accepted and client_submission_ids:
                    pending_ids = list(session.get("_pending_steer_submission_ids") or [])
                    session["_pending_steer_submission_ids"] = list(
                        dict.fromkeys([*pending_ids, *client_submission_ids])
                    )
                if accepted:
                    _drop_queued_duplicates_of_inflight_user(session)
                    session["last_active"] = time.time()
                    return _ok(rid, {"status": "steered"})
            except Exception:
                pass

        try:
            if image_paths:
                session["attached_images"] = []
            envelope = _enqueue_prompt(
                session,
                text,
                transport,
                client_submission_ids=client_submission_ids,
                image_paths=image_paths,
                turn_author=turn_author,
            )
        except OverflowError as exc:
            if image_paths:
                session["attached_images"] = image_paths + list(session.get("attached_images", []))
            return _err(rid, 4009, str(exc))
        # Durable AT ACCEPT (not when the turn runs): a cold resume sees the queued message and a
        # backend restart cannot lose it. Lives on the envelope, never the shared session slot.
        if envelope is not None:
            _persist_queued_user_row(session, envelope, display_kind)
        session["last_active"] = time.time()
        should_interrupt = (
            interrupt_live_turn
            and mode == "interrupt"
            and not steer_admission_closed
            and not image_paths
        )
    if should_interrupt:
        _interrupt_busy_session(sid, session, agent, history_lock_owned=history_lock_owned)
    return _ok(rid, {"status": "queued"})


def _drain_queued_prompt(rid, sid: str, session: dict) -> bool:
    """Claim and fire the accepted head prompt when the session is idle.

    The queued user's message wins over lower-priority follow-ups.
    """
    with _mcp_reload_admission_lock, _session_mutation_lock(session):
        with _sessions_lock:
            live_session = _sessions.get(sid)
            if (
                (live_session is not None and live_session is not session)
                or session.get("_finalized")
                or session.get("_closing")
            ):
                return False
        with _session_turn_admission(session) as admitted:
            if not admitted:
                return False
            queued = session.get("queued_prompt")
            if not queued or session.get("running") or session.get("_busy_interrupt_pending"):
                return False
            queue_generation = int(session.get("_queued_prompt_generation", 0))
            _ac_set_queue(session, session.get("queued_prompts") or [])
            session["running"] = True
            session["_turn_cancel_requested"] = False
            queued_transport = queued.get("transport")
            # The queuer's transport is pinned so the drained turn reaches the client that sent it — but
            # ATTACHED, not rebound: a mid-turn prompt from a second client used to silence the first for the
            # whole drained turn. A peer that disconnected while its prompt sat in the queue is skipped: the
            # prompt still runs, only the dead pin is dropped.
            if queued_transport is not None and not _transport_is_dead(queued_transport):
                _attach_session_transport(session, queued_transport)
    use_compute_host = _session_uses_compute_host(session)
    with session["history_lock"]:
        if int(session.get("_queued_prompt_generation", 0)) != queue_generation:
            rest: list = []
            if advanced := session.get("queued_prompt"):
                rest.append(advanced)
            rest.extend(session.get("queued_prompts") or [])
            session["queued_prompt"] = queued
            if rest:
                session["queued_prompts"] = rest
            else:
                session.pop("queued_prompts", None)
            session["running"] = False
            return True
    # Re-place the accept-time rows (if any) at the transcript END before the turn's rows follow
    # them, and slot the dispatching envelope's fresh row for adoption. EVERY queued envelope is
    # re-placed in acceptance order: a later-accepted prompt's row must never sit behind while an
    # earlier one heals past it, or a crash between drains would permanently render the later
    # prompt before the earlier one. Under history_lock so a concurrent submit can't interleave
    # its own row write between the re-append and the deactivation.
    with session["history_lock"]:
        dispatch_row = _replace_queued_user_row_for_turn(session, queued, is_dispatching=True)
        for envelope in _queued_prompt_envelopes(session):
            _replace_queued_user_row_for_turn(session, envelope)
        # The single adoption slot must hold the DISPATCHING envelope's row (the loop above leaves
        # the last processed one there) or the turn would adopt the wrong prompt's row.
        if dispatch_row is not None:
            session["_submit_user_row"] = dispatch_row
        else:
            session.pop("_submit_user_row", None)
    # The compute-host frame has no author field, so only the inline runner receives it.
    author_kwargs = {"turn_author": queued["turn_author"]} if queued.get("turn_author") else {}
    dispatch_failed = False
    dispatch_error = "queued prompt dispatch failed"
    try:
        if use_compute_host:
            kwargs = {}
            if queue_generation:
                kwargs["queued_prompt_generation"] = queue_generation
            if queued.get("image_paths"):
                kwargs["image_paths"] = queued["image_paths"]
            resp = _submit_prompt_to_compute_host(rid, sid, session, queued["text"], **kwargs)
            if resp.get("error"):
                dispatch_error = str((resp.get("error") or {}).get("message") or "queued prompt failed")
                with session["history_lock"]:
                    session["running"] = False
                    _clear_inflight_turn(session)
                dispatch_failed = True
            elif client_submission_ids := list(queued.get("client_submission_ids") or []):
                _emit("message.start", sid, {"client_submission_ids": client_submission_ids})
        else:
            kwargs = {
                "image_paths": queued.get("image_paths"),
                "queued_prompt_generation": queue_generation,
            }
            if client_submission_ids := list(queued.get("client_submission_ids") or []):
                kwargs["client_submission_ids"] = client_submission_ids
            _run_prompt_submit(rid, sid, session, queued["text"], **kwargs, **author_kwargs)
    except Exception as exc:
        print(
            f"[tui_gateway] queued prompt dispatch failed: {type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        with session["history_lock"]:
            session["running"] = False
            _clear_inflight_turn(session)
        dispatch_error = str(exc) or type(exc).__name__
        dispatch_failed = True
    if dispatch_failed:
        with session["history_lock"]:
            session["_active_client_submission_ids"] = []
        _emit_terminal_turn_error(
            sid,
            session,
            dispatch_error,
            client_submission_ids=list(queued.get("client_submission_ids") or []),
        )
        with session["history_lock"]:
            drain_next = bool(session.get("queued_prompt")) and not session.get("_turn_cancel_requested")
        if drain_next:
            _drain_queued_prompt(rid, sid, session)
    return True


def _inflight_snapshot(session: dict) -> dict | None:
    turn = session.get("inflight_turn")
    if not isinstance(turn, dict):
        return None
    user, assistant = str(turn.get("user") or "").strip(), str(turn.get("assistant") or "")
    streaming, error = bool(turn.get("streaming")), str(turn.get("error") or "").strip()
    if not (user or assistant or streaming or error):
        return None
    snapshot = {"assistant": assistant, "streaming": streaming, "user": user}
    if isinstance(display_kind := turn.get("display_kind"), str) and display_kind:
        snapshot["display_kind"] = display_kind
    if isinstance(display_metadata := turn.get("display_metadata"), dict):
        snapshot["display_metadata"] = dict(display_metadata)
    raw_offsets = turn.get("correction_offsets") or []
    correction_pairs = [(str(c), raw_offsets[i] if i < len(raw_offsets) else None)
                        for i, c in enumerate(turn.get("corrections") or []) if str(c).strip()]
    if correction_pairs:
        # Mid-turn redirects alongside (not over) the original prompt so resume can rebuild every user bubble; offsets
        # only when every correction has one so clients can trust the pairing.
        snapshot["corrections"] = [c for c, _ in correction_pairs]
        if all(isinstance(offset, int) and offset >= 0 for _, offset in correction_pairs):
            snapshot["correction_offsets"] = [int(offset) for _, offset in correction_pairs]  # type: ignore[arg-type]
    if error:
        # Retained failed turn (_fail_inflight_turn): a resuming client must rebuild the failed bubble, not render the
        # partial text as a healthy reply.
        snapshot.update(error=error, status=str(turn.get("status") or "error"), recoverable=bool(turn.get("recoverable")))
        if isinstance(surface := turn.get("error_surface"), dict) and surface:
            snapshot["error_surface"] = surface
    return snapshot


def _emit_terminal_turn_error(
    sid: str,
    session: dict,
    error: Any,
    error_surface: Optional[dict] = None,
    *,
    client_submission_ids: list[str] | None = None,
    history_lock_owned: bool = False,
    retire_marker: bool = True,
) -> None:
    """Close a failed turn with the same ``status: "error"`` ``message.complete`` frame as the returned-error path,
    retaining the turn so a client that missed the frame recovers it from ``session.resume``'s ``inflight``.
    ``error_surface`` ({layer, code, retryable}) is classified from an exception if absent."""
    agent = session.get("agent")
    if error_surface is None and isinstance(error, BaseException):
        with contextlib.suppress(Exception):
            from agent.error_surface import build_error_surface_from_exception
            error_surface = build_error_surface_from_exception(
                error, provider=str(getattr(agent, "provider", "") or ""),
                model=str(getattr(agent, "model", "") or ""), api_key=getattr(agent, "api_key", None))
    def _settle() -> tuple[str, str, int]:
        _fail_inflight_turn(session, error, error_surface=error_surface)
        turn = session.get("inflight_turn") or {}
        message, partial = str(turn.get("error") or "turn failed"), str(turn.get("assistant") or "")
        cols = int(session.get("cols", 80))
        return message, partial, cols

    if history_lock_owned:
        message, partial, cols = _settle()
    else:
        with session["history_lock"]:
            message, partial, cols = _settle()
    text = partial or turn_error_text(message, error_surface)
    rendered = ""
    with contextlib.suppress(Exception):
        rendered = render_message(text, cols)
    payload = {"text": text, "usage": _get_usage(agent) if agent is not None else {}, "status": "error",
               "error": message, "recoverable": True, **({"error_surface": error_surface} if error_surface else {}),
               **({"partial": True} if partial else {}), **({"rendered": rendered} if rendered else {})}
    if client_submission_ids:
        payload["client_submission_ids"] = list(dict.fromkeys(client_submission_ids))
    if retire_marker:
        _retire_turn_marker(session)
    _emit("message.complete", sid, payload)


def _restore_agent_history_after_turn_error(session: dict, agent) -> bool:
    """Keep a failed turn's working transcript: ``AIAgent`` persists its messages independently, so after a raise the
    next prompt must see them, not the pre-turn snapshot."""
    agent_messages = getattr(agent, "_session_messages", None)
    if not isinstance(agent_messages, list):
        return False
    with session["history_lock"]:
        session["history"] = list(agent_messages)
        session["history_version"] = int(session.get("history_version", 0)) + 1
    return True


def _queued_prompt_snapshot(session: dict) -> dict | None:
    """The accepted next-turn prompt without its transport handle, for the live-session projection (Desktop may
    reconnect while it is still queued)."""
    queued = session.get("queued_prompt")
    user = _inflight_text(queued.get("text")) if isinstance(queued, dict) else ""
    return {"user": user} if user else None


def register(server) -> None:
    """Publish this module's helpers + handlers onto ``server``, rebound to its globals."""
    bind_module(globals(), server, skip=("_",))
