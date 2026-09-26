"""A one-shot that removes its own job record mid-run keeps ownership for delivery.

Fork one-shots are fenced by a dispatch nonce (`run_token` -> `run_claim_is_owned`). Upstream's
`self_removal_delivery_allowed` early-return in `_FireOwnership.lost()` exists so a run that
deleted its own record can still deliver; the nonce check must not run ahead of it, because a
missing record makes `run_claim_is_owned` return False and the fence would treat a legitimate
self-removing run as lost.
"""
from __future__ import annotations

import cron.scheduler as sched


def test_self_removed_run_with_run_token_is_not_lost(monkeypatch):
    monkeypatch.setattr(sched, "self_removal_delivery_allowed", lambda _job_id: True)
    monkeypatch.setattr(sched, "run_claim_is_owned", lambda *_a, **_k: False)  # record is gone
    ownership = sched._FireOwnership({"id": "one-shot", "fire_claim": {"by": "proc-1"}, "run_claim": {"token": "nonce-1"}})
    assert ownership.lost() is False


def test_run_token_mismatch_is_still_lost_when_record_exists(monkeypatch):
    monkeypatch.setattr(sched, "self_removal_delivery_allowed", lambda _job_id: False)
    monkeypatch.setattr(sched, "run_claim_is_owned", lambda *_a, **_k: False)
    ownership = sched._FireOwnership({"id": "one-shot", "fire_claim": {"by": "proc-1"}, "run_claim": {"token": "nonce-1"}})
    assert ownership.lost() is True
