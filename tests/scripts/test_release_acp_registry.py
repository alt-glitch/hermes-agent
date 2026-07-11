"""Focused tests for version bumps and artifacts in scripts/release.py.

The official ACP Registry manifest must match ``pyproject.toml`` exactly —
``tests/acp/test_registry_manifest.py`` enforces this at lint time, and the
upstream registry CI rejects ``@latest`` / floating pins. The release script
is the single place that bumps the manifest in lockstep with pyproject; if
that bump ever silently breaks, weekly releases fail the manifest test
until someone hand-edits the JSON.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import subprocess
import tarfile
import zipfile
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest


def _load_release_module(monkeypatch, tmp_root: Path):
    """Import scripts/release.py with REPO_ROOT pinned to a temp tree."""
    spec = importlib.util.spec_from_file_location(
        "_release_under_test",
        Path(__file__).resolve().parents[2] / "scripts" / "release.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    monkeypatch.setattr(module, "REPO_ROOT", tmp_root)
    monkeypatch.setattr(
        module, "ACP_REGISTRY_MANIFEST", tmp_root / "acp_registry" / "agent.json"
    )
    return module


@pytest.mark.parametrize(
    ("raw", "normalized"),
    [
        ("2000.2.29", "2000.2.29"),
        ("2026.07.01", "2026.7.1"),
        ("2099.12.31", "2099.12.31"),
    ],
)
def test_release_date_parser_accepts_real_20xx_dates(
    monkeypatch, tmp_path, raw, normalized
):
    module = _load_release_module(monkeypatch, tmp_path)
    assert module.parse_release_date(raw) == normalized


@pytest.mark.parametrize(
    "raw",
    ["1999.12.31", "2100.1.1", "2026-7-11", "2026.2.29", "2024.13.1", "2024.1.0", "2024.1.1.2"],
)
def test_release_date_parser_rejects_non_dates(monkeypatch, tmp_path, raw):
    module = _load_release_module(monkeypatch, tmp_path)
    with pytest.raises(module.argparse.ArgumentTypeError):
        module.parse_release_date(raw)


def test_repository_desktop_package_and_lock_versions_match():
    root = Path(__file__).resolve().parents[2]
    package = json.loads((root / "apps/desktop/package.json").read_text())
    lock = json.loads((root / "package-lock.json").read_text())
    assert lock["packages"]["apps/desktop"]["version"] == package["version"]


def _write_manifest(root: Path, version: str) -> None:
    manifest_dir = root / "acp_registry"
    manifest_dir.mkdir(parents=True)
    (manifest_dir / "agent.json").write_text(
        json.dumps(
            {
                "id": "hermes-agent",
                "name": "Hermes Agent",
                "version": version,
                "description": "test",
                "distribution": {
                    "uvx": {
                        "package": f"hermes-agent[acp]=={version}",
                        "args": ["hermes-acp"],
                    }
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def _write_release_archives(
    root: Path,
    version: str,
    *,
    wheel_bundle: bytes | None = b"opentui bundle",
    sdist_bundle: bytes | None = b"opentui bundle",
) -> list[Path]:
    """Write minimal wheel/sdist fixtures with optional OpenTUI bundles."""
    root.mkdir(parents=True, exist_ok=True)
    wheel = root / f"hermes_agent-{version}-py3-none-any.whl"
    with zipfile.ZipFile(wheel, mode="w") as archive:
        archive.writestr("hermes_agent/__init__.py", "")
        if wheel_bundle is not None:
            archive.writestr("ui-opentui/dist/main.js", wheel_bundle)

    sdist = root / f"hermes_agent-{version}.tar.gz"
    with tarfile.open(sdist, mode="w:gz") as archive:
        package = f"hermes_agent-{version}"
        payloads = {f"{package}/pyproject.toml": b"[project]\n"}
        if sdist_bundle is not None:
            payloads[f"{package}/ui-opentui/dist/main.js"] = sdist_bundle
        for name, payload in payloads.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
    return [wheel, sdist]


def test_update_acp_registry_versions_bumps_manifest_and_pin(monkeypatch, tmp_path):
    _write_manifest(tmp_path, "0.13.0")
    module = _load_release_module(monkeypatch, tmp_path)

    module._update_acp_registry_versions("0.14.0")

    manifest = json.loads(
        (tmp_path / "acp_registry" / "agent.json").read_text(encoding="utf-8")
    )
    assert manifest["version"] == "0.14.0"
    assert manifest["distribution"]["uvx"]["package"] == "hermes-agent[acp]==0.14.0"
    # args stay untouched so we don't accidentally rewrite them.
    assert manifest["distribution"]["uvx"]["args"] == ["hermes-acp"]


def test_update_acp_registry_versions_is_silent_when_manifest_missing(
    monkeypatch, tmp_path
):
    """Older release branches predate the ACP Registry asset — must no-op."""
    module = _load_release_module(monkeypatch, tmp_path)

    # No fixture written; function should not raise.
    module._update_acp_registry_versions("0.14.0")


def test_update_version_files_bumps_manifest_alongside_pyproject(
    monkeypatch, tmp_path
):
    """End-to-end: update_version_files() is the function release.py actually
    calls, so it must drive the manifest bump too."""
    _write_manifest(tmp_path, "0.13.0")
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "hermes-agent"\nversion = "0.13.0"\n', encoding="utf-8"
    )
    version_dir = tmp_path / "hermes_cli"
    version_dir.mkdir()
    (version_dir / "__init__.py").write_text(
        '__version__ = "0.13.0"\n__release_date__ = "2026-05-14"\n',
        encoding="utf-8",
    )

    module = _load_release_module(monkeypatch, tmp_path)
    monkeypatch.setattr(module, "VERSION_FILE", version_dir / "__init__.py")
    monkeypatch.setattr(module, "PYPROJECT_FILE", tmp_path / "pyproject.toml")

    module.update_version_files("0.14.0", "2026-05-21")

    pyproject_text = (tmp_path / "pyproject.toml").read_text(encoding="utf-8")
    assert 'version = "0.14.0"' in pyproject_text

    manifest = json.loads(
        (tmp_path / "acp_registry" / "agent.json").read_text(encoding="utf-8")
    )
    assert manifest["version"] == "0.14.0"
    assert manifest["distribution"]["uvx"]["package"] == "hermes-agent[acp]==0.14.0"


def test_prepare_opentui_release_bundle_uses_production_runtime_helpers(
    monkeypatch, tmp_path
):
    module = _load_release_module(monkeypatch, tmp_path)
    app_dir = tmp_path / "ui-opentui"
    app_dir.mkdir()
    identity = object()
    runner = object()
    events = []

    @contextmanager
    def refresh_lock(root):
        events.append(("lock", root))
        yield
        events.append(("unlock", root))

    def inspect_runtime(root, selected, *, rebuild_requested, env):
        events.append(("inspect", root, selected, rebuild_requested, env))
        return SimpleNamespace(dependency_refresh_required=False)

    def build_bundle(root, *, npm, env, runner):
        events.append(("build", root, npm, env, runner))
        (root / "dist").mkdir()
        (root / "dist" / "main.js").write_bytes(b"production bundle")
        return True, subprocess.CompletedProcess(npm, 0, stdout="built", stderr="")

    runtime = SimpleNamespace(
        npm_command=lambda node: [node, "/node26/npm-cli.js"],
        build_environment=lambda node: {"NODE": node},
        refresh_lock=refresh_lock,
        recover_interrupted_promotion=lambda root: events.append(("recover", root)),
        inspect_runtime=inspect_runtime,
        refresh_runtime=lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("dependency refresh was not required")
        ),
        build_bundle=build_bundle,
        failure_preview=lambda result: result.stderr,
        packaged_seed=lambda root: events.append(("seed", root))
        or SimpleNamespace(bundle_digest="seed-digest"),
        runtime_sentinels_current=lambda root, selected: (
            events.append(("sentinels", root, selected)) or True
        ),
    )
    identity_calls = []
    hermes_main = SimpleNamespace(
        _node26_bin_or_none=lambda: "/node26/bin/node",
        _opentui_node_identity=lambda node, *, report_error: (
            identity_calls.append((node, report_error)) or identity
        ),
        _run_with_idle_timeout=runner,
    )
    monkeypatch.setattr(
        module,
        "_load_opentui_release_helpers",
        lambda: (runtime, hermes_main),
    )

    result = module._with_prepared_opentui_release_bundle(
        lambda action_runner, digest: events.append(
            ("action", app_dir, action_runner, digest)
        )
        or "artifacts"
    )

    assert result == "artifacts"
    assert identity_calls == [
        ("/node26/bin/node", False),
        ("/node26/bin/node", False),
    ]
    assert ("inspect", app_dir, identity, True, {"NODE": "/node26/bin/node"}) in events
    assert (
        "build",
        app_dir,
        ["/node26/bin/node", "/node26/npm-cli.js"],
        {"NODE": "/node26/bin/node"},
        runner,
    ) in events
    assert ("sentinels", app_dir, identity) in events
    action_event = ("action", app_dir, runner, "seed-digest")
    assert action_event in events
    assert events.index(action_event) < events.index(("unlock", app_dir))


def test_prepare_opentui_release_bundle_refreshes_stale_dependencies(
    monkeypatch, tmp_path
):
    module = _load_release_module(monkeypatch, tmp_path)
    app_dir = tmp_path / "ui-opentui"
    app_dir.mkdir()
    identity = object()
    calls = []

    @contextmanager
    def refresh_lock(root):
        yield

    def refresh_runtime(root, *, identity, npm, env, runner):
        calls.append((root, identity, npm, env, runner))
        (root / "dist").mkdir()
        (root / "dist" / "main.js").write_bytes(b"refreshed bundle")
        return True, subprocess.CompletedProcess(npm, 0, stdout="built", stderr="")

    runtime = SimpleNamespace(
        npm_command=lambda node: [node, "npm-cli.js"],
        build_environment=lambda node: {"NODE": node},
        refresh_lock=refresh_lock,
        recover_interrupted_promotion=lambda root: None,
        inspect_runtime=lambda *args, **kwargs: SimpleNamespace(
            dependency_refresh_required=True
        ),
        refresh_runtime=refresh_runtime,
        build_bundle=lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("stale dependencies require npm ci")
        ),
        failure_preview=lambda result: result.stderr,
        packaged_seed=lambda root: SimpleNamespace(bundle_digest="seed-digest"),
        runtime_sentinels_current=lambda root, selected: True,
    )
    runner = object()
    hermes_main = SimpleNamespace(
        _node26_bin_or_none=lambda: "/node26",
        _opentui_node_identity=lambda node, *, report_error: identity,
        _run_with_idle_timeout=runner,
    )
    monkeypatch.setattr(
        module,
        "_load_opentui_release_helpers",
        lambda: (runtime, hermes_main),
    )

    assert (
        module._with_prepared_opentui_release_bundle(
            lambda action_runner, digest: (action_runner, digest)
        )
        == (runner, "seed-digest")
    )
    assert calls == [
        (app_dir, identity, ["/node26", "npm-cli.js"], {"NODE": "/node26"}, runner)
    ]


def test_prepare_opentui_release_bundle_fails_closed_without_node(
    monkeypatch, tmp_path
):
    module = _load_release_module(monkeypatch, tmp_path)
    runtime = SimpleNamespace(
        npm_command=lambda node: (_ for _ in ()).throw(
            AssertionError("npm must not be inspected without Node 26")
        )
    )
    hermes_main = SimpleNamespace(_node26_bin_or_none=lambda: None)
    monkeypatch.setattr(
        module,
        "_load_opentui_release_helpers",
        lambda: (runtime, hermes_main),
    )

    assert (
        module._with_prepared_opentui_release_bundle(
            lambda action_runner, digest: True
        )
        is None
    )


def test_prepare_opentui_release_bundle_fails_if_dist_cleanup_is_incomplete(
    monkeypatch, tmp_path
):
    module = _load_release_module(monkeypatch, tmp_path)
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "hermes_agent-1.2.3-py3-none-any.whl").write_bytes(b"stale")
    identity = object()

    @contextmanager
    def refresh_lock(root):
        yield

    runtime = SimpleNamespace(
        npm_command=lambda node: [node, "npm-cli.js"],
        build_environment=lambda node: {},
        refresh_lock=refresh_lock,
    )
    hermes_main = SimpleNamespace(
        _node26_bin_or_none=lambda: "/node26",
        _opentui_node_identity=lambda node, *, report_error: identity,
        _run_with_idle_timeout=object(),
    )
    monkeypatch.setattr(
        module,
        "_load_opentui_release_helpers",
        lambda: (runtime, hermes_main),
    )
    monkeypatch.setattr(module.shutil, "rmtree", lambda path: None)
    action_calls = []

    result = module._with_prepared_opentui_release_bundle(
        lambda runner, digest: action_calls.append((runner, digest))
    )

    assert result is None
    assert action_calls == []
    assert dist.exists()


def test_prepare_opentui_release_bundle_rejects_empty_output(monkeypatch, tmp_path):
    module = _load_release_module(monkeypatch, tmp_path)
    app_dir = tmp_path / "ui-opentui"
    app_dir.mkdir()
    identity = object()

    @contextmanager
    def refresh_lock(root):
        yield

    def build_bundle(root, **kwargs):
        (root / "dist").mkdir()
        (root / "dist" / "main.js").write_bytes(b"")
        return True, subprocess.CompletedProcess([], 0, stdout="", stderr="")

    runtime = SimpleNamespace(
        npm_command=lambda node: [node, "npm-cli.js"],
        build_environment=lambda node: {},
        refresh_lock=refresh_lock,
        recover_interrupted_promotion=lambda root: None,
        inspect_runtime=lambda *args, **kwargs: SimpleNamespace(
            dependency_refresh_required=False
        ),
        build_bundle=build_bundle,
        failure_preview=lambda result: "",
        packaged_seed=lambda root: (_ for _ in ()).throw(
            AssertionError("empty bundles are rejected before seed validation")
        ),
        runtime_sentinels_current=lambda root, selected: True,
    )
    hermes_main = SimpleNamespace(
        _node26_bin_or_none=lambda: "/node26",
        _opentui_node_identity=lambda node, *, report_error: identity,
        _run_with_idle_timeout=object(),
    )
    monkeypatch.setattr(
        module,
        "_load_opentui_release_helpers",
        lambda: (runtime, hermes_main),
    )

    assert (
        module._with_prepared_opentui_release_bundle(
            lambda action_runner, digest: True
        )
        is None
    )


def test_build_release_artifacts_prebuilds_and_verifies_both_archives(
    monkeypatch, tmp_path
):
    module = _load_release_module(monkeypatch, tmp_path)
    events = []
    bundle_digest = hashlib.sha256(b"opentui bundle").hexdigest()
    monkeypatch.setattr(
        module,
        "_with_prepared_opentui_release_bundle",
        lambda action: events.append("opentui") or action(run, bundle_digest),
    )
    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/uv")

    def run(cmd, *, cwd):
        events.append(("python-build", cmd, cwd))
        _write_release_archives(tmp_path / "dist", "1.2.3")
        return subprocess.CompletedProcess(cmd, 0, stdout="built", stderr="")

    artifacts = module.build_release_artifacts("1.2.3")

    assert events[0] == "opentui"
    assert events[1][0] == "python-build"
    assert events[1][1] == [
        "/usr/bin/uv",
        "build",
        "--sdist",
        "--wheel",
        "--clear",
        "--no-build-logs",
        "--no-create-gitignore",
    ]
    assert {artifact.name for artifact in artifacts} == {
        "hermes_agent-1.2.3-py3-none-any.whl",
        "hermes_agent-1.2.3.tar.gz",
    }


def test_release_wheel_name_accepts_optional_build_tag_for_exact_version(
    monkeypatch, tmp_path
):
    module = _load_release_module(monkeypatch, tmp_path)

    assert module._is_target_release_wheel(
        "hermes_agent-1.2.3-py3-none-any.whl", "1.2.3"
    )
    assert module._is_target_release_wheel(
        "hermes_agent-1.2.3-1-py3-none-any.whl", "1.2.3"
    )
    assert not module._is_target_release_wheel(
        "hermes_agent-1.2.4-py3-none-any.whl", "1.2.3"
    )


def test_build_release_artifacts_never_runs_python_build_after_opentui_failure(
    monkeypatch, tmp_path
):
    module = _load_release_module(monkeypatch, tmp_path)
    monkeypatch.setattr(
        module, "_with_prepared_opentui_release_bundle", lambda action: None
    )
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("Python build must not run after OpenTUI failure")
        ),
    )

    assert module.build_release_artifacts("1.2.3") == []


def test_build_release_artifacts_discards_archives_missing_opentui_bundle(
    monkeypatch, tmp_path
):
    module = _load_release_module(monkeypatch, tmp_path)
    bundle_digest = hashlib.sha256(b"opentui bundle").hexdigest()
    monkeypatch.setattr(
        module,
        "_with_prepared_opentui_release_bundle",
        lambda action: action(run, bundle_digest),
    )
    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/uv")

    def run(cmd, **kwargs):
        _write_release_archives(tmp_path / "dist", "1.2.3", sdist_bundle=None)
        return subprocess.CompletedProcess(cmd, 0, stdout="built", stderr="")

    assert module.build_release_artifacts("1.2.3") == []
    assert not (tmp_path / "dist").exists()


def test_build_release_artifacts_rejects_stale_duplicate_target_wheel(
    monkeypatch, tmp_path
):
    module = _load_release_module(monkeypatch, tmp_path)
    bundle = b"opentui bundle"
    bundle_digest = hashlib.sha256(bundle).hexdigest()

    def run(cmd, *, cwd):
        dist = tmp_path / "dist"
        _write_release_archives(dist, "1.2.3", wheel_bundle=bundle, sdist_bundle=bundle)
        with zipfile.ZipFile(
            dist / "hermes_agent-1.2.3-1-py3-none-any.whl", mode="w"
        ) as archive:
            archive.writestr("ui-opentui/dist/main.js", bundle)
        return subprocess.CompletedProcess(cmd, 0, stdout="built", stderr="")

    monkeypatch.setattr(
        module,
        "_with_prepared_opentui_release_bundle",
        lambda action: action(run, bundle_digest),
    )
    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/uv")

    assert module.build_release_artifacts("1.2.3") == []
    assert not (tmp_path / "dist").exists()


def test_build_release_artifacts_handles_bounded_runner_timeout(
    monkeypatch, tmp_path
):
    module = _load_release_module(monkeypatch, tmp_path)

    def timeout_runner(cmd, *, cwd):
        raise subprocess.TimeoutExpired(cmd, timeout=180)

    monkeypatch.setattr(
        module,
        "_with_prepared_opentui_release_bundle",
        lambda action: action(timeout_runner, "seed-digest"),
    )
    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/uv")

    assert module.build_release_artifacts("1.2.3") == []


def test_release_artifact_validation_rejects_empty_or_missing_archive_kind(
    monkeypatch, tmp_path
):
    module = _load_release_module(monkeypatch, tmp_path)
    wheel, sdist = _write_release_archives(tmp_path / "dist", "1.2.3", wheel_bundle=b"")
    bundle_digest = hashlib.sha256(b"opentui bundle").hexdigest()

    assert (
        module._release_artifacts_have_opentui_bundle(
            [wheel, sdist], bundle_digest
        )
        is False
    )
    assert (
        module._release_artifacts_have_opentui_bundle([sdist], bundle_digest)
        is False
    )


def test_release_artifact_validation_rejects_bundle_digest_mismatch(
    monkeypatch, tmp_path
):
    module = _load_release_module(monkeypatch, tmp_path)
    wheel, sdist = _write_release_archives(
        tmp_path / "dist",
        "1.2.3",
        wheel_bundle=b"different bundle",
        sdist_bundle=b"different bundle",
    )
    expected_digest = hashlib.sha256(b"locked source bundle").hexdigest()

    assert (
        module._release_artifacts_have_opentui_bundle(
            [wheel, sdist], expected_digest
        )
        is False
    )


def test_publish_aborts_before_tag_when_release_artifacts_are_missing(
    monkeypatch, tmp_path, capsys
):
    module = _load_release_module(monkeypatch, tmp_path)
    monkeypatch.setattr(
        module.sys,
        "argv",
        [
            "release.py",
            "--publish",
            "--first-release",
            "--date",
            "2026.7.11",
        ],
    )
    monkeypatch.setattr(
        module,
        "next_available_tag",
        lambda base: (base, "2026.7.11"),
    )
    monkeypatch.setattr(module, "get_current_version", lambda: "1.2.3")
    monkeypatch.setattr(module, "get_last_tag", lambda **kwargs: None)
    monkeypatch.setattr(
        module,
        "get_commits",
        lambda since_tag, **kwargs: [{"github_author": "@release-tester"}],
    )
    monkeypatch.setattr(module, "generate_changelog", lambda *args, **kwargs: "notes")
    monkeypatch.setattr(module, "build_release_artifacts", lambda version: [])
    git_calls = []
    monkeypatch.setattr(
        module,
        "git_result",
        lambda *args, **kwargs: git_calls.append(args)
        or subprocess.CompletedProcess(args, 0, stdout="", stderr=""),
    )

    result = module.main()

    assert result == 1
    assert git_calls == [
        ("status", "--porcelain=v1", "--untracked-files=normal")
    ]
    assert not (tmp_path / ".release_notes.md").exists()
    assert "Refusing to publish" in capsys.readouterr().out


def test_publish_aborts_before_github_release_when_push_fails(
    monkeypatch, tmp_path, capsys
):
    module = _load_release_module(monkeypatch, tmp_path)
    monkeypatch.setattr(
        module.sys,
        "argv",
        [
            "release.py",
            "--publish",
            "--first-release",
            "--date",
            "2026.7.11",
        ],
    )
    monkeypatch.setattr(
        module,
        "next_available_tag",
        lambda base: (base, "2026.7.11"),
    )
    monkeypatch.setattr(module, "get_current_version", lambda: "1.2.3")
    monkeypatch.setattr(module, "get_last_tag", lambda **kwargs: None)
    monkeypatch.setattr(
        module,
        "get_commits",
        lambda since_tag, **kwargs: [{"github_author": "@release-tester"}],
    )
    monkeypatch.setattr(module, "generate_changelog", lambda *args, **kwargs: "notes")
    artifacts = [tmp_path / "dist" / "hermes_agent-1.2.3-py3-none-any.whl"]
    monkeypatch.setattr(module, "build_release_artifacts", lambda version: artifacts)

    git_calls = []

    def git_result(*args, **kwargs):
        git_calls.append(args)
        if args[0] == "rev-parse":
            return subprocess.CompletedProcess(args, 0, stdout="a" * 40, stderr="")
        if args[0] == "push":
            return subprocess.CompletedProcess(args, 1, stdout="", stderr="denied")
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    monkeypatch.setattr(module, "git_result", git_result)
    monkeypatch.setattr(
        module.shutil,
        "which",
        lambda name: (_ for _ in ()).throw(
            AssertionError("gh must not be resolved after a failed push")
        ),
    )
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("gh release must not run after a failed push")
        ),
    )

    result = module.main()

    assert result == 1
    assert [call[0] for call in git_calls] == ["status", "status", "rev-parse", "tag", "push"]
    assert git_calls[-1] == (
        "push",
        "--atomic",
        "origin",
        "HEAD",
        "refs/tags/v2026.7.11",
    )
    assert not (tmp_path / ".release_notes.md").exists()
    assert (tmp_path / ".release_state.json").is_file()
    output = capsys.readouterr().out
    assert "Failed to push to origin: denied" in output
    assert "Continue manually after fixing access" in output
    assert "Retry with the exact same checkout and command" in output


def _configure_publish_main(monkeypatch, tmp_path, *, artifacts):
    module = _load_release_module(monkeypatch, tmp_path)
    monkeypatch.setattr(
        module.sys,
        "argv",
        [
            "release.py",
            "--publish",
            "--first-release",
            "--date",
            "2026.7.11",
        ],
    )
    monkeypatch.setattr(
        module,
        "next_available_tag",
        lambda base: (base, "2026.7.11"),
    )
    monkeypatch.setattr(module, "get_current_version", lambda: "1.2.3")
    monkeypatch.setattr(module, "get_last_tag", lambda **kwargs: None)
    monkeypatch.setattr(
        module,
        "get_commits",
        lambda since_tag, **kwargs: [{"github_author": "@release-tester"}],
    )
    monkeypatch.setattr(module, "generate_changelog", lambda *args, **kwargs: "notes")
    monkeypatch.setattr(module, "build_release_artifacts", lambda version: artifacts)
    return module


def test_publish_rejects_dirty_inputs_before_build(monkeypatch, tmp_path, capsys):
    module = _configure_publish_main(monkeypatch, tmp_path, artifacts=[])
    monkeypatch.setattr(
        module,
        "build_release_artifacts",
        lambda version: (_ for _ in ()).throw(
            AssertionError("artifact build must not run for dirty inputs")
        ),
    )
    git_calls = []
    monkeypatch.setattr(
        module,
        "git_result",
        lambda *args, **kwargs: git_calls.append(args)
        or subprocess.CompletedProcess(
            args, 0, stdout=" M ui-opentui/src/entry/main.tsx\n", stderr=""
        ),
    )

    assert module.main() == 1
    assert git_calls == [
        ("status", "--porcelain=v1", "--untracked-files=normal")
    ]
    assert "worktree is dirty before release preparation" in capsys.readouterr().out


def test_publish_rechecks_tree_after_artifact_preflight(
    monkeypatch, tmp_path, capsys
):
    artifact = tmp_path / "dist" / "hermes_agent-1.2.3-py3-none-any.whl"
    module = _configure_publish_main(monkeypatch, tmp_path, artifacts=[artifact])
    git_calls = []

    def git_result(*args, **kwargs):
        git_calls.append(args)
        status_count = sum(call[0] == "status" for call in git_calls)
        stdout = " M ui-opentui/dist/main.js\n" if status_count == 2 else ""
        return subprocess.CompletedProcess(args, 0, stdout=stdout, stderr="")

    monkeypatch.setattr(module, "git_result", git_result)

    assert module.main() == 1
    assert [call[0] for call in git_calls] == ["status", "status"]
    assert "worktree is dirty after artifact preflight" in capsys.readouterr().out


def test_publish_creates_notes_only_verified_draft_after_atomic_push(
    monkeypatch, tmp_path
):
    artifact = tmp_path / "dist" / "hermes_agent-1.2.3-py3-none-any.whl"
    module = _configure_publish_main(monkeypatch, tmp_path, artifacts=[artifact])
    git_calls = []
    monkeypatch.setattr(
        module,
        "git_result",
        lambda *args, **kwargs: git_calls.append(args)
        or subprocess.CompletedProcess(
            args,
            0,
            stdout="a" * 40 if args[0] == "rev-parse" else "",
            stderr="",
        ),
    )
    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/gh")
    process_calls = []

    def run(command, **kwargs):
        process_calls.append((command, kwargs))
        return subprocess.CompletedProcess(
            command,
            0,
            stdout="https://github.invalid/release/draft\n",
            stderr="",
        )

    monkeypatch.setattr(module.subprocess, "run", run)

    assert module.main() == 0
    assert [call[0] for call in git_calls] == ["status", "status", "rev-parse", "tag", "push"]
    assert git_calls[-1] == (
        "push",
        "--atomic",
        "origin",
        "HEAD",
        "refs/tags/v2026.7.11",
    )
    assert len(process_calls) == 1
    command, kwargs = process_calls[0]
    assert command == [
        "gh",
        "release",
        "create",
        "v2026.7.11",
        "--title",
        "Hermes Agent v1.2.3 (2026.7.11)",
        "--notes-file",
        str(tmp_path / ".release_notes.md"),
        "--draft",
        "--verify-tag",
    ]
    assert str(artifact) not in command
    assert kwargs["cwd"] == str(tmp_path)
    assert kwargs["timeout"] == 120
    assert not (tmp_path / ".release_notes.md").exists()
    assert not (tmp_path / ".release_state.json").exists()


def test_publish_returns_failure_and_keeps_notes_when_gh_times_out(
    monkeypatch, tmp_path, capsys
):
    artifact = tmp_path / "dist" / "hermes_agent-1.2.3-py3-none-any.whl"
    module = _configure_publish_main(monkeypatch, tmp_path, artifacts=[artifact])
    monkeypatch.setattr(
        module,
        "git_result",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args,
            0,
            stdout="a" * 40 if args[0] == "rev-parse" else "",
            stderr="",
        ),
    )
    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/gh")

    def time_out(command, **kwargs):
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    monkeypatch.setattr(module.subprocess, "run", time_out)

    assert module.main() == 1
    assert (tmp_path / ".release_notes.md").read_text(encoding="utf-8") == "notes"
    assert (tmp_path / ".release_state.json").is_file()
    assert "GitHub draft release failed" in capsys.readouterr().out


def test_publish_stages_every_file_changed_by_version_bump(monkeypatch, tmp_path):
    artifact = tmp_path / "dist" / "hermes_agent-1.2.4-py3-none-any.whl"
    module = _configure_publish_main(monkeypatch, tmp_path, artifacts=[artifact])
    module.sys.argv.extend(["--bump", "patch"])

    version_dir = tmp_path / "hermes_cli"
    version_dir.mkdir()
    version_file = version_dir / "__init__.py"
    version_file.write_text(
        '__version__ = "1.2.3"\n__release_date__ = "2026-07-04"\n',
        encoding="utf-8",
    )
    pyproject_file = tmp_path / "pyproject.toml"
    pyproject_file.write_text(
        '[project]\nname = "hermes-agent"\nversion = "1.2.3"\n',
        encoding="utf-8",
    )
    desktop_dir = tmp_path / "apps" / "desktop"
    desktop_dir.mkdir(parents=True)
    desktop_package = desktop_dir / "package.json"
    desktop_package.write_text(
        '{\n  "name": "hermes-desktop",\n  "version": "1.2.3"\n}\n',
        encoding="utf-8",
    )
    root_lock = tmp_path / "package-lock.json"
    root_lock.write_text(
        json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {"apps/desktop": {"version": "1.2.3"}},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    _write_manifest(tmp_path, "1.2.3")
    monkeypatch.setattr(module, "VERSION_FILE", version_file)
    monkeypatch.setattr(module, "PYPROJECT_FILE", pyproject_file)

    git_calls = []
    monkeypatch.setattr(
        module,
        "git_result",
        lambda *args, **kwargs: git_calls.append(args)
        or subprocess.CompletedProcess(args, 0, stdout="", stderr=""),
    )
    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/gh")
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda command, **kwargs: subprocess.CompletedProcess(
            command, 0, stdout="https://github.invalid/release/draft\n", stderr=""
        ),
    )

    assert module.main() == 0
    add_call = next(call for call in git_calls if call[0] == "add")
    assert set(add_call[1:]) == {
        str(version_file),
        str(pyproject_file),
        str(tmp_path / "acp_registry" / "agent.json"),
        str(desktop_package),
        str(root_lock),
    }
    assert any(call[0] == "commit" for call in git_calls)
    assert json.loads(desktop_package.read_text(encoding="utf-8"))["version"] == (
        "1.2.4"
    )
    lock = json.loads(root_lock.read_text(encoding="utf-8"))
    assert lock["packages"]["apps/desktop"]["version"] == "1.2.4"
    assert lock["packages"]["apps/desktop"]["version"] == json.loads(
        desktop_package.read_text(encoding="utf-8")
    )["version"]


def test_publish_retry_reuses_exact_bump_commit_tag_and_notes(
    monkeypatch, tmp_path, capsys
):
    """A failed gh attempt must not turn the retry into a second version bump."""
    version_dir = tmp_path / "hermes_cli"
    version_dir.mkdir()
    version_file = version_dir / "__init__.py"
    version_file.write_text(
        '__version__ = "1.2.3"\n__release_date__ = "2026-07-04"\n',
        encoding="utf-8",
    )
    pyproject_file = tmp_path / "pyproject.toml"
    pyproject_file.write_text(
        '[project]\nname = "hermes-agent"\nversion = "1.2.3"\n',
        encoding="utf-8",
    )
    desktop_dir = tmp_path / "apps" / "desktop"
    desktop_dir.mkdir(parents=True)
    desktop_package = desktop_dir / "package.json"
    desktop_package.write_text(
        json.dumps(
            {"name": "hermes-desktop", "version": "1.2.3"}, indent=2
        )
        + "\n",
        encoding="utf-8",
    )
    root_lock = tmp_path / "package-lock.json"
    root_lock.write_text(
        json.dumps(
            {
                "lockfileVersion": 3,
                "packages": {"apps/desktop": {"version": "1.2.3"}},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    _write_manifest(tmp_path, "1.2.3")

    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "release-test@example.invalid"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Release Test"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "initial"], cwd=tmp_path, check=True
    )

    module = _load_release_module(monkeypatch, tmp_path)
    monkeypatch.setattr(module, "VERSION_FILE", version_file)
    monkeypatch.setattr(module, "PYPROJECT_FILE", pyproject_file)
    monkeypatch.setattr(
        module.sys,
        "argv",
        [
            "release.py",
            "--publish",
            "--first-release",
            "--date",
            "2026.7.11",
            "--bump",
            "patch",
        ],
    )
    changelog_subjects = []

    def changelog(commits, *args, **kwargs):
        subjects = [commit["subject"] for commit in commits]
        changelog_subjects.append(subjects)
        return "\n".join(subjects)

    monkeypatch.setattr(module, "generate_changelog", changelog)
    artifact = tmp_path / "dist" / "hermes_agent-1.2.4-py3-none-any.whl"
    monkeypatch.setattr(
        module, "build_release_artifacts", lambda version: [artifact]
    )
    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/gh")

    real_run = subprocess.run
    gh_creates = 0

    def run(command, **kwargs):
        nonlocal gh_creates
        if command[:3] == ["gh", "release", "view"]:
            return subprocess.CompletedProcess(
                command, 1, stdout="", stderr="release not found"
            )
        if command[:3] == ["gh", "release", "create"]:
            gh_creates += 1
            return subprocess.CompletedProcess(
                command,
                1 if gh_creates == 1 else 0,
                stdout=(
                    "" if gh_creates == 1 else "https://github.invalid/draft\n"
                ),
                stderr="temporary failure" if gh_creates == 1 else "",
            )
        return real_run(command, **kwargs)

    monkeypatch.setattr(module.subprocess, "run", run)

    def git_result(*args, cwd=None):
        if args[0] == "push":
            return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
        if args[0] == "ls-remote":
            head = real_run(
                ["git", "rev-parse", "HEAD"],
                cwd=cwd or tmp_path,
                text=True,
                capture_output=True,
                check=True,
            ).stdout.strip()
            tag_object = real_run(
                ["git", "rev-parse", args[-2]],
                cwd=cwd or tmp_path,
                text=True,
                capture_output=True,
                check=True,
            ).stdout.strip()
            return subprocess.CompletedProcess(
                args,
                0,
                stdout=(
                    f"{tag_object}\t{args[-2]}\n"
                    f"{head}\t{args[-1]}\n"
                ),
                stderr="",
            )
        return real_run(
            ["git", *args],
            capture_output=True,
            text=True,
            cwd=cwd or tmp_path,
        )

    monkeypatch.setattr(module, "git_result", git_result)

    assert module.main() == 1
    first_head = real_run(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True, capture_output=True
    ).stdout.strip()
    assert (tmp_path / ".release_notes.md").read_text() == "initial"

    assert module.main() == 0
    second_head = real_run(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True, capture_output=True
    ).stdout.strip()
    assert changelog_subjects == [["initial"], ["initial"]]
    assert second_head == first_head
    assert module.get_current_version() == "1.2.4"
    assert gh_creates == 2
    assert not (tmp_path / ".release_notes.md").exists()
    assert real_run(
        ["git", "cat-file", "-t", "refs/tags/v2026.7.11"],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip() == "tag"
    assert "Resuming exact release bump v1.2.4" in capsys.readouterr().out


def test_resumable_release_accepts_double_digit_same_day_suffix(
    monkeypatch, tmp_path
):
    version_dir = tmp_path / "hermes_cli"
    version_dir.mkdir()
    version_file = version_dir / "__init__.py"
    version_file.write_text(
        '__version__ = "1.2.4"\n__release_date__ = "2026.7.11.10"\n',
        encoding="utf-8",
    )
    pyproject_file = tmp_path / "pyproject.toml"
    pyproject_file.write_text(
        '[project]\nname = "hermes-agent"\nversion = "1.2.4"\n',
        encoding="utf-8",
    )
    module = _load_release_module(monkeypatch, tmp_path)
    monkeypatch.setattr(module, "VERSION_FILE", version_file)
    monkeypatch.setattr(module, "PYPROJECT_FILE", pyproject_file)

    def git_result(*args, **kwargs):
        if args[:3] == ("show", "-s", "--format=%s"):
            return subprocess.CompletedProcess(
                args,
                0,
                stdout="chore: bump version to v1.2.4 (2026.7.11.10)\n",
                stderr="",
            )
        if args[:2] == ("show", "HEAD^:hermes_cli/__init__.py"):
            return subprocess.CompletedProcess(
                args, 0, stdout='__version__ = "1.2.3"\n', stderr=""
            )
        if args[0] == "diff-tree":
            return subprocess.CompletedProcess(
                args,
                0,
                stdout="hermes_cli/__init__.py\npyproject.toml\n",
                stderr="",
            )
        raise AssertionError(f"unexpected git call: {args}")

    monkeypatch.setattr(module, "git_result", git_result)

    assert module._resumable_release_bump(
        current_version="1.2.4", requested_date="2026.7.11", bump="patch"
    ) == "2026.7.11.10"


def test_version_bump_validates_desktop_lock_before_any_write(
    monkeypatch, tmp_path
):
    version_dir = tmp_path / "hermes_cli"
    version_dir.mkdir()
    version_file = version_dir / "__init__.py"
    original_version = (
        '__version__ = "1.2.3"\n__release_date__ = "2026-07-04"\n'
    )
    version_file.write_text(original_version, encoding="utf-8")
    pyproject_file = tmp_path / "pyproject.toml"
    original_pyproject = '[project]\nversion = "1.2.3"\n'
    pyproject_file.write_text(original_pyproject, encoding="utf-8")
    desktop_dir = tmp_path / "apps" / "desktop"
    desktop_dir.mkdir(parents=True)
    desktop_package = desktop_dir / "package.json"
    original_desktop = '{"name": "hermes-desktop", "version": "1.2.3"}\n'
    desktop_package.write_text(original_desktop, encoding="utf-8")
    root_lock = tmp_path / "package-lock.json"
    original_lock = '{"lockfileVersion": 3, "packages": {}}\n'
    root_lock.write_text(original_lock, encoding="utf-8")

    module = _load_release_module(monkeypatch, tmp_path)
    monkeypatch.setattr(module, "VERSION_FILE", version_file)
    monkeypatch.setattr(module, "PYPROJECT_FILE", pyproject_file)

    with pytest.raises(
        ValueError,
        match=r"package-lock.json is missing packages\['apps/desktop'\]",
    ):
        module.update_version_files("1.2.4", "2026.7.11")

    assert version_file.read_text(encoding="utf-8") == original_version
    assert pyproject_file.read_text(encoding="utf-8") == original_pyproject
    assert desktop_package.read_text(encoding="utf-8") == original_desktop
    assert root_lock.read_text(encoding="utf-8") == original_lock


def test_resume_refuses_local_tag_that_does_not_point_at_head(
    monkeypatch, tmp_path, capsys
):
    module = _load_release_module(monkeypatch, tmp_path)

    def git_result(*args, **kwargs):
        if args[0] == "show-ref":
            return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
        if args[0] == "cat-file":
            return subprocess.CompletedProcess(args, 0, stdout="tag\n", stderr="")
        if args[-1] == "HEAD":
            return subprocess.CompletedProcess(
                args, 0, stdout="new-release-head\n", stderr=""
            )
        return subprocess.CompletedProcess(
            args, 0, stdout="different-tag-head\n", stderr=""
        )

    monkeypatch.setattr(module, "git_result", git_result)

    assert module._matching_annotated_tag_at_head("v2026.7.11") is None
    assert "Refusing to reuse v2026.7.11" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("returncode", "stdout", "expected"),
    [
        pytest.param(0, "", False, id="absent"),
        pytest.param(2, "", None, id="lookup-error"),
        pytest.param(
            0,
            f"{'b' * 40}\trefs/tags/v2026.7.11\n",
            None,
            id="lightweight",
        ),
        pytest.param(
            0,
            (
                f"{'b' * 40}\trefs/tags/v2026.7.11\n"
                f"{'c' * 40}\trefs/tags/v2026.7.11^{{}}\n"
            ),
            None,
            id="wrong-commit",
        ),
        pytest.param(
            0,
            (
                f"{'c' * 40}\trefs/tags/v2026.7.11\n"
                f"{'a' * 40}\trefs/tags/v2026.7.11^{{}}\n"
            ),
            None,
            id="different-annotation-same-commit",
        ),
        pytest.param(
            0,
            (
                f"{'b' * 40}\trefs/tags/v2026.7.11\n"
                f"{'a' * 40}\trefs/tags/v2026.7.11^{{}}\n"
            ),
            True,
            id="exact-annotated",
        ),
    ],
)
def test_remote_tag_recovery_is_exact_and_fail_closed(
    monkeypatch, tmp_path, returncode, stdout, expected
):
    module = _load_release_module(monkeypatch, tmp_path)
    calls = []

    def git_result(*args, **kwargs):
        calls.append(args)
        if args[0] == "ls-remote":
            return subprocess.CompletedProcess(
                args,
                returncode,
                stdout=stdout,
                stderr="remote lookup failed" if returncode else "",
            )
        if args == ("rev-parse", "--verify", "HEAD"):
            return subprocess.CompletedProcess(
                args, 0, stdout=f"{'a' * 40}\n", stderr=""
            )
        if args == ("rev-parse", "--verify", "refs/tags/v2026.7.11"):
            return subprocess.CompletedProcess(
                args, 0, stdout=f"{'b' * 40}\n", stderr=""
            )
        raise AssertionError(f"unexpected git call: {args}")

    monkeypatch.setattr(module, "git_result", git_result)

    assert module._matching_remote_annotated_tag_at_head("v2026.7.11") is expected
    assert calls[0] == (
        "ls-remote",
        "--tags",
        "origin",
        "refs/tags/v2026.7.11",
        "refs/tags/v2026.7.11^{}",
    )


@pytest.mark.parametrize("is_draft", [True, False])
def test_github_release_state_reconciles_existing_release(
    monkeypatch, tmp_path, is_draft
):
    module = _load_release_module(monkeypatch, tmp_path)
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda command, **kwargs: subprocess.CompletedProcess(
            command,
            0,
            stdout=json.dumps(
                {
                    "isDraft": is_draft,
                    "url": "https://github.invalid/releases/v2026.7.11",
                }
            ),
            stderr="",
        ),
    )

    assert module._github_release_state("v2026.7.11") == (
        is_draft,
        "https://github.invalid/releases/v2026.7.11",
    )


def test_publish_without_bump_retries_exact_tag_head_and_state(
    monkeypatch, tmp_path, capsys
):
    version_dir = tmp_path / "hermes_cli"
    version_dir.mkdir()
    version_file = version_dir / "__init__.py"
    version_file.write_text(
        '__version__ = "1.2.3"\n__release_date__ = "2026-07-04"\n',
        encoding="utf-8",
    )
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "release-test@example.invalid"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Release Test"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "initial"], cwd=tmp_path, check=True
    )
    for suffix in ["", ".2", ".3", ".4", ".5", ".6", ".7", ".8", ".9"]:
        subprocess.run(
            [
                "git",
                "tag",
                "-a",
                f"v2026.7.11{suffix}",
                "-m",
                f"prior release {suffix or '.1'}",
            ],
            cwd=tmp_path,
            check=True,
        )
    (tmp_path / "feature.txt").write_text("release payload\n", encoding="utf-8")
    subprocess.run(["git", "add", "feature.txt"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "feature"], cwd=tmp_path, check=True
    )

    module = _load_release_module(monkeypatch, tmp_path)
    monkeypatch.setattr(module, "VERSION_FILE", version_file)
    monkeypatch.setattr(
        module.sys,
        "argv",
        [
            "release.py",
            "--publish",
            "--date",
            "2026.7.11",
        ],
    )
    changelog_subjects = []

    def changelog(commits, *args, **kwargs):
        subjects = [commit["subject"] for commit in commits]
        changelog_subjects.append(subjects)
        return "\n".join(subjects)

    monkeypatch.setattr(module, "generate_changelog", changelog)
    artifact = tmp_path / "dist" / "hermes_agent-1.2.3-py3-none-any.whl"
    monkeypatch.setattr(module, "build_release_artifacts", lambda version: [artifact])
    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/gh")

    real_run = subprocess.run
    gh_creates = []

    def run(command, **kwargs):
        if command[:3] == ["gh", "release", "view"]:
            return subprocess.CompletedProcess(
                command, 1, stdout="", stderr="release not found"
            )
        if command[:3] == ["gh", "release", "create"]:
            gh_creates.append(command[3])
            return subprocess.CompletedProcess(
                command,
                1 if len(gh_creates) == 1 else 0,
                stdout=(
                    "" if len(gh_creates) == 1 else "https://github.invalid/draft\n"
                ),
                stderr="temporary failure" if len(gh_creates) == 1 else "",
            )
        return real_run(command, **kwargs)

    monkeypatch.setattr(module.subprocess, "run", run)

    def git_result(*args, cwd=None):
        if args[0] == "push":
            return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
        if args[0] == "ls-remote":
            head = real_run(
                ["git", "rev-parse", "HEAD"],
                cwd=cwd or tmp_path,
                text=True,
                capture_output=True,
                check=True,
            ).stdout.strip()
            tag_object = real_run(
                ["git", "rev-parse", args[-2]],
                cwd=cwd or tmp_path,
                text=True,
                capture_output=True,
                check=True,
            ).stdout.strip()
            return subprocess.CompletedProcess(
                args,
                0,
                stdout=(
                    f"{tag_object}\t{args[-2]}\n"
                    f"{head}\t{args[-1]}\n"
                ),
                stderr="",
            )
        return real_run(
            ["git", *args],
            capture_output=True,
            text=True,
            cwd=cwd or tmp_path,
        )

    monkeypatch.setattr(module, "git_result", git_result)

    initial_head = real_run(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True, capture_output=True
    ).stdout.strip()
    assert module.main() == 1

    state_path = tmp_path / ".release_state.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state == {
        "schema": 2,
        "tag": "v2026.7.11.10",
        "calver": "2026.7.11.10",
        "version": "1.2.3",
        "head": initial_head,
        "first_release": False,
    }
    assert (tmp_path / ".release_notes.md").read_text() == "feature"
    first_tags = real_run(
        ["git", "tag", "--list", "v2026.7.11*"],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.splitlines()
    assert "v2026.7.11.10" in first_tags
    assert "v2026.7.11.11" not in first_tags

    assert module.main() == 0
    final_head = real_run(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, text=True, capture_output=True
    ).stdout.strip()
    assert final_head == initial_head
    assert gh_creates == ["v2026.7.11.10", "v2026.7.11.10"]
    assert changelog_subjects == [["feature"], ["feature"]]
    assert not state_path.exists()
    assert not (tmp_path / ".release_state.json.tmp").exists()
    assert not (tmp_path / ".release_notes.md").exists()
    final_tags = real_run(
        ["git", "tag", "--list", "v2026.7.11*"],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.splitlines()
    assert "v2026.7.11.10" in final_tags
    assert "v2026.7.11.11" not in final_tags
    assert real_run(
        ["git", "cat-file", "-t", "refs/tags/v2026.7.11.10"],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip() == "tag"
    output = capsys.readouterr().out
    assert "Resuming exact no-bump release v1.2.3" in output
    assert "v2026.7.11.11" not in output


def test_no_bump_retry_cannot_toggle_first_release_mode(
    monkeypatch, tmp_path, capsys
):
    artifact = tmp_path / "dist" / "hermes_agent-1.2.3-py3-none-any.whl"
    module = _configure_publish_main(monkeypatch, tmp_path, artifacts=[artifact])
    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/gh")

    def git_result(*args, **kwargs):
        if args[0] == "ls-files":
            return subprocess.CompletedProcess(args, 1, stdout="", stderr="")
        if args[0] == "rev-parse":
            return subprocess.CompletedProcess(
                args, 0, stdout=f"{'a' * 40}\n", stderr=""
            )
        return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

    monkeypatch.setattr(module, "git_result", git_result)
    monkeypatch.setattr(
        module.subprocess,
        "run",
        lambda command, **kwargs: (_ for _ in ()).throw(
            subprocess.TimeoutExpired(command, kwargs["timeout"])
        ),
    )

    assert module.main() == 1
    state_path = tmp_path / ".release_state.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["schema"] == 2
    assert state["first_release"] is True

    module.sys.argv = [
        "release.py",
        "--publish",
        "--date",
        "2026.7.11",
    ]
    monkeypatch.setattr(
        module,
        "build_release_artifacts",
        lambda version: (_ for _ in ()).throw(
            AssertionError("mismatched retry must stop before artifact build")
        ),
    )

    assert module.main() == 1
    assert state_path.is_file()
    assert "first-release mode" in capsys.readouterr().out


def test_resumed_release_reuses_exact_remote_tag_after_branch_advances(
    monkeypatch, tmp_path, capsys
):
    real_run = subprocess.run
    remote = tmp_path / "origin.git"
    work = tmp_path / "release"
    other = tmp_path / "other"

    real_run(["git", "init", "--bare", "-q", str(remote)], check=True)
    real_run(
        ["git", "symbolic-ref", "HEAD", "refs/heads/main"],
        cwd=remote,
        check=True,
    )
    work.mkdir()
    real_run(["git", "init", "-q", "-b", "main"], cwd=work, check=True)
    for key, value in (
        ("user.email", "release-test@example.invalid"),
        ("user.name", "Release Test"),
    ):
        real_run(["git", "config", key, value], cwd=work, check=True)
    (work / "base.txt").write_text("base\n", encoding="utf-8")
    real_run(["git", "add", "base.txt"], cwd=work, check=True)
    real_run(["git", "commit", "-q", "-m", "base"], cwd=work, check=True)
    real_run(["git", "remote", "add", "origin", str(remote)], cwd=work, check=True)
    real_run(["git", "push", "-q", "-u", "origin", "main"], cwd=work, check=True)

    (work / "feature.txt").write_text("release payload\n", encoding="utf-8")
    real_run(["git", "add", "feature.txt"], cwd=work, check=True)
    real_run(["git", "commit", "-q", "-m", "feature"], cwd=work, check=True)
    release_head = real_run(
        ["git", "rev-parse", "HEAD"],
        cwd=work,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()

    artifact = work / "dist" / "hermes_agent-1.2.3-py3-none-any.whl"
    module = _configure_publish_main(monkeypatch, work, artifacts=[artifact])
    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/gh")
    gh_creates = []

    def run(command, **kwargs):
        if command[:3] == ["gh", "release", "view"]:
            return subprocess.CompletedProcess(
                command, 1, stdout="", stderr="release not found"
            )
        if command[:3] == ["gh", "release", "create"]:
            gh_creates.append(command[3])
            return subprocess.CompletedProcess(
                command,
                1 if len(gh_creates) == 1 else 0,
                stdout=(
                    ""
                    if len(gh_creates) == 1
                    else "https://github.invalid/draft\n"
                ),
                stderr="temporary failure" if len(gh_creates) == 1 else "",
            )
        return real_run(command, **kwargs)

    monkeypatch.setattr(module.subprocess, "run", run)

    assert module.main() == 1
    remote_tag_head = real_run(
        ["git", "--git-dir", str(remote), "rev-parse", "refs/tags/v2026.7.11^{}"],
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()
    assert remote_tag_head == release_head

    real_run(["git", "clone", "-q", str(remote), str(other)], check=True)
    for key, value in (
        ("user.email", "advance-test@example.invalid"),
        ("user.name", "Advance Test"),
    ):
        real_run(["git", "config", key, value], cwd=other, check=True)
    (other / "advance.txt").write_text("remote branch moved\n", encoding="utf-8")
    real_run(["git", "add", "advance.txt"], cwd=other, check=True)
    real_run(["git", "commit", "-q", "-m", "advance branch"], cwd=other, check=True)
    real_run(["git", "push", "-q", "origin", "main"], cwd=other, check=True)
    advanced_head = real_run(
        ["git", "rev-parse", "HEAD"],
        cwd=other,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()
    assert advanced_head != release_head

    assert module.main() == 0
    assert gh_creates == ["v2026.7.11", "v2026.7.11"]
    assert real_run(
        ["git", "--git-dir", str(remote), "rev-parse", "refs/heads/main"],
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip() == advanced_head
    assert real_run(
        ["git", "--git-dir", str(remote), "rev-parse", "refs/tags/v2026.7.11^{}"],
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip() == release_head
    output = capsys.readouterr().out
    assert "Remote annotated tag v2026.7.11 already points at HEAD" in output
    assert "gh workflow run upload_to_pypi.yml -f confirm_tag=v2026.7.11" in output
