"""In-process tick admission and dispatch; job execution stays in scheduler.py."""

import concurrent.futures
import contextlib


def _advance_gated_dispatches(_sched, pending_dispatches: list) -> None:
    """Advance only admitted occurrences, with receipts for cancellation compensation."""
    with _sched.cron_store_transaction():
        with _sched._running_lock:
            active = {}
            for _, job_id, _, _, cancelled in pending_dispatches:
                key = _sched._inflight_key(job_id)
                pending = _sched._gated_dispatches.get(key)
                if pending is not None and pending.cancelled is cancelled and not cancelled.is_set():
                    active[key] = pending
        if not active:
            return
        receipts = {}
        try:
            _sched.advance_next_runs([key[1] for key in active], write_receipts=receipts)
        except BaseException:
            for pending in active.values():
                pending.cancelled.set()
            raise
        finally:
            # Receipts exist before the write, even if a successful replace then raises.
            for job_id, (original_next, proposed) in receipts.items():
                key = _sched._inflight_key(job_id)
                pending = active.get(key)
                if pending is not None:
                    pending.schedule_advance = (
                        original_next,
                        {
                            field: proposed.get(field)
                            for field in _sched._SCHEDULE_OCCURRENCE_FIELDS
                        },
                    )
            for key, pending in active.items():
                if pending.cancelled.is_set():
                    _sched._restore_cancelled_schedule(key[1], pending)


def tick(verbose=True, adapters=None, loop=None, sync=True, *, can_dispatch=None):
    from hermes_cli.backend_retirement import retirement

    # Hold admission through the entire scan/advance/submit handoff. A predicate alone races
    # prepare after the check but before a due job enters the running-job ledger.
    with retirement.work() as admitted:
        if not admitted:
            return 0
        return _tick_admitted(verbose, adapters, loop, sync, can_dispatch=can_dispatch)


def _tick_admitted(
    verbose: bool = True, adapters=None, loop=None, sync: bool = True, *, can_dispatch=None):
    """Check and run all due jobs. File-locked so only one tick runs at a time (gateway ticker vs
    standalone daemon / manual tick). ``can_dispatch``: optional gate; false leaves due jobs for the
    next allowed tick. Returns the number of jobs executed (0 if another tick holds the lock)."""
    from cron import scheduler as _sched

    # Stale-code yield gate — BEFORE the lock race. A process whose checkout was updated under it
    # serves mixed sys.modules (jobs die on ImportErrors); if a fresher gateway holds the runtime
    # lock, ITS ticker dispatches. With no fresh holder (desktop-standalone) the tick proceeds.
    _skew = _sched._should_yield_tick_to_fresh_gateway()
    if _skew is not None:
        _sched._log_tick_yield_once(f"boot={_skew[0]} disk={_skew[1]}")
        raise _sched.CronTickYielded(_skew[0], _skew[1])

    lock_dir, lock_file = _sched._get_lock_paths()
    _sched._ensure_cron_dir(lock_dir)
    lock_fd = _sched._acquire_tick_lock(lock_file)
    if lock_fd is None:
        return 0

    try:
        # `hermes pause` ESTOP: skip dispatch, never touch in-flight runs; check_paused logs once.
        with contextlib.suppress(ImportError):
            from agent.estop import check_paused as _estop_check_paused
            if _estop_check_paused("cron", _sched.logger):
                return 0

        if can_dispatch is not None and not can_dispatch():
            _sched.logger.debug("Cron dispatch paused while gateway drains existing work")
            return 0

        from cron.bot_chat_delivery import drain, drain_in_background
        if sync:
            drain()
        else:
            drain_in_background()
        _sched._maybe_reap_dead_owners()
        # Periodic worktree GC (6h, threaded) — the only sweep gateway-only boxes get.
        try:
            _sched._maybe_run_worktree_maintenance()
        except Exception as _wt_exc:
            _sched.logger.debug("Worktree maintenance dispatch failed: %s", _wt_exc)

        due_jobs = _sched.get_due_jobs()
        _sched._sweep_stale_inflight_for_tick(due_jobs)

        if not due_jobs:
            # Idle tick: skip config load + pool setup, but still reap crashed jobs' MCP orphans.
            if verbose:
                # Idle tick: skip config load + pool partitioning entirely (#33612 — the gateway ticker
                # calls tick(verbose=False) every 60s, so idle ticks previously fell through to
                # load_config()). Still run the post-tick MCP orphan sweep: main intentionally sweeps on
                # idle ticks so orphaned stdio children from crashed jobs are reaped even when nothing is
                # due.
                _sched.logger.info("%s - No jobs due", _sched._hermes_now().strftime('%H:%M:%S'))
            _sched._sweep_mcp_orphans()
            return 0

        if verbose:
            _sched.logger.info("%s - %s job(s) due", _sched._hermes_now().strftime('%H:%M:%S'), len(due_jobs))

        _max_workers = _sched._resolve_max_parallel_workers()
        if verbose:
            _sched.logger.info(
                "Running %d job(s) in parallel (max_workers=%s)",
                len(due_jobs),
                _max_workers if _max_workers else "unbounded")

        def _process_job(job: dict) -> bool:
            return _sched._process_due_job(job, adapters, loop, verbose)

        # Fork invariant: ledger and register every worker before ONE batched schedule advance, then
        # open their start gates. A failed batch cancels unstarted workers and restores their slots.
        _results: list = []
        _all_futures: list = []
        pool = _sched._get_parallel_pool(_max_workers)
        pending_dispatches = []
        try:
            for job in due_jobs:
                pending = _sched._submit_with_guard(job, pool, _process_job)
                if pending is not None:
                    pending_dispatches.append(pending)
            if pending_dispatches:
                _advance_gated_dispatches(_sched, pending_dispatches)
        except BaseException as advance_err:
            for pending in pending_dispatches:
                pending[4].set()
            dispatched_ids = {pending[1] for pending in pending_dispatches}
            for job in due_jobs:
                claim = job.get("run_claim")
                if job["id"] in dispatched_ids and isinstance(claim, dict) and claim.get("token"):
                    with contextlib.suppress(Exception):
                        _sched.clear_run_claim(job["id"], expected_token=claim["token"])
            # The awakened worker owns release_running_job in its finally; never release here.
            for pending in pending_dispatches:
                pending[3].set()
                _sched._finish_execution_best_effort(
                    pending[2], success=False, error=f"Schedule advance failed: {advance_err}")
            raise
        for fut, _, _, start_gate, _ in pending_dispatches:
            start_gate.set()
            _all_futures.append(fut)
            if not sync:
                _results.append(True)  # optimistically counted

        if sync:
            for f in concurrent.futures.as_completed(_all_futures):
                try:
                    _results.append(f.result())
                except Exception as exc:
                    _sched.logger.error("Cron job future failed: %s", exc)
                    _results.append(False)
            _sched._sweep_mcp_orphans()
            return sum(_results)

        _sched._sweep_mcp_orphans_when_all_done(_all_futures)
        return sum(_results)
    finally:
        _sched._release_tick_lock(lock_fd)
