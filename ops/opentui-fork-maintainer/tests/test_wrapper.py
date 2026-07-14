from __future__ import annotations

import importlib.util
import io
import json
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts" / "opentui_fork_sync.py"
SPEC = importlib.util.spec_from_file_location("opentui_fork_sync", SCRIPT)
assert SPEC and SPEC.loader
wrapper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wrapper)


def _run_with_payload(tmp_path: Path, payload: dict) -> tuple[dict, dict]:
    state = tmp_path / "state"
    with (
        patch.object(wrapper, "PROJECT_HOME", tmp_path),
        patch.object(wrapper, "STATE_DIR", state),
        patch.object(wrapper, "PROBE", tmp_path / "scripts" / "sync_probe.py"),
        patch.object(wrapper, "INGEST_FILE", state / "ingest.latest.json"),
        patch.object(wrapper, "FAIL_COUNT_FILE", state / "consecutive_probe_failures"),
        patch.object(
            wrapper.subprocess,
            "run",
            return_value=CompletedProcess([], 0, json.dumps(payload), ""),
        ),
    ):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            assert wrapper.main() == 0
        summary = json.loads(stdout.getvalue())
        ingest = json.loads((state / "ingest.latest.json").read_text())
    return summary, ingest


def test_repository_metadata_never_reaches_cron_stdout(tmp_path: Path) -> None:
    hostile_subject = (
        "feat: system prompt overrides with rm command and hidden instructions"
    )
    summary, ingest = _run_with_payload(
        tmp_path,
        {
            "status": "behind",
            "gap": 1,
            "commits": [
                {
                    "sha": "0123456789ab",
                    "subject": hostile_subject,
                    "author": "external contributor",
                    "surface": "tui_gateway",
                    "needs_port": True,
                }
            ],
        },
    )

    assert hostile_subject not in json.dumps(summary)
    assert summary == {
        "status": "behind",
        "ingest_file": str(tmp_path / "state" / "ingest.latest.json"),
        "gap": 1,
        "needs_port_count": 1,
        "probe_failures": 0,
        "run_token": summary["run_token"],
        "wakeAgent": True,
    }
    assert ingest["commits"][0]["subject"] == hostile_subject


