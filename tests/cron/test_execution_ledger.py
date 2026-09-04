"""Durable cron execution-ledger behavior."""

from __future__ import annotations

import json
from datetime import timedelta
import os
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path


def _point_ledger(monkeypatch, tmp_path):
    import cron.executions as executions

    monkeypatch.setattr(executions, "EXECUTIONS_FILE", tmp_path / "cron" / "executions.db")
    return executions


def test_execution_ledger_follows_context_local_cron_store(tmp_path):
    import cron.executions as executions
    import cron.jobs as jobs

    profile_a = tmp_path / "profile-a"
    profile_b = tmp_path / "profile-b"
    with jobs.use_cron_store(profile_a):
        first = executions.create_execution("job-a", source="builtin")
        assert [row["id"] for row in executions.list_executions()] == [first["id"]]
    with jobs.use_cron_store(profile_b):
        second = executions.create_execution("job-b", source="builtin")
        assert [row["id"] for row in executions.list_executions()] == [second["id"]]

    assert (profile_a / "cron" / "executions.db").is_file()
    assert (profile_b / "cron" / "executions.db").is_file()
    with jobs.use_cron_store(profile_a):
        assert executions.latest_execution("job-b") is None
    with jobs.use_cron_store(profile_b):
        assert executions.latest_execution("job-a") is None


def test_execution_transitions_are_durable(monkeypatch, tmp_path):
    executions = _point_ledger(monkeypatch, tmp_path)

    claimed = executions.create_execution("job-1", source="builtin")
    assert claimed["status"] == "claimed"
    assert claimed["claimed_at"]
    assert claimed["started_at"] is None
    assert claimed["finished_at"] is None

    running = executions.mark_execution_running(claimed["id"])
    assert running["status"] == "running"
    assert running["started_at"]

    completed = executions.finish_execution(claimed["id"], success=True)
    assert completed["status"] == "completed"
    assert completed["finished_at"]
    assert completed["error"] is None

    persisted = executions.list_executions(job_id="job-1")
    assert persisted == [completed]


def test_execution_ledger_follows_the_current_profile_home(monkeypatch, tmp_path):
    import cron.executions as executions

    current_home = {"path": tmp_path / "default"}
    monkeypatch.setattr(executions, "EXECUTIONS_FILE", None)
    monkeypatch.setattr(executions, "get_hermes_home", lambda: current_home["path"])

    default_row = executions.create_execution("default-job", source="builtin")
    current_home["path"] = tmp_path / "worker"
    worker_row = executions.create_execution("worker-job", source="builtin")

    assert executions.list_executions() == [worker_row]
    current_home["path"] = tmp_path / "default"
    assert executions.list_executions() == [default_row]
    assert (tmp_path / "default" / "cron" / "executions.db").is_file()
    assert (tmp_path / "worker" / "cron" / "executions.db").is_file()


def test_terminal_execution_cannot_be_rewritten(monkeypatch, tmp_path):
    executions = _point_ledger(monkeypatch, tmp_path)
    record = executions.create_execution("immutable", source="builtin")
    executions.mark_execution_running(record["id"])
    executions.finish_execution(record["id"], success=True)

    assert executions.finish_execution(
        record["id"], success=False, error="late writer"
    ) is None
    assert executions.latest_execution("immutable")["status"] == "completed"


def test_retention_bounds_terminal_history_but_preserves_inflight(monkeypatch, tmp_path):
    executions = _point_ledger(monkeypatch, tmp_path)
    monkeypatch.setattr(executions, "MAX_TERMINAL_EXECUTIONS", 3)
    inflight = executions.create_execution("live", source="builtin")
    executions.mark_execution_running(inflight["id"])
    for index in range(8):
        row = executions.create_execution(f"done-{index}", source="builtin")
        executions.finish_execution(row["id"], success=True)

    records = executions.list_executions(limit=100)
    assert len([row for row in records if row["status"] == "completed"]) == 3
    assert executions.latest_execution("live")["status"] == "running"


def test_corrupt_store_fails_closed_without_overwrite(monkeypatch, tmp_path):
    executions = _point_ledger(monkeypatch, tmp_path)
    executions.EXECUTIONS_FILE.parent.mkdir(parents=True)
    executions.EXECUTIONS_FILE.write_bytes(b"not a sqlite database")

    with __import__("pytest").raises(sqlite3.DatabaseError):
        executions.create_execution("new", source="builtin")
    assert executions.EXECUTIONS_FILE.read_bytes() == b"not a sqlite database"


