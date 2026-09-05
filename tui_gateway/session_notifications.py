"""Per-session notification poller: kanban/loop/delegation events routed to the owning session,
desktop UI wiring, HUD surface note. Bodies are rebound onto server.py's globals at install time
(method_ctx.bind_module), so they reference server.py globals bare."""

from __future__ import annotations

import contextlib

from .method_ctx import bind_module


def _notif_locked_sessions(fn, default):
    """Run ``fn(_sessions)`` under ``_sessions_lock``; ``default`` on failure (poller must never crash)."""
    try:
        with _sessions_lock:
            return fn(_sessions)
    except Exception:
        return default


def _notif_current_keys(sid: str, session: dict) -> set:
    return {str(session.get("session_key") or ""), _session_lookup_key(session, fallback=sid)}


def _notif_session_matches(s: dict, keys) -> bool:
    return str(s.get("session_key") or "") in keys or _session_lookup_key(s, fallback="") in keys


def _notif_live_session_matches(keys, exclude: dict | None = None) -> bool:
    """Any non-finalized live session (other than ``exclude``) matches ``keys``; False if the registry can't be read
    (fail open rather than drop the event)."""
    return _notif_locked_sessions(
        lambda ss: any(s is not exclude and not s.get("_finalized") and _notif_session_matches(s, keys)
                       for s in ss.values()),
        False)


def _notif_resolve_event_key(evt_key: str) -> str:
    """Resolve a compression-rotated session key to its continuation tip (or itself)."""
    try:
        db = _get_db()
        return (db.resolve_resume_session_id(evt_key) if db is not None else evt_key) or evt_key
    except Exception:
        return evt_key


def _notification_event_belongs_elsewhere(sid: str, session: dict, evt: dict) -> bool:
    """True if ``evt`` is owned by a *different* live session. Background completions carry the ``session_key`` of the
    session that started the work; async delegation completions also carry ``origin_ui_session_id`` (the live TUI tab)."""
    evt_ui_sid = str(evt.get("origin_ui_session_id") or "")
    if evt_ui_sid:
        if evt_ui_sid == str(sid or "") and not session.get("_finalized"):
            return False
        if _notif_locked_sessions(lambda ss: evt_ui_sid in ss and not ss[evt_ui_sid].get("_finalized"), False):
            return True
        # Exact UI tab gone: fall through to durable session_key routing so a resumed continuation with the same
        # key/lineage can still claim it.
    evt_key = str(evt.get("session_key") or "")
    if not evt_key:
        return False
    current_keys = _notif_current_keys(sid, session)
    # Compression can rotate AIAgent.session_id while the detached child is still running: map the event's original
    # key to its continuation tip so it reaches the live session instead of becoming an orphan any poller may consume.
    # A live continuation wins over the compressed parent, else a stale parent tab could consume the event first.
    resolved_key = _notif_resolve_event_key(evt_key)
    if resolved_key != evt_key:
        if resolved_key in current_keys:
            return False
        if _notif_live_session_matches({resolved_key}):
            return True
    if evt_key in current_keys:
        return False
    return _notif_live_session_matches({evt_key, resolved_key}, exclude=session)


def _session_owns_notification_event(sid: str, session: dict, evt: dict) -> bool:
    """True iff *this* session PROVABLY owns ``evt`` (UI origin is this live session, or ``session_key`` raw/compression-
    resolved matches) — the fail-closed gate for addressed notifications, without the orphan-adoption fallback."""
    if session.get("_finalized"):
        return False
    if str(evt.get("origin_ui_session_id") or "") == str(sid or ""):
        return True
    evt_key = str(evt.get("session_key") or "")
    current_keys = _notif_current_keys(sid, session)
    return bool(evt_key) and (evt_key in current_keys or _notif_resolve_event_key(evt_key) in current_keys)


def _notification_event_requires_owner(evt: dict) -> bool:
    """Whether ``evt`` must be positively claimed before TUI delivery."""
    return evt.get("type") == "async_delegation" or bool(evt.get("origin_ui_session_id") or evt.get("session_key"))


