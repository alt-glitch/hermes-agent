"""Execute the workflow's shell step against a bounded GitHub CLI fixture."""

import os
from pathlib import Path
import subprocess

import pytest
import yaml


@pytest.mark.parametrize(
    ("scenario", "success", "rerun"),
    [
        ("completed-success", True, False),
        ("failed-producer-label-success", True, False),
        ("label-after-gate-failure", True, True),
        ("label-before-gate", True, False),
        ("pending", False, False),
        ("watch-timeout", False, False),
        ("run-cancelled", False, False),
        ("run-skipped", False, False),
        ("missing-run", False, False),
        ("list-api-error", False, False),
        ("watch-api-error", False, False),
        ("final-view-api-error", False, False),
        ("jobs-api-error", False, False),
        ("missing-job", False, False),
        ("ambiguous-job", False, False),
        ("job-pending", False, False),
        ("job-cancelled", False, False),
        ("job-skipped", False, False),
        ("rerun-error", False, True),
    ],
)
def test_label_recovery_targets_only_the_review_gate(
    tmp_path, scenario, success, rerun
):
    workflow = yaml.safe_load(
        (Path(__file__).parents[1] / ".github/workflows/label-rerun.yml").read_text()
    )
    script = workflow["jobs"]["rerun-review-labels"]["steps"][0]["run"]
    gh = tmp_path / "gh"
    gh.write_text(
        r'''#!/bin/bash
printf '%s\n' "$*" >> "$CALLS"

bad_args() {
  printf 'unexpected arguments: %s\n' "$*" >&2
  exit 90
}

[[ "$1" == run ]] || bad_args "$@"
case "$2" in
list)
  [[ "$#" -eq 14 && "$3" == --repo && "$4" == "$REPO" && \
    "$5" == --commit && "$6" == "$HEAD_SHA" && \
    "$7" == --workflow && "$8" == ci.yaml && \
    "$9" == --limit && "${10}" == 1 && \
    "${11}" == --json && "${12}" == databaseId,status,conclusion && \
    "${13}" == --jq && \
    "${14}" == '.[0] | select(. != null) | "\(.databaseId) \(.status) \(.conclusion // "unknown")"' \
  ]] || bad_args "$@"
  case "$SCENARIO" in
  list-api-error) exit 40 ;;
  missing-run) exit 0 ;;
  completed-success) printf '123 completed success' ;;
  run-cancelled) printf '123 completed cancelled' ;;
  run-skipped) printf '123 completed skipped' ;;
  label-before-gate|pending|watch-timeout|watch-api-error|final-view-api-error)
    printf '123 in_progress unknown'
    ;;
  *) printf '123 completed failure' ;;
  esac
  ;;
watch)
  [[ "$#" -eq 7 && "$3" == 123 && "$4" == --repo && \
    "$5" == "$REPO" && "$6" == --interval && "$7" == 15 \
  ]] || bad_args "$@"
  [[ "$SCENARIO" != watch-api-error ]] || exit 41
  ;;
view)
  if [[ "$7" == status,conclusion ]]; then
    [[ "$#" -eq 9 && "$3" == 123 && "$4" == --repo && \
      "$5" == "$REPO" && "$6" == --json && \
      "$7" == status,conclusion && "$8" == --jq && \
      "$9" == '"\(.status) \(.conclusion // "unknown")"' \
    ]] || bad_args "$@"
    [[ "$SCENARIO" != final-view-api-error ]] || exit 42
    if [[ "$SCENARIO" == pending ]]; then
      printf 'in_progress unknown'
    else
      printf 'completed failure'
    fi
    exit 0
  fi

  [[ "$#" -eq 9 && "$3" == 123 && "$4" == --repo && \
    "$5" == "$REPO" && "$6" == --json && "$7" == jobs && \
    "$8" == --jq && \
    "$9" == '.jobs[] | select(.name == "Review label gate / Review label gate") | [.databaseId, .status, (.conclusion // "unknown")] | @tsv' \
  ]] || bad_args "$@"
  [[ "$SCENARIO" != jobs-api-error ]] || exit 43
  case "$SCENARIO" in
  missing-job) exit 0 ;;
  ambiguous-job)
    printf '987\tcompleted\tfailure\n988\tcompleted\tfailure\n'
    ;;
  job-pending) printf '987\tin_progress\tunknown\n' ;;
  job-cancelled) printf '987\tcompleted\tcancelled\n' ;;
  job-skipped) printf '987\tcompleted\tskipped\n' ;;
  completed-success|failed-producer-label-success|label-before-gate)
    printf '987\tcompleted\tsuccess\n'
    ;;
  *) printf '987\tcompleted\tfailure\n' ;;
  esac
  ;;
rerun)
  [[ "$#" -eq 7 && "$3" == 123 && "$4" == --repo && \
    "$5" == "$REPO" && "$6" == --job && "$7" == 987 \
  ]] || bad_args "$@"
  [[ "$SCENARIO" != rerun-error ]]
  ;;
*) exit 91 ;;
esac
'''
    )
    gh.chmod(0o755)
    calls = tmp_path / "calls"
    timeout = tmp_path / "timeout"
    timeout.write_text(
        """#!/bin/bash
printf 'timeout %s\\n' "$*" >> "$CALLS"
[[ "$1" == 6000 ]] || exit 92
[[ "$SCENARIO" != watch-timeout ]] || exit 124
shift
exec "$@"
"""
    )
    timeout.chmod(0o755)
    result = subprocess.run(
        ["/bin/bash", "-c", script],
        env={
            "PATH": f"{tmp_path}:{os.defpath}",
            "SCENARIO": scenario,
            "CALLS": str(calls),
            "REPO": "example/fork",
            "HEAD_SHA": "a" * 40,
        },
        text=True,
        capture_output=True,
        timeout=10,
    )
    output = result.stdout + result.stderr
    assert (result.returncode == 0) is success, output

    rerun_calls = [
        call for call in calls.read_text().splitlines() if call.startswith("run rerun ")
    ]
    if rerun:
        assert rerun_calls == ["run rerun 123 --repo example/fork --job 987"]
    else:
        assert rerun_calls == []
    assert "--failed" not in calls.read_text()

    if scenario == "pending":
        assert "recovery pending" in result.stdout
    if scenario == "failed-producer-label-success":
        assert "Review label gate already succeeded" in result.stdout
        assert "CI conclusion: failure" in result.stdout
        assert "Run already succeeded" not in result.stdout
