"""Fork configuration choices survive the extracted upstream setter pipeline."""

import pytest
import yaml

from tui_gateway import server


@pytest.mark.parametrize("delegation", [None, "expanded"])
def test_global_details_does_not_overwrite_delegation_preference(tmp_path, monkeypatch, delegation):
    monkeypatch.setattr(server, "_hermes_home", tmp_path)
    config = {"display": {"sections": {}}}
    if delegation is not None:
        config["display"]["sections"]["delegation"] = delegation
    server._save_cfg(config)

    response = server.handle_request({
        "id": "details", "method": "config.set",
        "params": {"key": "details_mode", "value": "hidden"},
    })

    assert response["result"]["value"] == "hidden"
    saved = yaml.safe_load((tmp_path / "config.yaml").read_text())
    sections = saved["display"]["sections"]
    assert sections.get("delegation") == delegation
    assert all(sections[name] == "hidden" for name in server._GLOBAL_DETAIL_SECTION_NAMES)


@pytest.mark.parametrize("value", ["show", "hide", "full", "clamp", "medium"])
def test_stale_reasoning_request_never_mutates_display_or_effort(tmp_path, monkeypatch, value):
    monkeypatch.setattr(server, "_hermes_home", tmp_path)
    server._save_cfg({"display": {"show_reasoning": False}, "agent": {"reasoning_effort": "high"}})
    path = tmp_path / "config.yaml"
    before = path.read_bytes()

    response = server.handle_request({
        "id": "stale", "method": "config.set",
        "params": {"session_id": "no-longer-live", "key": "reasoning", "value": value},
    })

    assert response["error"]["code"] == 4006
    assert path.read_bytes() == before
