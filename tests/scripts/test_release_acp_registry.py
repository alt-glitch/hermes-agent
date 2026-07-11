"""Tests for the ACP Registry version-lockstep bump in scripts/release.py.

The official ACP Registry manifest must match ``pyproject.toml`` exactly —
``tests/acp/test_registry_manifest.py`` enforces this at lint time, and the
upstream registry CI rejects ``@latest`` / floating pins. The release script
is the single place that bumps the manifest in lockstep with pyproject; if
that bump ever silently breaks, weekly releases fail the manifest test
until someone hand-edits the JSON.
"""

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import tarfile
import zipfile
from pathlib import Path
from types import SimpleNamespace


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


def _write_opentui_seed(root: Path, bundle: bytes = b"portable bundle") -> Path:
    app = root / "ui-opentui"
    files = {
        ".node-version": b"26.3.0\n",
        "README.md": b"portable seed\n",
        "package.json": b"{}\n",
        "package-lock.json": b"{}\n",
        "tsconfig.json": b"{}\n",
        "scripts/build.mjs": b"export {}\n",
        "dist/main.js": bundle,
        "src/entry/main.tsx": b"export {}\n",
        "src/logic/store.ts": b"export {}\n",
        "src/test/ignored.ts": b"must not ship\n",
    }
    for relative, payload in files.items():
        path = app / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
    return app


def _write_release_pair(
    root: Path, payload: dict[str, bytes]
) -> tuple[Path, Path]:
    wheel = root / "hermes_agent-1.2.3-py3-none-any.whl"
    with zipfile.ZipFile(wheel, mode="w") as archive:
        for name, content in payload.items():
            archive.writestr(name, content)

    sdist = root / "hermes_agent-1.2.3.tar.gz"
    with tarfile.open(sdist, mode="w:gz") as archive:
        for name, content in payload.items():
            info = tarfile.TarInfo(f"hermes_agent-1.2.3/{name}")
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return wheel, sdist


def test_opentui_release_artifacts_require_exact_universal_seed(
    monkeypatch, tmp_path
):
    app = _write_opentui_seed(tmp_path)
    module = _load_release_module(monkeypatch, tmp_path)
    payload = module._opentui_release_payload(app)
    assert payload is not None
    assert "ui-opentui/src/test/ignored.ts" not in payload
    wheel, sdist = _write_release_pair(tmp_path, payload)

    assert module.validate_opentui_release_artifacts(
        [wheel, sdist], app_dir=app
    )

    with zipfile.ZipFile(wheel, mode="a") as archive:
        archive.writestr("ui-opentui/node_modules/native.so", b"host native")
    assert not module.validate_opentui_release_artifacts(
        [wheel, sdist], app_dir=app
    )


def test_opentui_release_artifacts_reject_platform_wheel(
    monkeypatch, tmp_path
):
    app = _write_opentui_seed(tmp_path)
    module = _load_release_module(monkeypatch, tmp_path)
    payload = module._opentui_release_payload(app)
    assert payload is not None
    wheel, sdist = _write_release_pair(tmp_path, payload)
    platform_wheel = wheel.with_name(
        "hermes_agent-1.2.3-cp313-cp313-manylinux_x86_64.whl"
    )
    wheel.rename(platform_wheel)

    assert not module.validate_opentui_release_artifacts(
        [platform_wheel, sdist], app_dir=app
    )


def test_prepare_opentui_seed_uses_launcher_node_and_paired_npm(
    monkeypatch, tmp_path
):
    app = _write_opentui_seed(tmp_path, bundle=b"stale")
    module = _load_release_module(monkeypatch, tmp_path)
    commands = []
    environment = {"PATH": "/node26/bin", "CI": "1"}

    fake_main = SimpleNamespace(_node26_bin_or_none=lambda: "/node26/bin/node")
    fake_runtime = SimpleNamespace(
        npm_command=lambda node: [node, "/node26/npm-cli.js"],
        build_environment=lambda node: environment,
    )
    import hermes_cli

    monkeypatch.setattr(hermes_cli, "main", fake_main, raising=False)
    monkeypatch.setattr(
        hermes_cli, "opentui_runtime", fake_runtime, raising=False
    )

    def run(command, *, cwd, env, capture_output, text):
        assert not (app / "dist" / "main.js").exists() or commands
        commands.append((tuple(command), Path(cwd), env))
        if command[-2:] == ("run", "build"):
            (app / "dist" / "main.js").write_bytes(b"fresh")
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    monkeypatch.setattr(module.subprocess, "run", run)

    assert module._prepare_opentui_release_seed()
    assert commands == [
        (
            (
                "/node26/bin/node",
                "/node26/npm-cli.js",
                "ci",
                "--include=dev",
                "--no-audit",
                "--no-fund",
                "--progress=false",
            ),
            app,
            environment,
        ),
        (
            ("/node26/bin/node", "/node26/npm-cli.js", "run", "build"),
            app,
            environment,
        ),
    ]
    assert (app / "dist" / "main.js").read_bytes() == b"fresh"
