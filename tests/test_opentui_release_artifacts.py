"""Release-channel contract for the portable OpenTUI wheel/sdist seed.

The Python distribution may carry JavaScript source and a prebuilt bundle, but
it must remain ``py3-none-any``: npm selects and installs the host's native
``@opentui/core-<platform>`` package later in the launcher's transactional
runtime cache.  Set ``HERMES_RELEASE_ARTIFACT_DIR`` to exercise the built
archives and a clean-venv install; metadata checks run in the normal suite.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tarfile
import tomllib
import venv
import zipfile
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
PORTABLE_ROOT = Path("ui-opentui")


def test_opentui_package_version_tracks_hermes_release() -> None:
    """The private engine is released with Hermes, not on a 0.0.0 line."""
    package = json.loads((PORTABLE_ROOT / "package.json").read_text())
    lock = json.loads((PORTABLE_ROOT / "package-lock.json").read_text())
    project = tomllib.loads(Path("pyproject.toml").read_text())["project"]

    assert package["version"] == project["version"]
    assert lock["version"] == project["version"]
    assert lock["packages"][""]["version"] == project["version"]


BUILD_INPUT_FILES = {
    PORTABLE_ROOT / "package.json",
    PORTABLE_ROOT / "package-lock.json",
    PORTABLE_ROOT / "tsconfig.json",
    PORTABLE_ROOT / "scripts" / "build.mjs",
}
PORTABLE_EXTRAS = {
    PORTABLE_ROOT / ".node-version",
    PORTABLE_ROOT / "README.md",
    PORTABLE_ROOT / "dist" / "main.js",
}
SOURCE_SUFFIXES = {".cjs", ".js", ".jsx", ".json", ".mjs", ".ts", ".tsx"}
NATIVE_SUFFIXES = {".dll", ".dylib", ".node", ".so"}
HYDRATE_INSTALLED_SEED = r"""
import os
import shutil
import signal
import subprocess
from pathlib import Path

import hermes_cli
from hermes_cli.opentui_runtime import (
    build_environment,
    dependencies_current,
    launch_argv,
    npm_command,
    packaged_runtime_current,
    packaged_seed,
    probe_node_identity,
    refresh_lock,
    refresh_packaged_runtime,
    runtime_payload_present,
    runtime_sentinels_current,
    select_runtime_location,
)

root = Path(hermes_cli.__file__).resolve().parent.parent
seed_dir = root / "ui-opentui"
state = Path(os.environ["HERMES_HOME"]) / "cache" / "opentui-runtime"
seed = packaged_seed(seed_dir)
assert seed is not None
assert not (seed_dir / "node_modules").exists()
location = select_runtime_location(root, state)
assert location is not None and location.is_packaged

configured_node = os.environ.get("HERMES_NODE")
node = (
    configured_node
    if configured_node and Path(configured_node).is_file() and os.access(configured_node, os.X_OK)
    else shutil.which("node")
)
assert node is not None
identity = probe_node_identity(node)
assert identity is not None
assert identity.platform == os.environ["EXPECTED_NODE_PLATFORM"]
assert identity.arch == os.environ["EXPECTED_NODE_ARCH"]
version = tuple(map(int, identity.version.removeprefix("v").split(".")[:3]))
assert version >= (26, 3, 0)
npm = npm_command(node)
assert npm is not None

def bounded_runner(cmd, cwd, *, idle_timeout_seconds=180, env=None):
    assert os.name == "posix"
    process = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, _ = process.communicate(timeout=idle_timeout_seconds)
        return subprocess.CompletedProcess(cmd, process.returncode, stdout, "")
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            stdout, _ = process.communicate(timeout=3)
            root_reaped = True
        except subprocess.TimeoutExpired:
            root_reaped = False
        # The root can exit while a descendant in the same group survives with
        # stdout closed. Always sweep the group before the final reap.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if not root_reaped:
            stdout, _ = process.communicate()
        return subprocess.CompletedProcess(
            cmd, 124, stdout, f"timed out after {idle_timeout_seconds}s"
        )

with refresh_lock(location.runtime_dir):
    success, result, promotion = refresh_packaged_runtime(
        location,
        identity=identity,
        npm=npm,
        env=build_environment(node),
        runner=bounded_runner,
    )
    assert success, f"{result.stdout}\n{result.stderr}"
    assert promotion is not None
    assert packaged_runtime_current(location)
    assert (location.runtime_dir / "dist" / "main.js").stat().st_size > 0
    assert runtime_payload_present(location.runtime_dir, identity)
    assert runtime_sentinels_current(location.runtime_dir, identity)
    assert dependencies_current(location.runtime_dir, identity)
    promotion.commit()
