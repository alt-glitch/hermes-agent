"""Release-channel contract for the portable OpenTUI wheel/sdist seed.

The Python distribution may carry JavaScript source and a prebuilt bundle, but
it must remain ``py3-none-any``: npm selects and installs the host's native
``@opentui/core-<platform>`` package later in the launcher's transactional
runtime cache.  Set ``HERMES_RELEASE_ARTIFACT_DIR`` to exercise the built
archives and a clean-venv install; metadata checks run in the normal suite.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tarfile
import textwrap
import tomllib
import venv
import zipfile
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
PORTABLE_ROOT = Path("ui-opentui")
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
    success, result = refresh_packaged_runtime(
        location,
        identity=identity,
        npm=npm,
        env=build_environment(node),
        runner=bounded_runner,
    )
assert success, f"{result.stdout}\n{result.stderr}"
assert packaged_runtime_current(location)
assert (location.runtime_dir / "dist" / "main.js").stat().st_size > 0
assert runtime_payload_present(location.runtime_dir, identity)
assert runtime_sentinels_current(location.runtime_dir, identity)
assert dependencies_current(location.runtime_dir, identity)
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


def test_publish_workflow_preserves_exact_tag_and_draft_release_contract() -> None:
    publish = (
        REPO_ROOT / ".github" / "workflows" / "upload_to_pypi.yml"
    ).read_text(encoding="utf-8")
    docker = (REPO_ROOT / ".github" / "workflows" / "docker.yml").read_text(
        encoding="utf-8"
    )
    site = (REPO_ROOT / ".github" / "workflows" / "deploy-site.yml").read_text(
        encoding="utf-8"
    )

    def between(name: str, next_name: str | None) -> str:
        section = publish.split(f"\n  {name}:", 1)[1]
        if next_name is not None:
            section = section.split(f"\n  {next_name}:", 1)[0]
        return section

    validate_job = between("validate-source", "build")
    build_job = between("build", "stage-release-assets")
    stage_job = between("stage-release-assets", "verify-opentui")
    verify_job = between("verify-opentui", "sign")
    sign_job = between("sign", "publish")
    pypi_job = between("publish", "docker-release")
    docker_caller = between("docker-release", "site-release")
    site_caller = between("site-release", "publish-github-release")
    final_job = between("publish-github-release", "request-vercel-deploy")
    vercel_job = between("request-vercel-deploy", None)

    assert "skip_sign" not in publish
    assert (
        "ref: ${{ inputs.confirm_tag != '' && "
        "format('refs/tags/{0}', inputs.confirm_tag) || github.ref }}"
    ) in validate_job
    assert "datetime.date(year, month, day)" in validate_job
    assert 'git rev-parse "refs/tags/$RELEASE_TAG^{commit}"' in validate_job
    assert "release_sha=$release_sha" in validate_job
    assert "release_tag=$RELEASE_TAG" in validate_job

    assert "needs: validate-source" in build_job
    assert "ref: ${{ needs.validate-source.outputs.release_sha }}" in build_job
    assert "SOURCE_DATE_EPOCH=" in build_job
    for required in (
        "Build web dashboard",
        "Build TUI bundle",
        "Build portable OpenTUI seed",
        "Bundle install scripts into wheel",
        "Verify complete portable artifacts in a clean venv",
        "candidate-python-package-distributions",
    ):
        assert required in build_job
    assert "overwrite: true" in build_job

    assert "needs: [validate-source, build]" in stage_job
    assert "Wait for unpublished GitHub Release" in stage_job
    assert 'if [ "$release_state" = "false" ]' in stage_job
    assert '"commit": os.environ["RELEASE_SHA"]' in stage_job
    assert '"sha256": hashlib.sha256(payload).hexdigest()' in stage_job
    assert "manifest_count" in stage_job
    distribution_upload = next(
        line
        for line in stage_job.splitlines()
        if 'gh release upload "$RELEASE_TAG" "${wheels[0]}"' in line
    )
    assert "--clobber" not in distribution_upload
    assert stage_job.index(distribution_upload) < stage_job.index(
        'gh release upload "$RELEASE_TAG" "candidate-meta/$manifest_name"'
    )
    assert "canonical manifest commit mismatch" in stage_job
    assert "canonical digest mismatch" in stage_job
    assert "unexpected distribution assets" in stage_job
    assert "canonical-python-package-distributions" in stage_job
    assert "overwrite: true" in stage_job

    for runner, platform, arch in (
        ("ubuntu-24.04", "linux", "x64"),
        ("ubuntu-24.04-arm", "linux", "arm64"),
        ("macos-15-intel", "darwin", "x64"),
        ("macos-15", "darwin", "arm64"),
    ):
        matrix_row = (
            f"runner: {runner}\n"
            f"            platform: {platform}\n"
            f"            arch: {arch}"
        )
        assert matrix_row in verify_job
    assert "needs: stage-release-assets" in verify_job
    assert "canonical-python-package-distributions" in verify_job
    assert "test_clean_venv_install_places_seed_beside_hermes_cli" in verify_job

    assert "needs: [stage-release-assets, verify-opentui]" in sign_job
    assert "Verify release remains a draft" in sign_job
    assert "Sign with Sigstore" in sign_job
    assert "dist/*.sigstore.json" in sign_job
    assert '"${wheels[0]}"' not in sign_job

    assert "needs: [stage-release-assets, sign]" in pypi_job
    assert "Revalidate release tag before first public upload" in pypi_job
    assert 'if [ "$current_tag_sha" != "$RELEASE_SHA" ]' in pypi_job
    assert "skip-existing: true" in pypi_job
    assert "Verify PyPI serves the canonical SHA256 values" in pypi_job
    assert "PyPI digest mismatch" in pypi_job

    for caller, workflow in (
        (docker_caller, "docker.yml"),
        (site_caller, "deploy-site.yml"),
    ):
        assert "publish" in caller.split("needs:", 1)[1].splitlines()[0]
        assert f"uses: ./.github/workflows/{workflow}" in caller
        assert "release_tag: ${{ needs.stage-release-assets.outputs.release_tag }}" in caller
        assert "release_sha: ${{ needs.stage-release-assets.outputs.release_sha }}" in caller

    assert "needs: [stage-release-assets, docker-release, site-release]" in final_job
    assert 'git fetch --force origin "+refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"' in final_job
    assert 'if [ "$current_tag_sha" != "$RELEASE_SHA" ]' in final_job
    assert "Reconcile canonical bytes with current draft assets" in final_job
    assert 'verify_directory("Actions canonical", Path("canonical"))' in final_job
    assert 'verify_directory("draft release", Path("draft"))' in final_job
    assert "final release manifest commit mismatch" in final_job
    assert "Sigstore subject digest mismatch" in final_job
    assert 'gh release edit "$RELEASE_TAG"' in final_job
    assert "--draft=false --verify-tag" in final_job
    assert "needs: publish-github-release" in vercel_job
    assert "branch-bound" in vercel_job
    assert "curl --fail-with-body" in vercel_job

    assert "workflow_call:" in docker
    assert "release_sha:" in docker
    assert "ref: ${{ inputs.release_sha || github.sha }}" in docker
    assert "Tag $RELEASE_TAG moved from $RELEASE_SHA" in docker
    assert "HERMES_GIT_SHA=${{ steps.source.outputs.sha }}" in docker
    assert "org.opencontainers.image.revision=${{ steps.source.outputs.sha }}" in docker
    assert "overwrite: true" in docker
    assert docker.index("Run docker integration tests") < docker.index(
        "Push ${{ matrix.arch }} by digest"
    )
    assert docker.index("Revalidate release tag before manifest publication") < docker.index(
        "Create manifest list and push"
    )

    assert "workflow_call:" in site
    assert "release_sha:" in site
    assert "release_publish:" not in site
    assert "ref: ${{ inputs.release_sha || github.sha }}" in site
    assert "Tag $RELEASE_TAG moved from $RELEASE_SHA" in site
    assert "inputs.release_sha == ''" in site
    assert "github-pages-${{ github.run_attempt }}" in site
    assert "artifact_name: github-pages-${{ github.run_attempt }}" in site
    assert "Revalidate release tag before Pages deployment" in site


def test_final_release_reconciliation_executes_against_real_bytes(
    tmp_path: Path,
) -> None:
    workflow = (
        REPO_ROOT / ".github" / "workflows" / "upload_to_pypi.yml"
    ).read_text(encoding="utf-8")
    final_job = workflow.split("\n  publish-github-release:", 1)[1].split(
        "\n  request-vercel-deploy:", 1
    )[0]
    embedded = final_job.split("python3 - <<'PY'", 1)[1].split(
        "\n          PY", 1
    )[0]
    validator = textwrap.dedent(embedded).strip() + "\n"

    canonical = tmp_path / "canonical"
    draft = tmp_path / "draft"
    canonical.mkdir()
    draft.mkdir()
    payloads = {
        "hermes_agent-1.2.3-py3-none-any.whl": b"portable-wheel",
        "hermes_agent-1.2.3.tar.gz": b"portable-sdist",
    }
    rows = []
    for name, payload in payloads.items():
        (canonical / name).write_bytes(payload)
        (draft / name).write_bytes(payload)
        rows.append(
            {
                "name": name,
                "size": len(payload),
                "sha256": __import__("hashlib").sha256(payload).hexdigest(),
            }
        )

    release_tag = "v2026.7.11"
    release_sha = "a" * 40
    manifest_name = "hermes-release-2026.7.11-manifest.json"
    (draft / manifest_name).write_text(
        json.dumps(
            {
                "schema": 1,
                "tag": release_tag,
                "commit": release_sha,
                "assets": rows,
            }
        ),
        encoding="utf-8",
    )
    for row in rows:
        name = row["name"]
        digest = bytes.fromhex(row["sha256"])
        bundle = {
            "messageSignature": {
                "messageDigest": {
                    "algorithm": "SHA2_256",
                    "digest": base64.b64encode(digest).decode("ascii"),
                }
            }
        }
        (draft / f"{name}.sigstore.json").write_text(
            json.dumps(bundle),
            encoding="utf-8",
        )
    environment = {
        **os.environ,
        "MANIFEST_NAME": manifest_name,
        "RELEASE_SHA": release_sha,
        "RELEASE_TAG": release_tag,
    }

    valid = subprocess.run(
        [sys.executable, "-c", validator],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert valid.returncode == 0, valid.stdout + valid.stderr

    (draft / "hermes_agent-1.2.3-py3-none-any.whl").write_bytes(b"mutated")
    mutated = subprocess.run(
        [sys.executable, "-c", validator],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert mutated.returncode != 0
    assert "draft release" in mutated.stdout + mutated.stderr
    assert "mismatch" in mutated.stdout + mutated.stderr


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


