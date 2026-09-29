"""Reload-safety contracts for the fork's OpenTUI engine refresh during updates.

The fork's OpenTUI refresh lives in ``source_build._refresh_opentui_engine``,
which ``build_update_products`` runs after the shared (Ink/web) products. The
old updater's ``_update_node_dependencies`` name is a retired shim and must stay
one: the live refresh never moves back under it.
"""

from __future__ import annotations

import importlib

import pytest

import hermes_cli.main as main_mod
from hermes_cli import main_tui_launch, old_updater_deps, source_build, update_cmd


def _stub_shared_update_products(monkeypatch, calls: list[str]) -> None:
    """Record the shared (Ink/web) product steps of ``build_update_products``."""
    import hermes_cli.main_install_repair as install_repair
    import hermes_cli.memory_provider_migration as memory_migration
    import hermes_cli.update_stage as update_stage

    monkeypatch.setattr(install_repair, "_install_configured_features_missing_deps", lambda _root: None)
    monkeypatch.setattr(update_stage, "publish_stage", lambda _stage: None)
    monkeypatch.setattr(memory_migration, "migrate_all_homes", lambda: None)
    monkeypatch.setattr(source_build, "source_frontends", lambda _root: ("ui-tui", "web"))
    monkeypatch.setattr(source_build, "source_build_env", lambda **_kwargs: {"PATH": ""})
    monkeypatch.setattr(
        source_build, "prepare_source_dependencies",
        lambda *_args, **_kwargs: calls.append("deps"),
    )
    monkeypatch.setattr(
        source_build, "build_source_tui", lambda *_args, **_kwargs: calls.append("tui")
    )
    monkeypatch.setattr(
        source_build, "build_source_web", lambda *_args, **_kwargs: calls.append("web")
    )


def test_opentui_refresh_survives_repeated_reload(tmp_path, monkeypatch) -> None:
    for _ in range(3):
        importlib.reload(main_mod)

    (tmp_path / "ui-opentui").mkdir()
    (tmp_path / "ui-opentui" / "package.json").write_text("{}", encoding="utf-8")
    opentui_calls: list[str] = []
    monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(
        main_tui_launch,
        "_update_opentui_package",
        lambda: (
            opentui_calls.append("opentui")
            or main_tui_launch._OpenTUIUpdateStatus.READY
        ),
    )

    source_build._refresh_opentui_engine(tmp_path, lambda _stage: None)

    # Reloading the CLI facade must not remove or multiply OpenTUI hydration.
    assert opentui_calls == ["opentui"]
    # The old updater's hook stays the retired shim; the live refresh never
    # moves back under the shimmed name.
    assert (
        update_cmd._update_node_dependencies
        is old_updater_deps._update_node_dependencies
    )


@pytest.mark.parametrize(
    ("opentui_status", "fails"),
    [
        (main_tui_launch._OpenTUIUpdateStatus.READY, False),
        (main_tui_launch._OpenTUIUpdateStatus.SKIPPED, False),
        (main_tui_launch._OpenTUIUpdateStatus.FAILED, True),
    ],
)
def test_update_keeps_both_engines_failure_reporting(
    tmp_path, monkeypatch, opentui_status, fails
):
    """Ink/web products are built before the OpenTUI refresh, so its failure never
    withholds them; only an attempted-and-failed OpenTUI refresh fails the update."""
    (tmp_path / "ui-opentui").mkdir()
    (tmp_path / "ui-opentui" / "package.json").write_text("{}", encoding="utf-8")
    calls: list[str] = []
    _stub_shared_update_products(monkeypatch, calls)
    monkeypatch.setattr(
        main_tui_launch,
        "_update_opentui_package",
        lambda: calls.append("opentui") or opentui_status,
    )

    if fails:
        with pytest.raises(RuntimeError, match="OpenTUI engine refresh failed"):
            source_build.build_update_products(tmp_path, desktop=False)
    else:
        source_build.build_update_products(tmp_path, desktop=False)

    assert calls == ["deps", "tui", "web", "opentui"]


@pytest.mark.platforms("linux")
@pytest.mark.parametrize("opentui_failure", [False, True])
def test_update_continues_only_after_optional_opentui_skip(
    tmp_path, monkeypatch, opentui_failure
):
    hermes_home = tmp_path / "home"
    seed = tmp_path / "ui-opentui"
    hermes_home.mkdir()
    seed.mkdir()
    (seed / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("HOME", str(hermes_home))
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(
        main_tui_launch, "_is_termux_startup_environment", lambda: False
    )
    monkeypatch.setattr(main_tui_launch, "_node26_bin_or_none", lambda: None)
    if opentui_failure:
        monkeypatch.setattr(
            main_tui_launch, "_opentui_runtime_location", lambda **_kwargs: None
        )
    else:
        location = main_tui_launch._opentui_runtime.RuntimeLocation(seed, seed)
        monkeypatch.setattr(
            main_tui_launch,
            "_opentui_runtime_location",
            lambda **_kwargs: location,
        )
    stages: list[str] = []

    if opentui_failure:
        # An incomplete packaged seed is a failure, not an optional skip.
        with pytest.raises(RuntimeError, match="OpenTUI engine refresh failed"):
            source_build._refresh_opentui_engine(tmp_path, stages.append)
    else:
        # Missing Node 26 is an explicit skip: the update continues.
        source_build._refresh_opentui_engine(tmp_path, stages.append)
    assert stages == ["Updating the OpenTUI engine"]
