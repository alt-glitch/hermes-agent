"""Per-model provider routing is bound when an agent's runtime identity changes."""

import os
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock


_OPENROUTER_URL = "https://openrouter.ai/api/v1"


def _write_routing_config(entries: str) -> None:
    home = Path(os.environ["HERMES_HOME"])
    (home / "config.yaml").write_text(
        "provider_routing:\n"
        "  models:\n"
        f"{entries}",
        encoding="utf-8",
    )


def _patch_agent_dependencies(monkeypatch) -> None:
    import run_agent

    ready = threading.Event()
    ready.set()
    monkeypatch.setattr(run_agent, "_openrouter_prewarm_done", ready)
    monkeypatch.setattr("model_tools.get_tool_definitions", lambda **_kwargs: [])
    monkeypatch.setattr("model_tools.check_toolset_requirements", lambda: {})
    monkeypatch.setattr("agent.process_bootstrap.OpenAI", lambda **_kwargs: MagicMock())
    monkeypatch.setattr("agent.context_compressor.get_model_context_length", lambda *_args, **_kwargs: 128_000)
    monkeypatch.setattr("agent.model_metadata.get_model_context_length", lambda *_args, **_kwargs: 128_000)


def _wire_routing(agent) -> dict:
    # Request timeouts have their own live-config policy. Isolate provider routing so any
    # config read here is a regression in request assembly, not the timeout resolver.
    agent._resolved_api_call_timeout = lambda: 1_800.0
    kwargs = agent._build_api_kwargs([{"role": "user", "content": "hello"}], tools_for_api=[])
    return kwargs["extra_body"]["provider"]


def test_runtime_boundaries_refresh_routing_without_request_time_reads(monkeypatch):
    _write_routing_config(
        "    vendor/start-model:\n"
        "      only: [start-route]\n"
        "    vendor/switch.model:\n"
        "      only: [switch-route]\n"
        "      sort: latency\n"
        "    vendor/fallback-model:\n"
        "      only: [fallback-route]\n"
    )
    _patch_agent_dependencies(monkeypatch)

    import hermes_cli.config as config_mod
    from run_agent import AIAgent

    original_load = config_mod.load_config_readonly
    reads = 0

    def counted_load():
        nonlocal reads
        reads += 1
        return original_load()

    monkeypatch.setattr(config_mod, "load_config_readonly", counted_load)
    agent = AIAgent(
        api_key="test-key",
        base_url=_OPENROUTER_URL,
        provider="openrouter",
        api_mode="chat_completions",
        model="vendor/start-model",
        providers_allowed=["flat-route"],
        provider_sort="price",
        fallback_model={"provider": "openrouter", "model": "vendor/fallback-model"},
        enabled_toolsets=[],
        quiet_mode=True,
        skip_context_files=True,
        skip_memory=True,
        save_trajectories=False,
    )
    try:
        init_reads = reads
        assert _wire_routing(agent) == {"only": ["start-route"], "sort": "price"}
        assert reads == init_reads

        agent.switch_model(
            "vendor/switch-model",
            "openrouter",
            api_key="test-key",
            base_url=_OPENROUTER_URL,
            api_mode="chat_completions",
        )
        switch_reads = reads
        assert switch_reads > init_reads
        assert _wire_routing(agent) == {"only": ["switch-route"], "sort": "latency"}
        assert reads == switch_reads

        fallback_client = SimpleNamespace(
            api_key="fallback-key",
            base_url=_OPENROUTER_URL,
            _custom_headers={},
        )
        monkeypatch.setattr(
            "agent.auxiliary_client.resolve_provider_client",
            lambda *_args, **_kwargs: (fallback_client, "vendor/fallback-model"),
        )
        assert agent._try_activate_fallback() is True
        fallback_reads = reads
        assert fallback_reads > switch_reads
        assert _wire_routing(agent) == {"only": ["fallback-route"], "sort": "price"}
        assert reads == fallback_reads

        assert agent._restore_primary_runtime() is True
        restore_reads = reads
        assert _wire_routing(agent) == {"only": ["switch-route"], "sort": "latency"}
        assert reads == restore_reads
    finally:
        agent.close()


def test_delegated_child_binds_its_tolerantly_matched_model_overlay(monkeypatch):
    _write_routing_config(
        "    anthropic/claude-fable-5.1:\n"
        "      only: [child-route]\n"
        "      sort: throughput\n"
    )
    _patch_agent_dependencies(monkeypatch)

    import hermes_cli.config as config_mod
    from run_agent import AIAgent
    from tools import delegate_tool

    original_load = config_mod.load_config_readonly
    reads = 0

    def counted_load():
        nonlocal reads
        reads += 1
        return original_load()

    monkeypatch.setattr(config_mod, "load_config_readonly", counted_load)
    parent = AIAgent(
        api_key="test-key",
        base_url=_OPENROUTER_URL,
        provider="openrouter",
        api_mode="chat_completions",
        model="vendor/parent-model",
        providers_allowed=["parent-route"],
        provider_sort="price",
        enabled_toolsets=["file"],
        quiet_mode=True,
        skip_context_files=True,
        skip_memory=True,
        save_trajectories=False,
    )
    child = delegate_tool._build_child_agent(
        task_index=0,
        goal="Inspect routing",
        context=None,
        toolsets=["file"],
        model="openrouter/anthropic/claude-fable-5-1",
        max_iterations=2,
        task_count=1,
        parent_agent=parent,
    )
    try:
        boundary_reads = reads
        assert _wire_routing(parent) == {"only": ["parent-route"], "sort": "price"}
        assert _wire_routing(child) == {"only": ["child-route"], "sort": "throughput"}
        assert reads == boundary_reads
    finally:
        child.close()
        parent.close()
