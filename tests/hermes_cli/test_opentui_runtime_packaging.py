"""Production packaging contracts for the standalone OpenTUI engine."""

from __future__ import annotations

import json
import multiprocessing
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import pytest

import hermes_cli.main as main_mod
from hermes_cli import opentui_runtime as runtime


TEST_IDENTITY = runtime.NodeIdentity(
    executable="/node-26",
    version="v26.3.0",
    platform="linux",
    arch="x64",
)
REAL_PROBE_NODE_IDENTITY = runtime.probe_node_identity


@pytest.fixture(autouse=True)
def _isolate_runtime_state(tmp_path, monkeypatch):
    monkeypatch.setattr(
        runtime,
        "probe_node_identity",
        lambda node: runtime.NodeIdentity(
            executable=str(Path(node)),
            version=TEST_IDENTITY.version,
            platform=TEST_IDENTITY.platform,
            arch=TEST_IDENTITY.arch,
        ),
    )
    monkeypatch.setattr(
        main_mod, "_opentui_runtime_state_dir", lambda: tmp_path / "runtime-state"
    )


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _make_runtime(
    tmp_path: Path,
    *,
    stamped: bool = True,
    identity: runtime.NodeIdentity = TEST_IDENTITY,
    source_checkout: bool = True,
) -> Path:
    app = tmp_path / "ui-opentui"
    if source_checkout:
        _write(tmp_path / ".git" / "HEAD", "ref: refs/heads/test\n")
    native_package = runtime.selected_native_package_name(identity)
    assert native_package is not None
    build_toolchain = {
        "@babel/core": "1.0.0",
        "@babel/preset-typescript": "1.0.0",
        "babel-preset-solid": "1.0.0",
        "esbuild": "1.0.0",
    }
    runtime_dependencies = {
        "@opentui/core": "1.0.0",
        "@opentui/keymap": "1.0.0",
        "@opentui/solid": "1.0.0",
        "effect": "1.0.0",
        "fuzzysort": "1.0.0",
        "solid-js": "1.0.0",
    }
    package = {
        "name": "@hermes/ui-opentui",
        "version": "0.0.0",
        "dependencies": runtime_dependencies,
        "devDependencies": build_toolchain,
    }
    root_entry = {
        "name": package["name"],
        "version": package["version"],
        "dependencies": package["dependencies"],
        "devDependencies": package["devDependencies"],
    }
    locked_packages = {
        **{
            f"node_modules/{name}": {
                "version": version,
                "integrity": f"sha512-{name}",
            }
            for name, version in runtime_dependencies.items()
        },
        f"node_modules/{native_package}": {
            "version": "1.0.0",
            "integrity": "sha512-native",
            "optional": True,
        },
        **{
            f"node_modules/{name}": {
                "version": version,
                "integrity": f"sha512-{name}",
                "dev": True,
            }
            for name, version in build_toolchain.items()
        },
    }
    package_lock = {
        "name": package["name"],
        "version": package["version"],
        "lockfileVersion": 3,
        "requires": True,
        "packages": {"": root_entry, **locked_packages},
    }
    hidden_lock = {
        "name": package["name"],
        "version": package["version"],
        "lockfileVersion": 3,
        "requires": True,
        "packages": {key: value for key, value in locked_packages.items()},
    }

    _write(app / "package.json", json.dumps(package, sort_keys=True))
    _write(app / "package-lock.json", json.dumps(package_lock, sort_keys=True))
    _write(app / "tsconfig.json", "{}")
    _write(app / "scripts" / "build.mjs", "// build")
    _write(app / "src" / "entry" / "main.tsx", "// entry")
    _write(app / "src" / "runtime" / "old.ts", "export const old = true")
    _write(app / "src" / "test" / "fixture.ts", "export const fixture = true")
    _write(
        app / "node_modules" / ".package-lock.json",
        json.dumps(hidden_lock, sort_keys=True),
    )
    _write(
        app / "node_modules" / "@opentui" / "core" / "package.json",
        json.dumps({
            "name": "@opentui/core",
            "version": "1.0.0",
            "optionalDependencies": {native_package: "1.0.0"},
        }),
    )
    for name, version in runtime_dependencies.items():
        if name == "@opentui/core":
            continue
        _write(
            app / "node_modules" / name / "package.json",
            json.dumps({"name": name, "version": version}),
        )
    for name, version in build_toolchain.items():
        _write(
            app / "node_modules" / name / "package.json",
            json.dumps({"name": name, "version": version}),
        )
    _write(
        app / "node_modules" / native_package / "package.json",
        json.dumps({"name": native_package, "version": "1.0.0"}),
    )
    native_library = "opentui.dll" if "win32" in native_package else "libopentui.so"
    _write(app / "node_modules" / native_package / native_library, "native")
    _write(app / "node_modules" / "old-runtime.txt", "old dependencies")
    _write(app / "dist" / "main.js", "old bundle")

    for path in runtime.BUILD_INPUT_FILES:
        os.utime(app / path, (100, 100))
    for path in (app / "src").rglob("*"):
        os.utime(path, (100, 100))
    os.utime(app / "src", (100, 100))
    os.utime(app / "dist" / "main.js", (200, 200))

    if stamped:
        digest = runtime.dependency_digest(app)
        assert digest is not None
        _write(app / "node_modules" / runtime.DEPENDENCY_STAMP, f"{digest}\n")
    return app


def _change_dependency_lock(app: Path) -> None:
    path = app / "package-lock.json"
    lock = json.loads(path.read_text(encoding="utf-8"))
    lock["hermesPackagingRevision"] = 2
    path.write_text(json.dumps(lock, sort_keys=True), encoding="utf-8")


def _ok(command: list[str]) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(command, 0, stdout="", stderr="")


def _install_fixture_dependencies(app: Path, staging: Path) -> None:
    shutil.copytree(app / "node_modules", staging / "node_modules")
    (staging / "node_modules" / "old-runtime.txt").unlink(missing_ok=True)


def _make_packaged_seed(tmp_path: Path) -> tuple[Path, Path]:
    seed = _make_runtime(tmp_path, source_checkout=False)
    fixture_dependencies = tmp_path / "fixture-node-modules"
    shutil.copytree(seed / "node_modules", fixture_dependencies)
    shutil.rmtree(seed / "node_modules")
    return seed, fixture_dependencies


def _set_tree_modes(root: Path, *, directory: int, file: int) -> None:
    for dirpath, dirnames, filenames in os.walk(root):
        current = Path(dirpath)
        current.chmod(directory)
        for name in dirnames:
            (current / name).chmod(directory)
        for name in filenames:
            (current / name).chmod(file)


def _prune_build_toolchain(app: Path) -> None:
    hidden_path = app / "node_modules" / ".package-lock.json"
    hidden = json.loads(hidden_path.read_text(encoding="utf-8"))
    for package_name in runtime.BUILD_TOOLCHAIN_PACKAGES:
        shutil.rmtree(app / "node_modules" / package_name)
        hidden["packages"].pop(f"node_modules/{package_name}")
    hidden_path.write_text(json.dumps(hidden, sort_keys=True), encoding="utf-8")


