"""Real-store regressions for live claims and cancelled dispatch ownership."""

import concurrent.futures
import subprocess
import sys
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from cron import executions, jobs, scheduler
from tools.cronjob_tools import _execute_job_now


@pytest.mark.parametrize("kind", ["once", "interval"])
def test_manual_run_cannot_steal_expired_claim_of_locally_running_job(tmp_path, monkeypatch, kind):
    now = jobs._hermes_now()
    with jobs.use_cron_store(tmp_path):
        schedule = (now + timedelta(minutes=1)).isoformat() if kind == "once" else "every 5m"
        created = jobs.create_job(prompt="live worker", schedule=schedule, repeat=2)
        owned = jobs.claim_job_for_fire(created["id"], return_job=True)
        token = (owned.get("run_claim") or {}).get("token")
        assert scheduler.try_register_running_job(created["id"], run_claim_token=token)
        try:
            monkeypatch.setattr(jobs, "_hermes_now", lambda: now + timedelta(hours=3))
            before = jobs.get_job(created["id"])
            with patch.object(scheduler, "run_one_job") as run:
                result = _execute_job_now(created)
            assert result["claimed"] is False
            run.assert_not_called()
            assert jobs.get_job(created["id"]) == before
            assert jobs.heartbeat_fire_claim(created["id"], expected_owner=owned["fire_claim"]["by"])
            assert jobs.mark_job_run(created["id"], True, expected_fire_owner=owned["fire_claim"]["by"])
        finally:
            scheduler.release_running_job(created["id"])


def test_delayed_dispatch_adoption_preserves_validated_token(tmp_path, monkeypatch):
    now = jobs._hermes_now()
    monkeypatch.setattr(scheduler, "_get_hermes_home", lambda: tmp_path)
    with jobs.use_cron_store(tmp_path):
        created = jobs.create_job(prompt="queued", schedule=(now + timedelta(minutes=1)).isoformat())
        jobs.trigger_job(created["id"])
        dispatched = jobs.get_due_jobs()[0]
        token = dispatched["run_claim"]["token"]
        assert scheduler.try_register_running_job(created["id"], run_claim_token=token)
        try:
            monkeypatch.setattr(jobs, "_hermes_now", lambda: now + timedelta(hours=3))
            adopted = jobs.claim_job_for_fire(
                created["id"], expected_run_claim_token=token, return_job=True)
            assert adopted["run_claim"]["token"] == token
            assert adopted["fire_claim"]["token"] == token
            assert scheduler.mark_running_jobs_interrupted("shutdown during adoption") == [created["id"]]
            assert jobs.get_job(created["id"])["last_error"] == "shutdown during adoption"
        finally:
            scheduler.release_running_job(created["id"])
            scheduler._interrupted_job_ids.discard(created["id"])


def test_stale_sweep_cancels_unstarted_dispatch_and_finishes_its_ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(scheduler, "_get_hermes_home", lambda: tmp_path)
    with jobs.use_cron_store(tmp_path):
        created = jobs.create_job(
            prompt="queued", schedule=(jobs._hermes_now() + timedelta(minutes=1)).isoformat())
        jobs.trigger_job(created["id"])
        dispatched = jobs.get_due_jobs()[0]
        process = Mock()

        class StalledSubmitPool:
            def submit(self, callback):
                scheduler._running_since[created["id"]] -= 10_000
                assert scheduler.sweep_stale_inflight([dispatched]) == [created["id"]]
                future = concurrent.futures.Future()
                future.set_result(callback())
                return future

        pending = scheduler._submit_with_guard(dispatched, StalledSubmitPool(), process)
        assert pending[0].result() is False
        process.assert_not_called()
        stored = jobs.get_job(created["id"])
        assert stored["run_claim"] is None
        assert stored["last_run_at"] is None
        assert stored["repeat"]["completed"] == 0
        assert executions.get_execution(pending[2])["status"] == "failed"
        assert [job["id"] for job in jobs.get_due_jobs()] == [created["id"]]


