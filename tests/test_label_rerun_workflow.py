"""Execute the workflow's shell step against a bounded GitHub CLI fixture."""
import os
from pathlib import Path
import subprocess

import pytest
import yaml


@pytest.mark.parametrize("scenario,success,rerun", [
    ("complete", True, True),
    ("wait-complete", True, True),
    ("pending", False, False),
    ("missing", False, False),
    ("api-error", False, False),
    ("rerun-error", False, True),
])
def test_label_recovery_never_reports_pending_or_api_errors_as_success(tmp_path, scenario, success, rerun):
    workflow = yaml.safe_load((Path(__file__).parents[1] / ".github/workflows/label-rerun.yml").read_text())
    script = workflow["jobs"]["rerun-review-labels"]["steps"][0]["run"]
    gh = tmp_path / "gh"
    gh.write_text("""#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
case "$2" in
list)
  case "$SCENARIO" in
  api-error) exit 1;;
  missing) exit 0;;
  complete|rerun-error) printf '123 completed';;
  *) printf '123 in_progress';;
  esac;;
watch) exit 1;;
view)
  if [ "$SCENARIO" = wait-complete ]; then printf completed; else printf in_progress; fi;;
rerun) [ "$SCENARIO" != rerun-error ];;
*) exit 2;;
esac
""")
    gh.chmod(0o755)
    calls = tmp_path / "calls"
    result = subprocess.run(["/bin/bash", "-c", script], env={
        "PATH": f"{tmp_path}:{os.defpath}", "SCENARIO": scenario, "CALLS": str(calls),
        "REPO": "example/fork", "HEAD_SHA": "a" * 40,
    }, text=True, capture_output=True, timeout=10)
    assert (result.returncode == 0) is success, result.stdout + result.stderr
    assert ("run rerun 123" in calls.read_text()) is rerun
    if scenario == "pending":
        assert "recovery pending" in result.stdout
