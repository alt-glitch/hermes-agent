"""Regression coverage for OpenTUI metadata bumps in the release script."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path


def _load_release_module(monkeypatch, tmp_root: Path):
    spec = importlib.util.spec_from_file_location(
        "_release_opentui_versions_under_test",
        Path(__file__).resolve().parents[2] / "scripts" / "release.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    monkeypatch.setattr(module, "REPO_ROOT", tmp_root)
    monkeypatch.setattr(
        module,
        "VERSION_FILE",
        tmp_root / "hermes_cli" / "__init__.py",
    )
    monkeypatch.setattr(module, "PYPROJECT_FILE", tmp_root / "pyproject.toml")
    return module


def test_update_version_files_bumps_all_opentui_version_fields(
    monkeypatch, tmp_path
):
    version_dir = tmp_path / "hermes_cli"
    version_dir.mkdir()
    (version_dir / "__init__.py").write_text(
        "__version__ = \"0.18.2\"\n__release_date__ = \"2026.7.13\"\n",
        encoding="utf-8",
    )
    (tmp_path / "pyproject.toml").write_text(
        "[project]\nname = \"hermes-agent\"\nversion = \"0.18.2\"\n",
        encoding="utf-8",
    )

    app_dir = tmp_path / "ui-opentui"
    app_dir.mkdir()
    (app_dir / "package.json").write_text(
        json.dumps(
            {
                "name": "@hermes/ui-opentui",
                "version": "0.18.2",
                "private": True,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (app_dir / "package-lock.json").write_text(
        json.dumps(
            {
                "name": "@hermes/ui-opentui",
                "version": "0.18.2",
                "lockfileVersion": 3,
                "packages": {
                    "": {
                        "name": "@hermes/ui-opentui",
                        "version": "0.18.2",
                        "dependencies": {"effect": "4.0.0-beta.78"},
                    },
                    "node_modules/effect": {"version": "4.0.0-beta.78"},
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    module = _load_release_module(monkeypatch, tmp_path)
    module.update_version_files("0.19.0", "2026.7.20")

    package = json.loads((app_dir / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((app_dir / "package-lock.json").read_text(encoding="utf-8"))

    assert package["version"] == "0.19.0"
    assert package["private"] is True
    assert lock["version"] == "0.19.0"
    assert lock["packages"][""]["version"] == "0.19.0"
    assert lock["packages"][""]["dependencies"] == {
        "effect": "4.0.0-beta.78"
    }
    assert lock["packages"]["node_modules/effect"]["version"] == "4.0.0-beta.78"