def test_cron_runs_cli_prints_execution_history(monkeypatch, tmp_path, capsys):
    executions = _point_ledger(monkeypatch, tmp_path)
    row = executions.create_execution("cli-job", source="builtin")
    executions.finish_execution(row["id"], success=False, error="boom")
    from hermes_cli.cron import cron_runs

    cron_runs("cli-job", limit=10)

    output = capsys.readouterr().out
    assert row["id"] in output
    assert "failed" in output
    assert "boom" in output


def test_quick_backup_includes_execution_ledger():
    from hermes_cli.backup import _QUICK_STATE_FILES

    assert "cron/executions.db" in _QUICK_STATE_FILES


def test_failed_execution_keeps_error(monkeypatch, tmp_path):
    executions = _point_ledger(monkeypatch, tmp_path)

    record = executions.create_execution("job-2", source="external")
    failed = executions.finish_execution(record["id"], success=False, error="provider exploded")

    assert failed["status"] == "failed"
    assert failed["error"] == "provider exploded"


def test_recovery_does_not_mark_live_process_execution_unknown(monkeypatch, tmp_path):
    executions = _point_ledger(monkeypatch, tmp_path)
    record = executions.create_execution("still-live", source="builtin")
    executions.mark_execution_running(record["id"])

    assert executions.recover_interrupted_executions() == 0
    assert executions.latest_execution("still-live")["status"] == "running"


def test_restart_marks_interrupted_execution_unknown_without_requeue(tmp_path):
    """Real temp-HERMES_HOME subprocess restart: in-flight is audit-only unknown."""
    home = tmp_path / "home"
    repo = Path(__file__).resolve().parents[2]
    env = os.environ.copy()
    env["HERMES_HOME"] = str(home)
    env["PYTHONPATH"] = str(repo)

    create = subprocess.run(
        [
            sys.executable,
            "-c",
            "from cron.executions import create_execution, mark_execution_running; "
            "r=create_execution('restart-job', source='builtin'); "
            "mark_execution_running(r['id']); print(r['id'])",
        ],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )
    execution_id = create.stdout.strip()

    recover = subprocess.run(
        [
            sys.executable,
            "-c",
            "import json; from cron.executions import recover_interrupted_executions, list_executions; "
            "print(recover_interrupted_executions()); "
            "print(json.dumps(list_executions(job_id='restart-job'))) ",
        ],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )
    lines = recover.stdout.strip().splitlines()
    assert lines[0] == "1"
    records = json.loads(lines[1])
    assert len(records) == 1
    assert records[0]["id"] == execution_id
    assert records[0]["status"] == "unknown"
    assert records[0]["finished_at"]
    assert "restart" in records[0]["error"].lower()
    # Recovery only classifies the old attempt. It must not manufacture a new
    # claimed record (which would imply an automatic retry).
    assert [r["status"] for r in records] == ["unknown"]


def test_generic_submit_failure_keeps_recurring_job_due(monkeypatch, tmp_path):
    import cron.jobs as jobs
    import cron.scheduler as scheduler

    class BrokenPool:
        def submit(self, _callable):
            raise ValueError("executor rejected")

    cron_dir = tmp_path / "cron"
    monkeypatch.setattr(jobs, "CRON_DIR", cron_dir)
    monkeypatch.setattr(jobs, "JOBS_FILE", cron_dir / "jobs.json")
    monkeypatch.setattr(jobs, "OUTPUT_DIR", cron_dir / "output")
    job = jobs.create_job(prompt="submit retry", schedule="every 1h")
    stored = jobs.load_jobs()
    due_at = (jobs._hermes_now() - timedelta(minutes=1)).isoformat()
    stored[0]["next_run_at"] = due_at
    jobs.save_jobs(stored)

    finished = []
    monkeypatch.setattr(scheduler, "_running_job_ids", set())
    monkeypatch.setattr(scheduler, "_running_run_claim_tokens", {})
    monkeypatch.setattr(scheduler, "_get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(
        scheduler, "create_execution",
        lambda *_args, **_kwargs: {"id": "exec-submit-fail"},
    )
    monkeypatch.setattr(
        scheduler, "finish_execution",
        lambda execution_id, **kwargs: finished.append((execution_id, kwargs)),
    )
    monkeypatch.setattr(scheduler, "_get_parallel_pool", lambda _workers: BrokenPool())

    assert scheduler.tick(verbose=False, sync=False) == 0
    assert jobs.get_job(job["id"])["next_run_at"] == due_at
    assert [item["id"] for item in jobs.get_due_jobs()] == [job["id"]]
    assert finished == [
        (
            "exec-submit-fail",
            {
                "success": False,
                "error": "Executor dispatch failed: executor rejected",
                "delivery_outcome": None,
            },
        )
    ]
    assert job["id"] not in scheduler.get_running_job_ids()


