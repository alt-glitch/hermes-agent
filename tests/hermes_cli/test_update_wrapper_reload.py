"""Reload-safety contracts for the extracted update command wrapper."""

from __future__ import annotations

import importlib
from unittest.mock import MagicMock

import pytest

import hermes_cli.main as main_mod
from hermes_cli import main_tui_launch, update_cmd, update_cmd_deps


def test_update_node_dependencies_survives_repeated_reload(
    tmp_path, monkeypatch
) -> None:
    for _ in range(3):
        importlib.reload(main_mod)

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

    assert update_cmd._update_node_dependencies() == []
    assert opentui_calls == ["opentui"]

    # Reloading the CLI facade must not remove or multiply OpenTUI hydration.
    # The extracted dependency module owns the wrapper used by the updater.
    assert (
        update_cmd._update_node_dependencies
        is update_cmd_deps._update_node_dependencies
    )


@pytest.mark.parametrize("workspace_failures", [[], ["ui-tui, web workspaces"]])
@pytest.mark.parametrize(
    ("opentui_status", "opentui_failures"),
    [
        (main_tui_launch._OpenTUIUpdateStatus.READY, []),
        (main_tui_launch._OpenTUIUpdateStatus.SKIPPED, []),
        (main_tui_launch._OpenTUIUpdateStatus.FAILED, ["OpenTUI engine"]),
    ],
)
def test_update_keeps_both_engines_failure_reporting(
    monkeypatch, workspace_failures, opentui_status, opentui_failures
):
    monkeypatch.setattr(
        update_cmd_deps,
        "_update_workspace_node_dependencies",
        lambda: list(workspace_failures),
    )
    monkeypatch.setattr(
        main_tui_launch,
        "_update_opentui_package",
        lambda: opentui_status,
    )

    failures = update_cmd._update_node_dependencies()

    assert failures == workspace_failures + opentui_failures


@pytest.mark.parametrize("opentui_failure", [False, True])
def test_current_checkout_continues_only_after_optional_opentui_skip(
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
        update_cmd_deps, "_update_workspace_node_dependencies", lambda: []
    )
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

    updater = MagicMock()
    updater.PROJECT_ROOT = tmp_path
    completion = MagicMock(return_value=True)
    monkeypatch.setattr(update_cmd, "_m", lambda: updater)
    monkeypatch.setattr(update_cmd, "_check_and_apply_config_migration", MagicMock())
    monkeypatch.setattr(
        update_cmd,
        "_rebuild_desktop_after_update",
        MagicMock(return_value=True),
    )

    result = update_cmd._repair_node_deps_on_current_checkout(completion)

    if opentui_failure:
        assert not result
        updater._build_web_ui.assert_not_called()
        update_cmd._check_and_apply_config_migration.assert_not_called()
        update_cmd._rebuild_desktop_after_update.assert_not_called()
        completion.assert_called_once_with(
            "⚠ Checkout is current, but Node.js dependencies could not be repaired."
        )
    else:
        assert result
        updater._build_web_ui.assert_called_once_with(tmp_path / "web")
        update_cmd._check_and_apply_config_migration.assert_called_once()
        update_cmd._rebuild_desktop_after_update.assert_called_once()
        completion.assert_called_once_with("✓ Already up to date!")