# Extra dedup fields per event type. Completions are terminal (one-shot per process session); watch events are not —
# one process can match patterns many times, so their content is part of the key.
_DEDUP_EXTRA_FIELDS = {
    "watch_match": ("command", "pattern", "output", "suppressed", "message_id"),
    "watch_disabled": ("command", "message", "suppressed"),
    "watch_overflow_": ("command", "message", "suppressed"),  # prefix match
}


def _notification_event_dedup_key(evt: dict) -> tuple:
    """UI-emission identity for a process notification event."""
    evt_type = evt.get("type", "completion")
    if evt_type == "async_delegation":
        # No process session_id: else every completion keys as ("", "async_delegation") and the second is suppressed forever.
        return (evt.get("delegation_id", ""), evt_type)
    extra = _DEDUP_EXTRA_FIELDS.get("watch_overflow_" if evt_type.startswith("watch_overflow_") else evt_type, ())
    return (evt.get("session_id", ""), evt_type, *(evt.get(f, 0 if f == "suppressed" else "") for f in extra))


# Mirror gateway/kanban_watchers.py TERMINAL_KINDS: claim silent kinds (archived/unblocked) too so the cursor advances
# past them and they can't wedge a later completed/blocked event behind an unclaimed row.
_KANBAN_NOTIFY_KINDS = ("completed", "blocked", "gave_up", "crashed", "timed_out", "status", "archived", "unblocked")
_KANBAN_POLL_SECONDS = _LOOP_POLL_SECONDS = 5.0


def _notif_release_turn(session: dict) -> None:
    with session["history_lock"]:
        session["running"] = False


def _notif_claim_turn(session: dict) -> bool:
    """Claim the idle session (running=True) under history_lock; False if a turn is live."""
    with _mcp_reload_admission_lock, session["history_lock"]:
        if session.get("running") or session.get("_closing") or session.get("_finalized"):
            return False
        session["running"] = True
        session["_turn_cancel_requested"] = False
        return True


def _notif_log_failure(what: str, exc: BaseException) -> None:
    print(f"[tui_gateway] {what}: {type(exc).__name__}: {exc}", file=sys.stderr)


def _notif_submit(rid: str, sid: str, session: dict, text: str, what: str, **kwargs) -> bool:
    """Submit a claimed turn; _run_prompt_submit owns its single message.start."""
    try:
        admitted = _run_prompt_submit(rid, sid, session, text, **kwargs)
        if admitted is False:
            _notif_release_turn(session)
        return admitted
    except Exception as exc:
        _notif_log_failure(what, exc)
        _notif_release_turn(session)
        raise


def _notif_loop_status(sid: str, text: str) -> None:
    _emit("status.update", sid, {"kind": "loop", "text": text})


def _notif_slash_loop_tick(rid: str, sid: str, session: dict, mgr, wakeup: str, claim_id: str) -> None:
    """Slash-command /loop wakeup: route through the slash pipeline, not the model. No model reply to evaluate, so the
    tick completes immediately — unless the command resolves to a prompt (skill command etc.), which runs as a normal
    turn whose post-turn hook completes the tick."""
    _notif_release_turn(session)
    try:
        parts = wakeup.lstrip()[1:].split(None, 1)
        resp = _methods["command.dispatch"](
            rid, {"name": parts[0] if parts else "", "arg": parts[1] if len(parts) > 1 else "", "session_id": sid})
        payload = (resp or {}).get("result") or {}
        if out := str(payload.get("output") or "").strip():
            _notif_loop_status(sid, out)
        if payload.get("type") == "send" and payload.get("message"):
            if not _notif_claim_turn(session):
                mgr.abandon_tick(claim_id)
                return
            try:
                admitted = _notif_submit(
                    rid, sid, session, payload["message"], "loop wakeup dispatch failed", loop_claim_id=claim_id)
            except Exception:
                with contextlib.suppress(Exception):
                    mgr.abandon_tick(claim_id)
                return
            if admitted is False:
                mgr.abandon_tick(claim_id)
            return
    except Exception:
        pass
    decision = mgr.complete_tick("", claim_id)
    if decision.get("message"):
        _notif_loop_status(sid, decision["message"])