def test_ledger_creation_failure_keeps_recurring_job_due_for_retry(monkeypatch, tmp_path):
    import cron.jobs as jobs
    import cron.scheduler as scheduler

    cron_dir = tmp_path / "cron"
    monkeypatch.setattr(jobs, "CRON_DIR", cron_dir)
    monkeypatch.setattr(jobs, "JOBS_FILE", cron_dir / "jobs.json")
    monkeypatch.setattr(jobs, "OUTPUT_DIR", cron_dir / "output")

    job = jobs.create_job(prompt="ledger retry", schedule="every 1h")
    stored = jobs.load_jobs()
    due_at = (jobs._hermes_now() - timedelta(minutes=1)).isoformat()
    stored[0]["next_run_at"] = due_at
    jobs.save_jobs(stored)
    assert [item["id"] for item in jobs.get_due_jobs()] == [job["id"]]

    attempts = []

    def fail_ledger_creation(job_id, *, source):
        attempts.append((job_id, source))
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(scheduler, "_running_job_ids", set())
    monkeypatch.setattr(scheduler, "_running_run_claim_tokens", {})
    monkeypatch.setattr(scheduler, "_get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(scheduler, "create_execution", fail_ledger_creation)

    for expected_attempts in (1, 2):
        # Ledger initialization is observability, not the execution control
        # plane: a locked DB leaves the occurrence due and releases the guard
        # without crashing the long-lived ticker.
        assert scheduler.tick(verbose=False, sync=False) == 0
        assert scheduler.get_running_job_ids() == frozenset()
        assert scheduler._running_run_claim_tokens == {}
        assert jobs.get_job(job["id"])["next_run_at"] == due_at
        assert [item["id"] for item in jobs.get_due_jobs()] == [job["id"]]
        assert len(attempts) == expected_attempts

    assert attempts == [
        (job["id"], "builtin"),
        (job["id"], "builtin"),
    ]


def test_schedule_advance_failure_finishes_attempt_and_releases_guard(monkeypatch):
    import cron.scheduler as scheduler

    finished = []
    monkeypatch.setattr(
        scheduler,
        "create_execution",
        lambda *_args, **_kwargs: {"id": "exec-advance-fail"},
    )
    monkeypatch.setattr(
        scheduler,
        "finish_execution",
        lambda execution_id, **kwargs: finished.append((execution_id, kwargs)),
    )
    monkeypatch.setattr(scheduler, "get_due_jobs", lambda: [{"id": "advance-fail"}])
    monkeypatch.setattr(
        scheduler,
        "claim_job_for_fire",
        lambda _job_id, **_kwargs: (_ for _ in ()).throw(
            OSError("jobs store unavailable")
        ),
    )

    assert scheduler.tick(verbose=False, sync=True) == 0

    assert finished == [
        (
            "exec-advance-fail",
            {
                "success": False,
                "error": "Fire claim failed: jobs store unavailable",
                "delivery_outcome": None,
            },
        )
    ]
    assert "advance-fail" not in scheduler.get_running_job_ids()


def test_run_one_job_records_running_then_terminal(monkeypatch):
    import cron.scheduler as scheduler

    events = []
    run_execution_ids = []
    monkeypatch.setattr(
        scheduler,
        "mark_execution_running",
        lambda execution_id: events.append(("running", execution_id)),
        raising=False,
    )
    monkeypatch.setattr(
        scheduler,
        "finish_execution",
        lambda execution_id, **kwargs: events.append(("finish", execution_id, kwargs)),
        raising=False,
    )
    monkeypatch.setattr(scheduler, "claim_dispatch", lambda _job_id: True)

    def fake_run_job(job, *, defer_agent_teardown=None, execution_id=None, **_kw):
        run_execution_ids.append(execution_id)
        return True, "output", "response", None

    monkeypatch.setattr(scheduler, "run_job", fake_run_job)
    monkeypatch.setattr(scheduler, "save_job_output", lambda *_args: None)
    monkeypatch.setattr(scheduler, "_deliver_result", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(scheduler, "mark_job_run", lambda *_args, **_kwargs: None)

    assert scheduler.run_one_job({"id": "job-3", "execution_id": "exec-3"}) is True
    assert run_execution_ids == ["exec-3"]
    assert events[0] == ("running", "exec-3")
    assert events[-1][0:2] == ("finish", "exec-3")
    assert events[-1][2]["success"] is True


def test_run_one_job_ledger_finish_failure_does_not_rewrite_success(monkeypatch):
    import cron.scheduler as scheduler

    marks = []
    finish_attempts = []

    monkeypatch.setattr(scheduler, "claim_dispatch", lambda _job_id: True)
    monkeypatch.setattr(
        scheduler,
        "run_job",
        lambda job, *, defer_agent_teardown=None, **_kwargs: (
            True, "output", "response", None
        ),
    )
    monkeypatch.setattr(scheduler, "save_job_output", lambda *_args: None)
    monkeypatch.setattr(scheduler, "_deliver_result", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        scheduler,
        "mark_job_run",
        lambda _job_id, success, error=None, **_kwargs: marks.append((success, error)) or True,
    )

    def fail_finish(_execution_id, *, success, error=None, delivery_outcome=None):
        finish_attempts.append((success, error, delivery_outcome))
        raise sqlite3.OperationalError("ledger unavailable")

    monkeypatch.setattr(scheduler, "finish_execution", fail_finish)

    assert scheduler.run_one_job({"id": "job-ledger-finish", "execution_id": "exec-ledger-finish"}) is True
    assert marks == [(True, None)]
    assert finish_attempts == [(True, None, "suppressed")]


def test_job_store_double_failure_still_finalizes_execution(monkeypatch):
    import cron.scheduler as scheduler

    mark_attempts = []
    finish_attempts = []
    monkeypatch.setattr(scheduler, "claim_dispatch", lambda _job_id: True)
    monkeypatch.setattr(
        scheduler,
        "run_job",
        lambda job, *, defer_agent_teardown=None, **_kwargs: (
            True, "output", "response", None
        ),
    )
    monkeypatch.setattr(scheduler, "save_job_output", lambda *_args: None)
    monkeypatch.setattr(scheduler, "_deliver_result", lambda *_args, **_kwargs: None)

    def fail_mark(_job_id, success, error=None, **_kwargs):
        mark_attempts.append((success, error))
        raise OSError("jobs store unavailable")

    monkeypatch.setattr(scheduler, "mark_job_run", fail_mark)
    monkeypatch.setattr(
        scheduler,
        "finish_execution",
        lambda execution_id, **kwargs: finish_attempts.append((execution_id, kwargs)),
    )

    assert scheduler.run_one_job(
        {"id": "job-store-fail", "execution_id": "exec-store-fail"}
    ) is False
    assert mark_attempts == [
        (True, None),
        (False, "jobs store unavailable"),
    ]
    assert finish_attempts == [
        (
            "exec-store-fail",
            {
                "success": False,
                "error": "jobs store unavailable",
                "delivery_outcome": "suppressed",
            },
        )
    ]


def test_run_claim_validation_failure_suppresses_delivery_and_finalizes_execution(
    monkeypatch,
):
    import cron.scheduler as scheduler

    finish_attempts = []
    delivery_attempts = []
    monkeypatch.setattr(scheduler, "claim_dispatch", lambda _job_id: True)
    monkeypatch.setattr(
        scheduler,
        "mark_execution_running",
        lambda _execution_id: None,
    )
    monkeypatch.setattr(
        scheduler,
        "run_job",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OSError("jobs store unavailable")
        ),
    )
    monkeypatch.setattr(
        scheduler,
        "run_claim_is_owned",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("jobs store unavailable")
        ),
    )
    monkeypatch.setattr(
        scheduler,
        "mark_job_run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OSError("jobs store unavailable")
        ),
    )
    monkeypatch.setattr(
        scheduler,
        "_deliver_result",
        lambda *_args, **_kwargs: delivery_attempts.append(True),
    )
    monkeypatch.setattr(
        scheduler,
        "finish_execution",
        lambda execution_id, **kwargs: finish_attempts.append(
            (execution_id, kwargs)
        ),
    )

    job = {
        "id": "token-store-fail",
        "execution_id": "exec-token-store-fail",
        "schedule": {"kind": "once", "at": "2026-08-15T00:00:00Z"},
        "run_claim": {"token": "claim-token"},
    }
    assert scheduler.run_one_job(job) is False
    assert delivery_attempts == []
    assert finish_attempts == [
        (
            "exec-token-store-fail",
            {
                "success": False,
                "error": "jobs store unavailable",
                "delivery_outcome": "suppressed",
            },
        )
    ]


