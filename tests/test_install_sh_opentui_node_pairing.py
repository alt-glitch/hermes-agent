"""Installer contracts for Node 26 provisioning and OpenTUI npm pairing."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"


def _text() -> str:
    return INSTALL_SH.read_text(encoding="utf-8")


def _function(name: str) -> str:
    match = re.search(rf"(?ms)^{re.escape(name)}\(\) \{{.*?^\}}$", _text())
    assert match is not None, f"missing shell function {name}"
    return match.group(0)


def _bash(
    script: str, *args: str, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", script, "hermes-test", *args],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
        env=env,
    )


def test_installer_script_is_valid_bash() -> None:
    result = subprocess.run(
        ["bash", "-n", str(INSTALL_SH)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_managed_node_line_and_floor_cover_opentui() -> None:
    assert 'NODE_VERSION="26"' in _text()
    function = _function("node_satisfies_opentui")
    probe = f'{function}\nnode_satisfies_opentui "$1"'

    for accepted in ("v26.3.0", "v26.12.1", "v27.0.0"):
        assert _bash(probe, accepted).returncode == 0
    for rejected in ("v22.22.0", "v26.0.0", "v26.2.99", "garbage"):
        assert _bash(probe, rejected).returncode != 0


def test_node26_failure_preserves_a_build_capable_ink_fallback() -> None:
    body = _function("check_node")
    assert "fallback_node" in body
    assert "node_satisfies_build" in body
    assert 'if [ "$HAS_NODE" = true ]' in body
    assert "HAS_NODE=true" in body.split("Node 26 provisioning failed", 1)[1]


def test_node26_provision_failure_keeps_real_node22_fallback(tmp_path: Path) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    node = fake_bin / "node"
    node.write_text("#!/bin/sh\nprintf 'v22.12.0\\n'\n", encoding="utf-8")
    node.chmod(0o755)
    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}:/usr/bin:/bin"

    functions = "\n".join(
        _function(name)
        for name in (
            "node_satisfies_build",
            "node_satisfies_opentui",
            "opentui_host_supported",
            "check_node",
        )
    )
    script = f"""
{functions}
configure_managed_node_npm_prefix() {{ :; }}
log_info() {{ :; }}
log_success() {{ :; }}
log_warn() {{ :; }}
install_node() {{ HAS_NODE=false; }}
HERMES_HOME="$1"
OS=linux
DISTRO=ubuntu
HAS_NODE=false
check_node
[ "$HAS_NODE" = true ]
[ "$(command -v node)" = "$2" ]
"""
    result = _bash(script, str(tmp_path / "home"), str(node), env=env)
    assert result.returncode == 0, result.stdout + result.stderr


def test_check_node_honors_valid_hermes_node_before_path_or_provisioning(
    tmp_path: Path,
) -> None:
    env_node = tmp_path / "override" / "node"
    path_node = tmp_path / "path-bin" / "node"
    env_npm = env_node.with_name("npm")
    env_npx = env_node.with_name("npx")
    for node, version in ((env_node, "v26.3.0"), (path_node, "v22.12.0")):
        node.parent.mkdir(parents=True, exist_ok=True)
        node.write_text(f"#!/bin/sh\nprintf '{version}\\n'\n", encoding="utf-8")
        node.chmod(0o755)
    for shim in (env_npm, env_npx):
        shim.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        shim.chmod(0o755)

    marker = tmp_path / "provisioned"
    env = os.environ.copy()
    env["HERMES_NODE"] = str(env_node)
    env["PATH"] = f"{path_node.parent}:/usr/bin:/bin"
    functions = "\n".join(
        _function(name)
        for name in (
            "node_satisfies_build",
            "node_satisfies_opentui",
            "opentui_host_supported",
            "check_node",
        )
    )
    script = f"""
{functions}
configure_managed_node_npm_prefix() {{ :; }}
log_info() {{ :; }}
log_success() {{ :; }}
log_warn() {{ :; }}
install_node() {{ printf called > "$HERMES_TEST_MARKER"; HAS_NODE=false; }}
HERMES_HOME="$1"
HERMES_TEST_MARKER="$2"
OS=linux
DISTRO=ubuntu
HAS_NODE=false
check_node
[ "$HAS_NODE" = true ]
[ ! -e "$2" ]
[ "$(command -v node)" = "$3" ]
[ "$(command -v npm)" = "$4" ]
[ "$(command -v npx)" = "$5" ]
"""

    result = _bash(
        script,
        str(tmp_path / "home"),
        str(marker),
        str(env_node),
        str(env_npm),
        str(env_npx),
        env=env,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_opentui_never_uses_ambient_npm() -> None:
    body = _function("install_opentui")
    assert "command -v npm" not in body
    assert " npm ci" not in body
    assert "_make_opentui_argv(False)" in body
    assert 'HERMES_NODE="$node_bin"' in body
    assert "HERMES_TUI_FORCE_BUILD=1" in body


def test_install_opentui_node_precedence_matches_launcher(tmp_path: Path) -> None:
    def write_node(path: Path, version: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "#!/bin/sh\n"
            f'if [ "$1" = --version ]; then printf \'{version}\\n\'; fi\n'
            f'if [ "$1" = -e ] && [ "{version}" = v22.12.0 ]; then exit 1; fi\n'
            "exit 0\n",
            encoding="utf-8",
        )
        path.chmod(0o755)

    env_node = tmp_path / "override" / "node"
    path_node = tmp_path / "path-bin" / "node"
    old_path_node = tmp_path / "old-path-bin" / "node"
    managed_node = tmp_path / "home" / "node" / "bin" / "node"
    write_node(env_node, "v26.3.0")
    write_node(path_node, "v26.3.0")
    write_node(old_path_node, "v22.12.0")
    write_node(managed_node, "v26.3.0")

    install_dir = tmp_path / "install"
    package_dir = install_dir / "ui-opentui"
    package_dir.mkdir(parents=True)
    (package_dir / "package.json").write_text("{}\n", encoding="utf-8")
    record = tmp_path / "selected-node"
    runtime_python = tmp_path / "runtime-python"
    runtime_python.write_text(
        "#!/bin/sh\nprintf '%s\\n' \"$HERMES_NODE\" >> \"$HERMES_TEST_RECORD\"\n",
        encoding="utf-8",
    )
    runtime_python.chmod(0o755)
    function = _function("install_opentui")
    script = f"""
{function}
log_info() {{ :; }}
log_success() {{ :; }}
log_warn() {{ :; }}
opentui_python_for_runtime() {{ printf '%s\\n' "$HERMES_TEST_PYTHON"; }}
run_with_timeout() {{ shift; "$@"; }}
OS=linux
DISTRO=ubuntu
NODE_DEPS_TIMEOUT=30
HERMES_HOME="$1"
INSTALL_DIR="$2"
HERMES_TEST_RECORD="$3"
HERMES_TEST_PYTHON="$4"
export HERMES_TEST_RECORD
install_opentui
"""

    cases = (
        ("override", str(env_node), path_node.parent, env_node),
        ("path", None, path_node.parent, path_node),
        ("managed", None, old_path_node.parent, managed_node),
    )
    for label, override, path_dir, expected in cases:
        record.unlink(missing_ok=True)
        env = os.environ.copy()
        env["PATH"] = f"{path_dir}:/usr/bin:/bin"
        if override is None:
            env.pop("HERMES_NODE", None)
        else:
            env["HERMES_NODE"] = override
        result = _bash(
            script,
            str(tmp_path / "home"),
            str(install_dir),
            str(record),
            str(runtime_python),
            env=env,
        )
        assert result.returncode == 0, f"{label}: {result.stdout}{result.stderr}"
        selected = record.read_text(encoding="utf-8").splitlines()
        assert selected and all(Path(path) == expected for path in selected), label


def test_runtime_python_prefers_importable_venv_then_falls_back_to_path(
    tmp_path: Path,
) -> None:
    install_dir = tmp_path / "install"
    venv_python = install_dir / "venv" / "bin" / "python"
    path_python = tmp_path / "bin" / "python3"
    for candidate in (venv_python, path_python):
        candidate.parent.mkdir(parents=True, exist_ok=True)
        candidate.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        candidate.chmod(0o755)

    env = os.environ.copy()
    env["PATH"] = f"{path_python.parent}:/usr/bin:/bin"
    function = _function("opentui_python_for_runtime")
    script = f"""
{function}
INSTALL_DIR="$1"
PYTHON_PATH=""
opentui_python_for_runtime
"""
    result = _bash(script, str(install_dir), env=env)
    assert result.returncode == 0, result.stderr
    assert Path(result.stdout.strip()) == venv_python

    venv_python.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
    result = _bash(script, str(install_dir), env=env)
    assert result.returncode == 0, result.stderr
    assert Path(result.stdout.strip()) == path_python


def test_failed_runtime_transaction_preserves_existing_pair(tmp_path: Path) -> None:
    install_dir = tmp_path / "install"
    package_dir = install_dir / "ui-opentui"
    (package_dir / "node_modules").mkdir(parents=True)
    (package_dir / "dist").mkdir()
    dependency = package_dir / "node_modules" / "sentinel"
    bundle = package_dir / "dist" / "main.js"
    dependency.write_bytes(b"old dependency graph")
    bundle.write_bytes(b"old bundle")
    (package_dir / "package.json").write_text("{}\n", encoding="utf-8")
    node = tmp_path / "node"
    node.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    node.chmod(0o755)
    failing_python = tmp_path / "python"
    failing_python.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
    failing_python.chmod(0o755)
    function = _function("install_opentui")
    script = f"""
{function}
log_info() {{ :; }}
log_success() {{ :; }}
log_warn() {{ :; }}
opentui_python_for_runtime() {{ printf '%s\\n' "$HERMES_TEST_PYTHON"; }}
run_with_timeout() {{ shift; "$@"; }}
OS=linux
DISTRO=ubuntu
NODE_DEPS_TIMEOUT=30
HERMES_HOME="$1"
INSTALL_DIR="$2"
HERMES_NODE="$3"
HERMES_TEST_PYTHON="$4"
install_opentui
"""
    result = _bash(
        script,
        str(tmp_path / "home"),
        str(install_dir),
        str(node),
        str(failing_python),
    )
    assert result.returncode == 0, result.stderr
    assert dependency.read_bytes() == b"old dependency graph"
    assert bundle.read_bytes() == b"old bundle"