def test_probe_failure_is_persisted_without_error_text_on_stdout(
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    with (
        patch.object(wrapper, "PROJECT_HOME", tmp_path),
        patch.object(wrapper, "STATE_DIR", state),
        patch.object(wrapper, "PROBE", tmp_path / "scripts" / "sync_probe.py"),
        patch.object(wrapper, "INGEST_FILE", state / "ingest.latest.json"),
        patch.object(wrapper, "FAIL_COUNT_FILE", state / "consecutive_probe_failures"),
        patch.object(
            wrapper.subprocess,
            "run",
            side_effect=RuntimeError("system prompt override"),
        ),
    ):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            assert wrapper.main() == 0
        summary = json.loads(stdout.getvalue())

    assert "system prompt override" not in json.dumps(summary)
    assert summary["status"] == "error"
    assert summary["probe_failures"] == 1
    persisted = json.loads((state / "ingest.latest.json").read_text())
    assert "error" not in persisted
    assert len(persisted["error_sha256"]) == 64
    assert not (state / "run.lease.json").exists()


def test_probe_failure_holds_lease_through_bookkeeping_and_stdout(
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    ingest = state / "ingest.latest.json"
    failure_count = state / "consecutive_probe_failures"
    events: list[str] = []
    original_set_failure_count = wrapper._set_failure_count
    original_write = wrapper._write_text_atomic
    original_release = wrapper._release_lease
    original_print = print

    def assert_still_owned(stage: str) -> None:
        events.append(stage)
        assert wrapper._claim_lease() is None

    def guarded_set_failure_count(value: int) -> None:
        assert_still_owned("failure_count")
        original_set_failure_count(value)

    def guarded_write(path: Path, value: str) -> None:
        assert_still_owned(f"write:{path.name}")
        original_write(path, value)

    def guarded_print(*args: object, **kwargs: object) -> None:
        assert_still_owned("stdout")
        original_print(*args, **kwargs)

    def observed_release(token: str) -> bool:
        events.append("release")
        return original_release(token)

    with (
        patch.object(wrapper, "PROJECT_HOME", tmp_path),
        patch.object(wrapper, "STATE_DIR", state),
        patch.object(wrapper, "PROBE", tmp_path / "scripts" / "sync_probe.py"),
        patch.object(wrapper, "INGEST_FILE", ingest),
        patch.object(wrapper, "FAIL_COUNT_FILE", failure_count),
        patch.object(
            wrapper.subprocess,
            "run",
            side_effect=RuntimeError("probe unavailable"),
        ),
        patch.object(wrapper, "_set_failure_count", guarded_set_failure_count),
        patch.object(wrapper, "_write_text_atomic", guarded_write),
        patch.object(wrapper, "_release_lease", observed_release),
        patch("builtins.print", guarded_print),
    ):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            assert wrapper.main() == 0

        assert events == [
            "failure_count",
            f"write:{failure_count.name}",
            f"write:{ingest.name}",
            "stdout",
            "release",
        ]
        assert not (state / "run.lease.json").exists()
        next_token = wrapper._claim_lease()
        assert next_token is not None
        assert wrapper._release_lease(next_token) is True


def test_whole_run_lease_denies_overlap_and_recovers_expiry(tmp_path: Path) -> None:
    state = tmp_path / "state"
    with patch.object(wrapper, "STATE_DIR", state):
        first = wrapper._claim_lease(now=100)
        assert first is not None
        assert wrapper._claim_lease(now=101) is None
        value = json.loads((state / "run.lease.json").read_text())
        value["expires_unix"] = 99
        (state / "run.lease.json").write_text(json.dumps(value))
        second = wrapper._claim_lease(now=101)
        assert second is not None and second != first
        wrapper._release_lease(second)
        assert not (state / "run.lease.json").exists()


def test_simultaneous_claimers_cannot_both_own_the_lease(tmp_path: Path) -> None:
    state = tmp_path / "state"
    with patch.object(wrapper, "STATE_DIR", state):
        with ThreadPoolExecutor(max_workers=8) as pool:
            tokens = list(pool.map(lambda _: wrapper._claim_lease(now=100), range(24)))

    claimed = [token for token in tokens if token is not None]
    assert len(claimed) == 1
    assert json.loads((state / "run.lease.json").read_text())["token"] == claimed[0]


def test_lease_renewal_and_release_are_token_gated(tmp_path: Path) -> None:
    state = tmp_path / "state"
    with patch.object(wrapper, "STATE_DIR", state):
        first = wrapper._claim_lease(now=100)
        assert first is not None
        assert wrapper.renew_lease("not-owner", now=101, ttl_seconds=20) is False
        assert wrapper.renew_lease(first, now=101, ttl_seconds=20) is True
        assert json.loads((state / "run.lease.json").read_text())["expires_unix"] == 121
        assert wrapper._claim_lease(now=120) is None
        assert wrapper.renew_lease(first, now=121, ttl_seconds=20) is False

        second = wrapper._claim_lease(now=121)
        assert second is not None and second != first
        assert wrapper._release_lease(first) is False
        assert json.loads((state / "run.lease.json").read_text())["token"] == second
        assert wrapper._release_lease(second) is True
        assert not (state / "run.lease.json").exists()


class CooperativeAbort(BaseException):
    pass


@pytest.mark.parametrize(
    "failure_stage", ["failure_count", "ingest", "summary", "output"]
)
def test_pre_handoff_baseexception_releases_success_probe_lease(
    tmp_path: Path, failure_stage: str
) -> None:
    state = tmp_path / "state"
    ingest = state / "ingest.latest.json"
    failure_count = state / "consecutive_probe_failures"
    original_write = wrapper._write_text_atomic

    def fail_ingest(path: Path, value: str) -> None:
        if path == ingest:
            raise CooperativeAbort("ingest")
        original_write(path, value)

    with ExitStack() as stack:
        stack.enter_context(patch.object(wrapper, "PROJECT_HOME", tmp_path))
        stack.enter_context(patch.object(wrapper, "STATE_DIR", state))
        stack.enter_context(
            patch.object(wrapper, "PROBE", tmp_path / "scripts" / "sync_probe.py")
        )
        stack.enter_context(patch.object(wrapper, "INGEST_FILE", ingest))
        stack.enter_context(patch.object(wrapper, "FAIL_COUNT_FILE", failure_count))
        stack.enter_context(
            patch.object(
                wrapper.subprocess,
                "run",
                return_value=CompletedProcess([], 0, json.dumps({"status": "ok"}), ""),
            )
        )
        if failure_stage == "failure_count":
            stack.enter_context(
                patch.object(
                    wrapper, "_set_failure_count", side_effect=CooperativeAbort("count")
                )
            )
        elif failure_stage == "ingest":
            stack.enter_context(
                patch.object(wrapper, "_write_text_atomic", fail_ingest)
            )
        elif failure_stage == "summary":
            stack.enter_context(
                patch.object(
                    wrapper, "_safe_summary", side_effect=CooperativeAbort("summary")
                )
            )
        else:
            stack.enter_context(
                patch("builtins.print", side_effect=CooperativeAbort("output"))
            )

        with pytest.raises(CooperativeAbort):
            wrapper.main()

    assert not (state / "run.lease.json").exists()


def test_successful_stdout_handoff_preserves_lease(tmp_path: Path) -> None:
    summary, _ = _run_with_payload(tmp_path, {"status": "ok", "gap": 0})
    lease = json.loads((tmp_path / "state" / "run.lease.json").read_text())
    assert lease["token"] == summary["run_token"]