def test_store_timeout_fails_closed_with_durable_attempt_and_no_one_shot_replay(tmp_path, monkeypatch):
    now = jobs._hermes_now()
    blocked = False
    real_acquire = jobs._acquire_flock
    def acquire(fd, timeout):
        if blocked and str(fd.name).endswith(".jobs.lock"):
            return False
        return real_acquire(fd, timeout)
    def run(_job, **kwargs):
        nonlocal blocked
        blocked = True
        return True, "result", "finished result", None
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(scheduler, "_get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(scheduler, "_launch_external_cron_worker", lambda _job: False)
    monkeypatch.setattr(jobs, "_acquire_flock", acquire)
    with jobs.use_cron_store(tmp_path):
        created = jobs.create_job(prompt="work", schedule=(now + timedelta(minutes=1)).isoformat())
        claimed = jobs.claim_job_for_fire(created["id"], return_job=True)
        with patch.object(scheduler, "run_job", side_effect=run), patch.object(scheduler, "_deliver_result") as deliver:
            assert scheduler.run_one_job(claimed) is False
        deliver.assert_not_called()
        row = executions.get_execution(claimed["execution_id"])
        assert row["status"] == "failed"
        assert "Timed out" in row["error"]
        blocked = False
        stored = jobs.get_job(created["id"])
        assert stored["run_claim"]["token"] == claimed["run_claim"]["token"]
        assert stored["repeat"]["completed"] == 1
        monkeypatch.setattr(jobs, "_hermes_now", lambda: now + timedelta(hours=3))
        assert jobs.get_due_jobs() == []
        assert jobs.get_job(created["id"]) is not None


def test_delivered_recurring_attempt_survives_completion_lock_timeout(tmp_path, monkeypatch):
    now = jobs._hermes_now()
    blocked = False
    real_acquire = jobs._acquire_flock

    def acquire(fd, timeout):
        if blocked and str(fd.name).endswith(".jobs.lock"):
            return False
        return real_acquire(fd, timeout)

    def deliver(*args, **kwargs):
        nonlocal blocked
        blocked = True

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(scheduler, "_get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(scheduler, "_launch_external_cron_worker", lambda _job: False)
    monkeypatch.setattr(jobs, "_acquire_flock", acquire)
    with jobs.use_cron_store(tmp_path):
        created = jobs.create_job(prompt="finite delivery", schedule="every 5m", repeat=1, deliver="local")
        claimed = jobs.claim_job_for_fire(created["id"], return_job=True)
        with patch.object(scheduler, "run_job", return_value=(True, "result", "result", None)), \
                patch.object(scheduler, "_deliver_result", side_effect=deliver) as delivery:
            assert scheduler.run_one_job(claimed) is False
        delivery.assert_called_once()
        row = executions.get_execution(claimed["execution_id"])
        assert row["status"] == "failed"
        assert "Timed out" in row["error"]
        blocked = False
        stored = jobs.get_job(created["id"])
        assert stored["repeat"]["completed"] == 1
        assert stored["dispatch_claim"]["execution_id"] == row["id"]
        assert stored["dispatch_claim"]["settled"] is False
        monkeypatch.setattr(jobs, "_hermes_now", lambda: now + timedelta(hours=3))
        assert jobs.get_due_jobs() == []
        assert jobs.claim_job_for_fire(created["id"]) is False
        assert jobs.get_job(created["id"]) == stored


@pytest.mark.parametrize("owned", [False, True])
def test_finite_recurring_reservation_settles_exactly_once(tmp_path, owned):
    with jobs.use_cron_store(tmp_path):
        created = jobs.create_job(prompt="finite", schedule="every 5m", repeat=2)
        for attempt in range(2):
            claim = jobs.claim_job_for_fire(created["id"], return_job=True) if owned else created
            owner = (claim.get("fire_claim") or {}).get("by")
            execution_id = f"attempt-{attempt}"
            kwargs = {"execution_id": execution_id, "expected_fire_owner": owner}
            assert jobs.claim_dispatch(created["id"], **kwargs)
            assert jobs.claim_dispatch(created["id"], **kwargs)
            assert jobs.get_job(created["id"])["repeat"]["completed"] == attempt + 1
            assert not jobs.mark_job_run(
                created["id"], True, expected_execution_id="wrong", expected_fire_owner=owner)
            assert not jobs.mark_job_run(created["id"], True)
            assert jobs.mark_job_run(
                created["id"], True, expected_execution_id=execution_id, expected_fire_owner=owner)
            assert not jobs.mark_job_run(
                created["id"], True, expected_execution_id=execution_id, expected_fire_owner=owner)
            assert not jobs.claim_dispatch(created["id"], **kwargs)
            assert jobs.get_job(created["id"])["repeat"]["completed"] == attempt + 1
        assert jobs.get_job(created["id"])["state"] == "completed"


def test_crash_after_last_recurring_reservation_does_not_replay(tmp_path, monkeypatch):
    now = jobs._hermes_now()
    with jobs.use_cron_store(tmp_path):
        created = jobs.create_job(prompt="crash", schedule="every 5m", repeat=1)
    worker = subprocess.run(
        [sys.executable, "-c", """
import os, sys
from cron import jobs, executions
with jobs.use_cron_store(sys.argv[1]):
    claim = jobs.claim_job_for_fire(sys.argv[2], return_job=True)
    row = executions.create_execution(sys.argv[2], source="crashing-test-worker")
    assert jobs.claim_dispatch(sys.argv[2], execution_id=row["id"], expected_fire_owner=claim["fire_claim"]["by"])
    os._exit(17)
""", str(tmp_path), created["id"]],
        cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True, timeout=20)
    assert worker.returncode == 17, worker.stderr
    monkeypatch.setattr(jobs, "_hermes_now", lambda: now + timedelta(hours=3))
    with jobs.use_cron_store(tmp_path):
        assert executions.recover_interrupted_executions() == 1
        execution = executions.list_executions(job_id=created["id"])[0]
        assert execution["status"] == "unknown"
        assert jobs.get_due_jobs() == []
        assert not jobs.claim_job_for_fire(created["id"])
        stored = jobs.get_job(created["id"])
        assert stored["last_run_at"] is None
        assert stored["repeat"]["completed"] == 1
        assert stored["dispatch_claim"]["execution_id"] == execution["id"]


@pytest.mark.parametrize("limit", [None, 2])
def test_legacy_direct_mark_retains_repeat_accounting(tmp_path, limit):
    with jobs.use_cron_store(tmp_path):
        created = jobs.create_job(prompt="legacy", schedule="every 5m", repeat=limit)
        assert jobs.claim_dispatch(created["id"])
        assert jobs.mark_job_run(created["id"], True)
        assert jobs.get_job(created["id"])["repeat"]["completed"] == 1
        assert "dispatch_claim" not in jobs.get_job(created["id"])


def test_unsettled_reservation_allows_only_remaining_budget_for_new_owner(tmp_path, monkeypatch):
    now = jobs._hermes_now()
    with jobs.use_cron_store(tmp_path):
        created = jobs.create_job(prompt="finite", schedule="every 5m", repeat=2)
        first = jobs.claim_job_for_fire(created["id"], return_job=True)
        old_owner = first["fire_claim"]["by"]
        assert jobs.claim_dispatch(created["id"], execution_id="first", expected_fire_owner=old_owner)
        monkeypatch.setattr(jobs, "_hermes_now", lambda: now + timedelta(hours=3))
        second = jobs.claim_job_for_fire(created["id"], return_job=True)
        new_owner = second["fire_claim"]["by"]
        assert new_owner != old_owner
        assert jobs.claim_dispatch(created["id"], execution_id="second", expected_fire_owner=new_owner)
        assert not jobs.mark_job_run(created["id"], True, expected_execution_id="first", expected_fire_owner=old_owner)
        assert jobs.mark_job_run(created["id"], True, expected_execution_id="second", expected_fire_owner=new_owner)
        assert jobs.get_job(created["id"])["repeat"]["completed"] == 2
        assert jobs.get_job(created["id"])["state"] == "completed"


@pytest.mark.parametrize("external", [False, True])
def test_finite_recurring_run_body_preserves_budget_for_manual_and_external_paths(tmp_path, monkeypatch, external):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(scheduler, "_get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(scheduler, "_launch_external_cron_worker", lambda _job: False)
    with jobs.use_cron_store(tmp_path):
        created = jobs.create_job(prompt="finite worker", schedule="every 5m", repeat=2)
        with patch.object(scheduler, "run_job", return_value=(True, "result", "result", None)) as run:
            for count in range(1, 3):
                if external:
                    claimed = jobs.claim_job_for_fire(created["id"], return_job=True)
                    row = executions.create_execution(created["id"], source="external-test")
                    claimed["execution_id"] = row["id"]
                    assert executions.mark_execution_running(row["id"]) is not None
                    monkeypatch.setenv("_HERMES_CRON_EXTERNAL_WORKER", row["id"])
                    assert scheduler.run_one_job(claimed)
                else:
                    result = _execute_job_now(jobs.get_job(created["id"]))
                    assert result["claimed"] is True
                stored = jobs.get_job(created["id"])
                assert stored["repeat"]["completed"] == count
                assert stored["dispatch_claim"]["settled"] is True
            assert run.call_count == 2
            assert stored["state"] == "completed"


def test_cancelled_recurring_dispatch_spends_no_slot(tmp_path, monkeypatch):
    callbacks = []

    class DeferredPool:
        def submit(self, callback):
            callbacks.append(callback)
            return concurrent.futures.Future()

    monkeypatch.setattr(scheduler, "_get_hermes_home", lambda: tmp_path)
    with jobs.use_cron_store(tmp_path):
        created = jobs.create_job(prompt="queued recurring", schedule="every 5m", repeat=1)
        jobs.trigger_job(created["id"])
        due = jobs.get_due_jobs()[0]
        process = Mock()
        pending = scheduler._submit_with_guard(due, DeferredPool(), process)
        try:
            assert scheduler.mark_running_jobs_interrupted("before start") == [created["id"]]
            pending[3].set()
            assert callbacks.pop()() is False
            process.assert_not_called()
            stored = jobs.get_job(created["id"])
            assert stored["repeat"]["completed"] == 0
            assert stored["last_run_at"] is None
            assert "dispatch_claim" not in stored
            assert jobs.claim_job_for_fire(created["id"])
        finally:
            scheduler.release_running_job(created["id"])
