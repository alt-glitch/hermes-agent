"""A cancelled, proven-unstarted tick must retain its scheduled occurrence."""

import concurrent.futures
import os
import threading
from pathlib import Path

import pytest


@pytest.fixture
def tick_store(monkeypatch):
    import cron.jobs as jobs
    import cron.scheduler as scheduler

    for name in ("_running_since", "_running_futures", "_running_run_claim_tokens",
                 "_running_fire_owners", "_gated_dispatches"):
        monkeypatch.setattr(scheduler, name, {})
    for name in ("_running_job_ids", "_interrupted_job_ids", "_restart_safe_waiter_job_ids"):
        monkeypatch.setattr(scheduler, name, set())
    for name in ("_maybe_run_worktree_maintenance", "_maybe_reap_dead_owners", "_sweep_mcp_orphans",
                 "_sweep_mcp_orphans_when_all_done"):
        monkeypatch.setattr(scheduler, name, lambda *args: None)
    callbacks = []

    class DeferredPool:
        def submit(self, callback):
            future = concurrent.futures.Future()
            callbacks.append((callback, future))
            return future

    monkeypatch.setattr(scheduler, "_get_parallel_pool", lambda workers: DeferredPool())
    with jobs.use_cron_store(Path(os.environ["HERMES_HOME"])):
        yield jobs, scheduler, callbacks
        scheduler.mark_running_jobs_interrupted("test teardown")
        for callback, future in callbacks:
            if not future.done():
                future.set_result(callback())


@pytest.mark.parametrize("phase", ["before_advance", "inside_advance", "during_advance", "after_advance"])
@pytest.mark.parametrize("schedule", ["every 5m", "*/5 * * * *"])
def test_tick_shutdown_preserves_unstarted_due_occurrence(tick_store, monkeypatch, phase, schedule):
    jobs, scheduler, callbacks = tick_store
    job = jobs.create_job(prompt="Unstarted finite task", schedule=schedule, repeat=1)
    jobs.trigger_job(job["id"])
    before = jobs.get_job(job["id"])
    shutdown = None

    if phase == "before_advance":
        original_submit = scheduler._submit_with_guard

        def submit(*args):
            pending = original_submit(*args)
            assert scheduler.mark_running_jobs_interrupted("shutdown before advance") == [job["id"]]
            return pending

        monkeypatch.setattr(scheduler, "_submit_with_guard", submit)
    elif phase in {"inside_advance", "during_advance"}:
        original_advance = scheduler.advance_next_runs

        def advance(ids, **kwargs):
            nonlocal shutdown
            if phase == "inside_advance":
                assert scheduler.mark_running_jobs_interrupted("shutdown inside advance") == [job["id"]]
                return original_advance(ids, **kwargs)
            result = original_advance(ids, **kwargs)
            pending = scheduler._gated_dispatches[job["id"]]
            shutdown = threading.Thread(target=scheduler.mark_running_jobs_interrupted, args=("shutdown during advance",))
            shutdown.start()
            assert pending.cancelled.wait(timeout=3)
            return result

        monkeypatch.setattr(scheduler, "advance_next_runs", advance)

    try:
        scheduler.tick(verbose=False, sync=False)
        if phase == "after_advance":
            assert jobs.get_job(job["id"])["next_run_at"] != before["next_run_at"]
            assert scheduler.mark_running_jobs_interrupted("shutdown after advance") == [job["id"]]
        if shutdown is not None:
            shutdown.join(timeout=3)
            assert not shutdown.is_alive()
        callback, future = callbacks[0]
        result = callback()
        future.set_result(result)
        assert result is False
        after = jobs.get_job(job["id"])
        assert after["next_run_at"] == before["next_run_at"]
        assert after["repeat"] == before["repeat"]
        assert after["last_run_at"] == before["last_run_at"]
        assert [due["id"] for due in jobs.get_due_jobs()] == [job["id"]]
    finally:
        if shutdown is not None:
            shutdown.join(timeout=3)


@pytest.mark.parametrize("change", ["owner", "reservation", "rearm", "metadata"])
def test_cancelled_schedule_restore_preserves_newer_state(tick_store, change):
    jobs, scheduler, callbacks = tick_store
    job = jobs.create_job(prompt="Finite task with a new owner", schedule="every 5m", repeat=1)
    jobs.trigger_job(job["id"])
    original_next = jobs.get_job(job["id"])["next_run_at"]
    scheduler.tick(verbose=False, sync=False)
    if change in {"owner", "reservation"}:
        claimed = jobs.claim_job_for_fire(job["id"], return_job=True)
        assert claimed
        if change == "reservation":
            assert jobs.claim_dispatch(job["id"], execution_id="new-execution", expected_fire_owner=claimed["fire_claim"]["by"])
    elif change == "rearm":
        jobs.trigger_job(job["id"])
    else:
        jobs.update_job(job["id"], {"name": "Edited name", "prompt": "Edited prompt"})
    before = jobs.get_job(job["id"])
    scheduler.mark_running_jobs_interrupted("shutdown after ownership changed")
    callback, future = callbacks[0]
    result = callback()
    future.set_result(result)
    assert result is False
    if change == "metadata":
        before["next_run_at"] = original_next
    assert jobs.get_job(job["id"]) == before


@pytest.mark.parametrize("failure", ["post_write_read", "persist_then_raise"])
def test_advance_failure_keeps_receipt_for_unstarted_occurrence(tick_store, monkeypatch, failure):
    jobs, scheduler, callbacks = tick_store
    job = jobs.create_job(prompt="Preserve occurrence across I/O failure", schedule="every 5m", repeat=1)
    jobs.trigger_job(job["id"])
    before = jobs.get_job(job["id"])
    original_load = scheduler.load_jobs
    original_advance = scheduler.advance_next_runs
    original_save = jobs.save_jobs

    def fail_read():
        raise OSError("injected post-write read failure")

    def advance(ids, **kwargs):
        result = original_advance(ids, **kwargs)
        monkeypatch.setattr(scheduler, "load_jobs", fail_read)
        return result

    def persist_then_raise(records, **kwargs):
        original_save(records, **kwargs)
        if any(record["id"] == job["id"] and record["next_run_at"] != before["next_run_at"] for record in records):
            raise OSError("injected error after persistence")

    if failure == "post_write_read":
        monkeypatch.setattr(scheduler, "advance_next_runs", advance)
    else:
        monkeypatch.setattr(jobs, "save_jobs", persist_then_raise)
    tick_error = None
    try:
        scheduler.tick(verbose=False, sync=False)
    except OSError as exc:
        tick_error = exc
    finally:
        monkeypatch.setattr(scheduler, "load_jobs", original_load)
        monkeypatch.setattr(jobs, "save_jobs", original_save)
    scheduler.mark_running_jobs_interrupted("shutdown after advance fault")
    callback, future = callbacks[0]
    result = callback()
    future.set_result(result)
    assert result is False
    after = jobs.get_job(job["id"])
    assert after["next_run_at"] == before["next_run_at"]
    assert after["repeat"] == before["repeat"]
    assert bool(tick_error) == (failure == "persist_then_raise")
