"""Contracts for per-job cron inactivity watchdog budgets."""

import pytest

from cron.jobs import (
    _oneshot_run_claim_ttl_seconds,
    create_job,
    get_job,
    resolve_cron_inactivity_timeout_seconds,
    update_job,
    use_cron_store,
)
from tools.cronjob_tools import CRONJOB_SCHEMA, _format_job


def test_legacy_jobs_keep_global_default(monkeypatch):
    monkeypatch.delenv("HERMES_CRON_TIMEOUT", raising=False)
    assert resolve_cron_inactivity_timeout_seconds({"id": "legacy"}) == 600.0

    monkeypatch.setenv("HERMES_CRON_TIMEOUT", "1200")
    assert resolve_cron_inactivity_timeout_seconds({"id": "legacy"}) == 1200.0


def test_per_job_budget_overrides_global_and_zero_is_unlimited(monkeypatch):
    monkeypatch.setenv("HERMES_CRON_TIMEOUT", "30")
    assert resolve_cron_inactivity_timeout_seconds(
        {"id": "maintainer", "inactivity_timeout_seconds": 18000}
    ) == 18000.0
    assert resolve_cron_inactivity_timeout_seconds(
        {"id": "unlimited", "inactivity_timeout_seconds": 0}
    ) is None


def test_extremely_large_integer_budget_does_not_overflow(monkeypatch):
    monkeypatch.setenv("HERMES_CRON_TIMEOUT", "30")
    huge = 10**1000
    assert resolve_cron_inactivity_timeout_seconds(
        {"id": "long", "inactivity_timeout_seconds": huge}
    ) == huge


def test_invalid_hand_edited_budget_falls_back_to_global(monkeypatch, caplog):
    monkeypatch.setenv("HERMES_CRON_TIMEOUT", "900")
    assert resolve_cron_inactivity_timeout_seconds(
        {"id": "bad", "inactivity_timeout_seconds": "forever"}
    ) == 900.0
    assert "Invalid inactivity_timeout_seconds" in caplog.text


@pytest.mark.parametrize("bad", [-1, 1.5, True, "", "forever"])
def test_create_rejects_invalid_budget(tmp_path, bad):
    with use_cron_store(tmp_path):
        with pytest.raises(ValueError, match="inactivity_timeout_seconds"):
            create_job(
                prompt="Maintain the fork",
                schedule="every 12h",
                inactivity_timeout_seconds=bad,
            )


def test_create_update_and_inherit_round_trip(tmp_path):
    with use_cron_store(tmp_path):
        job = create_job(
            prompt="Maintain the fork",
            schedule="every 12h",
            inactivity_timeout_seconds="18000",
        )
        assert job["inactivity_timeout_seconds"] == 18000
        assert _format_job(job)["inactivity_timeout_seconds"] == 18000

        updated = update_job(
            job["id"], {"inactivity_timeout_seconds": "inherit"}
        )
        assert "inactivity_timeout_seconds" not in updated
        assert "inactivity_timeout_seconds" not in get_job(job["id"])


def test_oneshot_claim_ttl_tracks_per_job_budget(monkeypatch):
    monkeypatch.setenv("HERMES_CRON_TIMEOUT", "600")
    assert _oneshot_run_claim_ttl_seconds(
        {"inactivity_timeout_seconds": 18000}
    ) == 54000.0
    assert _oneshot_run_claim_ttl_seconds(
        {"inactivity_timeout_seconds": 0}
    ) == 1800.0


def test_model_tool_schema_exposes_budget_and_inherit_reset():
    prop = CRONJOB_SCHEMA["parameters"]["properties"][
        "inactivity_timeout_seconds"
    ]
    assert {"type": "integer", "minimum": 0} in prop["oneOf"]
    assert {"type": "string", "enum": ["inherit"]} in prop["oneOf"]
