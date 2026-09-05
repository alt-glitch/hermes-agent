"""Reload-safety contracts for the extracted update command wrapper."""

from __future__ import annotations

import importlib

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
        lambda: opentui_calls.append("opentui") or True,
    )

    assert update_cmd._update_node_dependencies() == []
    assert opentui_calls == ["opentui"]

    # Reloading the CLI facade must not remove or multiply OpenTUI hydration.
    # The extracted dependency module owns the wrapper used by the updater.
    assert update_cmd._update_node_dependencies is update_cmd_deps._update_node_dependencies


@pytest.mark.parametrize("workspace_failures", [[], ["ui-tui, web workspaces"]])
@pytest.mark.parametrize("opentui_ok", [True, False])
def test_update_keeps_both_engines_failure_reporting(
    monkeypatch, workspace_failures, opentui_ok
):
    monkeypatch.setattr(
        update_cmd_deps, "_update_workspace_node_dependencies",
        lambda: list(workspace_failures),
    )
    monkeypatch.setattr(
        main_tui_launch, "_update_opentui_package", lambda: opentui_ok,
    )

    failures = update_cmd._update_node_dependencies()

    assert failures == workspace_failures + ([] if opentui_ok else ["OpenTUI engine"])