def test_late_shutdown_interruption_finalizes_execution_failed(monkeypatch):
    import cron.scheduler as scheduler

    delivery_entered = threading.Event()
    release_delivery = threading.Event()
    marks = []
    finishes = []
    results = []
    job_id = "late-interrupt"

    monkeypatch.setattr(scheduler, "_running_job_ids", {job_id})
    monkeypatch.setattr(scheduler, "_running_run_claim_tokens", {})
    monkeypatch.setattr(scheduler, "_interrupted_job_ids", set())
    monkeypatch.setattr(scheduler, "claim_dispatch", lambda _job_id: True)
    monkeypatch.setattr(scheduler, "mark_execution_running", lambda _execution_id: None)
    monkeypatch.setattr(
        scheduler,
        "run_job",
        lambda job, *, defer_agent_teardown=None, **_kwargs: (
            True, "output", "response", None
        ),
    )
    monkeypatch.setattr(scheduler, "save_job_output", lambda *_args: None)

    def block_delivery(*_args, **_kwargs):
        delivery_entered.set()
        assert release_delivery.wait(timeout=5)
        return None

    monkeypatch.setattr(scheduler, "_deliver_result", block_delivery)
    monkeypatch.setattr(
        scheduler,
        "mark_job_run",
        lambda jid, success, error=None, **_kwargs: marks.append((jid, success, error)) or True,
    )
    monkeypatch.setattr(
        scheduler,
        "finish_execution",
        lambda execution_id, **kwargs: finishes.append((execution_id, kwargs)),
    )

    worker = threading.Thread(
        target=lambda: results.append(
            scheduler.run_one_job({"id": job_id, "execution_id": "exec-interrupt"})
        )
    )
    worker.start()
    assert delivery_entered.wait(timeout=5)
    assert scheduler.mark_running_jobs_interrupted("gateway shutdown") == [job_id]
    release_delivery.set()
    worker.join(timeout=5)
    assert not worker.is_alive()

    assert results == [True]
    # There is no durable owner in this synthetic direct-run setup. Upstream's
    # interruption fence deliberately avoids an unfenced jobs.json rewrite;
    # the exact in-memory execution token still forces the ledger terminal.
    assert marks == []
    assert finishes == [
        (
            "exec-interrupt",
            {
                "success": False,
                "error": "Interrupted by gateway shutdown before terminal completion.",
                "delivery_outcome": None,
            },
        )
    ]
    assert scheduler._interrupted_job_ids == set()


