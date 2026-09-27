"""Fork contract: the user-facing ``hermes`` is the worktree-aware launcher.

PM's shared writer publishes ``$INSTALL_DIR/.hermes/bin/hermes`` plus a plain
``~/.local/bin/hermes`` forwarder. Both fork entry points -- install.sh's
``products`` stage and setup-hermes.sh -- then replace that forwarder with the
launcher from ``scripts/write-hermes-launcher.sh``. When install.sh is launched
from another Python-driven tool session, inherited PYTHONPATH/PYTHONHOME must
not leak into the managed runtime the launcher executes.
"""

from __future__ import annotations

import os
import shlex
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.platforms("posix")

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"
SETUP_HERMES_SH = REPO_ROOT / "setup-hermes.sh"
LAUNCHER_GENERATOR = REPO_ROOT / "scripts" / "write-hermes-launcher.sh"

_CAPTURE_LAUNCHER = """#!/bin/sh
{
  printf 'PYTHONPATH=%s\\n' "${PYTHONPATH-<unset>}"
  printf 'PYTHONHOME=%s\\n' "${PYTHONHOME-<unset>}"
  for arg in "$@"; do printf 'ARG=%s\\n' "$arg"; done
} > "$CAPTURE"
"""


def _install_tree(tmp_path: Path) -> tuple[Path, Path]:
    """A checkout after PM publication: generator + managed launcher present."""
    install = tmp_path / "install"
    (install / "scripts").mkdir(parents=True)
    shutil.copy2(LAUNCHER_GENERATOR, install / "scripts")
    (install / "hermes_cli").mkdir()
    # stage_products hands the checkout to source_completion; PM's real
    # publication is out of scope here, so the managed launcher pre-exists.
    (install / "hermes_cli" / "source_completion.py").write_text("", encoding="utf-8")
    managed = install / ".hermes" / "bin" / "hermes"
    managed.parent.mkdir(parents=True)
    managed.write_text(_CAPTURE_LAUNCHER, encoding="utf-8")
    managed.chmod(managed.stat().st_mode | stat.S_IXUSR)
    return install, managed


def _run_products(tmp_path: Path, install: Path) -> subprocess.CompletedProcess[str]:
    script = (
        f"source {shlex.quote(INSTALL_SH.as_posix())} --manifest >/dev/null\n"
        'INSTALL_DIR="$1"\n'
        'bootstrap_python() { boot_py="$PYTHON_FOR_TEST"; }\n'
        "stage_products\n"
    )
    env = {
        **os.environ,
        "HOME": str(tmp_path / "home"),
        "HERMES_HOME": str(tmp_path / "home" / ".hermes"),
        "HERMES_RUNTIME_DIR": str(tmp_path / "store"),
        "PYTHON_FOR_TEST": sys.executable,
        "SHELL": "/bin/bash",
    }
    return subprocess.run(
        ["bash", "-c", script, "products-test", str(install)],
        cwd=tmp_path, env=env, capture_output=True, text=True, timeout=30,
    )


def test_products_stage_installs_sanitizing_worktree_launcher(tmp_path: Path) -> None:
    install, managed = _install_tree(tmp_path)
    target = tmp_path / "home" / ".local" / "bin" / "hermes"
    # A legacy install linked the command straight at the managed entrypoint;
    # writing through that link would overwrite the entrypoint (#21454).
    target.parent.mkdir(parents=True)
    target.symlink_to(managed)
    managed_before = managed.read_text(encoding="utf-8")

    result = _run_products(tmp_path, install)

    assert result.returncode == 0, result.stdout + result.stderr
    assert managed.read_text(encoding="utf-8") == managed_before
    assert target.is_file() and not target.is_symlink()
    assert "managed_cli=" in target.read_text(encoding="utf-8")
    assert Path(f"{target}.trusted-roots").is_file()

    outside = tmp_path / "outside"
    outside.mkdir()
    capture = tmp_path / "capture.txt"
    launched = subprocess.run(
        [str(target), "--version"],
        cwd=outside,
        env={**os.environ, "CAPTURE": str(capture),
             "PYTHONPATH": "/wrong/checkout", "PYTHONHOME": "/wrong/home"},
        capture_output=True, text=True, timeout=30,
    )
    assert launched.returncode == 0, launched.stderr
    assert capture.read_text(encoding="utf-8").splitlines() == [
        "PYTHONPATH=<unset>",
        "PYTHONHOME=<unset>",
        "ARG=--version",
    ]


def test_products_stage_keeps_pm_forwarder_without_the_generator(tmp_path: Path) -> None:
    install, _managed = _install_tree(tmp_path)
    (install / "scripts" / "write-hermes-launcher.sh").unlink()

    result = _run_products(tmp_path, install)

    assert result.returncode == 0, result.stdout + result.stderr
    assert not (tmp_path / "home" / ".local" / "bin" / "hermes").exists()


def test_setup_script_installs_worktree_launcher_after_shared_publication() -> None:
    text = SETUP_HERMES_SH.read_text(encoding="utf-8")

    publish = text.index('hermes_cli/_launchers.py "$bin_dir"')
    generate = text.index('bash "$launcher_generator"')
    assert publish < generate
    assert 'launcher_generator="$SCRIPT_DIR/scripts/write-hermes-launcher.sh"' in text
    assert '"$bin_dir/hermes" "$SCRIPT_DIR/.hermes/bin/hermes" "$SCRIPT_DIR"' in text


def test_launcher_generator_clears_python_env_before_exec() -> None:
    launcher_text = LAUNCHER_GENERATOR.read_text(encoding="utf-8")

    assert "unset PYTHONPATH" in launcher_text
    assert "unset PYTHONHOME" in launcher_text
    assert "export PYTHONSAFEPATH=1" in launcher_text
    assert 'exec "$managed_cli" "$@"' in launcher_text
