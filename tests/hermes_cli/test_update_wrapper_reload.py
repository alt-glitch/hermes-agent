"""Reload-safety contracts for the extracted update command wrapper."""

from __future__ import annotations

import importlib

import hermes_cli.main as main_mod


def test_update_node_dependencies_survives_repeated_reload(
    tmp_path, monkeypatch
) -> None:
    for _ in range(3):
        importlib.reload(main_mod)

    opentui_calls: list[str] = []
    monkeypatch.setattr(main_mod, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(
        main_mod,
        "_update_opentui_package",
        lambda: opentui_calls.append("opentui") or True,
    )

    assert main_mod._update_node_dependencies() == []
    assert opentui_calls == ["opentui"]
    assert main_mod._update_cmd._update_node_dependencies is (
        main_mod._update_node_dependencies
    )
