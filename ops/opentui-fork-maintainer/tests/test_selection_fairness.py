from __future__ import annotations

import hashlib
import importlib.util
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

import pytest


ROOT = Path(__file__).parents[1]
WRAPPER_SCRIPT = ROOT / "scripts" / "opentui_fork_sync.py"
RUNTIME_SCRIPT = ROOT / "scripts" / "maintainer_runtime.py"
INTAKE_SCRIPT = ROOT / "scripts" / "issue_intake.py"
BASE_SHA = "a" * 40
UPSTREAM_SHA = "b" * 40


def _load_script(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


wrapper = _load_script(WRAPPER_SCRIPT, "fairness_wrapper")
runtime = _load_script(RUNTIME_SCRIPT, "fairness_runtime")
intake = _load_script(INTAKE_SCRIPT, "fairness_intake")


def _issue_request(number: int) -> dict[str, object]:
    identity = {
        "repository": "alt-glitch/hermes-agent",
        "issue": number,
        "issue_url": f"https://github.com/alt-glitch/hermes-agent/issues/{number}",
        "title": f"Approved feature {number}",
        "body": "Implement the bounded approved behavior.",
        "created_at": "2026-09-06T01:00:00Z",
        "last_edited_at": None,
    }
    revision = hashlib.sha256(
        json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return {
        "mode": "issue",
        **identity,
        "revision_sha256": revision,
        "approval": {
            "actor": "alt-glitch",
            "event_id": str(number),
            "created_at": "2026-09-06T02:00:00Z",
            "revision_sha256": revision,
        },
        "existing_prs": [],
    }


def _run_behind_tick(
    root: Path, module, *, offered_issue: int
) -> tuple[dict, dict]:
    state = root / "state"
    state.mkdir(exist_ok=True)
    payload = {
        "status": "behind",
        "branch_sha": BASE_SHA,
        "upstream_sha": UPSTREAM_SHA,
        "gap": 1,
    }
    request = _issue_request(offered_issue)
    workflow_api = {
        "select_approved_issue": lambda _state, now=None, **_kwargs: request,
        "validate_issue_request": intake.validate_issue_request,
        "mark_selected": intake.mark_selected,
    }

    def run(argv, **_kwargs):
        if str(module.PROBE) in argv:
            return CompletedProcess(argv, 0, json.dumps(payload), "")
        assert "intake-issue" in argv
        with patch.object(runtime.runpy, "run_path", return_value=workflow_api):
            result = runtime.intake_issue_request(state, now=100)
        return CompletedProcess(argv, 0, json.dumps(result), "")

    with (
        patch.object(module, "PROJECT_HOME", root),
        patch.object(module, "STATE_DIR", state),
        patch.object(module, "PROBE", root / "scripts" / "sync_probe.py"),
        patch.object(module, "INGEST_FILE", state / "ingest.latest.json"),
        patch.object(
            module, "FAIL_COUNT_FILE", state / "consecutive_probe_failures"
        ),
        patch.object(module, "_current_execution_id", return_value="execution"),
        patch.object(module, "_launch_watchdog"),
        patch.object(module.subprocess, "run", side_effect=run),
    ):
        output = io.StringIO()
        with redirect_stdout(output):
            assert module.main() == 0
    return (
        json.loads(output.getvalue()),
        json.loads((state / "ingest.latest.json").read_text(encoding="utf-8")),
    )


def _complete_tick(root: Path, summary: dict, *, status: str) -> None:
    state = root / "state"
    evidence = Path(summary["evidence_dir"])
    claimed = None
    if (state / "run-request.json").exists():
        claimed = runtime.claim_request(state, evidence)
        assert claimed is not None and claimed["mode"] == "issue"
    if status == "failed":
        runtime.finalize_failure(
            state,
            evidence,
            stage="gate",
            reason_code="gate-failed",
        )
        runtime.release_completed_lease(state, evidence, summary["run_token"])
        return
    assert status == "success"
    if claimed is not None:
        runtime.consume_request(state, evidence)
    runtime._record_run_outcome(
        state,
        evidence,
        {
            "status": "success",
            "stage": "finalized",
            "published": True,
            "upstream_sha": None if claimed is not None else UPSTREAM_SHA,
        },
    )
    with patch.object(wrapper, "STATE_DIR", state):
        assert wrapper._release_lease(summary["run_token"])


@pytest.mark.parametrize("issue_status", ["success", "failed"])
def test_terminal_issue_and_failed_sync_alternate_across_restarted_wrappers(
    tmp_path: Path, issue_status: str,
) -> None:
    first, first_ingest = _run_behind_tick(tmp_path, wrapper, offered_issue=56)
    assert first_ingest["issue_intake"]["issue"] == 56
    _complete_tick(tmp_path, first, status=issue_status)

    restarted = _load_script(WRAPPER_SCRIPT, "fairness_wrapper_restarted_once")
    second, second_ingest = _run_behind_tick(
        tmp_path, restarted, offered_issue=57
    )
    assert "issue_intake" not in second_ingest
    assert not (tmp_path / "state" / "run-request.json").exists()
    _complete_tick(tmp_path, second, status="failed")

    restarted = _load_script(WRAPPER_SCRIPT, "fairness_wrapper_restarted_twice")
    third, third_ingest = _run_behind_tick(tmp_path, restarted, offered_issue=57)
    assert third_ingest["issue_intake"]["issue"] == 57
    assert third["wakeAgent"] is True


@pytest.mark.parametrize(
    "request_name", ["run-request.json", "run-request.inflight.json"]
)
def test_pending_work_precedes_unreadable_fairness_history(
    tmp_path: Path, request_name: str
) -> None:
    state = tmp_path / "state"
    state.mkdir()
    (state / "last-run.json").write_text("not json\n", encoding="utf-8")
    request = _issue_request(58)
    (state / request_name).write_text(json.dumps(request), encoding="utf-8")

    summary, ingest = _run_behind_tick(tmp_path, wrapper, offered_issue=59)

    assert summary["wakeAgent"] is True
    assert ingest["work_selection"] == {
        "lane": "claimed",
        "basis": "pending-request",
    }
    assert "issue_intake" not in ingest
    assert json.loads((state / request_name).read_text(encoding="utf-8")) == request


def test_unreadable_fairness_history_blocks_both_automatic_lanes(
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    state.mkdir()
    (state / "last-run.json").write_text("not json\n", encoding="utf-8")

    summary, ingest = _run_behind_tick(tmp_path, wrapper, offered_issue=59)

    assert summary["status"] == "selection_state_error"
    assert summary["wakeAgent"] is True
    assert ingest["work_selection"] == {
        "lane": "blocked",
        "basis": "unreadable-durable-outcome",
    }
    assert "issue_intake" not in ingest
    assert not (state / "run-request.json").exists()