def _maybe_fire_tui_loop_tick(sid: str, session: dict) -> None:
    """Claim and dispatch one due /loop wakeup without racing recovery or a user turn."""
    try:
        from hermes_cli.loops import LoopManager, goal_blocks_loop_tick
    except Exception:
        return
    sid_key = session.get("session_key") or ""
    if not sid_key:
        return
    mgr = LoopManager(session_id=sid_key)
    state = mgr.state
    now = time.time()
    if state is None or state.status != "active" or now < state.next_due_at:
        return
    if goal_blocks_loop_tick(sid_key):
        return

    with session["history_lock"]:
        if session.get("running") or session.get("_auto_continue_scheduled"):
            return
        if read_turn_marker(_session_home(session), sid_key) is not None:
            return
        if state.awaiting_response and not mgr.recover_stale_tick(now):
            return
        if not mgr.is_due(now):
            return
        session["running"] = True
        session["_turn_cancel_requested"] = False

    wakeup = mgr.fire_tick()
    if not wakeup:
        _notif_release_turn(session)
        return
    claim_id = mgr.state.claim_id if mgr.state else ""
    rid = f"__loop__{int(time.time() * 1000)}"
    try:
        _notif_loop_status(sid, f"↻ /loop wakeup #{mgr.state.ticks_fired if mgr.state else '?'} firing…")
        if wakeup.lstrip().startswith("/"):
            _notif_slash_loop_tick(rid, sid, session, mgr, wakeup, claim_id)
        else:
            if _notif_submit(
                rid, sid, session, wakeup, "loop wakeup dispatch failed", loop_claim_id=claim_id
            ) is False:
                mgr.abandon_tick(claim_id)
    except Exception as exc:
        _notif_log_failure("loop wakeup dispatch failed", exc)
        _notif_release_turn(session)
        with contextlib.suppress(Exception):
            mgr.abandon_tick(claim_id)


def _kb_first_line(value: Any, limit: int) -> str:
    lines = str(value).strip().splitlines()
    return f"\n{lines[0][:limit]}" if lines else ""


def _kb_completed(task, payload: dict, title: str) -> str:
    handoff = (_kb_first_line(payload["summary"], 200) if payload.get("summary")
               else _kb_first_line(task.result, 160) if getattr(task, "result", None) else "")
    return f" done — {title}{handoff}"


def _kb_timed_out(task, payload: dict, title: str) -> str:
    with contextlib.suppress(TypeError, ValueError):
        return f" timed out (max_runtime={int(payload.get('limit_seconds') or 0)}s); will retry"
    return " timed out (max_runtime=0s); will retry"


# kind -> (glyph, suffix after "Kanban <id>"); silent kinds (archived/unblocked) are absent → None.
_KANBAN_EVENT_FORMATTERS = {
    "completed": ("✔", _kb_completed),
    "blocked": ("⏸", lambda t, p, title: " blocked" + (f": {str(p.get('reason'))[:160]}" if p.get("reason") else "")),
    "gave_up": ("✖", lambda t, p, title: " gave up after repeated spawn failures"
                + (f"\n{str(p.get('error'))[:200]}" if p.get("error") else "")),
    "crashed": ("✖", lambda t, p, title: " worker crashed (pid gone); dispatcher will retry"),
    "timed_out": ("⏱", _kb_timed_out),
    "status": ("🔄", lambda t, p, title: f" → {p.get('status') or ''}"),
}


