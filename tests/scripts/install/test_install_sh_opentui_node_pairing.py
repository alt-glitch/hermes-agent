"""Installer contracts for the fork's best-effort ``opentui-engine`` stage.

PM provisions Node (pinned in ``pm/lock.json``). The fork's stage only picks a
Node >= 26.3 (OpenTUI's renderer loads through ``node:ffi``) with the
launcher's precedence and hands the dependency hydration and build to the
launcher's runtime transaction, which owns paired-npm selection. Any failure
leaves the Ink engine in place and never fails the install.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"
OPENTUI_FLOOR = (26, 3)


def _bash(
    body: str, *args: str, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    """Source the installer for its definitions (``--manifest`` stops before main)."""
    script = f"source {shlex.quote(INSTALL_SH.as_posix())} --manifest\n{body}\n"
    return subprocess.run(
        ["bash", "-c", script, "hermes-test", *args],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        env=env,
    )


def _write_executable(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def _fake_node(path: Path, version: str) -> Path:
    """A node that reports ``version`` for ``--version`` (the only probe the floor uses)."""
    return _write_executable(
        path,
        f'if [ "$1" = --version ]; then printf \'v{version}\\n\'; exit 0; fi\n'
        "exit 0",
    )


def _env(path_dir: Path, **extra: str) -> dict[str, str]:
    env = os.environ.copy()
    for key in ("HERMES_NODE", "HERMES_RUNTIME_DIR", "HERMES_TUI_ENGINE"):
        env.pop(key, None)
    env["PATH"] = f"{path_dir}:/usr/bin:/bin"
    env.update(extra)
    return env


def test_installer_script_is_valid_bash() -> None:
    result = subprocess.run(
        ["bash", "-n", str(INSTALL_SH)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_pm_pinned_node_satisfies_the_opentui_floor() -> None:
    lock = json.loads((REPO_ROOT / "pm" / "lock.json").read_text(encoding="utf-8"))
    version = lock["packages"]["node"]["version"]
    assert tuple(int(part) for part in version.split(".")[:2]) >= OPENTUI_FLOOR, version


@pytest.mark.parametrize(
    "version,accepted",
    [
        ("26.3.0", True),
        ("26.12.1", True),
        ("27.0.0", True),
        ("22.22.0", False),
        ("26.0.0", False),
        ("26.2.99", False),
        ("garbage", False),
    ],
)
def test_opentui_node_floor_is_26_3(tmp_path: Path, version: str, accepted: bool) -> None:
    node = _write_executable(
        tmp_path / "node", f'if [ "$1" = --version ]; then printf \'{version}\\n\'; fi\n'
    )

    result = _bash('opentui_node_satisfies "$1"', str(node))

    assert (result.returncode == 0) is accepted, result.stdout + result.stderr


def _precedence_layout(tmp_path: Path) -> dict[str, Path]:
    home = tmp_path / "home"
    return {
        "home": home,
        "override": _fake_node(tmp_path / "override" / "node", "26.3.0"),
        "old_override": _fake_node(tmp_path / "old-override" / "node", "22.12.0"),
        "path": _fake_node(tmp_path / "path-bin" / "node", "26.3.0"),
        "old_path": _fake_node(tmp_path / "old-path-bin" / "node", "22.12.0"),
        "store": _fake_node(home / "tools" / "node-26.7.0" / "bin" / "node", "26.7.0"),
        "legacy": _fake_node(home / "node" / "bin" / "node", "26.3.0"),
    }


@pytest.mark.parametrize(
    "override,path_node,drop,expected",
    [
        ("override", "path", (), "override"),
        ("old_override", "path", (), "path"),
        (None, "path", (), "path"),
        (None, "old_path", (), "store"),
        (None, "old_path", ("store",), "legacy"),
        ("old_override", "old_path", ("store", "legacy"), None),
    ],
    ids=["override", "stale-override", "path", "pm-store", "legacy-managed", "none"],
)
def test_opentui_node_bin_matches_launcher_precedence(
    tmp_path: Path, override, path_node, drop, expected
) -> None:
    nodes = _precedence_layout(tmp_path)
    for name in drop:
        shutil.rmtree(nodes[name].parent.parent)
    extra = {"HERMES_NODE": str(nodes[override])} if override else {}
    env = _env(nodes[path_node].parent, **extra)

    result = _bash('HERMES_HOME="$1"\nopentui_node_bin', str(nodes["home"]), env=env)

    if expected is None:
        assert result.returncode != 0
        assert result.stdout == ""
    else:
        assert result.returncode == 0, result.stdout + result.stderr
        assert Path(result.stdout.strip()) == nodes[expected]


def _package(install_dir: Path, *, with_package_json: bool = True) -> tuple[Path, Path]:
    package_dir = install_dir / "ui-opentui"
    (package_dir / "node_modules").mkdir(parents=True)
    (package_dir / "dist").mkdir()
    dependency = package_dir / "node_modules" / "sentinel"
    bundle = package_dir / "dist" / "main.js"
    dependency.write_bytes(b"old dependency graph")
    bundle.write_bytes(b"old bundle")
    if with_package_json:
        (package_dir / "package.json").write_text("{}\n", encoding="utf-8")
    return dependency, bundle


_RUN_STAGE = """
HERMES_HOME="$1"
INSTALL_DIR="$2"
HERMES_TEST_PYTHON="$3"
JSON=true
{bootstrap}
run_stage opentui-engine
"""
_BOOT_OK = 'bootstrap_python() { boot_py="$HERMES_TEST_PYTHON"; }'
# The real bootstrap aborts through fail(); the stage must survive it.
_BOOT_FAILS = 'bootstrap_python() { fail "bootstrap Python installation failed"; }'


def test_stage_hands_selected_node_to_the_launcher_transaction(tmp_path: Path) -> None:
    nodes = _precedence_layout(tmp_path)
    install_dir = tmp_path / "install"
    _package(install_dir)
    record = tmp_path / "runtime-call.json"
    npm_marker = tmp_path / "npm-called"
    # Ambient npm must never run: the launcher transaction owns paired npm.
    _write_executable(nodes["path"].parent / "npm", f"touch {shlex.quote(str(npm_marker))}")
    runtime_python = tmp_path / "python"
    runtime_python.write_text(
        f"#!{shutil.which('python3') or '/usr/bin/python3'}\n"
        "import json, os, sys\n"
        "keys = ('HERMES_NODE', 'HERMES_TUI_ENGINE', 'HERMES_TUI_FORCE_BUILD')\n"
        f"with open({str(record)!r}, 'w') as fh:\n"
        "    json.dump({'argv': sys.argv[1:], 'env': {k: os.environ.get(k) for k in keys}}, fh)\n",
        encoding="utf-8",
    )
    runtime_python.chmod(0o755)
    env = _env(nodes["path"].parent, HERMES_NODE=str(nodes["override"]))

    result = _bash(
        _RUN_STAGE.format(bootstrap=_BOOT_OK),
        str(nodes["home"]),
        str(install_dir),
        str(runtime_python),
        env=env,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout.strip().splitlines()[-1]) == {
        "ok": True, "stage": "opentui-engine", "skipped": False,
    }
    call = json.loads(record.read_text(encoding="utf-8"))
    assert call["env"] == {
        "HERMES_NODE": str(nodes["override"]),
        "HERMES_TUI_ENGINE": "opentui",
        "HERMES_TUI_FORCE_BUILD": "1",
    }
    # <boot python> -I -B -c OPENTUI_RUNTIME_EXEC INSTALL_DIR CODE: re-enter the
    # installed runtime and run the launcher's own build transaction there.
    isolated, runtime_exec, root, code = call["argv"][:3], call["argv"][3], call["argv"][4], call["argv"][5]
    assert isolated == ["-I", "-B", "-c"]
    assert "runtime_command(" in runtime_exec
    assert root == str(install_dir)
    assert "_make_opentui_argv(False)" in code
    assert not npm_marker.exists()


@pytest.mark.parametrize(
    "scenario,warning",
    [
        ("no-package", "Skipping OpenTUI engine"),
        ("no-node", "needs Node >= 26.3.0"),
        ("no-bootstrap-python", "no bootstrap Python"),
        ("runtime-failure", "transactional runtime preparation failed"),
    ],
)
def test_stage_falls_back_to_ink_and_preserves_the_existing_pair(
    tmp_path: Path, scenario: str, warning: str
) -> None:
    nodes = _precedence_layout(tmp_path)
    install_dir = tmp_path / "install"
    dependency, bundle = _package(install_dir, with_package_json=scenario != "no-package")
    if scenario == "no-node":
        shutil.rmtree(nodes["store"].parent.parent)
        shutil.rmtree(nodes["legacy"].parent.parent)
    path_dir = nodes["old_path" if scenario == "no-node" else "path"].parent
    failing_python = _write_executable(tmp_path / "python", "exit 1")
    bootstrap = _BOOT_FAILS if scenario == "no-bootstrap-python" else _BOOT_OK

    result = _bash(
        _RUN_STAGE.format(bootstrap=bootstrap),
        str(nodes["home"]),
        str(install_dir),
        str(failing_python),
        env=_env(path_dir),
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout.strip().splitlines()[-1]) == {
        "ok": True, "stage": "opentui-engine", "skipped": False,
    }
    assert warning in result.stdout + result.stderr
    assert dependency.read_bytes() == b"old dependency graph"
    assert bundle.read_bytes() == b"old bundle"
