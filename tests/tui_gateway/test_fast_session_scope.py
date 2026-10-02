"""Fast-mode (service tier) session scoping in the TUI gateway (desktop backend).

Sibling of test_reasoning_session_scope.py — the ``reasoning`` key was made
session-scoped when a session is targeted, but ``fast`` kept writing the
global ``agent.service_tier`` to config.yaml on every call. The desktop's
per-model presets call ``config.set key=fast`` on every model selection, so
toggling fast in ONE session silently flipped the tier for every other
session, profile, CLI, and gateway build ("switch one session, switches
everywhere").

Contract under test:

1. ``config.set key=fast`` with a session must NOT write config.yaml; it pins
   ``create_service_tier_override`` ("priority" / "" for explicit normal) so
   lazily-built sessions and rebuilds keep the choice.
2. Without a session it persists globally, unchanged. A session_id the
   backend no longer holds is refused with 4001, not treated as "no session".
3. ``config.get key=fast`` must read a pre-build session's pin.
"""

from __future__ import annotations

from types import SimpleNamespace
import threading
from unittest.mock import patch

import tui_gateway.server as server

FAST_OVERRIDES = {"service_tier": "priority"}

def _agent(service_tier=None):
    return SimpleNamespace(
        reasoning_config=None,
        service_tier=service_tier,
        request_overrides={},
        model="gpt-6",
        provider="openai",
        session_id="sess-key",
    )

def _set(params: dict) -> dict:
    return server._methods["config.set"]("rid-1", params)

def _get(params: dict) -> dict:
    return server._methods["config.get"]("rid-1", params)

