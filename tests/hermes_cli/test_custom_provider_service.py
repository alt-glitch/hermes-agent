from __future__ import annotations

import pytest
import yaml

from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from hermes_cli import config as config_module
from hermes_cli import custom_provider_service as service


def _home(tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    token = set_hermes_home_override(home)
    config_module._RAW_CONFIG_CACHE.clear()
    return home, token


def _reset(token):
    config_module._RAW_CONFIG_CACHE.clear()
    reset_hermes_home_override(token)


def test_save_keyless_local_provider_uses_canonical_schema(tmp_path):
    home, token = _home(tmp_path)
    try:
        result = service.save_custom_provider(
            display_name="Local Ollama",
            base_url="http://localhost:11434/v1/",
            model="qwen3.5:27b",
            context_length=64_000,
        )
        saved = yaml.safe_load((home / "config.yaml").read_text())
        row = saved["providers"]["local-ollama"]
        assert row["api"] == "http://localhost:11434/v1"
        assert row["transport"] == "chat_completions"
        assert row["models"]["qwen3.5:27b"]["context_length"] == 64_000
        assert "key_env" not in row
        assert result["provider_identity"] == "custom:local-ollama"
        assert result["switch_value"] == "qwen3.5:27b --provider local-ollama"
    finally:
        _reset(token)


def test_secret_is_only_written_to_env_and_endpoint_update_deduplicates(tmp_path):
    home, token = _home(tmp_path)
    try:
        first = service.save_custom_provider(
            display_name="Lab Server",
            base_url="https://lab.invalid/v1",
            model="model-a",
            api_key="super-secret",
        )
        second = service.save_custom_provider(
            display_name="Renamed Lab",
            base_url="https://lab.invalid/v1/",
            model="model-b",
        )
        text = (home / "config.yaml").read_text()
        saved = yaml.safe_load(text)
        assert list(saved["providers"]) == ["lab-server"]
        assert first["provider_key"] == second["provider_key"] == "lab-server"
        assert "super-secret" not in text
        assert "super-secret" in (home / ".env").read_text()
        assert saved["providers"]["lab-server"]["key_env"] == "HERMES_LAB_SERVER_API_KEY"
    finally:
        _reset(token)


def test_probe_reports_manual_fallback_without_failing(monkeypatch):
    monkeypatch.setattr(
        service,
        "probe_api_models",
        lambda *args, **kwargs: {
            "models": None,
            "probed_url": "http://localhost:8000/models",
            "resolved_base_url": "http://localhost:8000",
            "suggested_base_url": "http://localhost:8000/v1",
            "used_fallback": False,
        },
    )
    result = service.probe_custom_provider("http://localhost:8000")
    assert result["reachable"] is False
    assert result["models"] == []
    assert result["suggested_base_url"] == "http://localhost:8000/v1"


def test_rejects_non_http_endpoint():
    try:
        service.save_custom_provider(display_name="bad", base_url="file:///tmp/socket", model="m")
    except ValueError as exc:
        assert "http(s)" in str(exc)
    else:
        raise AssertionError("expected invalid URL to be rejected")


@pytest.mark.parametrize(
    "url",
    [
        "https://user:secret@localhost:8000/v1",
        "https://localhost:8000/v1?api_key=secret",
        "https://localhost:8000/v1#secret",
    ],
)
def test_rejects_credentials_or_auth_material_in_endpoint(url):
    with pytest.raises(ValueError, match="credentials|query string"):
        service.save_custom_provider(display_name="bad", base_url=url, model="m")


def test_config_failure_does_not_write_secret(monkeypatch):
    wrote_secret = False

    def fail_config(_config):
        raise OSError("disk full")

    def write_secret(*_args):
        nonlocal wrote_secret
        wrote_secret = True

    monkeypatch.setattr(service, "read_raw_config", lambda: {})
    monkeypatch.setattr(service, "save_config", fail_config)
    monkeypatch.setattr(service, "save_env_value", write_secret)

    with pytest.raises(OSError, match="disk full"):
        service.save_custom_provider(
            display_name="Local",
            base_url="http://localhost:8000/v1",
            model="m",
            api_key="secret",
        )
    assert wrote_secret is False


def test_env_failure_rolls_back_provider_config(monkeypatch):
    config = {"providers": {"existing": {"api": "http://old/v1", "default_model": "old"}}}
    writes = []
    monkeypatch.setattr(service, "read_raw_config", lambda: config)
    monkeypatch.setattr(service, "save_config", lambda value: writes.append(yaml.safe_load(yaml.safe_dump(value))))
    monkeypatch.setattr(service, "save_env_value", lambda *_args: (_ for _ in ()).throw(OSError("env read-only")))

    with pytest.raises(OSError, match="env read-only"):
        service.save_custom_provider(
            display_name="Local",
            base_url="http://localhost:8000/v1",
            model="m",
            api_key="secret",
        )

    assert len(writes) == 2
    assert "local" in writes[0]["providers"]
    assert writes[1] == {"providers": {"existing": {"api": "http://old/v1", "default_model": "old"}}}


def test_managed_secret_key_is_rejected_before_config_write(monkeypatch):
    wrote_config = False

    def write_config(_value):
        nonlocal wrote_config
        wrote_config = True

    monkeypatch.setattr(service, "read_raw_config", lambda: {})
    monkeypatch.setattr(service, "save_config", write_config)
    monkeypatch.setattr("hermes_cli.managed_scope.is_env_managed", lambda key: True)

    with pytest.raises(PermissionError, match="managed by your administrator"):
        service.save_custom_provider(
            display_name="Local",
            base_url="http://localhost:8000/v1",
            model="m",
            api_key="secret",
        )
    assert wrote_config is False


def test_custom_provider_slug_does_not_shadow_builtin(tmp_path, monkeypatch):
    home, token = _home(tmp_path)
    monkeypatch.setattr("hermes_cli.auth.PROVIDER_REGISTRY", {"anthropic": object()})
    try:
        result = service.save_custom_provider(
            display_name="Anthropic",
            base_url="http://localhost:8000/v1",
            model="local-claude",
        )
        saved = yaml.safe_load((home / "config.yaml").read_text())
        assert result["provider_key"] == "anthropic-2"
        assert "anthropic" not in saved["providers"]
    finally:
        _reset(token)
