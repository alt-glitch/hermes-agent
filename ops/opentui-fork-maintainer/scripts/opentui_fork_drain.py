#!/usr/bin/env python3
"""Drain pending Telegram notifications queued by the OpenTUI fork-maintainer agent.

Hermes `no_agent` cron script (drain pattern):
- stdout is delivered VERBATIM to the cron job's `deliver` target (Telegram)
- empty stdout = silent tick (nothing pending)

The maintainer agent appends lines to
~/projects/opentui-fork-maintainer/state/pending_notifications.log:
    <iso-ts> | PENDING | telegram:<chat_id> | <message>

DELIVERY-FAILURE-AWARE RETRY (the important part):
A `no_agent` script cannot see whether the scheduler's delivery of its stdout
actually reached Telegram — the script finishes first, THEN the scheduler
delivers. The naive approach (mark SENT immediately) silently LOSES every
notification during a Telegram outage (observed 2026-06-17: the gateway's
Telegram connection was down for >40 min, every delivery timing out).

So this script reads its OWN previous tick's delivery result from the cron
registry (`~/.hermes/cron/jobs.json` -> this job's `last_delivery_error`,
cleared by the scheduler only on a SUCCESSFUL delivery). If the last delivery
FAILED, it reverts the lines it marked `SENT <that-tick>` back to `PENDING` so
they are re-sent this tick. A line is only permanently SENT once a subsequent
tick confirms the delivery that carried it succeeded.

This is why the agent must QUEUE notifications here instead of calling
`hermes send` inline: inline sends fight the gateway's Telegram long-poll and
time out, AND have no retry. This drain reuses the gateway's own delivery path
and retries across outages.
"""

from __future__ import annotations

import json
import fcntl
import os
import tempfile
from contextlib import contextmanager
import sys
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
LOG = (
    HOME
    / "projects"
    / "opentui-fork-maintainer"
    / "state"
    / "pending_notifications.log"
)
JOBS_JSON = HOME / ".hermes" / "cron" / "jobs.json"
JOB_ID = "7bc207dab71f"  # opentui-fork-drain (this job)
LAST_TICK_FILE = (
    HOME / "projects" / "opentui-fork-maintainer" / "state" / "drain_last_tick.txt"
)
LOCK_FILE = LOG.with_suffix(".lock")

MAX_PER_TICK = 10  # don't flood the chat if a backlog built up
# Alerts older than this are stale -> mark EXPIRED, don't send. Set generously:
# Telegram can be unreachable for MULTI-DAY stretches (e.g. India's nationwide
# block 2026-06-16..06-22 ahead of the NEET-UG retest). A short window would
# silently drop notifications queued during the outage before delivery resumes.
# 14d comfortably outlives a week-long block; truly ancient alerts still expire.
MAX_AGE_DAYS = 14


def _expired(ts: str, now: datetime) -> bool:
    try:
        then = datetime.fromisoformat(ts)
        if then.tzinfo is None:
            then = then.replace(tzinfo=timezone.utc)
        else:
            then = then.astimezone(timezone.utc)
    except ValueError:
        return False
    return (now - then).days > MAX_AGE_DAYS


def _last_delivery_failed() -> bool | None:
    """True if this job's PREVIOUS tick failed to deliver its stdout.

    The scheduler sets last_delivery_error to a string on failure and clears it
    to None on success. Absent file / unparseable / job-missing return None. Registry errors
    also return None so the drain fails closed
    without mutating the queue."""
    try:
        raw = json.loads(JOBS_JSON.read_text(encoding="utf-8"))
        jobs = raw.get("jobs") if isinstance(raw, dict) else raw
        job = next((j for j in jobs if j.get("id") == JOB_ID), None)
        if job is None or "last_delivery_error" not in job:
            return None
        error = job["last_delivery_error"]
        if error is None:
            return False
        if isinstance(error, str):
            return bool(error)
        return None
    except (OSError, json.JSONDecodeError, TypeError, StopIteration):
        return None


def _revert_last_tick(lines: list[str], last_tick: str) -> tuple[list[str], int]:
    """Flip lines marked `SENT <last_tick>` back to PENDING (delivery failed)."""
    out: list[str] = []
    reverted = 0
    needle = f"SENT {last_tick}"
    for line in lines:
        parts = [p.strip() for p in line.split("|", 3)]
        if len(parts) == 4 and parts[1] == needle:
            ts, _, target, message = parts
            out.append(f"{ts} | PENDING | {target} | {message}")
            reverted += 1
        else:
            out.append(line)
    return out, reverted


@contextmanager
def _queue_lock():
    LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_FILE.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _write_lines_atomic(lines: list[str]) -> None:
    fd, tmp_name = tempfile.mkstemp(prefix=f".{LOG.name}.", dir=LOG.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, LOG)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def _main_locked() -> int:
    if not LOG.exists():
        return 0
    lines = LOG.read_text(encoding="utf-8").splitlines()

    # 1. If our last delivery failed, un-send the lines that last tick marked SENT.
    delivery_failed = _last_delivery_failed()
    if delivery_failed is None:
        return 1
    if delivery_failed and LAST_TICK_FILE.exists():
        last_tick = LAST_TICK_FILE.read_text(encoding="utf-8").strip()
        if last_tick:
            lines, reverted = _revert_last_tick(lines, last_tick)
            if reverted:
                _write_lines_atomic(lines)

    # 2. Normal drain.
    out: list[str] = []
    sent = 0
    expired = 0
    now_dt = datetime.now(timezone.utc)
    now = now_dt.strftime("%Y-%m-%dT%H:%M")
    for line in lines:
        parts = [p.strip() for p in line.split("|", 3)]
        if len(parts) == 4 and parts[1] == "PENDING":
            ts, _, target, message = parts
            if _expired(ts, now_dt):
                out.append(f"{ts} | EXPIRED {now} | {target} | {message}")
                expired += 1
                continue
            if sent < MAX_PER_TICK:
                print(message)
                out.append(f"{ts} | SENT {now} | {target} | {message}")
                sent += 1
                continue
        out.append(line)

    if sent or expired:
        _write_lines_atomic(out)
    if sent:
        # Record which tick stamp these SENT lines carry, so a delivery failure
        # next tick can find & revert exactly them.
        LAST_TICK_FILE.write_text(now, encoding="utf-8")
        remaining = sum(1 for ln in out if "| PENDING |" in ln)
        if remaining:
            print(f"(+{remaining} more pending, will follow next tick)")
    return 0


def main() -> int:
    with _queue_lock():
        return _main_locked()


if __name__ == "__main__":
    sys.exit(main())