class TestConfigSetFastSessionScope:
    """Session-targeted fast changes must never touch global config."""

    def test_session_scoped_fast_skips_global_write(self) -> None:
        agent = _agent()
        session = {"session_key": "k1", "agent": agent}
        with patch.dict(server._sessions, {"s1": session}, clear=False), \
                patch.object(server, "_write_config_key") as write_key, \
                patch.object(server, "_persist_live_session_runtime"), \
                patch.object(server, "_emit"), \
                patch(
                    "hermes_cli.models.resolve_fast_mode_overrides",
                    return_value=FAST_OVERRIDES,
                ):
            resp = _set({"key": "fast", "session_id": "s1", "value": "fast"})
        assert resp["result"]["value"] == "fast"
        assert agent.service_tier == "priority"
        assert session["create_service_tier_override"] == "priority"
        write_key.assert_not_called()

    def test_lazy_session_pins_create_override(self) -> None:
        """A pre-build (agent=None) session must keep the change for the
        deferred agent build instead of dropping it."""
        session = {
            "session_key": "k3",
            "agent": None,
            "model_override": {"model": "gpt-6", "provider": "openai"},
        }
        with patch.dict(server._sessions, {"s3": session}, clear=False), \
                patch.object(server, "_write_config_key") as write_key, \
                patch(
                    "hermes_cli.models.resolve_fast_mode_overrides",
                    return_value=FAST_OVERRIDES,
                ):
            resp = _set({"key": "fast", "session_id": "s3", "value": "fast"})
        assert resp["result"]["value"] == "fast"
        assert session["create_service_tier_override"] == "priority"
        write_key.assert_not_called()

    def test_lazy_resume_syncs_service_tier_override(self) -> None:
        """A deferred resume splats resume_runtime_overrides after the ordinary
        create pins, so a live /fast change must update that authoritative map."""
        session = {
            "session_key": "k3-resume",
            "agent": None,
            "model_override": {"model": "gpt-6", "provider": "openai"},
            "resume_runtime_overrides": {"service_tier_override": ""},
        }
        with patch.dict(server._sessions, {"s3-resume": session}, clear=False), \
                patch.object(server, "_write_config_key") as write_key, \
                patch(
                    "hermes_cli.models.resolve_fast_mode_overrides",
                    return_value=FAST_OVERRIDES,
                ):
            resp = _set(
                {"key": "fast", "session_id": "s3-resume", "value": "fast"}
            )
        assert resp["result"]["value"] == "fast"
        assert session["create_service_tier_override"] == "priority"
        assert session["resume_runtime_overrides"]["service_tier_override"] == "priority"
        write_key.assert_not_called()

    def test_lazy_session_validates_fast_against_session_model(self) -> None:
        """Fast support is checked against the session's picked model, not the
        global default the session will never use."""
        session = {
            "session_key": "k4",
            "agent": None,
            "model_override": {"model": "session-model", "provider": "openai"},
        }
        with patch.dict(server._sessions, {"s4": session}, clear=False), \
                patch.object(server, "_write_config_key"), \
                patch(
                    "hermes_cli.models.resolve_fast_mode_overrides",
                    return_value=FAST_OVERRIDES,
                ) as resolve:
            _set({"key": "fast", "session_id": "s4", "value": "fast"})
        resolve.assert_called_once_with(
            "session-model", provider=None, base_url=None, tier=None
        )

    def test_auto_and_cold_are_session_scoped_tier_pins(self) -> None:
        session = {
            "session_key": "k4-window",
            "agent": _agent(service_tier=None),
        }
        with patch.dict(server._sessions, {"s4-window": session}, clear=False), \
                patch.object(server, "_write_config_key") as write_key:
            auto = _set(
                {"key": "fast", "session_id": "s4-window", "value": "auto"}
            )
            assert auto["result"]["value"] == "auto"
            assert session["create_service_tier_override"] == "auto"
            assert session["agent"].service_tier == "auto"

            status = _set(
                {"key": "fast", "session_id": "s4-window", "value": "status"}
            )
            assert status["result"]["value"] == "auto"

            cold = _set(
                {"key": "fast", "session_id": "s4-window", "value": "cold"}
            )
            assert cold["result"]["value"] == "cold"
            assert session["agent"].service_tier == "cold"

    def test_toggle_flips_prebuild_pin(self) -> None:
        """An empty value toggles from the session's pin, not the global."""
        session = {
            "session_key": "k5",
            "agent": None,
            "create_service_tier_override": "priority",
        }
        with patch.dict(server._sessions, {"s5": session}, clear=False), \
                patch.object(server, "_write_config_key") as write_key:
            resp = _set({"key": "fast", "session_id": "s5", "value": ""})
        assert resp["result"]["value"] == "normal"
        assert session["create_service_tier_override"] == ""
        write_key.assert_not_called()

    def test_no_session_persists_globally(self) -> None:
        with patch.object(server, "_write_config_key") as write_key:
            resp = _set({"key": "fast", "value": "normal"})
        assert resp["result"]["value"] == "normal"
        write_key.assert_called_once_with("agent.service_tier", "normal")

    def test_deferred_publication_race_applies_pin_to_new_agent(self) -> None:
        """A config request that observed agent=None must re-read after taking
        the runtime lock, because the deferred build can publish meanwhile."""
        backing_lock = threading.Lock()
        attempted = threading.Event()

        class SignalingLock:
            def __enter__(self):
                attempted.set()
                backing_lock.acquire()

            def __exit__(self, *_exc):
                backing_lock.release()

        built_agent = _agent(service_tier="priority")
        built_agent.request_overrides = {
            "service_tier": "priority",
            "speed": "fast",
            "unrelated": "kept",
        }
        session = {
            "session_key": "k-race",
            "agent": None,
            "runtime_override_lock": SignalingLock(),
        }
        result = {}

        # _emit_session_info builds a full session.info (MCP status, live tool
        # discovery) before _emit; that real work is not under test and blew
        # the join bound on a loaded gate box, so stub it with the emitter.
        # The waits are deadlock guards only: a real lock re-entry never
        # finishes, so generous bounds cost nothing on the passing path.
        with patch.dict(server._sessions, {"s-race": session}, clear=False), \
                patch.object(server, "_persist_live_session_runtime"), \
                patch.object(server, "_emit_session_info"), \
                patch.object(server, "_emit"):
            backing_lock.acquire()
            thread = threading.Thread(
                target=lambda: result.setdefault(
                    "response",
                    _set(
                        {
                            "key": "fast",
                            "session_id": "s-race",
                            "value": "normal",
                        }
                    ),
                ),
                daemon=True,
            )
            thread.start()
            try:
                assert attempted.wait(timeout=10)
                # Simulate deferred publication after config.set's initial
                # agent snapshot but before it acquires the runtime lock.
                session["agent"] = built_agent
            finally:
                backing_lock.release()
            thread.join(timeout=10)

        assert not thread.is_alive()
        assert result["response"]["result"]["value"] == "normal"
        assert built_agent.service_tier is None
        assert built_agent.request_overrides == {"unrelated": "kept"}

    def test_stale_session_id_is_refused_not_persisted_globally(self) -> None:
        """A runtime id the backend no longer holds (reaped / re-minted) is not "no session": it
        must 4001 so the client resumes, not rewrite the profile's tier for every surface."""
        with patch.dict(server._sessions, {}, clear=True), \
                patch.object(server, "_write_config_key") as write_key:
            resp = _set({"key": "fast", "session_id": "reaped-sid", "value": "normal"})
        assert resp.get("error", {}).get("code") == 4001, resp
        write_key.assert_not_called()


