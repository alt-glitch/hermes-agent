"""Recurring in-session wakeups — the /loop command (Claude Code parity).

A loop stops when the agent ends a wakeup reply with ``LOOP_COMPLETE`` on its own line, when
``--times N`` ticks have fired, when the ``--until`` judge rules the condition met, or when the
``loops.max_ticks`` backstop pauses it. State lives in SessionDB ``state_meta`` (same contract as
``hermes_cli/goals.py``); CLI, gateway, and TUI all drive it through :class:`LoopManager`.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field, fields, asdict
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# Floor for fixed intervals. Claude Code allows 30s; anything tighter is almost always an
# accident that burns tokens polling unchanged state. Config loops.min_interval_seconds (clamped ≥ 5).
DEFAULT_MIN_INTERVAL_SECONDS = 30
# Backstop tick budget so an unattended loop can't run forever. 0 = unlimited; config loops.max_ticks.
DEFAULT_MAX_TICKS = 100
# Self-paced mode: start at the floor, double while replies are unchanged, cap at the
# ceiling, snap back to the floor on any change.
DEFAULT_SELF_PACED_FLOOR_SECONDS = 60
DEFAULT_SELF_PACED_CEILING_SECONDS = 15 * 60

# Completion sentinel the wakeup prompt teaches the agent to emit.
LOOP_COMPLETE_MARKER = "LOOP_COMPLETE"
# Marker on its own line, tolerating surrounding whitespace / trailing punctuation.
_LOOP_COMPLETE_RE = re.compile(
    r"(?im)^\s*" + re.escape(LOOP_COMPLETE_MARKER) + r"\s*[.!]?\s*$"
)
# Interval token: 30s / 5m / 2h / 1h30m (compound units allowed, at least one).
_INTERVAL_TOKEN_RE = re.compile(
    r"^(?=\d)(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$", re.IGNORECASE
)


WAKEUP_PROMPT_TEMPLATE = (
    "[/loop wakeup #{tick}{cadence}]\n"
    "Recurring task: {prompt}\n\n"
    "This is an automatic wakeup from the /loop the user set. Perform the "
    "task now against the CURRENT state (re-check files, processes, or "
    "services fresh — do not assume anything from earlier iterations still "
    "holds). Report concisely what you found or did this iteration.\n"
    "If the task is now complete, no longer applicable, or the thing you "
    "were watching has finished, say so and end your reply with "
    f"{LOOP_COMPLETE_MARKER} on its own line — that stops the loop."
)

WAKEUP_PROMPT_WITH_UNTIL_TEMPLATE = (
    "[/loop wakeup #{tick}{cadence}]\n"
    "Recurring task: {prompt}\n\n"
    "Stop condition: {until}\n\n"
    "This is an automatic wakeup from the /loop the user set. Perform the "
    "task now against the CURRENT state (re-check files, processes, or "
    "services fresh — do not assume anything from earlier iterations still "
    "holds). Report concisely what you found or did this iteration, and "
    "show concrete evidence of the stop condition's status.\n"
    "If the stop condition is met, or the task is no longer applicable, say "
    f"so and end your reply with {LOOP_COMPLETE_MARKER} on its own line — "
    "that stops the loop."
)


def parse_interval_token(token: str) -> Optional[int]:
    """Total seconds for ``30s``/``5m``/``2h``/``1h30m``, else None.

    A bare number is NOT an interval (it collides with prompt text like ``/loop 3 things``).
    """
    m = _INTERVAL_TOKEN_RE.match(token.strip()) if token else None
    if not m:
        return None
    h, mnt, s = (int(g) if g else 0 for g in m.groups())
    total = h * 3600 + mnt * 60 + s
    return total if total > 0 else None


def parse_loop_args(text: str) -> Dict[str, Any]:
    """Parse ``/loop [interval] <prompt> [--times N] [--until ...]``.

    Returns ``{"interval_seconds": int|None, "prompt", "times", "until", "error"}``;
    ``interval_seconds`` None means self-paced, ``error`` is set for unusable input.
    """
    raw = (text or "").strip()
    result: Dict[str, Any] = {"interval_seconds": None, "prompt": "", "times": 0, "until": "", "error": None}
    if not raw:
        return {**result, "error": "empty"}

    # Pull trailing flags first so an interval-looking token inside the --until clause can't
    # confuse the front parse. --until consumes to end-of-line (or to a following --times).
    times, until = 0, ""
    m_times = re.search(r"\s--times\s+(\S+)", raw)
    if m_times:
        try:
            times = int(m_times.group(1))
            if times < 1:
                raise ValueError
        except ValueError:
            return {**result, "error": f"--times expects a positive integer, got {m_times.group(1)!r}"}
        raw = (raw[: m_times.start()] + raw[m_times.end():]).strip()

    m_until = re.search(r"\s--until\s+(.+)$", raw, re.DOTALL)
    if m_until:
        until = m_until.group(1).strip()
        raw = raw[: m_until.start()].strip()

    # Leading "every" sugar: /loop every 5m <prompt>
    tokens = raw.split(None, 1)
    if tokens and tokens[0].lower() == "every" and len(tokens) > 1:
        raw = tokens[1]
        tokens = raw.split(None, 1)

    interval = parse_interval_token(tokens[0]) if tokens else None
    if interval is not None:
        raw = tokens[1].strip() if len(tokens) > 1 else ""

    if not raw:
        return {**result, "error": "missing prompt (usage: /loop [interval] <prompt>)"}
    return {**result, "interval_seconds": interval, "prompt": raw, "times": times, "until": until}


def format_interval(seconds: float) -> str:
    """Render seconds as a compact human interval (``90`` → ``1m30s``)."""
    h, rem = divmod(int(max(0, round(seconds))), 3600)
    m, s = divmod(rem, 60)
    parts = [f"{h}h"] if h else []
    if m:
        parts.append(f"{m}m")
    if s or not parts:
        parts.append(f"{s}s")
    return "".join(parts)


def _loops_config() -> Dict[str, Any]:
    try:
        from hermes_cli.config import load_config

        section = (load_config() or {}).get("loops") or {}
        return section if isinstance(section, dict) else {}
    except Exception:
        return {}


def _config_int(key: str, default: int, floor: int) -> int:
    """``loops.<key>`` as an int clamped to ``floor``; ``default`` on any bad value."""
    try:
        return max(floor, int(_loops_config().get(key, default)))
    except Exception:
        return default


def min_interval_seconds() -> int:
    return _config_int("min_interval_seconds", DEFAULT_MIN_INTERVAL_SECONDS, 5)


def max_ticks_default() -> int:
    return _config_int("max_ticks", DEFAULT_MAX_TICKS, 0)


def self_paced_floor_seconds() -> int:
    return _config_int("self_paced_floor_seconds", DEFAULT_SELF_PACED_FLOOR_SECONDS, 10)


def self_paced_ceiling_seconds() -> int:
    floor = self_paced_floor_seconds()
    return _config_int("self_paced_ceiling_seconds", max(floor, DEFAULT_SELF_PACED_CEILING_SECONDS), floor)


@dataclass
class LoopState:
    """Serializable /loop state stored per session."""

    prompt: str
    status: str = "active"            # active | paused | done | cleared
    mode: str = "interval"            # interval | self_paced
    interval_seconds: float = 0.0     # fixed cadence (mode == "interval")
    current_delay: float = 0.0        # live cadence (self-paced backoff)
    times: int = 0                    # user cap (--times N); 0 = none
    until: str = ""                   # judged stop condition; "" = none
    max_ticks: int = DEFAULT_MAX_TICKS  # config backstop; 0 = unlimited
    ticks_fired: int = 0
    created_at: float = 0.0
    last_fired_at: float = 0.0
    next_due_at: float = 0.0
    # True between "wakeup injected" and "that turn's response evaluated": stops a tick from
    # double-firing mid-turn and tells the post-turn hook the turn that just ended was ours.
    awaiting_response: bool = False
    claim_id: str = ""
    last_response_digest: str = ""    # self-paced change detection
    paused_reason: Optional[str] = None
    last_stop_reason: Optional[str] = None
    # Gateway routing (platform / chat_id / chat_type / thread_id) captured at creation so the
    # idle watcher can inject ticks into the right chat. Empty for CLI/TUI (own schedulers).
    route: Dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @classmethod
    def from_json(cls, raw: str) -> "LoopState":
        data = json.loads(raw)
        route = data.get("route")
        kwargs: Dict[str, Any] = {
            "prompt": data.get("prompt", ""),
            "status": data.get("status", "active"),
            "mode": data.get("mode", "interval"),
            "paused_reason": data.get("paused_reason"),
            "last_stop_reason": data.get("last_stop_reason"),
            "route": route if isinstance(route, dict) else {},
        }
        # Remaining scalar fields: missing key -> dataclass default; present-but-falsy -> type zero.
        casts = {"str": str, "int": int, "float": float, "bool": bool}
        for f in fields(cls):
            if f.name not in kwargs:
                kwargs[f.name] = casts[f.type](data.get(f.name, f.default) or casts[f.type]())
        return cls(**kwargs)

    def cadence_label(self) -> str:
        if self.mode == "self_paced":
            live = f", currently {format_interval(self.current_delay)}" if self.current_delay else ""
            return f"self-paced{live}"
        return f"every {format_interval(self.interval_seconds)}"

    def remaining_label(self) -> str:
        if self.status != "active":
            return ""
        remaining = self.next_due_at - time.time()
        return "due now" if remaining <= 0 else f"next in {format_interval(remaining)}"


_META_PREFIX = "loop:"


def _meta_key(session_id: str) -> str:
    return f"{_META_PREFIX}{session_id}"


def _get_session_db() -> Optional[Any]:
    """The goals module's cached SessionDB, so goals/loops/heartbeats share one connection and
    its off-loop bootstrap (a cold cache on the loop thread never runs ``SessionDB()`` inline).

    The previous copy here did, which froze the loop for the init duration and dropped the first ``loop:*``
    write (the /goal bug class, #88965).
    """
    try:
        from hermes_cli.goals import _get_session_db as _goals_db
    except Exception as exc:  # pragma: no cover
        logger.debug("LoopManager: SessionDB bootstrap failed (%s)", exc)
        return None
    return _goals_db()


def _db_op(label: str, fn, default=None):
    """Run one SessionDB call; any error is logged at debug and yields ``default``."""
    try:
        return fn()
    except Exception as exc:
        logger.debug("LoopManager: %s failed: %s", label, exc)
        return default


def _parse_state(raw: str, session_id: str = "") -> Optional[LoopState]:
    """``LoopState`` from stored JSON; None (warning when *session_id* given) on corrupt data."""
    try:
        return LoopState.from_json(raw)
    except Exception as exc:
        if session_id:
            logger.warning("LoopManager: could not parse stored loop for %s: %s", session_id, exc)
        return None


def load_loop(session_id: str) -> Optional[LoopState]:
    """Load the loop for a session, or None if none exists."""
    db = _get_session_db() if session_id else None
    if db is None:
        return None
    raw = _db_op("get_meta", lambda: db.get_meta(_meta_key(session_id)))
    return _parse_state(raw, session_id) if raw else None


def save_loop(session_id: str, state: LoopState) -> None:
    """Persist a loop to SessionDB. No-op if DB unavailable."""
    if not session_id:
        return
    db = _get_session_db()
    if db is None:
        from hermes_cli.goals import _warn_dropped_write

        _warn_dropped_write("LoopManager", "loop", session_id)
        return
    _db_op("set_meta", lambda: db.set_meta(_meta_key(session_id), state.to_json()))


def compare_and_set_loop(
    session_id: str,
    expected_raw: Optional[str],
    state: LoopState,
) -> bool:
    """Persist ``state`` iff the loop row still matches ``expected_raw``."""
    if not session_id:
        return False
    db = _get_session_db()
    if db is None:
        return False
    try:
        return bool(
            db.compare_and_set_meta(
                _meta_key(session_id), expected_raw, state.to_json()
            )
        )
    except Exception as exc:
        logger.debug("LoopManager: compare-and-set failed: %s", exc)
        return False


def _load_loop_record(session_id: str) -> tuple[Optional[LoopState], Optional[str]]:
    """Return parsed state plus the exact raw value used for CAS."""
    if not session_id:
        return None, None
    db = _get_session_db()
    if db is None:
        return None, None
    try:
        raw = db.get_meta(_meta_key(session_id))
    except Exception as exc:
        logger.debug("LoopManager: get_meta failed: %s", exc)
        return None, None
    if not raw:
        return None, None
    try:
        return LoopState.from_json(raw), raw
    except Exception as exc:
        logger.warning("LoopManager: could not parse stored loop for %s: %s", session_id, exc)
        return None, raw


def clear_loop(session_id: str) -> None:
    """Mark a loop cleared in the DB (preserved for audit, status=cleared)."""
    state = load_loop(session_id)
    if state is not None:
        state.status = "cleared"
        save_loop(session_id, state)


def list_active_loops() -> List[Tuple[str, LoopState]]:
    """``[(session_id, LoopState), ...]`` for every ACTIVE loop; ``[]`` on any DB error.

    Used by the gateway's idle wakeup watcher, which scans for due loops on a coarse tick.
    """
    db = _get_session_db()
    if db is None:
        return []
    out: List[Tuple[str, LoopState]] = []
    for key, raw in _db_op("list_meta_prefix", lambda: db.list_meta_prefix(_META_PREFIX), []):
        session_id = key[len(_META_PREFIX):]
        state = _parse_state(raw) if session_id and raw else None
        if state is not None and state.status == "active":
            out.append((session_id, state))
    return out


def migrate_loop_to_session(old_session_id: str, new_session_id: str, *, reason: str = "") -> bool:
    """Carry a /loop from a parent session to its continuation. Best-effort, never raises.

    Context compression rotates ``session_id`` to a fresh child; without this the loop silently
    dies at the compaction boundary.

    Copies the loop onto the new session and archives the old row as ``cleared`` so exactly one active loop
    row exists per logical conversation. See #33618.
    """
    if not old_session_id or not new_session_id or old_session_id == new_session_id:
        return False
    try:
        state = load_loop(old_session_id)
        if state is None or state.status == "cleared" or load_loop(new_session_id) is not None:
            return False
        save_loop(new_session_id, state)
        clear_loop(old_session_id)
        logger.debug(
            "LoopManager: migrated loop %s -> %s (%s)",
            old_session_id, new_session_id, reason or "rotation",
        )
        return True
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("LoopManager: loop migration failed: %s", exc)
        return False


def _ticks_label(n: int) -> str:
    return f"{n} tick{'s' if n != 1 else ''}"


def _dash(reason: Optional[str]) -> str:
    return f" — {reason}" if reason else ""


def response_signals_complete(response: str) -> bool:
    """True when the agent ended its reply with the LOOP_COMPLETE marker."""
    return bool(response) and _LOOP_COMPLETE_RE.search(response) is not None


def _digest_response(response: str) -> str:
    """Digest for self-paced change detection; whitespace-normalized with clock/timestamp/duration
    tokens stripped so 'checked at 14:02:33' doesn't defeat the backoff."""
    text = (response or "").strip().lower()
    text = re.sub(r"\d{1,2}:\d{2}(:\d{2})?", "", text)
    text = re.sub(r"\d{4}-\d{2}-\d{2}", "", text)
    text = re.sub(r"\b\d+(\.\d+)?\s*(s|sec|secs|seconds|m|min|mins|minutes|h|hr|hrs|hours)\b", "", text)
    text = re.sub(r"\s+", " ", text)
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


class LoopManager:
    """Per-session /loop state + tick decisions.

    Drivers (CLI process_loop, gateway wakeup watcher, TUI ticker) call:

    - ``set(...)`` / ``pause()`` / ``resume()`` / ``clear()`` — user controls.
    - ``is_due()`` — should a wakeup fire now? (cheap, in-memory)
    - ``fire_tick()`` — claim the tick; returns the wakeup message to inject.
    - ``complete_tick(last_response)`` — evaluate the finished wakeup turn:
      detect LOOP_COMPLETE, judge --until, apply --times / max_ticks caps,
      schedule the next tick (with self-paced backoff when applicable).
    - ``status_line()`` — printable one-liner.
    """

    def __init__(self, session_id: str):
        self.session_id = session_id
        self._state, self._raw = _load_loop_record(session_id)

    # --- introspection ------------------------------------------------

    @property
    def state(self) -> Optional[LoopState]:
        return self._state

    def refresh(self) -> None:
        """Re-read state from the DB (cross-process safety for the gateway)."""
        self._state, self._raw = _load_loop_record(self.session_id)

    def _cas(self, state: LoopState, expected_raw: Optional[str]) -> bool:
        if not compare_and_set_loop(self.session_id, expected_raw, state):
            self.refresh()
            return False
        self._state = state
        self._raw = state.to_json()
        return True

    def _ownership_changed(self) -> Dict[str, Any]:
        return {
            "status": self._state.status if self._state else None,
            "stopped": False,
            "reason": "tick ownership changed",
            "message": "",
        }

    def is_active(self) -> bool:
        return self._state is not None and self._state.status == "active"

    def has_loop(self) -> bool:
        return self._state is not None and self._state.status in {"active", "paused"}

    def status_line(self) -> str:
        s = self._state
        if s is None or s.status == "cleared":
            return "No loop set. Start one with /loop [interval] <prompt>."
        fired = f"{s.ticks_fired} tick{'s' if s.ticks_fired != 1 else ''}"
        caps = []
        if s.times:
            caps.append(f"{s.ticks_fired}/{s.times} runs")
        elif s.max_ticks:
            caps.append(f"{s.ticks_fired}/{s.max_ticks} budget")
        else:
            caps.append(fired)
        if s.until:
            caps.append(f"until: {s.until}")
        meta = f"{s.cadence_label()}, {', '.join(caps)}"
        if s.status == "active":
            remaining = s.remaining_label()
            tail = f", {remaining}" if remaining else ""
            if s.awaiting_response:
                tail = ", wakeup running"
            return f"↻ Loop (active, {meta}{tail}): {s.prompt}"
        if s.status == "paused":
            extra = f" — {s.paused_reason}" if s.paused_reason else ""
            return f"⏸ Loop (paused, {meta}{extra}): {s.prompt}"
        if s.status == "done":
            extra = f" — {s.last_stop_reason}" if s.last_stop_reason else ""
            return f"✓ Loop finished ({fired}{extra}): {s.prompt}"
        return f"Loop ({s.status}, {meta}): {s.prompt}"

    # --- mutation -----------------------------------------------------

    def set(
        self,
        prompt: str,
        *,
        interval_seconds: Optional[int] = None,
        times: int = 0,
        until: str = "",
        route: Optional[Dict[str, Any]] = None,
    ) -> LoopState:
        """Start a new loop (replaces any existing one for the session).

        The first wakeup is due immediately (next idle poll / gateway
        watcher scan); subsequent wakeups follow the cadence.
        """
        prompt = (prompt or "").strip()
        if not prompt:
            raise ValueError("loop prompt is empty")

        now = time.time()
        if interval_seconds is not None:
            interval = max(int(interval_seconds), min_interval_seconds())
            state = LoopState(
                prompt=prompt,
                mode="interval",
                interval_seconds=float(interval),
                current_delay=float(interval),
                next_due_at=now,
            )
        else:
            floor = self_paced_floor_seconds()
            state = LoopState(
                prompt=prompt,
                mode="self_paced",
                interval_seconds=0.0,
                current_delay=float(floor),
                next_due_at=now,
            )
        state.times = max(0, int(times or 0))
        state.until = (until or "").strip()
        state.max_ticks = max_ticks_default()
        state.created_at = now
        state.route = dict(route or {})
        self._state = state
        save_loop(self.session_id, state)
        self._raw = state.to_json()
        return state

    def pause(self, reason: str = "user-paused") -> Optional[LoopState]:
        for _ in range(3):
            self.refresh()
            if not self._state or self._state.status not in {"active", "paused"}:
                return None
            expected = self._raw
            self._state.status = "paused"
            self._state.paused_reason = reason
            self._state.awaiting_response = False
            self._state.claim_id = ""
            if self._cas(self._state, expected):
                return self._state
        return None

    def resume(self) -> Optional[LoopState]:
        for _ in range(3):
            self.refresh()
            if not self._state or self._state.status == "cleared":
                return None
            expected = self._raw
            self._state.status = "active"
            self._state.paused_reason = None
            self._state.awaiting_response = False
            self._state.claim_id = ""
            # Re-arm relative to now so a long pause doesn't fire instantly.
            delay = (
                self._state.current_delay
                or self._state.interval_seconds
                or self_paced_floor_seconds()
            )
            self._state.next_due_at = time.time() + min(delay, 5.0)
            if self._cas(self._state, expected):
                return self._state
        return None

    def clear(self) -> bool:
        for _ in range(3):
            self.refresh()
            if self._state is None or self._state.status == "cleared":
                return False
            expected = self._raw
            self._state.status = "cleared"
            self._state.awaiting_response = False
            self._state.claim_id = ""
            if self._cas(self._state, expected):
                self._state = None
                self._raw = None
                return True
        return False

    def mark_done(self, reason: str) -> None:
        self.refresh()
        if not self._state:
            return
        expected = self._raw
        self._state.status = "done"
        self._state.last_stop_reason = reason
        self._state.awaiting_response = False
        self._state.claim_id = ""
        self._cas(self._state, expected)

    # --- tick lifecycle -------------------------------------------------

    def is_due(self, now: Optional[float] = None) -> bool:
        """Cheap check: active, not mid-wakeup, and the clock has passed."""
        s = self._state
        if s is None or s.status != "active" or s.awaiting_response:
            return False
        return (now if now is not None else time.time()) >= s.next_due_at

    def fire_tick(self) -> Optional[str]:
        """Claim a due tick. Returns the message to inject, or None.

        The returned text is either the wakeup-framed prompt or — when the
        loop's prompt is itself a slash command (``/loop 10m /recap``) —
        the raw command so the surface's normal slash dispatch handles it.
        Marks ``awaiting_response`` so the tick can't double-fire while its
        turn runs; drivers MUST follow up with ``complete_tick`` (or
        ``abandon_tick`` on injection failure).
        """
        s = self._state
        if s is None or not self.is_due():
            return None
        expected = self._raw
        s.ticks_fired += 1
        s.last_fired_at = time.time()
        s.awaiting_response = True
        s.claim_id = uuid.uuid4().hex
        # Provisionally schedule the next tick from NOW; complete_tick
        # reschedules from turn end (so a 10-minute turn doesn't cause an
        # instant re-fire), but if the process dies mid-turn the provisional
        # schedule keeps the persisted loop from being 'due' in a tight loop.
        delay = s.current_delay or s.interval_seconds or self_paced_floor_seconds()
        s.next_due_at = s.last_fired_at + delay
        if not self._cas(s, expected):
            return None

        if s.prompt.lstrip().startswith("/"):
            return s.prompt.strip()
        cadence = f", {s.cadence_label()}" if s.mode == "interval" else ", self-paced"
        template = WAKEUP_PROMPT_WITH_UNTIL_TEMPLATE if s.until else WAKEUP_PROMPT_TEMPLATE
        return template.format(tick=s.ticks_fired, cadence=cadence, prompt=s.prompt, until=s.until)

    def abandon_tick(self, claim_id: Optional[str] = None) -> bool:
        """Roll back a fired tick whose injection failed (nothing ran)."""
        self.refresh()
        s = self._state
        if (
            s is None
            or not s.awaiting_response
            or (claim_id is not None and s.claim_id != claim_id)
        ):
            return False
        expected = self._raw
        s.awaiting_response = False
        s.claim_id = ""
        s.ticks_fired = max(0, s.ticks_fired - 1)
        return self._cas(s, expected)

    def recover_stale_tick(self, now: Optional[float] = None) -> bool:
        """Re-arm a crash-left tick after its provisional cadence elapsed.

        ``fire_tick`` persists ``awaiting_response`` before a surface injects
        the wakeup. A process death in that small window can otherwise wedge
        the loop forever. Drivers may call this only after proving that no
        live or restart-recoverable turn still owns the claim.

        Recovery is deliberately at-least-once: roll the unacknowledged tick
        back and make that same ordinal due again.
        """
        self.refresh()
        s = self._state
        ts = now if now is not None else time.time()
        if (
            s is None
            or s.status != "active"
            or not s.awaiting_response
            or ts < s.next_due_at
        ):
            return False
        expected = self._raw
        s.awaiting_response = False
        s.claim_id = ""
        s.ticks_fired = max(0, s.ticks_fired - 1)
        s.next_due_at = ts
        return self._cas(s, expected)

    def complete_tick(
        self, last_response: str, claim_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Evaluate the finished wakeup turn and schedule what's next.

        Returns a decision dict::

            {"status": "active|done|paused", "stopped": bool,
             "reason": str, "message": str}

        ``message`` is a user-visible one-liner ("" when nothing worth
        saying — the common still-looping case stays quiet).
        """
        self.refresh()
        s = self._state
        if (
            s is None
            or not s.awaiting_response
            or (claim_id is not None and s.claim_id != claim_id)
        ):
            return {"status": s.status if s else None, "stopped": False, "reason": "no tick in flight", "message": ""}
        expected = self._raw
        s.awaiting_response = False
        s.claim_id = ""
        now = time.time()

        # 1. Agent self-stop marker.
        if response_signals_complete(last_response):
            s.status = "done"
            s.last_stop_reason = "agent signaled the task is complete"
            if not self._cas(s, expected):
                return self._ownership_changed()
            return {
                "status": "done",
                "stopped": True,
                "reason": s.last_stop_reason,
                "message": f"✓ Loop finished after {s.ticks_fired} tick{'s' if s.ticks_fired != 1 else ''} — task complete.",
            }

        # 2. Evidence-based --until judge (reuses the /goal judge; fail-open).
        if s.until and (last_response or "").strip():
            try:
                from hermes_cli.goals import judge_goal

                verdict, reason, _pf, _wait, _tf = judge_goal(s.until, last_response)
            except Exception as exc:
                verdict, reason = "continue", f"judge unavailable: {type(exc).__name__}"
            if verdict == "done":
                s.status = "done"
                s.last_stop_reason = f"stop condition met: {reason}"
                if not self._cas(s, expected):
                    return self._ownership_changed()
                return {
                    "status": "done",
                    "stopped": True,
                    "reason": s.last_stop_reason,
                    "message": f"✓ Loop finished after {s.ticks_fired} tick{'s' if s.ticks_fired != 1 else ''} — {reason}",
                }
            if verdict == "blocked":
                # Judge ruled the stop condition unachievable — don't spin
                # until the tick budget; pause so the user can re-scope.
                s.status = "paused"
                s.paused_reason = f"stop condition judged unachievable: {reason}"
                if not self._cas(s, expected):
                    return self._ownership_changed()
                return {
                    "status": "paused",
                    "stopped": True,
                    "reason": s.paused_reason,
                    "message": f"⏸ Loop paused — {s.paused_reason}. /loop resume to keep going, /loop stop to end it.",
                }

        # 3. --times user cap.
        if s.times and s.ticks_fired >= s.times:
            s.status = "done"
            s.last_stop_reason = f"completed the requested {s.times} runs"
            if not self._cas(s, expected):
                return self._ownership_changed()
            return {
                "status": "done",
                "stopped": True,
                "reason": s.last_stop_reason,
                "message": f"✓ Loop finished — ran {s.times}/{s.times} times.",
            }

        # 4. Config backstop budget → pause (recoverable), not done.
        if s.max_ticks and s.ticks_fired >= s.max_ticks:
            s.status = "paused"
            s.paused_reason = f"tick budget exhausted ({s.ticks_fired}/{s.max_ticks})"
            if not self._cas(s, expected):
                return self._ownership_changed()
            return {
                "status": "paused",
                "stopped": True,
                "reason": s.paused_reason,
                "message": (
                    f"⏸ Loop paused — {s.ticks_fired}/{s.max_ticks} ticks used "
                    "(loops.max_ticks). /loop resume to keep going, /loop stop to end it."
                ),
            }

        # 5. Still looping — schedule the next tick from turn end.
        if s.mode == "self_paced":
            digest = _digest_response(last_response)
            floor = self_paced_floor_seconds()
            ceiling = self_paced_ceiling_seconds()
            if digest and digest == s.last_response_digest:
                # Nothing changed — back off.
                s.current_delay = min(max(s.current_delay, floor) * 2, ceiling)
            else:
                s.current_delay = float(floor)
            s.last_response_digest = digest
        else:
            s.current_delay = s.interval_seconds
        s.next_due_at = now + s.current_delay
        if not self._cas(s, expected):
            return self._ownership_changed()
        return {
            "status": "active",
            "stopped": False,
            "reason": "loop continues",
            "message": "",
        }



def goal_blocks_loop_tick(session_id: str) -> bool:
    """True when an ACTIVE, non-parked /goal should defer this session's /loop tick.

    Both features inject synthetic turns at idle boundaries; interleaving them would burn the
    goal's turn budget. Parked (waiting), paused, or done goals do NOT block the loop.
    """
    try:
        from hermes_cli.goals import GoalManager

        mgr = GoalManager(session_id=session_id)
        return mgr.is_active() and not mgr.is_waiting()
    except Exception:
        return False


LOOP_HELP = (
    "Usage: /loop [interval] <prompt> [--times N] [--until <condition>]\n"
    "  /loop 5m check the deploy status      — first run now, then every 5m\n"
    "  /loop every 10m /recap                — loop a slash command\n"
    "  /loop keep fixing tests until green   — self-paced (backs off while output is unchanged)\n"
    "  /loop 2m poll CI --times 30           — stop after 30 runs\n"
    "  /loop 5m watch the queue --until queue is empty\n"
    "Controls: /loop status · /loop pause · /loop resume · /loop stop\n"
    "The loop also stops itself when the agent replies with "
    f"{LOOP_COMPLETE_MARKER}."
)


def _pause_output(mgr: "LoopManager") -> str:
    state = mgr.pause(reason="user-paused")
    return "No loop set." if state is None else f"⏸ Loop paused: {state.prompt}\nUse /loop resume to continue."


def _resume_output(mgr: "LoopManager") -> str:
    state = mgr.resume()
    return "No loop to resume." if state is None else f"▶ Loop resumed ({state.cadence_label()}): {state.prompt}"


# Control words -> handler returning the output text. Anything else is a new loop spec.
_CONTROL_COMMANDS = {
    **dict.fromkeys(("", "status"), lambda mgr: mgr.status_line()),
    "pause": _pause_output,
    "resume": _resume_output,
    **dict.fromkeys(("stop", "clear", "cancel"), lambda mgr: "✓ Loop stopped." if mgr.clear() else "No active loop."),
    **dict.fromkeys(("help", "--help", "-h"), lambda mgr: LOOP_HELP),
}


def dispatch_loop_command(
    mgr: "LoopManager",
    args: str,
    *,
    route: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Surface-agnostic handler for ``/loop <args>`` → ``{"output": str, "created": bool}``.

    ``output`` is printed/sent verbatim by each surface. ``route`` is stored on new loops so the
    gateway's idle watcher can inject wakeups into the right chat; CLI/TUI pass None.
    """
    arg = (args or "").strip()
    control = _CONTROL_COMMANDS.get(arg.lower())
    if control is not None:
        return {"output": control(mgr), "created": False}

    parsed = parse_loop_args(arg)
    if parsed["error"]:
        if parsed["error"] == "empty":
            return {"output": "Usage: /loop [interval] <prompt> — see /loop help.", "created": False}
        return {"output": f"/loop: {parsed['error']}", "created": False}

    replacing = mgr.has_loop()
    try:
        state = mgr.set(
            parsed["prompt"],
            interval_seconds=parsed["interval_seconds"],
            times=parsed["times"],
            until=parsed["until"],
            route=route,
        )
    except ValueError as exc:
        return {"output": f"/loop: {exc}", "created": False}

    lines = [f"↻ Loop set ({state.cadence_label()}): {state.prompt}"]
    if replacing:
        lines.append("(replaced the previous loop for this session)")
    if parsed["interval_seconds"] is not None and parsed["interval_seconds"] < state.interval_seconds:
        lines.append(
            f"(interval raised to the {format_interval(state.interval_seconds)} minimum — "
            "loops.min_interval_seconds)"
        )
    if state.mode == "self_paced":
        lines.append(
            f"Self-paced: first check in {format_interval(state.current_delay)}; "
            f"backs off up to {format_interval(self_paced_ceiling_seconds())} while nothing changes."
        )
    if state.times:
        lines.append(f"Runs {state.times} time{'s' if state.times != 1 else ''}, then stops.")
    if state.until:
        lines.append(f"Stops when: {state.until}")
    if not state.times and state.max_ticks:
        lines.append(f"Backstop budget: {state.max_ticks} ticks (loops.max_ticks; 0 = unlimited).")
    first = "fires now, then on the cadence above" if state.status == "active" else state.remaining_label()
    lines.append(f"First wakeup {first}. Controls: /loop status · pause · resume · stop.")
    return {"output": "\n".join(lines), "created": True}


__all__ = [
    "LoopState", "LoopManager", "parse_loop_args", "parse_interval_token", "format_interval",
    "response_signals_complete", "goal_blocks_loop_tick", "load_loop", "save_loop", "clear_loop",
    "list_active_loops", "migrate_loop_to_session", "dispatch_loop_command", "LOOP_COMPLETE_MARKER",
    "WAKEUP_PROMPT_TEMPLATE", "WAKEUP_PROMPT_WITH_UNTIL_TEMPLATE", "DEFAULT_MIN_INTERVAL_SECONDS",
    "DEFAULT_MAX_TICKS",
]