def _concurrent_refresh_worker(
    app: str, attempts: str, temp_root: str, start_event
) -> None:
    app_path = Path(app)
    os.environ["TMPDIR"] = temp_root
    tempfile.tempdir = temp_root
    if not start_event.wait(timeout=5):
        raise RuntimeError("concurrency test start barrier timed out")
    with runtime.refresh_lock(app_path):
        # This is the production contract: freshness is decided again only
        # after the cross-process lock is held.
        if runtime.bundle_needs_rebuild(app_path):
            with Path(attempts).open("a", encoding="utf-8") as handle:
                handle.write(f"{os.getpid()}\n")
                handle.flush()
                os.fsync(handle.fileno())
            time.sleep(0.25)
            _write(app_path / "dist" / "main.js", "built by one process")


class TestFreshness:
    def test_fresh_runtime_needs_no_build(self, tmp_path):
        app = _make_runtime(tmp_path)

        assert runtime.dependencies_current(app, TEST_IDENTITY)
        assert not runtime.bundle_needs_rebuild(app)
        assert not runtime.needs_rebuild(app, TEST_IDENTITY)

        assert runtime.launch_argv("/node-26", app) == [
            "/node-26",
            "--experimental-ffi",
            "--no-warnings",
            "--expose-gc",
            str(app / "dist" / "main.js"),
        ]

    def test_launch_argv_rejects_empty_bundle(self, tmp_path):
        app = _make_runtime(tmp_path)
        (app / "dist" / "main.js").write_bytes(b"")

        with pytest.raises(FileNotFoundError, match="missing or empty"):
            runtime.launch_argv("/node-26", app)

    @pytest.mark.parametrize(
        "relative",
        ["src/runtime/old.ts", "tsconfig.json", "scripts/build.mjs"],
    )
    def test_source_or_build_config_mtime_requires_bundle_only(
        self, tmp_path, relative
    ):
        app = _make_runtime(tmp_path)
        os.utime(app / relative, (300, 300))

        assert runtime.dependencies_current(app, TEST_IDENTITY)
        assert runtime.bundle_needs_rebuild(app)

    @pytest.mark.parametrize("relative", ["package.json", "package-lock.json"])
    def test_package_content_change_invalidates_dependency_stamp(
        self, tmp_path, relative
    ):
        app = _make_runtime(tmp_path)
        path = app / relative
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["hermesPackagingRevision"] = 2
        path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")

        assert not runtime.dependencies_current(app, TEST_IDENTITY)
        assert runtime.needs_rebuild(app, TEST_IDENTITY)

    def test_force_build(self, tmp_path):
        app = _make_runtime(tmp_path)
        assert runtime.bundle_needs_rebuild(app, env={"HERMES_TUI_FORCE_BUILD": "true"})

    def test_deleted_runtime_source_invalidates_bundle(self, tmp_path):
        app = _make_runtime(tmp_path)
        (app / "src" / "runtime" / "old.ts").unlink()
        os.utime(app / "src" / "runtime", (300, 300))

        assert runtime.bundle_needs_rebuild(app)

    def test_test_only_edit_does_not_invalidate_bundle(self, tmp_path):
        app = _make_runtime(tmp_path)
        _write(app / "src" / "test" / "new-fixture.ts", "// newer test")
        os.utime(app / "src" / "test", (300, 300))

        assert not runtime.bundle_needs_rebuild(app)

    def test_unstamped_valid_runtime_bootstraps_offline_without_npm(
        self, tmp_path, monkeypatch
    ):
        app = _make_runtime(tmp_path, stamped=False)
        monkeypatch.setattr(
            runtime,
            "npm_command",
            lambda _node: pytest.fail("offline bootstrap must not resolve npm"),
        )

        assert runtime.dependencies_current(app, TEST_IDENTITY)
        assert (app / "node_modules" / runtime.DEPENDENCY_STAMP).read_text(
            encoding="ascii"
        ).strip() == runtime.dependency_digest(app)

    def test_unstamped_pruned_runtime_bootstraps_offline(self, tmp_path):
        app = _make_runtime(tmp_path, stamped=False)
        _prune_build_toolchain(app)

        assert runtime.dependencies_current(app, TEST_IDENTITY)
        assert not runtime.build_toolchain_available(app)
        assert not runtime.bundle_needs_rebuild(app)

    @pytest.mark.parametrize("missing", ["direct", "native"])
    def test_matching_stamp_does_not_hide_missing_runtime_package(
        self, tmp_path, missing
    ):
        app = _make_runtime(tmp_path)
        package_name = (
            "effect"
            if missing == "direct"
            else runtime.selected_native_package_name(TEST_IDENTITY)
        )
        assert package_name is not None
        shutil.rmtree(app / "node_modules" / package_name)

        assert not runtime.runtime_sentinels_current(app, TEST_IDENTITY)
        assert not runtime.dependencies_current(app, TEST_IDENTITY)

    def test_zero_byte_native_library_forces_refresh(self, tmp_path):
        app = _make_runtime(tmp_path)
        native_package = runtime.selected_native_package_name(TEST_IDENTITY)
        assert native_package is not None
        native_dir = app / "node_modules" / native_package
        native_library = next(
            path
            for pattern in ("*.so", "*.dylib", "*.dll")
            for path in native_dir.rglob(pattern)
        )
        native_library.write_bytes(b"")

        assert not runtime.runtime_payload_present(app, TEST_IDENTITY)
        assert not runtime.dependencies_current(app, TEST_IDENTITY)

    @pytest.mark.parametrize("manifest", [[], {"optionalDependencies": []}])
    def test_malformed_core_manifest_is_stale_instead_of_crashing(
        self, tmp_path, manifest
    ):
        app = _make_runtime(tmp_path)
        _write(
            app / "node_modules" / "@opentui" / "core" / "package.json",
            json.dumps(manifest),
        )

        inspection = runtime.inspect_runtime(app, TEST_IDENTITY)

        assert not inspection.payload_present
        assert inspection.dependency_refresh_required