def _format_kanban_event_text(sub: dict, task, ev, board_slug: str) -> Optional[str]:
    """Single-line notification text for one kanban event; wording mirrors gateway/kanban_watchers.py (reads the same
    as on Telegram). None for silent kinds."""
    if (entry := _KANBAN_EVENT_FORMATTERS.get(getattr(ev, "kind", ""))) is None:
        return None
    glyph, fmt = entry
    task_id = sub.get("task_id", "")
    title = (getattr(task, "title", None) or task_id)[:120]
    who = getattr(task, "assignee", None) or ""
    prefix = f"{glyph} " + (f"[{board_slug}] " if board_slug else "") + (f"@{who} " if who else "")
    return f"{prefix}Kanban {task_id}{fmt(task, getattr(ev, 'payload', None) or {}, title)}"


def _kb_board_key(_kb, board_meta) -> tuple[str, str]:
    """(slug, resolved DB identity) — multiple slugs can point at one DB when HERMES_KANBAN_DB pins it."""
    slug = (board_meta or {}).get("slug") or _kb.DEFAULT_BOARD
    db_path = (board_meta or {}).get("db_path")
    try:
        return slug, str(Path(db_path).expanduser().resolve() if db_path else _kb.kanban_db_path(slug).resolve())
    except Exception:
        return slug, f"slug:{slug}"


def _kb_poll_board(_kb, slug: str, session_key: str) -> list:
    """Claim + format this session's unseen events on one board. One poller per live session: the board is not opened
    writable unless it has a subscription owned by this exact session (a failed read-only probe — locked/corrupt DB —
    falls through so delivery is preserved)."""
    from hermes_cli import kanban_db_connect as _kbc
    from hermes_cli import kanban_db_notify as _kbn
    with contextlib.suppress(Exception):
        if _kbn.count_notify_subs(board=slug, platform="tui", chat_id=session_key) == 0:
            return []
    try:
        conn = _kbc.connect(board=slug)
    except Exception:
        return []
    texts: list = []
    with contextlib.closing(conn):
        try:
            subs = _kbn.list_notify_subs(conn)
        except Exception:
            return []
        for sub in subs:
            if (sub.get("platform") or "").lower() != "tui" or sub.get("chat_id") != session_key:
                continue
            sub_ident = dict(task_id=sub["task_id"], platform=sub["platform"], chat_id=sub["chat_id"],
                             thread_id=sub.get("thread_id") or "")
            _old, _new, events = _kbn.claim_unseen_events_for_sub(conn, kinds=_KANBAN_NOTIFY_KINDS, **sub_ident)
            if not events:
                continue
            task = _kb.get_task(conn, sub["task_id"])
            texts.extend(t for t in (_format_kanban_event_text(sub, task, ev, slug) for ev in events) if t)
            # Unsubscribe only on archive: ``done`` is reversible in review/controller flows, so keeping the sub lets a
            # later reopen notify the same session. The claimed cursor prevents replay.
            if task and getattr(task, "status", "") == "archived":
                with contextlib.suppress(Exception):
                    _kbn.remove_notify_sub(conn, **sub_ident)
    return texts


def _collect_kanban_notifications(session: dict) -> list:
    """Claim unseen terminal kanban events for this session's ``platform="tui"`` subscriptions (``kanban_create``
    auto-subscribes with ``chat_id=HERMES_SESSION_KEY``; no "tui" messaging adapter exists, so this poller is the
    delivery path). Same atomic cursor-claim as the gateway notifier: exactly-once even if a gateway polls the same DB.

    See #59890.
    """
    session_key = str(session.get("session_key") or "")
    if not session_key or session.get("_finalized"):
        return []
    try:
        from hermes_cli import kanban_db as _kb
    except Exception:
        return []
    try:
        boards = _kb.list_boards(include_archived=False)
    except Exception:
        try:
            boards = [_kb.read_board_metadata(_kb.DEFAULT_BOARD)]
        except Exception:
            return []
    # dict keyed by resolved DB identity: first slug per DB wins (a pinned HERMES_KANBAN_DB aliases slugs).
    unique = {}
    for slug, resolved in (_kb_board_key(_kb, board_meta) for board_meta in boards):
        unique.setdefault(resolved, slug)
    return [t for slug in unique.values() for t in _kb_poll_board(_kb, slug, session_key)]


