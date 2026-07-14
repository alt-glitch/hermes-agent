"""Non-interactive custom/local inference-provider setup.

This is the shared service boundary for terminal and desktop UIs.  It writes
the canonical ``providers:`` schema, keeps credentials in ``.env``, and reuses
Hermes' existing OpenAI/Anthropic ``/models`` probe.
"""

from __future__ import annotations

import copy
import re
from typing import Any
from urllib.parse import urlparse

from hermes_cli.config import is_managed, read_raw_config, save_config, save_env_value
from hermes_cli.models import probe_api_models


_API_MODES = frozenset({"chat_completions", "anthropic_messages", "codex_responses"})


def _normalized_url(value: str) -> str:
    url = str(value or "").strip().rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("base_url must be an http(s) URL")
    # The URL is persisted in config.yaml and returned to UI inventory. Auth
    # belongs only in the separately persisted API key, never in userinfo or a
    # query/fragment that would leak through config, logs, and picker rows.
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("base_url must not contain embedded credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("base_url must not contain a query string or fragment")
    return url


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug or "local-model"


def _env_key(slug: str) -> str:
    return f"HERMES_{slug.replace('-', '_').upper()}_API_KEY"


def probe_custom_provider(
    base_url: str,
    *,
    api_key: str = "",
    api_mode: str = "chat_completions",
    timeout: float = 5.0,
) -> dict[str, Any]:
    """Probe a local/custom endpoint without persisting anything."""
    normalized = _normalized_url(base_url)
    mode = str(api_mode or "chat_completions").strip()
    if mode not in _API_MODES:
        raise ValueError(f"unsupported API mode: {mode}")
    result = probe_api_models(api_key.strip() or None, normalized, timeout=timeout, api_mode=mode)
    return {
        "models": [model for model in (result.get("models") or []) if isinstance(model, str) and model.strip()],
        "probed_url": result.get("probed_url"),
        "resolved_base_url": result.get("resolved_base_url") or normalized,
        "suggested_base_url": result.get("suggested_base_url"),
        "used_fallback": bool(result.get("used_fallback")),
        "reachable": result.get("models") is not None,
    }


def save_custom_provider(
    *,
    display_name: str,
    base_url: str,
    model: str,
    api_key: str = "",
    api_mode: str = "chat_completions",
    context_length: int | None = None,
    discover_models: bool = True,
) -> dict[str, Any]:
    """Save or update a canonical custom provider and return its switch arg."""
    if is_managed():
        raise PermissionError("managed install — provider configuration is read-only")

    normalized = _normalized_url(base_url)
    model = str(model or "").strip()
    if not model:
        raise ValueError("model is required")
    mode = str(api_mode or "chat_completions").strip()
    if mode not in _API_MODES:
        raise ValueError(f"unsupported API mode: {mode}")

    config = read_raw_config()
    previous_config = copy.deepcopy(config)
    providers = config.get("providers")
    if not isinstance(providers, dict):
        providers = {}
        config["providers"] = providers

    # Updating the same endpoint must retain its stable identity, including
    # when its human display name changes.
    provider_key = ""
    for key, value in providers.items():
        if not isinstance(value, dict):
            continue
        candidate = value.get("api") or value.get("base_url")
        if str(candidate or "").strip().rstrip("/").lower() == normalized.lower():
            provider_key = str(key)
            break

    name = str(display_name or "").strip() or f"Local {urlparse(normalized).hostname or 'model'}"
    created = not provider_key
    if not provider_key:
        try:
            from hermes_cli.auth import PROVIDER_REGISTRY

            reserved = {str(key).strip().lower() for key in PROVIDER_REGISTRY}
        except Exception:
            reserved = set()
        reserved.update({"auto", "custom"})
        base = _slug(name)
        provider_key = base
        suffix = 2
        while provider_key in providers or provider_key in reserved:
            provider_key = f"{base}-{suffix}"
            suffix += 1

    previous = providers.get(provider_key)
    entry = dict(previous) if isinstance(previous, dict) else {}
    entry.update(
        {
            "name": name,
            "api": normalized,
            "transport": mode,
            "default_model": model,
            "discover_models": bool(discover_models),
        }
    )
    models = entry.get("models")
    if not isinstance(models, dict):
        models = {}
    model_config = models.get(model)
    if not isinstance(model_config, dict):
        model_config = {}
    if context_length is not None:
        parsed_context = int(context_length)
        if parsed_context <= 0:
            raise ValueError("context_length must be positive")
        model_config["context_length"] = parsed_context
    models[model] = model_config
    entry["models"] = models

    secret = str(api_key or "").strip()
    if secret:
        key_env = str(entry.get("key_env") or _env_key(provider_key))
        from hermes_cli import managed_scope

        if managed_scope.is_env_managed(key_env):
            raise PermissionError(f"{key_env} is managed by your administrator")
        entry["key_env"] = key_env
    else:
        # Keyless localhost-compatible servers are first-class. Preserve an
        # existing key_env on update, but never manufacture one for keyless.
        key_env = entry.get("key_env")

    providers[provider_key] = entry
    # Commit non-secret config first. If the atomic env write then fails, roll
    # the config back so callers never observe a successful half-transaction.
    # Config failures cannot mutate the credential because save_env_value has
    # not run yet.
    save_config(config)
    if secret:
        try:
            save_env_value(key_env, secret)
        except BaseException:
            save_config(previous_config)
            raise
    return {
        "provider_key": provider_key,
        "provider_identity": f"custom:{provider_key}",
        "model": model,
        "base_url": normalized,
        "switch_value": f"{model} --provider {provider_key}",
        "created": created,
        "key_env": key_env or None,
    }