class TestPairedNpm:
    @pytest.mark.parametrize(
        ("reported_libc", "expected_suffix"),
        [("glibc", "linux-x64"), ("musl", "linux-x64-musl")],
    )
    def test_native_package_matches_detected_linux_libc(
        self, monkeypatch, reported_libc, expected_suffix
    ):
        monkeypatch.delenv("OPENTUI_LIBC", raising=False)
        monkeypatch.setattr(
            runtime.platform, "libc_ver", lambda: (reported_libc, "1.0")
        )

        assert runtime.selected_native_package_name(TEST_IDENTITY) == (
            f"@opentui/core-{expected_suffix}"
        )

    def test_native_package_honors_explicit_libc_override(self, monkeypatch):
        monkeypatch.setattr(runtime.platform, "libc_ver", lambda: ("glibc", "2.40"))
        monkeypatch.setenv("OPENTUI_LIBC", "musl")
        identity = runtime.NodeIdentity(
            executable="/arm-node",
            version="v26.3.0",
            platform="linux",
            arch="arm64",
        )

        assert runtime.selected_native_package_name(identity) == (
            "@opentui/core-linux-arm64-musl"
        )

    def test_probes_identity_from_the_selected_node_process(self, monkeypatch):
        observed = []

        def fake_run(command, **kwargs):
            observed.append((command, kwargs))
            return subprocess.CompletedProcess(
                command,
                0,
                stdout='{"version":"v26.4.0","platform":"linux","arch":"arm64"}',
                stderr="",
            )

        monkeypatch.setattr(runtime.subprocess, "run", fake_run)

        identity = REAL_PROBE_NODE_IDENTITY("/selected/node")

        assert identity is not None
        assert identity.platform == "linux"
        assert identity.arch == "arm64"
        assert observed[0][0][0] == "/selected/node"
        assert "process.platform" in observed[0][0][2]
        assert "process.arch" in observed[0][0][2]

    def test_same_path_node_replacement_is_reprobed(self, monkeypatch):
        payloads = iter(
            [
                '{"version":"v26.3.0","platform":"linux","arch":"x64"}',
                '{"version":"v26.4.0","platform":"linux","arch":"arm64"}',
            ]
        )

        def fake_run(command, **_kwargs):
            return subprocess.CompletedProcess(
                command, 0, stdout=next(payloads), stderr=""
            )

        monkeypatch.setattr(runtime.subprocess, "run", fake_run)

        before = REAL_PROBE_NODE_IDENTITY("/managed/node")
        after = REAL_PROBE_NODE_IDENTITY("/managed/node")

        assert before is not None and before.arch == "x64"
        assert after is not None and after.arch == "arm64"
        assert after.version == "v26.4.0"

    def test_mixed_arch_validation_uses_node_identity_not_python_host(self, tmp_path):
        arm_identity = runtime.NodeIdentity(
            executable="/selected/arm-node",
            version="v26.4.0",
            platform="linux",
            arch="arm64",
        )
        app = _make_runtime(tmp_path, identity=arm_identity)

        assert runtime.runtime_payload_present(app, arm_identity)
        assert not runtime.runtime_payload_present(app, TEST_IDENTITY)

    def test_cached_runtime_launch_gets_matching_musl_override(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(runtime.platform, "libc_ver", lambda: ("musl", "1.2"))
        env = {}

        main_mod._apply_opentui_native_env(
            ["/node-26", "--experimental-ffi", "dist/main.js"],
            tmp_path / "artifacts" / "seed" / "runtime",
            env,
        )

        assert env["OPENTUI_LIBC"] == "musl"

    def test_uses_selected_node_install_npm_cli_not_ambient(
        self, tmp_path, monkeypatch
    ):
        node = tmp_path / "node-26" / "bin" / "node"
        npm_cli = (
            tmp_path / "node-26" / "lib" / "node_modules" / "npm" / "bin" / "npm-cli.js"
        )
        _write(node, "node")
        _write(npm_cli, "npm")
        monkeypatch.setattr(
            runtime.shutil,
            "which",
            lambda _name: pytest.fail("ambient npm must not be inspected"),
        )

        assert runtime.npm_command(str(node)) == [str(node), str(npm_cli)]

    def test_build_environment_selects_node_and_forces_dev_dependencies(
        self, tmp_path, monkeypatch
    ):
        node = tmp_path / "node-26" / "bin" / "node"
        monkeypatch.setenv("PATH", "/ambient/bin")
        monkeypatch.setenv("NODE_ENV", "production")
        monkeypatch.setenv("NPM_CONFIG_OMIT", "dev")
        monkeypatch.setenv("npm_config_production", "true")

        env = runtime.build_environment(str(node))

        assert env["PATH"].split(os.pathsep)[0] == str(node.parent)
        assert "NODE_ENV" not in env
        assert "NPM_CONFIG_OMIT" not in env
        assert env["npm_config_production"] == "false"
        assert env["npm_config_include"] == "dev"


class TestRefreshBackoff:
    def test_marker_expires_within_bounded_retry_interval(self, tmp_path):
        state_dir = tmp_path / "state"
        assert runtime.record_refresh_failure(state_dir, "key", now=100.0)

        assert runtime.refresh_backoff_remaining(state_dir, "key", now=150.0) == 250
        assert runtime.refresh_backoff_remaining(state_dir, "key", now=401.0) == 0
        assert runtime.refresh_backoff_remaining(state_dir, "key", now=50.0) == 0

    def test_key_changes_with_inputs_selected_node_and_platform(self, tmp_path):
        app = _make_runtime(tmp_path)
        first_digest = runtime.refresh_digest(app)
        assert first_digest is not None
        first_key = runtime.refresh_failure_key(app, first_digest, TEST_IDENTITY)

        _write(app / "src" / "runtime" / "old.ts", "changed source")
        second_digest = runtime.refresh_digest(app)
        assert second_digest is not None
        assert second_digest != first_digest
        assert (
            runtime.refresh_failure_key(app, second_digest, TEST_IDENTITY) != first_key
        )

        other_node = runtime.NodeIdentity(
            executable="/other/node",
            version="v26.4.0",
            platform="linux",
            arch="x64",
        )
        other_platform = runtime.NodeIdentity(
            executable=TEST_IDENTITY.executable,
            version=TEST_IDENTITY.version,
            platform="darwin",
            arch="arm64",
        )
        assert runtime.refresh_failure_key(app, first_digest, other_node) != first_key
        assert (
            runtime.refresh_failure_key(app, first_digest, other_platform) != first_key
        )

    def test_shared_profile_keeps_independent_install_failure_markers(
        self, tmp_path
    ):
        state_dir = tmp_path / "shared-profile"
        assert runtime.record_refresh_failure(state_dir, "install-a", now=100.0)
        assert runtime.record_refresh_failure(state_dir, "install-b", now=110.0)

        assert (
            runtime.refresh_backoff_remaining(
                state_dir, "install-a", now=150.0
            )
            == 250
        )
        assert (
            runtime.refresh_backoff_remaining(
                state_dir, "install-b", now=150.0
            )
            == 260
        )

        runtime.clear_refresh_failure(state_dir, "install-a")

        assert runtime.refresh_backoff_remaining(
            state_dir, "install-a", now=150.0
        ) == 0
        assert (
            runtime.refresh_backoff_remaining(
                state_dir, "install-b", now=150.0
            )
            == 260
        )

    def test_recording_failure_reaps_expired_generation_markers(self, tmp_path):
        state_dir = tmp_path / "profile"
        assert runtime.record_refresh_failure(state_dir, "old-inputs", now=100.0)
        assert runtime.record_refresh_failure(state_dir, "new-inputs", now=401.0)

        markers = list((state_dir / runtime.FAILED_REFRESH_DIR).glob("*.json"))
        assert len(markers) == 1
        assert runtime.refresh_backoff_remaining(
            state_dir, "old-inputs", now=401.0
        ) == 0
        assert (
            runtime.refresh_backoff_remaining(
                state_dir, "new-inputs", now=401.0
            )
            == runtime.FAILURE_BACKOFF_SECONDS
        )

    def test_npmrc_change_invalidates_failed_refresh_key(self, tmp_path):
        app = _make_runtime(tmp_path)
        first_digest = runtime.refresh_digest(app)
        assert first_digest is not None

        _write(app / ".npmrc", "registry=https://registry.example.invalid\n")
        second_digest = runtime.refresh_digest(app)

        assert second_digest is not None
        assert second_digest != first_digest


class TestPackagedRuntimeCache:
    def test_prebuilt_prod_runtime_launches_in_place_without_npm_or_copy(
        self, tmp_path, monkeypatch
    ):
        seed = _make_runtime(tmp_path, source_checkout=False)
        _prune_build_toolchain(seed)
        (seed / "node_modules" / runtime.DEPENDENCY_STAMP).unlink()
        seed_fingerprint = runtime.packaged_seed(seed)
        assert seed_fingerprint is not None
        state_dir = tmp_path / "profile-cache"
        location = runtime.select_runtime_location(tmp_path, state_dir)
        assert location is not None and location.is_packaged
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_opentui_runtime_state_dir", lambda: state_dir)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod,
            "_run_with_idle_timeout",
            lambda *_args, **_kwargs: pytest.fail(
                "validated baked runtime must not contact npm or rebuild"
            ),
        )

        _set_tree_modes(seed, directory=0o555, file=0o444)
        try:
            argv, cwd = main_mod._make_opentui_argv(tui_dev=False)
        finally:
            _set_tree_modes(seed, directory=0o755, file=0o644)

        assert runtime.packaged_prebuilt_runtime_current(location, TEST_IDENTITY)
        assert cwd == seed
        assert argv[-1] == str(seed / "dist" / "main.js")
        assert not state_dir.exists()
        assert not runtime.build_toolchain_available(seed)
        assert not (seed / "node_modules" / runtime.DEPENDENCY_STAMP).exists()
        assert runtime.packaged_seed(seed) == seed_fingerprint

    def test_installed_seed_selects_stable_profile_cache_and_tracks_content(
        self, tmp_path
    ):
        seed, _fixture_dependencies = _make_packaged_seed(tmp_path)
        state_dir = tmp_path / "profile" / "cache" / "opentui-runtime"

        first = runtime.select_runtime_location(tmp_path, state_dir)
        assert first is not None
        assert first.is_packaged
        assert first.seed_dir == seed
        assert first.runtime_dir.is_relative_to(state_dir / "artifacts")
        assert first.runtime_dir.name == "runtime"
        assert not first.runtime_dir.exists()

        _write(seed / "src" / "runtime" / "old.ts", "changed packaged source")
        second = runtime.select_runtime_location(tmp_path, state_dir)
        assert second is not None
        assert second.runtime_dir == first.runtime_dir
        assert second.packaged_seed is not None
        assert first.packaged_seed is not None
        assert second.packaged_seed.fingerprint != first.packaged_seed.fingerprint

    def test_auto_probe_does_not_hydrate_clean_packaged_install(
        self, tmp_path, monkeypatch
    ):
        seed, _fixture_dependencies = _make_packaged_seed(tmp_path)
        state_dir = tmp_path / "profile-cache"
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_opentui_runtime_state_dir", lambda: state_dir)
        monkeypatch.setattr(main_mod, "_node26_bin_or_none", lambda: "/node-26")

        assert not main_mod._opentui_available()
        assert not state_dir.exists()
        assert not (seed / "node_modules").exists()

    def test_read_only_packaged_seed_hydrates_clean_runtime_in_profile_cache(
        self, tmp_path, monkeypatch
    ):
        site_root = tmp_path / "site-packages"
        seed, fixture_dependencies = _make_packaged_seed(site_root)
        state_dir = tmp_path / "hermes-home" / "cache" / "opentui-runtime"
        seed_snapshot = runtime.refresh_digest(seed)
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", site_root)
        monkeypatch.setattr(main_mod, "_opentui_runtime_state_dir", lambda: state_dir)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod._opentui_runtime,
            "npm_command",
            lambda _node: ["/node-26", "/npm-cli.js"],
        )

        calls = []

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            if "ci" in command:
                shutil.copytree(
                    fixture_dependencies,
                    Path(kwargs["cwd"]) / "node_modules",
                )
            else:
                _write(Path(command[-1]) / "main.js", "cached production bundle")
            return _ok(command)

        monkeypatch.setattr(main_mod, "_run_with_idle_timeout", runner)
        _set_tree_modes(seed, directory=0o555, file=0o444)
        try:
            argv, cwd = main_mod._make_opentui_argv(tui_dev=False)
        finally:
            _set_tree_modes(seed, directory=0o755, file=0o644)

        location = runtime.select_runtime_location(site_root, state_dir)
        assert location is not None
        assert cwd == location.runtime_dir
        assert argv[-1] == str(location.runtime_dir / "dist" / "main.js")
        assert runtime.packaged_runtime_current(location)
        assert runtime.runtime_payload_present(location.runtime_dir, TEST_IDENTITY)
        assert "ci" in calls[0][0]
        assert "run" in calls[1][0]
        assert runtime.refresh_digest(seed) == seed_snapshot
        assert not (seed / "node_modules").exists()

        (location.runtime_dir / "dist" / "main.js").write_bytes(b"")
        assert not runtime.packaged_runtime_current(location)

    def test_failed_packaged_upgrade_preserves_prior_cached_runtime(self, tmp_path):
        seed, fixture_dependencies = _make_packaged_seed(tmp_path)
        state_dir = tmp_path / "profile-cache"
        first = runtime.select_runtime_location(tmp_path, state_dir)
        assert first is not None

        def successful_runner(command, **kwargs):
            if "ci" in command:
                shutil.copytree(
                    fixture_dependencies,
                    Path(kwargs["cwd"]) / "node_modules",
                )
            else:
                _write(Path(command[-1]) / "main.js", "first cached bundle")
            return _ok(command)

        success, _result = runtime.refresh_packaged_runtime(
            first,
            identity=TEST_IDENTITY,
            npm=["/node-26", "/npm-cli.js"],
            env={"PATH": "/node-26"},
            runner=successful_runner,
        )
        assert success
        assert runtime.packaged_runtime_current(first)

        _write(seed / "src" / "runtime" / "old.ts", "new wheel source")
        upgraded = runtime.select_runtime_location(tmp_path, state_dir)
        assert upgraded is not None
        assert upgraded.runtime_dir == first.runtime_dir
        assert not runtime.packaged_runtime_current(upgraded)

        def failed_runner(command, **_kwargs):
            return subprocess.CompletedProcess(
                command, 1, stdout="", stderr="registry offline"
            )

        success, _result = runtime.refresh_packaged_runtime(
            upgraded,
            identity=TEST_IDENTITY,
            npm=["/node-26", "/npm-cli.js"],
            env={"PATH": "/node-26"},
            runner=failed_runner,
        )

        assert not success
        assert (first.runtime_dir / "dist" / "main.js").read_text() == (
            "first cached bundle"
        )
        assert runtime.packaged_runtime_current(first)
        assert not runtime.packaged_runtime_current(upgraded)

    def test_next_packaged_launch_prunes_completed_full_root_backup(
        self, tmp_path, monkeypatch
    ):
        seed, fixture_dependencies = _make_packaged_seed(tmp_path)
        state_dir = tmp_path / "profile-cache"
        location = runtime.select_runtime_location(tmp_path, state_dir)
        assert location is not None

        def runner(command, **kwargs):
            if "ci" in command:
                shutil.copytree(
                    fixture_dependencies,
                    Path(kwargs["cwd"]) / "node_modules",
                )
            else:
                _write(Path(command[-1]) / "main.js", "cached production bundle")
            return _ok(command)

        success, _result = runtime.refresh_packaged_runtime(
            location,
            identity=TEST_IDENTITY,
            npm=["/node-26", "/npm-cli.js"],
            env={"PATH": "/node-26"},
            runner=runner,
        )
        assert success
        backup = location.runtime_dir.parent / ".runtime.previous-crashed"
        shutil.copytree(location.runtime_dir, backup)
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_opentui_runtime_state_dir", lambda: state_dir)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod,
            "_run_with_idle_timeout",
            lambda *_args, **_kwargs: pytest.fail("fresh runtime must not rebuild"),
        )

        argv, cwd = main_mod._make_opentui_argv(tui_dev=False)

        assert seed == location.seed_dir
        assert cwd == location.runtime_dir
        assert argv[-1] == str(location.runtime_dir / "dist" / "main.js")
        assert not backup.exists()