def _notif_poll_kanban(sid: str, session: dict) -> None:
    """One kanban poll: emit new texts, buffer them, and run the buffered batch as a turn if idle. Events are
    cursor-claimed (never re-queued), so they wait in the buffer instead of dropping the agent turn."""
    try:
        texts = _collect_kanban_notifications(session)
    except Exception as exc:
        _notif_log_failure("kanban notification poll failed", exc)
        texts = []
    for text in texts:
        _emit("status.update", sid, {"kind": "process", "text": text})
    if texts:
        session.setdefault("_kanban_pending", []).extend(texts)
    if not session.get("_kanban_pending") or not _notif_claim_turn(session):
        return
    with session["history_lock"]:
        batch, session["_kanban_pending"] = list(session.get("_kanban_pending") or []), []
    admitted = False
    try:
        admitted = _notif_submit(
            f"__notif__{int(time.time() * 1000)}", sid, session, "\n".join(batch), "kanban notification dispatch failed")
    except Exception:
        pass  # _notif_submit already logs the dispatch failure and releases the turn.
    finally:
        if admitted is False:
            with session["history_lock"]:
                session["_kanban_pending"] = batch + list(session.get("_kanban_pending") or [])


def _notif_dispatch_event(sid: str, session: dict, evt: dict, text: str) -> bool:
    """Dispatch a claimed turn; False leaves the event eligible for retry."""
    from tools.async_delegation import claim_event_delivery, complete_event_delivery, release_event_delivery
    if (claim := claim_event_delivery(evt, "tui-poller")) is None:
        _notif_release_turn(session)
        return True  # Another consumer owns the event; do not create a retry duplicate.
    kwargs = ({"display_kind": "async_delegation_complete", "display_metadata": _async_delegation_display_metadata(evt)}
              if evt.get("type") == "async_delegation" else {})
    try:
        _emit_process_completion_card(sid, evt, text)
        admitted = _notif_submit(
            f"__notif__{int(time.time() * 1000)}", sid, session, text, "notification poller dispatch failed", **kwargs)
    except Exception:
        _notif_release_turn(session)
        release_event_delivery(evt, claim)
        return False
    if admitted is False:
        release_event_delivery(evt, claim)
        return False
    complete_event_delivery(evt, claim)
    return True


def _notif_handle_event(sid, session, evt, emitted, registry, fmt, deferred) -> bool:
    """Route one dequeued event: foreign (another live session owns it) → requeued, or onto ``deferred`` during the
    shutdown drain; unowned (addressed but unprovable — never adopt an orphan) → dropped, except delegation payloads
    deferred for a resume; ours (or ownerless legacy, kept process-global) → status.update once, then an agent turn if
    idle. False = the drain must stop (session busy)."""
    queue = registry.completion_queue
    evt_type, is_delegation = evt.get("type", "completion"), evt.get("type") == "async_delegation"
    if _notification_event_belongs_elsewhere(sid, session, evt):
        if deferred is not None:
            deferred.append(evt)
        else:  # otherwise a process started in session A surfaces in whichever poller wakes first
            queue.put(evt)
            time.sleep(0.1)
        return True
    if _notification_event_requires_owner(evt) and not _session_owns_notification_event(sid, session, evt):
        origin, key = str(evt.get("origin_ui_session_id") or ""), str(evt.get("session_key") or "")
        if deferred is None:
            (logger.warning if is_delegation else logger.debug)(
                "Dropping unowned %s notification (origin=%r key=%r) instead of delivering to session %s",
                evt_type, origin, key, sid)
        elif is_delegation:
            deferred.append(evt)
        else:
            logger.debug("Dropping unowned %s notification during shutdown drain (origin=%r key=%r)", evt_type, origin, key)
        return True
    if evt_type == "completion" and registry.is_completion_consumed(evt.get("session_id", "")):
        return True
    text = fmt(evt)
    if not text:
        return True
    # Emit once per dedup key: a re-queued completion would otherwise re-emit every 0.5s while the session is busy,
    # while distinct watch_match events from one process must stay visible.
    dedup_key = _notification_event_dedup_key(evt)
    if dedup_key not in emitted:
        if is_delegation:
            notice = _async_delegation_notice(evt, text)
            _emit("status.update", sid, {"kind": "status", "text": notice["text"]})
        else:
            _emit("status.update", sid, {"kind": "process", "text": text})
        emitted.add(dedup_key)
    if not _notif_claim_turn(session) or not _notif_dispatch_event(sid, session, evt, text):
        queue.put(evt)
        if deferred is not None:
            return False
        time.sleep(0.25)  # back off: the re-queued event keeps the queue non-empty, else this loop spins at 100% CPU
        return True
    return True