def test_provider_start_recovers_interrupted_records_before_tick(monkeypatch):
    import cron.scheduler_provider as provider

    events = []
    stop = __import__("threading").Event()
    stop.set()
    monkeypatch.setattr(
        "cron.executions.recover_interrupted_executions",
        lambda: events.append("recover") or 0,
        raising=False,
    )
    monkeypatch.setattr("cron.jobs.record_ticker_heartbeat", lambda **_kwargs: events.append("heartbeat"))

    provider.InProcessCronScheduler().start(stop, interval=1)

    assert events[:2] == ["recover", "heartbeat"]


def test_external_provider_start_recovers_interrupted_records(monkeypatch):
    from plugins.cron_providers.chronos import ChronosCronScheduler

    provider = ChronosCronScheduler()
    provider._client = type("Client", (), {"arm": lambda self, **kwargs: None})()
    events = []
    monkeypatch.setattr(
        "cron.executions.recover_interrupted_executions",
        lambda: events.append("recover") or 0,
    )
    monkeypatch.setattr(provider, "reconcile", lambda: events.append("reconcile"))

    provider.start(__import__("threading").Event())

    assert events == ["recover", "reconcile"]


class _TrackingConnection:
    """Delegates to a real sqlite3.Connection while recording close() calls.

    sqlite3.Connection is a static C type: it has no per-instance __dict__
    and its class methods can't be monkeypatched, so open/close tracking is
    done via a delegating wrapper returned in place of the real connection.
    """

    def __init__(self, real, closed_ids):
        object.__setattr__(self, "_real", real)
        object.__setattr__(self, "_closed_ids", closed_ids)

    def close(self):
        self._closed_ids.append(id(self._real))
        self._real.close()

    def __enter__(self):
        self._real.__enter__()
        return self

    def __exit__(self, exc_type, exc, tb):
        return self._real.__exit__(exc_type, exc, tb)

    def __getattr__(self, name):
        return getattr(self._real, name)

    def __setattr__(self, name, value):
        setattr(self._real, name, value)