assert not (seed_dir / "node_modules").exists()
assert packaged_seed(seed_dir) == seed

argv = launch_argv(node, location.runtime_dir)
assert argv == [
    node,
    "--experimental-ffi",
    "--no-warnings",
    "--expose-gc",
    str(location.runtime_dir / "dist" / "main.js"),
]
native = subprocess.run(
    [
        node,
        "--experimental-ffi",
        "--no-warnings",
        "-e",
        'import("@opentui/core").catch(error => { console.error(error); process.exit(1) })',
    ],
    cwd=location.runtime_dir,
    capture_output=True,
    text=True,
    timeout=30,
    check=False,
)
assert native.returncode == 0, native.stdout + native.stderr
"""


def _expected_payload() -> set[Path]:
    source = REPO_ROOT / PORTABLE_ROOT / "src"
    runtime_source = {
        path.relative_to(REPO_ROOT)
        for path in source.rglob("*")
        if path.is_file()
        and path.suffix in SOURCE_SUFFIXES
        and "test" not in path.relative_to(source).parts[:1]
    }
    return BUILD_INPUT_FILES | PORTABLE_EXTRAS | runtime_source


def _artifact_dir() -> Path:
    configured = os.environ.get("HERMES_RELEASE_ARTIFACT_DIR")
    if not configured:
        pytest.skip("set HERMES_RELEASE_ARTIFACT_DIR to verify built artifacts")
    path = Path(configured).resolve()
    assert path.is_dir(), f"artifact directory does not exist: {path}"
    return path


def _one_artifact(pattern: str) -> Path:
    matches = sorted(_artifact_dir().glob(pattern))
    assert len(matches) == 1, f"expected one {pattern} artifact, got {matches}"
    return matches[0]


def _sdist_payload(sdist: Path) -> dict[Path, bytes]:
    with tarfile.open(sdist, "r:gz") as archive:
        members = [member for member in archive.getmembers() if member.isfile()]
        names = [member.name for member in members]
        roots = {name.split("/", 1)[0] for name in names if "/" in name}
        assert len(roots) == 1, f"sdist must have one root directory, got {roots}"
        root = roots.pop()
        payload = {}
        for member in members:
            relative = Path(member.name.removeprefix(f"{root}/"))
            if relative.parts[:1] != ("ui-opentui",):
                continue
            handle = archive.extractfile(member)
            assert handle is not None
            payload[relative] = handle.read()
        return payload


def _wheel_payload(wheel: Path) -> dict[Path, bytes]:
    with zipfile.ZipFile(wheel) as archive:
        return {
            Path(name): archive.read(name)
            for name in archive.namelist()
            if not name.endswith("/") and name.startswith("ui-opentui/")
        }


def _assert_portable_payload(paths: set[Path]) -> None:
    expected = _expected_payload()
    missing = sorted(expected - paths)
    assert not missing, f"OpenTUI release payload is incomplete: {missing}"

    opentui_paths = {path for path in paths if path.parts[:1] == ("ui-opentui",)}
    unexpected = sorted(opentui_paths - expected)
    assert not unexpected, (
        f"OpenTUI release payload has non-runtime files: {unexpected}"
    )
    assert not any("node_modules" in path.parts for path in opentui_paths)
    assert not any(path.suffix in NATIVE_SUFFIXES for path in opentui_paths)
    assert not any(
        path.parts[:3] == ("ui-opentui", "src", "test") for path in opentui_paths
    )
    assert PORTABLE_ROOT / "dist" / "main.js.map" not in opentui_paths


def test_packaging_metadata_declares_portable_opentui_seed() -> None:
    metadata = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    setuptools = metadata["tool"]["setuptools"]

    assert "ui-opentui" in setuptools["packages"]["find"]["include"]
    package_data = set(setuptools["package-data"]["ui-opentui"])
    for required in (
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        "scripts/build.mjs",
        "src/boundary/**/*",
        "src/entry/**/*",
        "src/logic/**/*",
        "src/view/**/*",
        "dist/main.js",
    ):
        assert required in package_data

    manifest = (REPO_ROOT / "MANIFEST.in").read_text(encoding="utf-8")
    assert not any(line.strip() == "graft ui-opentui" for line in manifest.splitlines())
    for required in (
        "include ui-opentui/package.json",
        "include ui-opentui/package-lock.json",
        "include ui-opentui/tsconfig.json",
        "include ui-opentui/scripts/build.mjs",
        "include ui-opentui/dist/main.js",
        "recursive-include ui-opentui/src",
        "prune ui-opentui/src/test",
    ):
        assert required in manifest


def _job_names(workflow: str) -> list[str]:
    jobs = workflow.split("\njobs:\n", 1)[1]
    return [
        line[2:-1]
        for line in jobs.splitlines()
        if line.startswith("  ")
        and not line.startswith("    ")
        and line.endswith(":")
    ]


def _job_section(workflow: str, name: str, next_name: str | None) -> str:
    section = workflow.split(f"\n  {name}:", 1)[1]
    if next_name is not None:
        section = section.split(f"\n  {next_name}:", 1)[0]
    return section


def _trigger_block(workflow: str) -> str:
    return workflow.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]


def test_publish_workflow_keeps_upstream_flow_with_one_native_gate() -> None:
    publish = (
        REPO_ROOT / ".github" / "workflows" / "upload_to_pypi.yml"
    ).read_text(encoding="utf-8")
    docker = (REPO_ROOT / ".github" / "workflows" / "docker.yml").read_text(
        encoding="utf-8"
    )
    site = (
        REPO_ROOT / ".github" / "workflows" / "deploy-site.yml"
    ).read_text(encoding="utf-8")

    assert _job_names(publish) == ["build", "verify-opentui", "publish", "sign"]
    build = _job_section(publish, "build", "verify-opentui")
    verify = _job_section(publish, "verify-opentui", "publish")
    publish_job = _job_section(publish, "publish", "sign")
    sign = _job_section(publish, "sign", None)

    for step in (
        "Build web dashboard",
        "Build TUI bundle",
        "Build portable OpenTUI seed",
        "Bundle install scripts into wheel",
        "Build wheel and sdist",
        "Verify portable OpenTUI seed in both archives",
    ):
        assert step in build
    assert 'node-version: "22"' in build
    assert 'node-version: "26.3.0"' in build
    assert "validate_opentui_release_artifacts" in build
    assert "name: python-package-distributions" in build

    for runner, platform, arch in (
        ("ubuntu-24.04", "linux", "x64"),
        ("ubuntu-24.04-arm", "linux", "arm64"),
        ("macos-15-intel", "darwin", "x64"),
        ("macos-15", "darwin", "arm64"),
    ):
        assert (
            f"runner: {runner}\n"
            f"            platform: {platform}\n"
            f"            arch: {arch}"
        ) in verify
    assert "needs: build" in verify
    assert "name: python-package-distributions" in verify
    assert "HERMES_RELEASE_HYDRATE_OPENTUI" in verify
    assert "test_clean_venv_install_places_seed_beside_hermes_cli" in verify

    assert "needs: [build, verify-opentui]" in publish_job
    assert "name: python-package-distributions" in publish_job
    assert "skip-existing: true" in publish_job
    assert "needs: publish" in sign
    assert "Wait for GitHub Release to exist" in sign
    assert "skip_sign=true" in sign
    assert "Sign with Sigstore" in sign

    for removed_job in (
        "validate-source:",
        "stage-release-assets:",
        "docker-release:",
        "site-release:",
        "publish-github-release:",
    ):
        assert removed_job not in publish
    assert "uses: ./.github/workflows/docker.yml" not in publish
    assert "uses: ./.github/workflows/deploy-site.yml" not in publish

    docker_triggers = _trigger_block(docker)
    assert "  release:\n    types: [published]" in docker_triggers
    assert "  workflow_call:" in docker_triggers
    assert "release_sha:" not in docker
    assert "release_tag:" not in docker

    site_triggers = _trigger_block(site)
    assert "  release:\n    types: [published]" in site_triggers
    assert "  push:" in site_triggers
    assert "  workflow_dispatch:" in site_triggers
    assert "  workflow_call:" not in site_triggers
    assert "release_sha:" not in site
    assert "release_tag:" not in site


def test_release_script_keeps_upstream_tag_and_public_release_behavior() -> None:
    source = (REPO_ROOT / "scripts" / "release.py").read_text(encoding="utf-8")
    main = source.split("def main():", 1)[1]

    assert 'push_result = git_result("push", "origin", "HEAD", "--tags")' in main
    assert '"gh", "release", "create", tag_name,' in main
    assert "gh_cmd.extend(str(path) for path in artifacts)" in main
    assert '"--draft"' not in main
    assert '"--verify-tag"' not in main


def test_built_wheel_and_sdist_contain_only_portable_opentui_payload() -> None:
    wheel = _one_artifact("*.whl")
    sdist = _one_artifact("*.tar.gz")
    assert wheel.name.endswith("-py3-none-any.whl")

    wheel_payload = _wheel_payload(wheel)
    sdist_payload = _sdist_payload(sdist)
    _assert_portable_payload(set(wheel_payload))
    _assert_portable_payload(set(sdist_payload))

    source_payload = {
        path: (REPO_ROOT / path).read_bytes() for path in _expected_payload()
    }
    assert wheel_payload == source_payload
    assert sdist_payload == source_payload

    required_legacy_assets = {
        "hermes_cli/web_dist/index.html",
        "hermes_cli/tui_dist/entry.js",
        "hermes_cli/scripts/install.sh",
        "hermes_cli/scripts/install.ps1",
    }
    with zipfile.ZipFile(wheel) as archive:
        wheel_names = set(archive.namelist())
        missing = sorted(required_legacy_assets - wheel_names)
        assert not missing, f"wheel is missing production assets: {missing}"
        for name in required_legacy_assets:
            assert archive.getinfo(name).file_size > 0, f"wheel asset is empty: {name}"

    with tarfile.open(sdist, "r:gz") as archive:
        members = [member for member in archive.getmembers() if member.isfile()]
        roots = {
            member.name.split("/", 1)[0]
            for member in members
            if "/" in member.name
        }
        assert len(roots) == 1
        root = roots.pop()
        sdist_members = {
            member.name.removeprefix(f"{root}/"): member for member in members
        }
        missing = sorted(required_legacy_assets - set(sdist_members))
        assert not missing, f"sdist is missing production assets: {missing}"
        for name in required_legacy_assets:
            assert sdist_members[name].size > 0, f"sdist asset is empty: {name}"


def test_clean_venv_install_places_seed_beside_hermes_cli(tmp_path: Path) -> None:
    wheel = _one_artifact("*.whl")
    environment = tmp_path / "artifact-venv"
    venv.EnvBuilder(with_pip=True, clear=True).create(environment)
    if os.name == "nt":
        python = environment / "Scripts" / "python.exe"
    else:
        python = environment / "bin" / "python"

    install = subprocess.run(
        [str(python), "-m", "pip", "install", "--no-deps", str(wheel)],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert install.returncode == 0, install.stdout + install.stderr

    clean_env = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
    clean_env["HERMES_HOME"] = str(tmp_path / "hermes-home")
    probe = subprocess.run(
        [
            str(python),
            "-c",
            (
                "from pathlib import Path; import hermes_cli; "
                "print(Path(hermes_cli.__file__).resolve().parent.parent)"
            ),
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
        cwd=tmp_path,
        env=clean_env,
    )
    assert probe.returncode == 0, probe.stdout + probe.stderr
    project_root = Path(probe.stdout.strip())
    installed_paths = {
        path.relative_to(project_root)
        for path in (project_root / PORTABLE_ROOT).rglob("*")
        if path.is_file()
    }
    _assert_portable_payload(installed_paths)

    cache_contract = subprocess.run(
        [
            str(python),
            "-c",
            (
                "import os; from pathlib import Path; import hermes_cli; "
                "from hermes_cli.opentui_runtime import ("
                "packaged_runtime_current, packaged_seed, select_runtime_location); "
                "root=Path(hermes_cli.__file__).resolve().parent.parent; "
                "seed_dir=root/'ui-opentui'; "
                "state=Path(os.environ['HERMES_HOME'])/'cache'/'opentui-runtime'; "
                "seed=packaged_seed(seed_dir); assert seed is not None; "
                "location=select_runtime_location(root,state); assert location is not None; "
                "assert location.is_packaged; assert location.seed_dir==seed_dir; "
                "assert location.runtime_dir==state/'artifacts'/seed.source_key/'runtime'; "
                "assert not packaged_runtime_current(location); assert not state.exists()"
            ),
        ],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
        cwd=tmp_path,
        env=clean_env,
    )
    assert cache_contract.returncode == 0, cache_contract.stdout + cache_contract.stderr

    if os.environ.get("HERMES_RELEASE_HYDRATE_OPENTUI") == "1":
        hydrated = subprocess.run(
            [str(python), "-c", HYDRATE_INSTALLED_SEED],
            capture_output=True,
            text=True,
            timeout=480,
            check=False,
            cwd=tmp_path,
            env=clean_env,
        )
        assert hydrated.returncode == 0, hydrated.stdout + hydrated.stderr