class TestRuntimeTransactions:
    def test_default_lock_is_resource_adjacent_not_ambient_tmp(self, tmp_path):
        app = _make_runtime(tmp_path)

        lock_path = runtime._refresh_lock_path(app)

        assert lock_path.is_relative_to(tmp_path / ".hermes")

    def test_cross_process_lock_rechecks_freshness_and_builds_once(self, tmp_path):
        app = _make_runtime(tmp_path)
        os.utime(app / "src" / "runtime" / "old.ts", (300, 300))
        attempts = tmp_path / "attempts.txt"
        temp_roots = [tmp_path / "tmp-a", tmp_path / "tmp-b"]
        for temp_root in temp_roots:
            temp_root.mkdir()
        context = multiprocessing.get_context("spawn")
        start_event = context.Event()
        processes = [
            context.Process(
                target=_concurrent_refresh_worker,
                args=(str(app), str(attempts), str(temp_roots[index]), start_event),
            )
            for index in range(2)
        ]
        for process in processes:
            process.start()
        start_event.set()
        for process in processes:
            process.join(timeout=10)
            if process.is_alive():
                process.terminate()
                process.join(timeout=2)

        assert [process.exitcode for process in processes] == [0, 0]
        assert len(attempts.read_text(encoding="utf-8").splitlines()) == 1
        assert not runtime.bundle_needs_rebuild(app)

    def test_recovers_paired_runtime_backups_after_hard_crash(self, tmp_path):
        app = _make_runtime(tmp_path)
        suffix = ".ui-opentui-update-crashed"
        node_backup = app / f".node_modules.previous-{suffix}"
        dist_backup = app / f".dist.previous-{suffix}"
        os.replace(app / "node_modules", node_backup)
        os.replace(app / "dist", dist_backup)
        _write(app / "node_modules" / "half-promoted.txt", "new generation")

        assert runtime.recover_interrupted_promotion(app)

        assert (app / "node_modules" / "old-runtime.txt").is_file()
        assert (app / "dist" / "main.js").read_text() == "old bundle"
        assert not node_backup.exists()
        assert not dist_backup.exists()

    def test_recovers_full_cached_runtime_root_after_hard_crash(self, tmp_path):
        app = _make_runtime(tmp_path)
        backup = tmp_path / ".ui-opentui.previous-.runtime-next-crashed"
        os.replace(app, backup)

        assert runtime.recover_interrupted_promotion(app)

        assert (app / "dist" / "main.js").read_text() == "old bundle"
        assert not backup.exists()

    def test_prunes_completed_full_root_backup_only_after_validation(self, tmp_path):
        app = _make_runtime(tmp_path)
        backup = tmp_path / ".ui-opentui.previous-.runtime-next-crashed"
        shutil.copytree(app, backup)

        assert runtime.promotion_backups_present(app)
        assert not runtime.prune_obsolete_promotion_backups(app)
        assert backup.is_dir()

        assert runtime.prune_obsolete_promotion_backups(
            app, full_root_current=True
        )
        assert app.is_dir()
        assert not backup.exists()

    def test_prunes_completed_paired_backups_only_after_validation(self, tmp_path):
        app = _make_runtime(tmp_path)
        suffix = ".ui-opentui-update-crashed"
        node_backup = app / f".node_modules.previous-{suffix}"
        dist_backup = app / f".dist.previous-{suffix}"
        shutil.copytree(app / "node_modules", node_backup)
        shutil.copytree(app / "dist", dist_backup)

        assert runtime.promotion_backups_present(app)
        assert not runtime.prune_obsolete_promotion_backups(app)
        assert node_backup.is_dir() and dist_backup.is_dir()

        assert runtime.prune_obsolete_promotion_backups(
            app, runtime_dirs_current=True
        )
        assert (app / "node_modules").is_dir()
        assert (app / "dist").is_dir()
        assert not node_backup.exists()
        assert not dist_backup.exists()

    def test_prunes_read_only_abandoned_staging_under_lock(self, tmp_path):
        app = _make_runtime(tmp_path)
        staging = tmp_path / ".ui-opentui-update-crashed"
        _write(staging / "readonly" / "nested" / "payload", "old staging")
        _set_tree_modes(staging, directory=0o555, file=0o444)

        assert runtime.promotion_debris_present(app)
        with runtime.refresh_lock(app):
            assert runtime.prune_abandoned_staging(app)

        assert not staging.exists()

    @pytest.mark.parametrize("name", ["node_modules", "dist"])
    def test_recovers_single_directory_backup_after_hard_crash(self, tmp_path, name):
        app = _make_runtime(tmp_path)
        backup = app / f".{name}.previous-.dist-next-crashed"
        os.replace(app / name, backup)

        assert runtime.recover_interrupted_promotion(app)

        assert (app / name).is_dir()
        assert not backup.exists()

    def test_source_staleness_builds_without_npm_ci(self, tmp_path):
        app = _make_runtime(tmp_path)
        os.utime(app / "src" / "runtime" / "old.ts", (300, 300))
        calls = []

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            assert "ci" not in command
            _write(Path(command[-1]) / "main.js", "new bundle")
            return _ok(command)

        success, _result = runtime.build_bundle(
            app,
            npm=["/node-26", "/npm-cli.js"],
            env={"PATH": "/node-26"},
            runner=runner,
        )

        assert success
        assert (app / "dist" / "main.js").read_text() == "new bundle"
        assert (app / "node_modules" / "old-runtime.txt").read_text() == (
            "old dependencies"
        )
        assert calls[0][0][:5] == [
            "/node-26",
            "/npm-cli.js",
            "run",
            "build",
            "--",
        ]
        assert calls[0][0][5] == "src/entry/main.tsx"
        assert calls[0][0][6].startswith(str(app / ".dist-next-"))
        assert len(calls[0][0]) == 7
        assert calls[0][1]["idle_timeout_seconds"] == 180

    def test_zero_byte_bundle_is_never_promoted(self, tmp_path):
        app = _make_runtime(tmp_path)
        os.utime(app / "src" / "runtime" / "old.ts", (300, 300))

        def runner(command, **_kwargs):
            _write(Path(command[-1]) / "main.js", "")
            return _ok(command)

        success, result = runtime.build_bundle(
            app,
            npm=["/node-26", "/npm-cli.js"],
            env={"PATH": "/node-26"},
            runner=runner,
        )

        assert not success
        assert "non-empty" in result.stderr
        assert (app / "dist" / "main.js").read_text() == "old bundle"

    def test_source_change_during_build_is_never_promoted(self, tmp_path):
        app = _make_runtime(tmp_path)
        os.utime(app / "src" / "runtime" / "old.ts", (300, 300))

        def runner(command, **_kwargs):
            _write(Path(command[-1]) / "main.js", "new bundle")
            _write(app / "src" / "runtime" / "raced.ts", "changed during build")
            return _ok(command)

        success, result = runtime.build_bundle(
            app,
            npm=["/node-26", "/npm-cli.js"],
            env={"PATH": "/node-26"},
            runner=runner,
        )

        assert not success
        assert "inputs changed" in result.stderr
        assert (app / "dist" / "main.js").read_text() == "old bundle"

    def test_dependency_change_installs_and_promotes_both_dirs(self, tmp_path):
        app = _make_runtime(tmp_path)
        _change_dependency_lock(app)
        calls = []

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            if "ci" in command:
                _install_fixture_dependencies(app, Path(kwargs["cwd"]))
                _write(Path(kwargs["cwd"]) / "node_modules" / "new.txt", "new deps")
            else:
                _write(Path(command[-1]) / "main.js", "new bundle")
            return _ok(command)

        success, _result = runtime.refresh_runtime(
            app,
            identity=TEST_IDENTITY,
            npm=["/node-26", "/npm-cli.js"],
            env={"PATH": "/node-26"},
            runner=runner,
        )

        assert success
        assert "ci" in calls[0][0]
        assert "--include=dev" in calls[0][0]
        assert "run" in calls[1][0]
        assert all(call[1]["idle_timeout_seconds"] == 180 for call in calls)
        assert not (app / "node_modules" / "old-runtime.txt").exists()
        assert (app / "node_modules" / "new.txt").read_text() == "new deps"
        assert (app / "dist" / "main.js").read_text() == "new bundle"
        assert runtime.dependencies_current(app, TEST_IDENTITY)

    def test_source_change_during_dependency_staging_preserves_live_runtime(
        self, tmp_path
    ):
        app = _make_runtime(tmp_path)
        _change_dependency_lock(app)

        def runner(command, **kwargs):
            if "ci" in command:
                _install_fixture_dependencies(app, Path(kwargs["cwd"]))
            else:
                _write(Path(command[-1]) / "main.js", "new bundle")
                _write(app / "src" / "runtime" / "raced.ts", "changed")
            return _ok(command)

        success, result = runtime.refresh_runtime(
            app,
            identity=TEST_IDENTITY,
            npm=["/node-26", "/npm-cli.js"],
            env={"PATH": "/node-26"},
            runner=runner,
        )

        assert not success
        assert "inputs changed" in result.stderr
        assert (app / "node_modules" / "old-runtime.txt").is_file()
        assert (app / "dist" / "main.js").read_text() == "old bundle"

    def test_build_runner_exception_preserves_prior_bundle(self, tmp_path):
        app = _make_runtime(tmp_path)

        def runner(*_args, **_kwargs):
            raise OSError("spawn failed")

        success, result = runtime.build_bundle(
            app,
            npm=["/node-26", "/npm-cli.js"],
            env={"PATH": "/node-26"},
            runner=runner,
        )

        assert not success
        assert "spawn failed" in result.stderr
        assert (app / "dist" / "main.js").read_text() == "old bundle"

    @pytest.mark.parametrize("failure_phase", ["install", "build"])
    def test_dependency_refresh_failure_preserves_live_runtime(
        self, tmp_path, failure_phase
    ):
        app = _make_runtime(tmp_path)
        _change_dependency_lock(app)

        def runner(command, **kwargs):
            if "ci" in command:
                if failure_phase == "install":
                    return subprocess.CompletedProcess(
                        command, 1, stdout="", stderr="registry offline"
                    )
                _install_fixture_dependencies(app, Path(kwargs["cwd"]))
                return _ok(command)
            return subprocess.CompletedProcess(
                command, 1, stdout="", stderr="compiler failed"
            )

        success, _result = runtime.refresh_runtime(
            app,
            identity=TEST_IDENTITY,
            npm=["/node-26", "/npm-cli.js"],
            env={"PATH": "/node-26"},
            runner=runner,
        )

        assert not success
        assert (app / "dist" / "main.js").read_text() == "old bundle"
        assert (app / "node_modules" / "old-runtime.txt").read_text() == (
            "old dependencies"
        )
        assert not list(tmp_path.glob(".ui-opentui-update-*"))

    def test_two_directory_promotion_rolls_back_if_second_swap_fails(
        self, tmp_path, monkeypatch
    ):
        app = _make_runtime(tmp_path)
        staging = tmp_path / "staged"
        _write(staging / "node_modules" / "new.txt", "new deps")
        _write(staging / "dist" / "main.js", "new bundle")
        real_replace = runtime.os.replace

        def fail_dist_promotion(source, destination):
            if Path(source) == staging / "dist" and Path(destination) == app / "dist":
                raise OSError("injected second-swap failure")
            return real_replace(source, destination)

        monkeypatch.setattr(runtime.os, "replace", fail_dist_promotion)

        with pytest.raises(OSError, match="second-swap"):
            runtime.promote_runtime(app, staging)

        assert (app / "dist" / "main.js").read_text() == "old bundle"
        assert (app / "node_modules" / "old-runtime.txt").read_text() == (
            "old dependencies"
        )


