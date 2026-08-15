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

    # Upstream now lazy-loads command modules through main.__getattr__ instead
    # of retaining the old eager main._update_cmd alias.  The behavior contract
    # is that resolving the main export decorates the authoritative update_cmd
    # function used by the real update path, without undoing that startup win.
    update_cmd = importlib.import_module("hermes_cli.update_cmd")
    assert update_cmd._update_node_dependencies is main_mod._update_node_dependencies
