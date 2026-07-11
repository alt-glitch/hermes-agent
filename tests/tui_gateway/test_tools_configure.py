"""Safety contracts for the live ``tools.configure`` RPC."""

from __future__ import annotations

import threading
from unittest.mock import patch

import tui_gateway.server as server


def test_tools_configure_rejects_running_session_before_config_mutation() -> None:
    session = {"running": True}
    with (
        patch.dict(server._sessions, {"live-1": session}, clear=False),
        patch("hermes_cli.config.load_config") as load_config,
        patch.object(server, "_reset_session_agent") as reset_agent,
    ):
        response = server._methods["tools.configure"](
            "rid-tools",
            {"action": "disable", "names": ["web"], "session_id": "live-1"},
        )

    assert response["error"] == {
        "code": 4009,
        "message": "session busy — interrupt the current turn before changing tools",
    }
    load_config.assert_not_called()
    reset_agent.assert_not_called()


def test_tools_configure_claim_atomically_rejects_racing_prompt() -> None:
    entered_config = threading.Event()
    release_config = threading.Event()
    session = {"history_lock": threading.Lock(), "running": False}
    result: dict = {}

    def load_config() -> dict:
        entered_config.set()
        assert release_config.wait(2), "test did not release tools.configure"
        return {}

    def run_configure() -> None:
        result.update(
            server._methods["tools.configure"](
                "rid-tools",
                {
                    "action": "enable",
                    "names": ["definitely-unknown"],
                    "session_id": "live-1",
                },
            )
        )

    with (
        patch.dict(server._sessions, {"live-1": session}, clear=False),
        patch("hermes_cli.config.load_config", side_effect=load_config),
        patch("hermes_cli.config.save_config"),
        patch("hermes_cli.tools_config._get_plugin_toolset_keys", return_value=set()),
        patch("hermes_cli.tools_config._get_platform_tools", return_value=[]),
        patch.object(server, "_reset_session_agent", return_value={"running": False}),
    ):
        worker = threading.Thread(target=run_configure)
        worker.start()
        assert entered_config.wait(2), "tools.configure never reached config load"

        prompt = server._methods["prompt.submit"](
            "rid-prompt", {"session_id": "live-1", "text": "must not race"}
        )
        assert prompt["error"] == {
            "code": 4009,
            "message": "session tools are being reconfigured — wait for it to finish",
        }

        release_config.set()
        worker.join(2)
        assert not worker.is_alive()

    assert result["result"]["reset"] is True
    assert "_tools_configuring" not in session


def test_session_close_waits_for_tools_agent_rebuild() -> None:
    entered_reset = threading.Event()
    release_reset = threading.Event()
    close_started = threading.Event()
    close_finished = threading.Event()
    session = {"history_lock": threading.Lock(), "running": False}
    closed: list[bool] = []

    def reset_agent(_sid: str, _session: dict) -> dict:
        entered_reset.set()
        assert release_reset.wait(2), "test did not release agent reset"
        return {"running": False}

    def run_configure() -> None:
        server._methods["tools.configure"](
            "rid-tools",
            {
                "action": "enable",
                "names": ["definitely-unknown"],
                "session_id": "live-1",
            },
        )

    def run_close() -> None:
        close_started.set()
        closed.append(server._close_session_by_id("live-1"))
        close_finished.set()

    with (
        patch.dict(server._sessions, {"live-1": session}, clear=False),
        patch("hermes_cli.config.load_config", return_value={}),
        patch("hermes_cli.config.save_config"),
        patch("hermes_cli.tools_config._get_plugin_toolset_keys", return_value=set()),
        patch("hermes_cli.tools_config._get_platform_tools", return_value=[]),
        patch.object(server, "_reset_session_agent", side_effect=reset_agent),
        patch.object(server, "_teardown_session"),
    ):
        configure_worker = threading.Thread(target=run_configure)
        configure_worker.start()
        assert entered_reset.wait(2), "tools.configure never reached agent reset"

        close_worker = threading.Thread(target=run_close)
        close_worker.start()
        assert close_started.wait(2)
        assert not close_finished.wait(0.05), (
            "close bypassed the in-flight mutation lock"
        )

        release_reset.set()
        configure_worker.join(2)
        close_worker.join(2)
        assert not configure_worker.is_alive()
        assert not close_worker.is_alive()

    assert closed == [True]
    assert "live-1" not in server._sessions