class TestMainIntegration:
    def test_fresh_launch_does_not_build(self, tmp_path, monkeypatch):
        app = _make_runtime(tmp_path)
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod,
            "_run_with_idle_timeout",
            lambda *_args, **_kwargs: pytest.fail("fresh launch must not build"),
        )

        argv, cwd = main_mod._make_opentui_argv(tui_dev=False)

        assert cwd == app
        assert argv[-1] == str(app / "dist" / "main.js")

    def test_next_source_launch_prunes_completed_paired_backups(
        self, tmp_path, monkeypatch
    ):
        app = _make_runtime(tmp_path)
        suffix = ".ui-opentui-update-crashed"
        node_backup = app / f".node_modules.previous-{suffix}"
        dist_backup = app / f".dist.previous-{suffix}"
        shutil.copytree(app / "node_modules", node_backup)
        shutil.copytree(app / "dist", dist_backup)
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod,
            "_run_with_idle_timeout",
            lambda *_args, **_kwargs: pytest.fail("fresh runtime must not rebuild"),
        )

        argv, cwd = main_mod._make_opentui_argv(tui_dev=False)

        assert cwd == app
        assert argv[-1] == str(app / "dist" / "main.js")
        assert not node_backup.exists()
        assert not dist_backup.exists()

    def test_next_source_launch_prunes_abandoned_staging(
        self, tmp_path, monkeypatch
    ):
        app = _make_runtime(tmp_path)
        staging = tmp_path / ".ui-opentui-update-crashed"
        _write(staging / "src" / "stale.ts", "abandoned")
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod,
            "_run_with_idle_timeout",
            lambda *_args, **_kwargs: pytest.fail("fresh runtime must not rebuild"),
        )

        main_mod._make_opentui_argv(tui_dev=False)

        assert not staging.exists()

    def test_fresh_pruned_launch_is_offline_and_does_not_build(
        self, tmp_path, monkeypatch
    ):
        app = _make_runtime(tmp_path, stamped=False)
        _prune_build_toolchain(app)
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod._opentui_runtime,
            "npm_command",
            lambda _node: pytest.fail("fresh pruned launch must stay offline"),
        )

        argv, _cwd = main_mod._make_opentui_argv(tui_dev=False)

        assert argv[-1] == str(app / "dist" / "main.js")

    def test_stale_pruned_launch_escalates_to_staged_ci(self, tmp_path, monkeypatch):
        app = _make_runtime(tmp_path)
        _prune_build_toolchain(app)
        os.utime(app / "src" / "runtime" / "old.ts", (300, 300))
        calls = []
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod._opentui_runtime,
            "npm_command",
            lambda _node: ["/node-26", "/npm-cli.js"],
        )

        def runner(command, **kwargs):
            calls.append(command)
            if "ci" in command:
                _install_fixture_dependencies(app, Path(kwargs["cwd"]))
            else:
                _write(Path(command[-1]) / "main.js", "rebuilt")
            return _ok(command)

        monkeypatch.setattr(main_mod, "_run_with_idle_timeout", runner)

        argv, _cwd = main_mod._make_opentui_argv(tui_dev=False)

        assert "ci" in calls[0]
        assert argv[-1] == str(app / "dist" / "main.js")

    def test_missing_stamped_native_package_forces_refresh_before_launch(
        self, tmp_path, monkeypatch
    ):
        app = _make_runtime(tmp_path)
        known_good_dependencies = tmp_path / "known-good-node-modules"
        shutil.copytree(app / "node_modules", known_good_dependencies)
        native_package = runtime.selected_native_package_name(TEST_IDENTITY)
        assert native_package is not None
        shutil.rmtree(app / "node_modules" / native_package)
        calls = []
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod._opentui_runtime,
            "npm_command",
            lambda _node: ["/node-26", "/npm-cli.js"],
        )

        def runner(command, **kwargs):
            calls.append(command)
            if "ci" in command:
                shutil.copytree(
                    known_good_dependencies,
                    Path(kwargs["cwd"]) / "node_modules",
                )
            else:
                _write(Path(command[-1]) / "main.js", "recovered")
            return _ok(command)

        monkeypatch.setattr(main_mod, "_run_with_idle_timeout", runner)

        argv, _cwd = main_mod._make_opentui_argv(tui_dev=False)

        assert "ci" in calls[0]
        assert argv[-1] == str(app / "dist" / "main.js")
        assert (app / "node_modules" / native_package).is_dir()

    @pytest.mark.parametrize("missing", ["effect", "native"])
    def test_missing_runtime_payload_and_failed_refresh_never_launches_old_bundle(
        self, tmp_path, monkeypatch, missing
    ):
        app = _make_runtime(tmp_path)
        package_name = (
            runtime.selected_native_package_name(TEST_IDENTITY)
            if missing == "native"
            else missing
        )
        assert package_name is not None
        shutil.rmtree(app / "node_modules" / package_name)
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(main_mod, "_node26_bin_or_none", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod._opentui_runtime,
            "npm_command",
            lambda _node: ["/node-26", "/npm-cli.js"],
        )
        monkeypatch.setattr(
            main_mod,
            "_run_with_idle_timeout",
            lambda command, **_kwargs: subprocess.CompletedProcess(
                command, 1, stdout="", stderr="offline"
            ),
        )

        assert not main_mod._opentui_available()
        with pytest.raises(SystemExit):
            main_mod._make_opentui_argv(tui_dev=False)
        assert (app / "dist" / "main.js").read_text() == "old bundle"

    def test_source_build_failure_uses_prior_runtime(self, tmp_path, monkeypatch):
        app = _make_runtime(tmp_path)
        os.utime(app / "src" / "runtime" / "old.ts", (300, 300))
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod._opentui_runtime,
            "npm_command",
            lambda _node: ["/node-26", "/npm-cli.js"],
        )
        monkeypatch.setattr(
            main_mod,
            "_run_with_idle_timeout",
            lambda command, **_kwargs: subprocess.CompletedProcess(
                command, 1, stdout="", stderr="compiler failed"
            ),
        )

        argv, _cwd = main_mod._make_opentui_argv(tui_dev=False)

        assert argv[-1] == str(app / "dist" / "main.js")
        assert (app / "dist" / "main.js").read_text() == "old bundle"

    def test_zero_byte_prior_bundle_never_falls_back_after_refresh_failure(
        self, tmp_path, monkeypatch
    ):
        app = _make_runtime(tmp_path)
        (app / "dist" / "main.js").write_bytes(b"")
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod._opentui_runtime,
            "npm_command",
            lambda _node: ["/node-26", "/npm-cli.js"],
        )
        monkeypatch.setattr(
            main_mod,
            "_run_with_idle_timeout",
            lambda command, **_kwargs: subprocess.CompletedProcess(
                command, 1, stdout="", stderr="compiler failed"
            ),
        )

        with pytest.raises(SystemExit):
            main_mod._make_opentui_argv(tui_dev=False)

        assert not runtime.bundle_payload_present(app)

    def test_post_refresh_noncurrent_generation_is_never_launched(
        self, tmp_path, monkeypatch
    ):
        app = _make_runtime(tmp_path)
        os.utime(app / "src" / "runtime" / "old.ts", (300, 300))
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod._opentui_runtime,
            "npm_command",
            lambda _node: ["/node-26", "/npm-cli.js"],
        )

        def runner(command, **_kwargs):
            _write(Path(command[-1]) / "main.js", "compiled")
            return _ok(command)

        def reject_completed(location, identity):
            inspection = runtime.inspect_runtime(
                location.runtime_dir, identity, env={}
            )
            return False, inspection, True

        monkeypatch.setattr(main_mod, "_run_with_idle_timeout", runner)
        monkeypatch.setattr(
            main_mod, "_completed_opentui_refresh", reject_completed
        )

        with pytest.raises(SystemExit):
            main_mod._make_opentui_argv(tui_dev=False)

    def test_failed_refresh_backoff_retries_for_changed_digest_or_node(
        self, tmp_path, monkeypatch
    ):
        app = _make_runtime(tmp_path)
        _change_dependency_lock(app)
        selected_node = ["/node-a"]
        attempts = []
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: selected_node[0])
        monkeypatch.setattr(
            main_mod._opentui_runtime,
            "npm_command",
            lambda node: [node, "/npm-cli.js"],
        )

        def runner(command, **_kwargs):
            attempts.append(command)
            return subprocess.CompletedProcess(
                command, 1, stdout="", stderr="registry offline"
            )

        monkeypatch.setattr(main_mod, "_run_with_idle_timeout", runner)

        main_mod._make_opentui_argv(tui_dev=False)
        main_mod._make_opentui_argv(tui_dev=False)
        assert len(attempts) == 1

        _write(app / "src" / "runtime" / "old.ts", "new digest")
        main_mod._make_opentui_argv(tui_dev=False)
        assert len(attempts) == 2

        selected_node[0] = "/node-b"
        main_mod._make_opentui_argv(tui_dev=False)
        assert len(attempts) == 3

    def test_force_and_explicit_update_bypass_failed_refresh_backoff(
        self, tmp_path, monkeypatch
    ):
        app = _make_runtime(tmp_path)
        _change_dependency_lock(app)
        attempts = []
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(main_mod, "_node26_bin_or_none", lambda: "/node-26")
        monkeypatch.setattr(main_mod, "_is_termux_startup_environment", lambda: False)
        monkeypatch.setattr(
            main_mod._opentui_runtime,
            "npm_command",
            lambda node: [node, "/npm-cli.js"],
        )

        def runner(command, **_kwargs):
            attempts.append(command)
            return subprocess.CompletedProcess(
                command, 1, stdout="", stderr="registry offline"
            )

        monkeypatch.setattr(main_mod, "_run_with_idle_timeout", runner)

        main_mod._make_opentui_argv(tui_dev=False)
        main_mod._make_opentui_argv(tui_dev=False)
        assert len(attempts) == 1

        monkeypatch.setenv("HERMES_TUI_FORCE_BUILD", "1")
        main_mod._make_opentui_argv(tui_dev=False)
        assert len(attempts) == 2

        monkeypatch.delenv("HERMES_TUI_FORCE_BUILD")
        assert not main_mod._update_opentui_package()
        assert len(attempts) == 3

    def test_lock_refresh_failure_uses_coherent_prior_runtime(
        self, tmp_path, monkeypatch
    ):
        app = _make_runtime(tmp_path)
        _change_dependency_lock(app)
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_node26_bin", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod._opentui_runtime,
            "npm_command",
            lambda _node: ["/node-26", "/npm-cli.js"],
        )
        monkeypatch.setattr(
            main_mod,
            "_run_with_idle_timeout",
            lambda command, **_kwargs: subprocess.CompletedProcess(
                command, 1, stdout="", stderr="registry offline"
            ),
        )

        argv, _cwd = main_mod._make_opentui_argv(tui_dev=False)

        assert argv[-1] == str(app / "dist" / "main.js")
        assert (app / "dist" / "main.js").read_text() == "old bundle"
        assert (app / "node_modules" / "old-runtime.txt").read_text() == (
            "old dependencies"
        )

    def test_update_lock_change_uses_sanitized_staged_install(
        self, tmp_path, monkeypatch
    ):
        app = _make_runtime(tmp_path)
        _change_dependency_lock(app)
        calls = []
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_is_termux_startup_environment", lambda: False)
        monkeypatch.setattr(main_mod, "_node26_bin_or_none", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod._opentui_runtime,
            "npm_command",
            lambda _node: ["/node-26", "/npm-cli.js"],
        )
        monkeypatch.setenv("NODE_ENV", "production")
        monkeypatch.setenv("NPM_CONFIG_OMIT", "dev")

        def runner(command, **kwargs):
            calls.append((command, kwargs))
            if "ci" in command:
                _install_fixture_dependencies(app, Path(kwargs["cwd"]))
            else:
                _write(Path(command[-1]) / "main.js", "updated")
            return _ok(command)

        monkeypatch.setattr(main_mod, "_run_with_idle_timeout", runner)

        assert main_mod._update_opentui_package()
        install_command, install_kwargs = calls[0]
        assert "ci" in install_command
        assert "--include=dev" in install_command
        assert install_kwargs["idle_timeout_seconds"] == 180
        assert "NODE_ENV" not in install_kwargs["env"]
        assert "NPM_CONFIG_OMIT" not in install_kwargs["env"]
        assert install_kwargs["env"]["npm_config_include"] == "dev"
        assert install_kwargs["env"]["PATH"].split(os.pathsep)[0] == "/"

    def test_update_source_change_builds_bundle_without_npm_ci(
        self, tmp_path, monkeypatch
    ):
        app = _make_runtime(tmp_path)
        os.utime(app / "src" / "runtime" / "old.ts", (300, 300))
        calls = []
        monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
        monkeypatch.setattr(main_mod, "_is_termux_startup_environment", lambda: False)
        monkeypatch.setattr(main_mod, "_node26_bin_or_none", lambda: "/node-26")
        monkeypatch.setattr(
            main_mod._opentui_runtime,
            "npm_command",
            lambda _node: ["/node-26", "/npm-cli.js"],
        )

        def runner(command, **_kwargs):
            calls.append(command)
            _write(Path(command[-1]) / "main.js", "updated source bundle")
            return _ok(command)

        monkeypatch.setattr(main_mod, "_run_with_idle_timeout", runner)

        assert main_mod._update_opentui_package()
        assert len(calls) == 1
        assert "run" in calls[0]
        assert "ci" not in calls[0]
        assert (app / "dist" / "main.js").read_text() == "updated source bundle"

    def test_update_wrapper_always_includes_standalone_package(self, monkeypatch):
        calls = []
        monkeypatch.setattr(
            main_mod,
            "_update_workspace_node_dependencies",
            lambda: calls.append("workspaces"),
        )
        monkeypatch.setattr(
            main_mod, "_update_opentui_package", lambda: calls.append("opentui")
        )

        main_mod._update_node_dependencies()

        assert calls == ["workspaces", "opentui"]