def _notification_poller_loop(stop_event: threading.Event, sid: str, session: dict) -> None:
    """Daemon thread (started by _init_session()) that drains the process-global completion_queue for this session
    (ownership routing: _notif_handle_event) and polls ``kanban_notify_subs`` every ``_KANBAN_POLL_SECONDS`` — the
    delivery path for platform="tui" rows.

    Also polls ``kanban_notify_subs`` every ``_KANBAN_POLL_SECONDS`` for this session's TUI kanban
    subscriptions and delivers terminal task events the same way (status.update + agent turn) — the delivery
    path tools/kanban_tools.py documents for platform="tui" rows (issue #59890).
    """
    from tools.process_registry import process_registry
    from tools.process_registry_notifications import format_process_notification
    queue = process_registry.completion_queue
    emitted: set = set()  # dedup re-queued events so one completion isn't emitted 50 times while busy
    handle = lambda evt, deferred: _notif_handle_event(  # noqa: E731
        sid, session, evt, emitted, process_registry, format_process_notification, deferred)
    last_kanban_poll = last_loop_poll = 0.0
    while not stop_event.is_set() and not session.get("_finalized"):
        now = time.monotonic()
        # /loop wakeup driver: fire a due tick for THIS session while idle (same claim-under-lock as kanban dispatch).
        # An active non-parked /goal owns the idle boundary and defers it.
        if now - last_loop_poll >= _LOOP_POLL_SECONDS:
            last_loop_poll = now
            try:
                _maybe_fire_tui_loop_tick(sid, session)
            except Exception as loop_exc:
                _notif_log_failure("loop wakeup poll failed", loop_exc)
        if now - last_kanban_poll >= _KANBAN_POLL_SECONDS:
            last_kanban_poll = now
            _notif_poll_kanban(sid, session)
        try:
            evt = queue.get(timeout=0.5)
        except Exception:
            continue
        handle(evt, None)
    # Drain remaining events after the stop signal so nothing is lost on shutdown; foreign and orphaned-delegation
    # events are handed back to the shared queue afterwards.
    deferred: list = []
    while not queue.empty():
        try:
            evt = queue.get_nowait()
        except Exception:
            break
        if not handle(evt, deferred):
            break
    for evt in deferred:
        queue.put(evt)


def _async_delegation_display_metadata(evt: dict) -> dict:
    """Build display-only metadata before the completion event is formatted."""
    raw_results = evt.get("results")
    results: list[dict] = [r for r in raw_results if isinstance(r, dict)] if isinstance(raw_results, list) else []
    task_count = len(results) or 1
    completed_count = sum(1 for r in results if r.get("status") in {"completed", "success"})
    failed_count = sum(1 for r in results if r.get("status") in {"failed", "error"})
    duration = evt.get("total_duration_seconds") or evt.get("duration_seconds")
    return {"delegation_id": str(evt.get("delegation_id") or ""), "task_count": task_count,
            "completed_count": completed_count or task_count - failed_count, "failed_count": failed_count,
            **({"duration_seconds": duration} if isinstance(duration, (int, float)) else {})}