def _count_open_connections(executions, monkeypatch):
    """Wrap sqlite3.connect to track open/close balance for the ledger module."""
    opened_ids = []
    closed_ids = []
    real_connect = sqlite3.connect

    def tracking_connect(*args, **kwargs):
        conn = real_connect(*args, **kwargs)
        opened_ids.append(id(conn))
        return _TrackingConnection(conn, closed_ids)

    monkeypatch.setattr(executions.sqlite3, "connect", tracking_connect)
    return opened_ids, closed_ids


def test_ledger_operations_close_every_connection(monkeypatch, tmp_path):
    """Regression for #69567: every ledger call must close its connection
    deterministically instead of relying on garbage collection."""
    executions = _point_ledger(monkeypatch, tmp_path)
    opened, closed = _count_open_connections(executions, monkeypatch)

    record = executions.create_execution("leak-check", source="builtin")
    executions.mark_execution_running(record["id"])
    executions.finish_execution(record["id"], success=True)
    executions.list_executions(job_id="leak-check")
    executions.latest_executions(["leak-check"])
    executions.recover_interrupted_executions()

    assert len(opened) == 6
    assert len(closed) == 6
    assert set(opened) == set(closed)


def test_early_return_still_closes_connection(monkeypatch, tmp_path):
    """mark_execution_running returns None mid-block on a bad transition;
    the connection must still be closed rather than leaked."""
    executions = _point_ledger(monkeypatch, tmp_path)
    opened, closed = _count_open_connections(executions, monkeypatch)

    assert executions.mark_execution_running("does-not-exist") is None

    assert len(opened) == 1
    assert len(closed) == 1


def test_exception_during_operation_still_closes_connection(monkeypatch, tmp_path):
    """A failing statement inside the transaction must roll back and close,
    not leak the connection."""
    executions = _point_ledger(monkeypatch, tmp_path)
    opened, closed = _count_open_connections(executions, monkeypatch)

    with __import__("pytest").raises(sqlite3.IntegrityError):
        with executions._transaction() as conn:
            conn.execute(
                "INSERT INTO executions (id, job_id, source, process_id, pid, "
                "status, claimed_at) VALUES ('x', 'x', 'x', 'x', 1, 'bogus-status', 'now')"
            )

    assert len(opened) == 1
    assert len(closed) == 1


def test_schema_init_failure_still_closes_connection(monkeypatch, tmp_path):
    """If PRAGMA/DDL setup in _connect() fails after sqlite3.connect()
    succeeds, the partially-initialized connection must still be closed."""
    executions = _point_ledger(monkeypatch, tmp_path)
    opened_ids = []
    closed_ids = []
    real_connect = sqlite3.connect

    class _FailingSchemaConnection(_TrackingConnection):
        def execute(self, sql, *args, **kwargs):
            if "CREATE TABLE" in sql:
                raise sqlite3.OperationalError("simulated schema init failure")
            return self._real.execute(sql, *args, **kwargs)

    def tracking_connect(*args, **kwargs):
        conn = real_connect(*args, **kwargs)
        opened_ids.append(id(conn))
        return _FailingSchemaConnection(conn, closed_ids)

    monkeypatch.setattr(executions.sqlite3, "connect", tracking_connect)

    with __import__("pytest").raises(sqlite3.OperationalError):
        executions.create_execution("init-fail", source="builtin")

    assert len(opened_ids) == 1
    assert len(closed_ids) == 1


def test_job_listing_exposes_latest_execution(monkeypatch, tmp_path):
    import cron.jobs as jobs

    monkeypatch.setattr(jobs, "CRON_DIR", tmp_path / "cron")
    monkeypatch.setattr(jobs, "JOBS_FILE", tmp_path / "cron" / "jobs.json")
    monkeypatch.setattr(jobs, "OUTPUT_DIR", tmp_path / "cron" / "output")
    executions = _point_ledger(monkeypatch, tmp_path)

    job = jobs.create_job(prompt="audit me", schedule="every 1h", name="audit")
    record = executions.create_execution(job["id"], source="builtin")
    executions.mark_execution_running(record["id"])

    listed = jobs.list_jobs(include_disabled=True)
    assert listed[0]["latest_execution"]["id"] == record["id"]
    assert listed[0]["latest_execution"]["status"] == "running"
