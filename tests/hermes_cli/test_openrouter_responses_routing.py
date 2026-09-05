"""Explicit OpenRouter transport survives credential resolution, without changing defaults."""

from types import SimpleNamespace

import pytest

from hermes_cli import runtime_provider as rp


@pytest.mark.parametrize("credential_source", ["pool", "explicit", "environment"])
@pytest.mark.parametrize(
    "configured_provider, configured_mode, expected_mode",
    [
        ("openrouter", "codex_responses", "codex_responses"),
        ("openrouter", "responses", "codex_responses"),
        ("openrouter", None, "chat_completions"),
        ("openai-codex", "codex_responses", "chat_completions"),
    ],
)
def test_openrouter_explicit_transport_across_credentials(
    monkeypatch, credential_source, configured_provider, configured_mode, expected_mode
):
    model_config = {
        "provider": configured_provider,
        "default": "openai/gpt-6-astra",
        "api_mode": configured_mode,
    }
    monkeypatch.setattr(rp, "_get_model_config", lambda: model_config)
    monkeypatch.setattr(rp, "load_config", lambda: {"model": model_config})
    monkeypatch.setattr(rp, "_getenv", lambda name, default="": "environment-key" if name == "OPENROUTER_API_KEY" else default)
    entry = SimpleNamespace(
        access_token="pool-key", source="manual", base_url=rp.OPENROUTER_BASE_URL
    )
    pool = SimpleNamespace(
        has_credentials=lambda: credential_source == "pool", select=lambda: entry
    )
    monkeypatch.setattr(rp, "load_pool", lambda provider: pool)

    runtime = rp.resolve_runtime_provider(
        requested="openrouter",
        explicit_api_key="explicit-key" if credential_source == "explicit" else None,
        target_model="openai/gpt-6-astra",
    )

    assert runtime["provider"] == "openrouter"
    assert runtime["base_url"] == rp.OPENROUTER_BASE_URL
    assert runtime["api_mode"] == expected_mode
    assert runtime["api_key"] == {
        "pool": "pool-key", "explicit": "explicit-key", "environment": "environment-key"
    }[credential_source]


def test_custom_probe_does_not_report_ignoring_openrouter_configuration(caplog):
    with caplog.at_level("INFO", logger="hermes_cli.runtime_provider"):
        mode = rp._resolve_plain_custom_api_mode(
            {"provider": "openrouter", "api_mode": "codex_responses"},
            rp.OPENROUTER_BASE_URL,
        )

    assert mode == "chat_completions"
    assert "Ignoring persisted custom" not in caplog.text


def test_bare_custom_still_rejects_responses_for_unknown_endpoint():
    assert rp._resolve_plain_custom_api_mode(
        {"provider": "custom", "api_mode": "codex_responses"},
        "https://custom.example/v1",
    ) == "chat_completions"