def _duration_label(value: Any) -> str:
    """Compact a process/delegation duration for one-line notification chrome."""
    if value in (None, "", "?"):
        return ""
    try:
        seconds = max(0, int(float(value)))
    except (TypeError, ValueError, OverflowError):
        text = str(value).strip()
        return text if text.endswith(("s", "m", "h")) else f"{text}s"
    if seconds < 60:
        return f"{seconds}s"
    minutes, seconds = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m" if seconds == 0 else f"{minutes}m{seconds}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h" if minutes == 0 else f"{hours}h{minutes}m"


def _async_delegation_notice(evt: dict, detail: str) -> dict:
    """Build compact UI chrome while keeping the full detail for disclosure."""
    deleg_id = str(evt.get("delegation_id") or "delegation")
    results = evt.get("results")
    is_batch = bool(evt.get("is_batch")) or isinstance(results, list)
    duration = _duration_label(
        evt.get("total_duration_seconds")
        if is_batch
        else evt.get("duration_seconds")
    )
    if is_batch:
        rows = results if isinstance(results, list) else []
        goals = evt.get("goals")
        count = len(rows) or (len(goals) if isinstance(goals, list) else int(evt.get("task_count") or 0))
        succeeded = sum(
            1
            for row in rows
            if isinstance(row, dict)
            and str(row.get("status") or "").lower() in {"completed", "success"}
        )
        failed = max(0, count - succeeded)
        pieces = [
            f"{count} agent{'s' if count != 1 else ''}",
            "all done" if count > 0 and failed == 0 else f"{succeeded} done",
        ]
        if failed:
            pieces.append(f"{failed} failed")
        level = "success" if failed == 0 else "warn"
    else:
        status = str(evt.get("status") or "completed").strip().lower()
        pieces = [status]
        level = "success" if status in {"completed", "success"} else "warn"
    if duration:
        pieces.append(duration)
    pieces.append(deleg_id)
    return {
        "always_visible": True,
        "detail": detail,
        "key": f"deleg:{deleg_id}",
        "kind": "async delegation",
        "level": level,
        "text": " · ".join(pieces),
    }


def _async_delegation_notice_from_text(detail: str) -> dict | None:
    """Reconstruct compact presentation metadata from a persisted reinjection."""
    import re

    header = re.match(
        r"^\[ASYNC DELEGATION( BATCH)? COMPLETE [—-] ([^\]]+)\]",
        detail,
    )
    if header is None:
        return None
    deleg_id = header.group(2).strip()
    task_statuses = re.findall(
        r"^--- ([✓✗]) TASK \d+/\d+",
        detail,
        flags=re.MULTILINE,
    )
    if header.group(1):
        evt: dict = {
            "delegation_id": deleg_id,
            "is_batch": True,
            "results": [
                {"status": "completed" if icon == "✓" else "failed"}
                for icon in task_statuses
            ],
        }
        if not task_statuses:
            count_match = re.search(r"fan-out of (\d+) subagent", detail)
            if count_match is not None:
                evt["task_count"] = int(count_match.group(1))
        duration_match = re.search(r"Total duration:\s*([^\n]+)", detail)
        if duration_match is not None:
            evt["total_duration_seconds"] = duration_match.group(1).strip()
    else:
        status_match = re.search(r"^Status:\s*([^\s]+)", detail, flags=re.MULTILINE)
        duration_match = re.search(r"Duration:\s*([^\s]+)", detail)
        evt = {
            "delegation_id": deleg_id,
            "status": status_match.group(1) if status_match is not None else "completed",
        }
        if duration_match is not None:
            evt["duration_seconds"] = duration_match.group(1)
    return _async_delegation_notice(evt, detail)