class TestConfigGetFastSessionScope:
    def test_reads_prebuild_pin(self) -> None:
        session = {
            "session_key": "k6",
            "agent": None,
            "create_service_tier_override": "priority",
        }
        with patch.dict(server._sessions, {"s6": session}, clear=False):
            resp = _get({"key": "fast", "session_id": "s6"})
        assert resp["result"]["value"] == "fast"

    def test_explicit_normal_pin_beats_live_agent_and_global_fast(self) -> None:
        session = {
            "session_key": "k-explicit-normal",
            "agent": _agent(service_tier=None),
            "create_service_tier_override": "",
        }
        with patch.dict(server._sessions, {"s-normal": session}, clear=False), \
                patch.object(server, "_load_service_tier", return_value="priority"):
            resp = _get({"key": "fast", "session_id": "s-normal"})
        assert resp["result"]["value"] == "normal"


def test_install_deferred_agent_reconciles_latest_fast_request_overrides() -> None:
    session = {
        "agent": None,
        "create_service_tier_override": "priority",
    }
    built_agent = _agent(service_tier=None)
    built_agent.request_overrides = {"speed": "standard", "unrelated": "kept"}

    with patch(
        "hermes_cli.models.resolve_fast_mode_overrides",
        return_value={"service_tier": "priority", "speed": "fast"},
    ):
        changed = server._install_deferred_agent_runtime(session, built_agent)

    assert changed is True
    assert session["agent"] is built_agent
    assert built_agent.service_tier == "priority"
    assert built_agent.request_overrides == {
        "service_tier": "priority",
        "speed": "fast",
        "unrelated": "kept",
    }


class TestSessionInfoFastFollowsTheRoute:
    """``session.info`` reports Fast only where the priority tier reaches the wire. A profile-wide
    ``service_tier: fast`` on a local model sends nothing, so the Fast switch and label stay hidden."""

    @staticmethod
    def _info(**agent_fields) -> dict:
        agent = SimpleNamespace(**{
            "reasoning_config": None, "service_tier": "priority", "request_overrides": {},
            "session_id": "sess-key", "api_mode": "chat_completions", **agent_fields,
        })
        return server._session_info(agent, {"session_key": "k7", "agent": agent})

    def test_first_party_route_reports_fast(self) -> None:
        info = self._info(model="gpt-5.4", provider="openai", base_url="https://api.openai.com/v1")
        assert (info["service_tier"], info["fast"]) == ("priority", True)

    def test_anthropic_route_reads_the_anthropic_base_url(self) -> None:
        info = self._info(model="claude-opus-5", provider="anthropic", api_mode="anthropic_messages",
                          base_url="", _anthropic_base_url="https://api.anthropic.com")
        assert info["fast"] is True

    def test_local_model_keeps_the_tier_but_reports_no_fast(self) -> None:
        info = self._info(model="Qwen3.8-27B-UD-Q4_K_M", provider="llamacpp", base_url="http://127.0.0.1:18434/v1")
        assert (info["service_tier"], info["fast"]) == ("priority", False)

    def test_fast_capable_model_behind_a_proxy_reports_no_fast(self) -> None:
        info = self._info(model="gpt-5.4", provider="openrouter", base_url="https://openrouter.ai/api/v1")
        assert info["fast"] is False

    def test_pending_switch_is_judged_by_the_new_route(self) -> None:
        """Mid-turn the agent still holds the old base URL; the pending pick decides."""
        agent = SimpleNamespace(
            reasoning_config=None, service_tier="priority", request_overrides={}, session_id="sess-key",
            api_mode="chat_completions", model="gpt-5.4", provider="openai", base_url="https://api.openai.com/v1")
        session = {"session_key": "k8", "agent": agent, "pending_model_switch": {
            "display_model": "Qwen3.8-27B-UD-Q4_K_M", "display_provider": "llamacpp"}}
        assert server._session_info(agent, session)["fast"] is False
        session["pending_model_switch"] = {"display_model": "claude-opus-5", "display_provider": "anthropic"}
        assert server._session_info(agent, session)["fast"] is True
