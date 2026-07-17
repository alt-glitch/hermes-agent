"""Contracts for the user-facing, worktree-aware Hermes launcher."""

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


def _generate(target: Path, managed_cli: Path, *trusted: Path) -> None:
    subprocess.run(
        [
            "bash",
            str(GENERATOR),
            str(target),
            str(managed_cli),
            *(str(path) for path in trusted),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def _mark_hermes_checkout(root: Path) -> None:
    (root / "hermes_cli").mkdir(parents=True, exist_ok=True)
    (root / "pyproject.toml").write_text('[project]\nname = "hermes-agent"\n')
    (root / "run_agent.py").write_text("")
    (root / "hermes_cli" / "main.py").write_text("")


def _capture_python(path: Path) -> Path:
    return _executable(
        path,
        """#!/usr/bin/env bash
{
  printf 'PYTHONPATH=%s\\n' "$PYTHONPATH"
  printf 'HERMES_PYTHON_SRC_ROOT=%s\\n' "$HERMES_PYTHON_SRC_ROOT"
  printf 'HERMES_PYTHON=%s\\n' "$HERMES_PYTHON"
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
    trust_file = Path(f"{target}.trusted-roots")
    assert stat.S_IMODE(trust_file.stat().st_mode) == 0o600


def test_launcher_uses_current_checkout_python_and_source(tmp_path: Path) -> None:
    repo = tmp_path / "hermes source"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    _mark_hermes_checkout(repo)
    source_python = _capture_python(repo / ".venv" / "bin" / "python")
    managed_cli = _executable(
        tmp_path / "managed" / "bin" / "hermes",
        "#!/usr/bin/env bash\nexit 91\n",
    )
    target = tmp_path / "bin" / "hermes"
    _generate(target, managed_cli, repo)
    nested = repo / "nested"
    nested.mkdir()
    capture = tmp_path / "capture.txt"

    env = {**os.environ, "CAPTURE": str(capture), "PYTHONPATH": "/wrong"}
    result = subprocess.run(
        [str(target), "--tui", "--yolo"],
        cwd=nested,
        env=env,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert capture.read_text().splitlines() == [
        f"PYTHONPATH={repo}",
        f"HERMES_PYTHON_SRC_ROOT={repo}",
        f"HERMES_PYTHON={source_python}",
        "ARG=-m",
        "ARG=hermes_cli.main",
        "ARG=--tui",
        "ARG=--yolo",
    ]


def test_launcher_uses_primary_checkout_venv_for_linked_worktree(
    tmp_path: Path,
) -> None:
    primary = tmp_path / "primary"
    primary.mkdir()
    subprocess.run(["git", "init", "-q", str(primary)], check=True)
    _mark_hermes_checkout(primary)
    subprocess.run(["git", "-C", str(primary), "add", "."], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(primary),
            "-c",
            "user.name=Hermes Test",
            "-c",
            "user.email=hermes@example.invalid",
            "commit",
            "-qm",
            "fixture",
        ],
        check=True,
    )
    linked = tmp_path / "linked"
    subprocess.run(
        ["git", "-C", str(primary), "worktree", "add", "-q", "--detach", str(linked)],
        check=True,
    )
    shared_python = _capture_python(primary / ".venv" / "bin" / "python")
    managed_cli = _executable(
        tmp_path / "managed" / "bin" / "hermes",
        "#!/usr/bin/env bash\nexit 92\n",
    )
    target = tmp_path / "bin" / "hermes"
    _generate(target, managed_cli, primary)
    # Trust is stored beside the launcher and survives a later installer rerun.
    _generate(target, managed_cli)
    capture = tmp_path / "capture.txt"

    result = subprocess.run(
        [str(target), "doctor"],
        cwd=linked,
        env={**os.environ, "CAPTURE": str(capture)},
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    lines = capture.read_text().splitlines()
    assert lines[:3] == [
        f"PYTHONPATH={linked}",
        f"HERMES_PYTHON_SRC_ROOT={linked}",
        f"HERMES_PYTHON={shared_python}",
    ]
    assert lines[3:] == ["ARG=-m", "ARG=hermes_cli.main", "ARG=doctor"]


def test_launcher_falls_back_to_managed_entrypoint_outside_checkout(
    tmp_path: Path,
) -> None:
    capture = tmp_path / "managed.txt"
    managed_cli = _executable(
        tmp_path / "managed" / "bin" / "hermes",
        """#!/usr/bin/env bash
printf '%s\\n' "$@" > "$CAPTURE"
""",
    )
    target = tmp_path / "bin" / "hermes"
    _generate(target, managed_cli)
    outside = tmp_path / "outside"
    outside.mkdir()

    result = subprocess.run(
        [str(target), "--version"],
        cwd=outside,
        env={**os.environ, "CAPTURE": str(capture)},
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert capture.read_text().splitlines() == ["--version"]


def test_launcher_does_not_execute_untrusted_lookalike_checkout(tmp_path: Path) -> None:
    lookalike = tmp_path / "lookalike"
    lookalike.mkdir()
    subprocess.run(["git", "init", "-q", str(lookalike)], check=True)
    _mark_hermes_checkout(lookalike)
    attacked = tmp_path / "attacked.txt"
    _executable(
        lookalike / ".venv" / "bin" / "python",
        f"#!/usr/bin/env bash\nprintf attacked > {attacked!s}\nexit 93\n",
    )
    capture = tmp_path / "managed.txt"
    managed_cli = _executable(
        tmp_path / "managed" / "bin" / "hermes",
        """#!/usr/bin/env bash
printf 'managed\n' > "$CAPTURE"
""",
    )
    target = tmp_path / "bin" / "hermes"
    _generate(target, managed_cli)

    result = subprocess.run(
        [str(target)],
        cwd=lookalike,
        env={**os.environ, "CAPTURE": str(capture)},
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert capture.read_text() == "managed\n"
    assert not attacked.exists()