def _emit_process_completion_card(
    sid: str, evt: dict, detail: str | None = None
) -> None:
    """Emit compact completion chrome separately from the full model-facing prompt.

    Callers own delivery deduplication; watch matches are not terminal cards.
    """
    evt_type = evt.get("type", "completion")
    if evt_type == "async_delegation":
        if not detail:
            return
        _emit("notification.show", sid, _async_delegation_notice(evt, detail))
        return
    if evt_type != "completion":
        return
    cmd = str(evt.get("command") or "process").strip().replace("\n", " ")
    if len(cmd) > 60:
        cmd = cmd[:59] + "…"
    code = evt.get("exit_code")
    if code is None:
        text, level = f"{cmd} finished", "info"
    else:
        text = f"{cmd} exited {code}"
        level = "info" if code == 0 else "warn"
    _emit(
        "notification.show",
        sid,
        {
            "text": text,
            "kind": "process.complete",
            "level": level,
            "key": f"proc:{evt.get('session_id', '')}",
        },
    )


_desktop_ui_wired = False


def _wire_desktop_sinks() -> None:
    """Idempotently wire process-registry and desktop-tool sinks to renderer events: `agent.terminal.output` and
    `terminal.close` (drops a tab without killing the process) route to the window owning the process; desktop-only
    tools pass the turn's ``HERMES_UI_SESSION_ID`` as ``sid``. `_emit` is thread-safe."""
    global _desktop_ui_wired
    from tools.process_registry import process_registry

    def _owner_sid(session) -> str:
        # session may be None (process already finished/pruned) — the tab can still linger and be closed.
        session_key = str(getattr(session, "session_key", "") or "") if session is not None else ""
        if not session_key:
            return ""
        with _sessions_lock:
            return next((sid for sid, s in _sessions.items() if str(s.get("session_key") or "") == session_key), "")
    if getattr(process_registry, "on_output", None) is None:
        process_registry.on_output = lambda session, chunk: _emit(
            "agent.terminal.output", _owner_sid(session), {"process_id": session.id, "chunk": chunk})
    if getattr(process_registry, "on_close", None) is None:
        process_registry.on_close = lambda session, pid: _emit("terminal.close", _owner_sid(session), {"process_id": pid})
    if not _desktop_ui_wired:
        with contextlib.suppress(Exception):
            from tools import desktop_ui
            desktop_ui.set_emitter(lambda sid, event, payload: _emit(event, sid, payload))
            _desktop_ui_wired = True


# (stop_event, thread) for every poller started in this process, pruned of dead threads on each spawn. Test teardowns
# reap leaked pollers through it: an unjoined poller steals events off the process-global queue in a LATER test.
_notification_pollers: list = []


def _start_notification_poller(sid: str, session: dict) -> threading.Event:
    """Start the background notification poller for a TUI session (thread name is greppable)."""
    _wire_desktop_sinks()
    stop = threading.Event()
    t = threading.Thread(target=_notification_poller_loop, args=(stop, sid, session), daemon=True, name=f"tui-notif-poller-{sid}")
    _notification_pollers[:] = [(s, th) for (s, th) in _notification_pollers if th.is_alive()] + [(stop, t)]
    t.start()
    return stop


def _hud_surface_note(session: dict) -> str:
    """The HUD-mode note for this turn, or "" when it was not typed there."""
    if session.get("client_surface") != "hud":
        return ""
    from agent.prompt_builder import hud_surface_note
    return hud_surface_note(getattr(session.get("agent"), "valid_tool_names", None))


def _prepend_note(run_message: Any, note: str) -> Any:
    """Prefix a per-turn note onto the MODEL INPUT, leaving the prompt alone: everything the model must know that the
    user did not type (interrupted reply, reactions, surface) arrives this way, so no scaffolding reaches the
    transcript and no sent message is rewritten — the cached prefix survives."""
    if note and isinstance(run_message, str):
        return f"{note}\n\n{run_message}"
    if note and isinstance(run_message, list):
        return [{"type": "text", "text": note}, *run_message]
    return run_message


def register(server) -> None:
    """Publish this module's helpers + handlers onto ``server``, rebound to its globals."""
    bind_module(globals(), server, skip=("_",))
