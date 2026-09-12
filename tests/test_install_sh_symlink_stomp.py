"""Contracts for the user-facing Hermes launcher.

The launcher always runs the managed install: the caller's working directory,
including a Hermes source checkout or linked worktree, never selects a
different Python or source tree.
"""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
GENERATOR = REPO_ROOT / "scripts" / "write-hermes-launcher.sh"


def _executable(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def _generate(target: Path, managed_cli: Path, *extra: Path) -> None:
    subprocess.run(
        ["bash", str(GENERATOR), str(target), str(managed_cli), *(str(p) for p in extra)],
        check=True,
        capture_output=True,
        text=True,
    )


def _mark_hermes_checkout(root: Path) -> None:
    (root / "hermes_cli").mkdir(parents=True, exist_ok=True)
    (root / "pyproject.toml").write_text('[project]\nname = "hermes-agent"\n')
    (root / "run_agent.py").write_text("")
    (root / "hermes_cli" / "main.py").write_text("")


def _capture_managed(path: Path) -> Path:
    return _executable(
        path,
        """#!/usr/bin/env bash
{
  printf 'PYTHONPATH=%s\\n' "${PYTHONPATH-}"
  printf 'PYTHONSAFEPATH=%s\\n' "${PYTHONSAFEPATH-}"
  printf 'ARG=%s\\n' "$@"
} > "$CAPTURE"
""",
    )


def test_generator_replaces_old_symlink_without_stomping_entrypoint(
    tmp_path: Path,
) -> None:
    managed_cli = _executable(
        tmp_path / "venv" / "bin" / "hermes",
        "#!/usr/bin/env bash\nexit 0\n",
    )
    target = tmp_path / "bin" / "hermes"
    target.parent.mkdir()
    target.symlink_to(managed_cli)

    _generate(target, managed_cli)

    assert managed_cli.read_text() == "#!/usr/bin/env bash\nexit 0\n"
    assert target.is_file()
    assert not target.is_symlink()
    assert target.stat().st_mode & stat.S_IXUSR


def test_launcher_runs_managed_install_from_inside_a_checkout(tmp_path: Path) -> None:
    repo = tmp_path / "hermes source"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    _mark_hermes_checkout(repo)
    attacked = tmp_path / "attacked.txt"
    _executable(
        repo / ".venv" / "bin" / "python",
        f"#!/usr/bin/env bash\nprintf attacked > {attacked!s}\nexit 93\n",
    )
    capture = tmp_path / "capture.txt"
    managed_cli = _capture_managed(tmp_path / "managed" / "bin" / "hermes")
    target = tmp_path / "bin" / "hermes"
    # Legacy installers passed the checkout as a trust argument; it is ignored.
    _generate(target, managed_cli, repo)
    nested = repo / "nested"
    nested.mkdir()

    result = subprocess.run(
        [str(target), "--tui", "--yolo"],
        cwd=nested,
        env={**os.environ, "CAPTURE": str(capture), "PYTHONPATH": "/wrong"},
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert capture.read_text().splitlines() == [
        "PYTHONPATH=",
        "PYTHONSAFEPATH=1",
        "ARG=--tui",
        "ARG=--yolo",
    ]
    assert not attacked.exists()


def test_generator_removes_stale_trust_file(tmp_path: Path) -> None:
    managed_cli = _capture_managed(tmp_path / "managed" / "bin" / "hermes")
    target = tmp_path / "bin" / "hermes"
    target.parent.mkdir()
    trust_file = Path(f"{target}.trusted-roots")
    trust_file.write_text("/some/checkout/.git\n")

    _generate(target, managed_cli)

    assert not trust_file.exists()
