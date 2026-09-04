"""Concurrency-safe installation of lazily constructed TUI agent runtimes."""

from __future__ import annotations

import threading


def apply_service_tier_override(agent, pinned_tier: str) -> None:
    """Apply a session tier pin and rebuild provider request overrides."""
    tier = pinned_tier or None
    agent.service_tier = tier
    request_overrides = dict(getattr(agent, "request_overrides", {}) or {})
    request_overrides.pop("service_tier", None)
    request_overrides.pop("speed", None)
    if tier == "priority":
        from hermes_cli.models import resolve_fast_mode_overrides

        resolved = resolve_fast_mode_overrides(
            getattr(agent, "model", None),
            provider=getattr(agent, "provider", None),
            base_url=getattr(agent, "base_url", None),
        )
        if isinstance(resolved, dict):
            request_overrides.update(resolved)
    agent.request_overrides = request_overrides


def install_deferred_agent_runtime(session: dict, agent) -> bool:
    """Publish a built runtime without losing overrides changed mid-build."""
    runtime_lock = session.setdefault("runtime_override_lock", threading.Lock())
    with runtime_lock:
        runtime_changed = False
        latest_reasoning = session.get("create_reasoning_override")
        if latest_reasoning is not None:
            agent.reasoning_config = latest_reasoning
            runtime_changed = True
        latest_tier = session.get("create_service_tier_override")
        if latest_tier is not None:
            apply_service_tier_override(agent, latest_tier)
            runtime_changed = True
        session["agent"] = agent
    return runtime_changed
