"""Durable reporting for a scheduled fire that overlaps a direct owner."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from cron import executions, jobs, scheduler


REPO_ROOT = Path(__file__).resolve().parents[2]
_CLAIM_SCRIPT = r"""
import json
import os
import sys
import threading
from pathlib import Path
from cron import jobs

with jobs.use_cron_store(sys.argv[1]):
    claimed = jobs.claim_job_for_fire(sys.argv[2], return_job=True)
    if sys.argv[4] != "claim-only-hold":
        assert jobs.heartbeat_fire_claim(
            sys.argv[2], expected_owner=claimed["fire_claim"]["by"]
        )
    claimed = jobs.get_job(sys.argv[2])
    result = Path(sys.argv[3])
    staged = result.with_suffix(".tmp")
    staged.write_text(json.dumps(claimed["fire_claim"]), encoding="utf-8")
    os.replace(staged, result)
    if sys.argv[4] in {"hold", "claim-only-hold"}:
        released = threading.Event()
        threading.Thread(
            target=lambda: (sys.stdin.read(1), released.set()), daemon=True
        ).start()
        released.wait(10)
"""


def _claim_in_process(
    store: Path, job_id: str, *, hold: bool, heartbeat: bool = True
):
    result = store / f"claim-{job_id}.json"
    mode = "exit"
    if hold:
        mode = "hold" if heartbeat else "claim-only-hold"
    proc = subprocess.Popen(
        [sys.executable, "-c", _CLAIM_SCRIPT, str(store), job_id, str(result),
         mode],
        cwd=REPO_ROOT,
        env={**os.environ, "HERMES_HOME": str(store)},
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    deadline = time.monotonic() + 10
    while not result.exists() and proc.poll() is None and time.monotonic() < deadline:
        time.sleep(0.02)
    if not result.exists():
        _stdout, stderr = proc.communicate(timeout=2)
        raise AssertionError(f"claim owner did not become ready: {stderr}")
    return proc, json.loads(result.read_text(encoding="utf-8"))


def _release(proc: subprocess.Popen) -> None:
    try:
        proc.communicate(input="\n", timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate(timeout=5)


def test_live_cross_process_owner_is_durably_skipped_without_duplicate_start(
    tmp_path,
):
    with jobs.use_cron_store(tmp_path):
        created = jobs.create_job(
            prompt="owned elsewhere", schedule="every 5m", repeat=1
        )
        proc, owner_claim = _claim_in_process(tmp_path, created["id"], hold=True)
        try:
            assert proc.poll() is None
            execution = executions.create_execution(created["id"], source="builtin")
            due = {**created, "execution_id": execution["id"]}

            with patch.object(scheduler, "run_one_job") as start:
                assert scheduler._process_due_job(due, None, None, False) is True

            start.assert_not_called()
            persisted = executions.get_execution(execution["id"])
            assert persisted["status"] == "skipped"
            assert persisted["started_at"] is None
            assert "active fire owner" in persisted["error"]
            stored = jobs.get_job(created["id"])
            assert stored["fire_claim"]["by"] == owner_claim["by"]
            assert stored["repeat"]["completed"] == 0
        finally:
            _release(proc)


def test_stale_cross_process_owner_without_run_heartbeat_is_reclaimed(
    tmp_path, monkeypatch
):
    with jobs.use_cron_store(tmp_path):
        created = jobs.create_job(prompt="never started", schedule="every 5m")
        proc, stale_claim = _claim_in_process(
            tmp_path, created["id"], hold=True, heartbeat=False
        )
        try:
            assert proc.poll() is None
            claimed_at = datetime.fromisoformat(stale_claim["at"])
            monkeypatch.setattr(
                jobs, "_hermes_now", lambda: claimed_at + timedelta(hours=1)
            )

            outcome = jobs.claim_job_for_fire(
                created["id"], return_outcome=True
            )

            assert outcome.claimed_job is not None
            assert outcome.claimed_job["fire_claim"]["by"] != stale_claim["by"]
        finally:
            _release(proc)


def test_dead_cross_process_owner_is_reclaimed_and_starts_once(tmp_path):
    with jobs.use_cron_store(tmp_path):
        created = jobs.create_job(
            prompt="owner exited", schedule="every 5m", repeat=1
        )
        proc, dead_claim = _claim_in_process(tmp_path, created["id"], hold=False)
        proc.communicate(timeout=5)
        assert proc.returncode == 0
        execution = executions.create_execution(created["id"], source="builtin")
        due = {**created, "execution_id": execution["id"]}
        starts = []

        def record_start(claimed, **_kwargs):
            starts.append(claimed["fire_claim"]["by"])
            assert jobs.claim_dispatch(
                claimed["id"], execution_id=claimed["execution_id"],
                expected_fire_owner=claimed["fire_claim"]["by"],
            )
            assert executions.mark_execution_running(claimed["execution_id"])
            assert executions.finish_execution(claimed["execution_id"], success=True)
            return True

        with patch.object(scheduler, "run_one_job", side_effect=record_start):
            assert scheduler._process_due_job(due, None, None, False) is True

        assert len(starts) == 1
        assert starts[0] != dead_claim["by"]
        assert executions.get_execution(execution["id"])["status"] == "completed"
        assert jobs.get_job(created["id"])["repeat"]["completed"] == 1
