"""Model history enriches the shared inventory without dropping upstream fields."""

from types import SimpleNamespace

from tui_gateway import server


def _options(monkeypatch, payload, recent=(), frequent=()):
    monkeypatch.setattr(server, "_model_picker_context", lambda _agent: object())
    monkeypatch.setattr(server, "_get_db", lambda: SimpleNamespace(
        list_recent_models=lambda **kwargs: list(recent),
        list_frequent_models=lambda **kwargs: list(frequent),
    ))
    monkeypatch.setattr(
        "hermes_cli.inventory.build_model_options_payload", lambda *args, **kwargs: dict(payload))
    response = server._methods["model.options"]("options", {})
    assert "error" not in response
    return response["result"]


def test_history_resolves_renamed_local_endpoint_and_filters_unavailable_models(monkeypatch):
    provider = {
        "slug": "local-new", "name": "Local Lab", "models": ["local-a"],
        "api_url": "http://localhost:8000/v1", "pricing": {"input": 0},
    }
    usage = {
        "provider_id": "custom:local-old", "model": "local-a",
        "base_url": "http://localhost:8000/v1/", "activation_count": 3,
    }
    payload = {"providers": [provider], "capabilities": {"vision": True}}
    result = _options(monkeypatch, payload, [usage, {**usage, "model": "removed"}], [usage])
    assert result["recent_models"] == [
        {**usage, "provider": "local-new", "provider_name": "Local Lab"}]
    assert result["frequent_models"] == result["recent_models"]
    assert result["providers"] == payload["providers"]
    assert result["capabilities"] == payload["capabilities"]


def test_current_model_is_seeded_once_without_inventing_frequency(monkeypatch):
    provider = {"slug": "local", "name": "Local", "models": ["model"], "is_current": True}
    payload = {"model": "model", "providers": [provider]}
    result = _options(monkeypatch, payload)
    assert len(result["recent_models"]) == 1
    assert result["recent_models"][0]["activation_count"] == 0
    assert result["frequent_models"] == []
    existing = {"model": "model", "provider_id": "local", "activation_count": 7}
    result = _options(monkeypatch, payload, [existing])
    assert len(result["recent_models"]) == 1
    assert result["recent_models"][0]["activation_count"] == 7
