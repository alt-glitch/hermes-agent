import asyncio
import os
import json
from datetime import datetime, timedelta, timezone
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import sys
from unittest.mock import patch

import pytest

MODULE_PATH = Path(__file__).resolve().parents[2] / "tools" / "managed_tool_gateway.py"
MODULE_SPEC = spec_from_file_location("managed_tool_gateway_test_module", MODULE_PATH)
assert MODULE_SPEC and MODULE_SPEC.loader
managed_tool_gateway = module_from_spec(MODULE_SPEC)
sys.modules[MODULE_SPEC.name] = managed_tool_gateway
MODULE_SPEC.loader.exec_module(managed_tool_gateway)
is_managed_tool_gateway_ready = managed_tool_gateway.is_managed_tool_gateway_ready
resolve_managed_tool_gateway = managed_tool_gateway.resolve_managed_tool_gateway

# Every gateway knob, so a test can state the whole environment it wants.
_GATEWAY_ENV_KEYS = (
    "TOOL_GATEWAY_URL",
    "CONNECTOR_GATEWAY_URL",
    "TOOL_GATEWAY_DOMAIN",
    "TOOL_GATEWAY_SCHEME",
    "HERMES_TRUSTED_GATEWAY_ORIGINS",
    "FIRECRAWL_GATEWAY_URL",
    "BROWSER_USE_GATEWAY_URL",
    "BFL_GATEWAY_URL",
    "MODAL_GATEWAY_URL",
)


def gateway_env(**overrides):
    """patch.dict context with ONLY the given gateway env keys set.

    The trust gate keys on whether the environment shaped the origin, so a
    leaked TOOL_GATEWAY_DOMAIN from the ambient shell would change the verdict.
    Every trust test states its whole environment through this helper.
    """
    env = {k: v for k, v in os.environ.items() if k not in _GATEWAY_ENV_KEYS}
    env.update(overrides)
    return patch.dict(os.environ, env, clear=True)


@pytest.fixture(autouse=True)
def _forget_untrusted_origin_warnings():
    """The warn-once set is module state; tests must not inherit each other's."""
    managed_tool_gateway._warned_untrusted_origins.clear()
    yield
    managed_tool_gateway._warned_untrusted_origins.clear()


def test_resolve_managed_tool_gateway_derives_vendor_origin_from_the_default_domain():
    with gateway_env(), patch.object(
        managed_tool_gateway, "managed_nous_tools_enabled", return_value=True
    ):
        result = resolve_managed_tool_gateway(
            "firecrawl",
            token_reader=lambda: "nous-token",
        )

    assert result is not None
    assert result.gateway_origin == "https://firecrawl-gateway.nousresearch.com"
    assert result.nous_user_token == "nous-token"
    assert result.managed_mode is True


def test_a_domain_reshape_is_env_derived_and_needs_the_trust_list():
    # Deliberate: TOOL_GATEWAY_DOMAIN is an env knob like TOOL_GATEWAY_URL, so
    # a host it shapes does not inherit the bearer just because it happens to
    # spell out today's default domain.
    with patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True):
        with gateway_env(TOOL_GATEWAY_DOMAIN="nousresearch.com"):
            assert resolve_managed_tool_gateway(
                "firecrawl", token_reader=lambda: "nous-token"
            ) is None

        with gateway_env(
            TOOL_GATEWAY_DOMAIN="nousresearch.com",
            HERMES_TRUSTED_GATEWAY_ORIGINS="https://firecrawl-gateway.nousresearch.com",
        ):
            granted = resolve_managed_tool_gateway(
                "firecrawl", token_reader=lambda: "nous-token"
            )
        assert granted is not None
        assert granted.gateway_origin == "https://firecrawl-gateway.nousresearch.com"


def test_resolve_managed_tool_gateway_uses_vendor_specific_override():
    with gateway_env(
        BROWSER_USE_GATEWAY_URL="http://browser-use-gateway.localhost:3009/"
    ), patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True):
        result = resolve_managed_tool_gateway(
            "browser-use",
            token_reader=lambda: "nous-token",
        )

    assert result is not None
    assert result.gateway_origin == "http://browser-use-gateway.localhost:3009"


def test_resolve_managed_tool_gateway_is_inactive_without_nous_token():
    with gateway_env(), patch.object(
        managed_tool_gateway, "managed_nous_tools_enabled", return_value=True
    ):
        result = resolve_managed_tool_gateway(
            "firecrawl",
            token_reader=lambda: None,
        )

    assert result is None


def test_resolve_managed_tool_gateway_is_disabled_without_subscription():
    with gateway_env(), patch.object(
        managed_tool_gateway, "managed_nous_tools_enabled", return_value=False
    ):
        result = resolve_managed_tool_gateway(
            "firecrawl",
            token_reader=lambda: "nous-token",
        )

    assert result is None


def test_read_nous_access_token_refreshes_expiring_cached_token(tmp_path, monkeypatch):
    monkeypatch.delenv("TOOL_GATEWAY_USER_TOKEN", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat()
    (tmp_path / "auth.json").write_text(json.dumps({
        "providers": {
            "nous": {
                "access_token": "stale-token",
                "refresh_token": "refresh-token",
                "expires_at": expires_at,
            }
        }
    }))
    monkeypatch.setattr(
        "hermes_cli.auth.resolve_nous_access_token",
        lambda refresh_skew_seconds=120: "fresh-token",
    )

    assert managed_tool_gateway.read_nous_access_token() == "fresh-token"


def test_managed_vendor_endpoints_pin_the_deployed_gateway_url():
    """The exact URL an agent may connect to is a code fact, not a lookup.

    Exercises the real default resolution (which once resolved a typo'd
    pseudo-vendor to a non-existent host while every other test stubbed it):
    default resolver, real deployed host, pinned vendor path.
    """
    with gateway_env(TOOL_GATEWAY_DOMAIN="nousresearch.com", TOOL_GATEWAY_SCHEME="https"):
        endpoints = managed_tool_gateway.managed_vendor_endpoints("bfl")

    assert endpoints == {
        "origin": "https://tool-gateway.nousresearch.com",
        "base_url": "https://tool-gateway.nousresearch.com/api/bfl",
        "upload_path": "/api/uploads/bfl",
    }


def test_connector_gateway_origin_pins_the_deployed_connectors_host():
    # The connectors API is its own deployment on its own canonical host, so
    # its default resolution must not land on the media/vendor origin.
    with gateway_env():
        assert managed_tool_gateway.connector_gateway_origin() == (
            "https://connector-gateway.nousresearch.com"
        )
        assert managed_tool_gateway.managed_gateway_origin() == (
            "https://tool-gateway.nousresearch.com"
        )


def test_managed_gateway_origin_honors_the_harness_override():
    # TOOL_GATEWAY_URL pins the full media origin (the e2e harness sets it to a
    # loopback gateway), and the bearer gate must accept exactly that origin.
    with gateway_env(TOOL_GATEWAY_URL="http://127.0.0.1:3009/"):
        assert managed_tool_gateway.managed_gateway_origin() == "http://127.0.0.1:3009"
        assert managed_tool_gateway.is_managed_nous_gateway_url(
            "http://127.0.0.1:3009/api/bfl/generations"
        )
        # The retired shared host is now nobody's origin, and the override
        # means even the real media host is not this install's address.
        for untrusted in (
            "https://tools.nousresearch.com/api/bfl/generations",
            "https://tool-gateway.nousresearch.com/api/bfl/generations",
        ):
            assert not managed_tool_gateway.is_managed_nous_gateway_url(untrusted)


def test_the_two_first_party_hosts_have_separate_override_keys():
    # Each surface is pinned by its own key. Moving the media host must not
    # drag the connectors client along, or connector calls would silently go to
    # a host that does not serve them (and the reverse).
    with gateway_env(TOOL_GATEWAY_URL="http://127.0.0.1:3009/"):
        assert managed_tool_gateway.connector_gateway_origin() == (
            "https://connector-gateway.nousresearch.com"
        )

    with gateway_env(CONNECTOR_GATEWAY_URL="http://127.0.0.1:3009/"):
        assert managed_tool_gateway.connector_gateway_origin() == "http://127.0.0.1:3009"
        assert managed_tool_gateway.managed_gateway_origin() == (
            "https://tool-gateway.nousresearch.com"
        )
        # Loopback earns the bearer with no trust list, same as the media host.
        assert managed_tool_gateway.is_managed_nous_gateway_url(
            "http://127.0.0.1:3009/v1/connectors/search"
        )


def test_vendor_env_override_does_not_inherit_the_bearer():
    # An attacker who can set one env var must not receive the user's token:
    # managed mode resolves to None (tool reports unconfigured) with a warning,
    # instead of shipping the bearer to whatever the environment names.
    with gateway_env(FIRECRAWL_GATEWAY_URL="https://attacker.example"), patch.object(
        managed_tool_gateway, "managed_nous_tools_enabled", return_value=True
    ):
        config = managed_tool_gateway.resolve_managed_tool_gateway(
            "firecrawl", token_reader=lambda: "secret-token"
        )
    assert config is None


def test_loopback_and_trust_listed_overrides_keep_managed_mode():
    with patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True):
        # Loopback (the local harness) needs no configuration.
        with gateway_env(FIRECRAWL_GATEWAY_URL="http://127.0.0.1:3009"):
            config = managed_tool_gateway.resolve_managed_tool_gateway(
                "firecrawl", token_reader=lambda: "secret-token"
            )
        assert config is not None and config.nous_user_token == "secret-token"

        # A staging origin is granted by exact membership in the trust list.
        with gateway_env(
            FIRECRAWL_GATEWAY_URL="https://stage.example",
            HERMES_TRUSTED_GATEWAY_ORIGINS="https://other.example, https://stage.example",
        ):
            config = managed_tool_gateway.resolve_managed_tool_gateway(
                "firecrawl", token_reader=lambda: "secret-token"
            )
        assert config is not None

        # The hardcoded deployed vendor host stays trusted with no env at all.
        with gateway_env():
            config = managed_tool_gateway.resolve_managed_tool_gateway(
                "firecrawl", token_reader=lambda: "secret-token"
            )
        assert config is not None
        assert config.gateway_origin == "https://firecrawl-gateway.nousresearch.com"


def test_trust_list_entries_are_normalized_like_origins():
    # (scheme, host, port) on both sides: a trailing slash and a shouted host
    # still match, but a port is significant and an entry must spell it out.
    with patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True):
        with gateway_env(
            FIRECRAWL_GATEWAY_URL="https://Stage.Example/",
            HERMES_TRUSTED_GATEWAY_ORIGINS="https://stage.example",
        ):
            assert managed_tool_gateway.resolve_managed_tool_gateway(
                "firecrawl", token_reader=lambda: "t"
            ) is not None

        with gateway_env(
            FIRECRAWL_GATEWAY_URL="https://stage.example:8443",
            HERMES_TRUSTED_GATEWAY_ORIGINS="https://stage.example",
        ):
            assert managed_tool_gateway.resolve_managed_tool_gateway(
                "firecrawl", token_reader=lambda: "t"
            ) is None

        with gateway_env(
            FIRECRAWL_GATEWAY_URL="https://stage.example:8443",
            HERMES_TRUSTED_GATEWAY_ORIGINS="junk, https://stage.example:8443/",
        ):
            assert managed_tool_gateway.resolve_managed_tool_gateway(
                "firecrawl", token_reader=lambda: "t"
            ) is not None


def test_untrusted_origin_warns_once_per_vendor_and_origin(caplog):
    # is_managed_tool_gateway_ready runs on every availability paint; the same
    # warning on every repaint would drown the log.
    import logging

    def _warnings():
        return [r for r in caplog.records if "attacker.example" in r.getMessage()]

    with gateway_env(
        FIRECRAWL_GATEWAY_URL="https://attacker.example",
        BFL_GATEWAY_URL="https://attacker.example",
    ), patch.object(
        managed_tool_gateway, "managed_nous_tools_enabled", return_value=True
    ), caplog.at_level(logging.WARNING, logger=managed_tool_gateway.logger.name):
        for _ in range(5):
            assert managed_tool_gateway.is_managed_tool_gateway_ready(
                "firecrawl", token_reader=lambda: "t"
            ) is False
        assert len(_warnings()) == 1

        # A DIFFERENT vendor on the same origin is a distinct fact worth saying.
        assert managed_tool_gateway.is_managed_tool_gateway_ready(
            "bfl", token_reader=lambda: "t"
        ) is False
        assert len(_warnings()) == 2
        assert {r.getMessage().split("for ")[1] for r in _warnings()} == {
            "vendor firecrawl; add the exact origin to HERMES_TRUSTED_GATEWAY_ORIGINS to allow it.",
            "vendor bfl; add the exact origin to HERMES_TRUSTED_GATEWAY_ORIGINS to allow it.",
        }


def test_shared_origin_override_gates_the_bearer_not_the_address():
    # TOOL_GATEWAY_URL still steers where requests GO (address resolution is
    # untouched), but an untrusted override origin never earns the bearer.
    with gateway_env(TOOL_GATEWAY_URL="https://attacker.example"):
        endpoints = managed_tool_gateway.managed_vendor_endpoints("bfl")
        assert endpoints is not None and endpoints["origin"] == "https://attacker.example"
        assert not managed_tool_gateway.is_managed_nous_gateway_url(
            "https://attacker.example/api/bfl/generations"
        )

    with gateway_env(
        TOOL_GATEWAY_URL="https://stage.example",
        HERMES_TRUSTED_GATEWAY_ORIGINS="https://stage.example",
    ):
        assert managed_tool_gateway.is_managed_nous_gateway_url(
            "https://stage.example/api/bfl/generations"
        )


def test_connector_origin_override_gates_the_bearer_not_the_address():
    # The connectors host gets no weaker a gate for being the newer surface:
    # CONNECTOR_GATEWAY_URL still resolves the address, and an attacker-named
    # origin still earns nothing until it is loopback or trust-listed.
    with gateway_env(CONNECTOR_GATEWAY_URL="https://attacker.example"):
        assert managed_tool_gateway.connector_gateway_origin() == "https://attacker.example"
        assert not managed_tool_gateway.is_managed_nous_gateway_url(
            "https://attacker.example/v1/connectors/search"
        )

    with gateway_env(
        CONNECTOR_GATEWAY_URL="https://stage.example",
        HERMES_TRUSTED_GATEWAY_ORIGINS="https://stage.example",
    ):
        assert managed_tool_gateway.is_managed_nous_gateway_url(
            "https://stage.example/v1/connectors/search"
        )


def test_default_bearer_gate_accepts_both_deployed_hosts_only():
    # Exact (scheme, host, port) equality against each deployed origin. Both
    # first-party hosts are in; the retired shared host, subdomain cousins,
    # scheme downgrades, and a bare hostname are all out.
    with gateway_env():
        for trusted in (
            "https://connector-gateway.nousresearch.com/v1/connectors/execute",
            "https://tool-gateway.nousresearch.com/api/bfl/generations",
        ):
            assert managed_tool_gateway.is_managed_nous_gateway_url(trusted)
        for untrusted in (
            "https://tools.nousresearch.com/v1/connectors/execute",
            "https://connector-gateway.nousresearch.com.attacker.dev/v1/connectors",
            "https://evil-connector-gateway.nousresearch.com/v1/connectors",
            "http://connector-gateway.nousresearch.com/v1/connectors",
            "http://tool-gateway.nousresearch.com/api/bfl/generations",
            "connector-gateway.nousresearch.com/v1/connectors",  # no scheme
        ):
            assert not managed_tool_gateway.is_managed_nous_gateway_url(untrusted)


def test_a_domain_reshape_needs_the_trust_list_on_both_first_party_hosts():
    # Same deliberate consequence as the vendor path, and it applies per host:
    # TOOL_GATEWAY_DOMAIN is an env knob, so every host built from it is
    # env-derived — even when it spells out today's default domain.
    with gateway_env(TOOL_GATEWAY_DOMAIN="nousresearch.com", TOOL_GATEWAY_SCHEME="https"):
        assert not managed_tool_gateway.is_managed_nous_gateway_url(
            "https://connector-gateway.nousresearch.com/v1/connectors/execute"
        )
        assert not managed_tool_gateway.is_managed_nous_gateway_url(
            "https://tool-gateway.nousresearch.com/api/bfl/generations"
        )

    # Listing one host grants that host only — trust does not spread sideways.
    with gateway_env(
        TOOL_GATEWAY_DOMAIN="gw.example.com",
        HERMES_TRUSTED_GATEWAY_ORIGINS="https://connector-gateway.gw.example.com",
    ):
        assert managed_tool_gateway.is_managed_nous_gateway_url(
            "https://connector-gateway.gw.example.com/v1/connectors/execute"
        )
        assert not managed_tool_gateway.is_managed_nous_gateway_url(
            "https://tool-gateway.gw.example.com/api/bfl/generations"
        )

    with gateway_env(
        TOOL_GATEWAY_DOMAIN="gw.example.com",
        HERMES_TRUSTED_GATEWAY_ORIGINS=(
            "https://connector-gateway.gw.example.com,"
            "https://tool-gateway.gw.example.com"
        ),
    ):
        assert managed_tool_gateway.is_managed_nous_gateway_url(
            "https://tool-gateway.gw.example.com/api/bfl/generations"
        )


def test_managed_vendor_endpoints_do_not_consult_entitlement():
    """Address resolution, not a policy decision.

    What an account may spend is the gateway's ruling, stated in its refusals.
    Guessing at it here would hide the address from a caller the server would
    have served, so entitlement must not be read on this path at all.
    """
    with gateway_env(TOOL_GATEWAY_DOMAIN="nousresearch.com"), patch.object(
        managed_tool_gateway,
        "managed_nous_tools_enabled",
        side_effect=AssertionError("entitlement must not gate address resolution"),
    ):
        endpoints = managed_tool_gateway.managed_vendor_endpoints("bfl")

    assert endpoints is not None
    assert endpoints["base_url"] == "https://tool-gateway.nousresearch.com/api/bfl"


def test_managed_vendor_endpoints_are_none_when_no_origin_resolves():
    # A misconfigured scheme leaves nothing to call, and the caller reports
    # that rather than building a URL out of a broken setting.
    with gateway_env(TOOL_GATEWAY_SCHEME="ftp"):
        assert managed_tool_gateway.managed_gateway_origin() is None
        assert managed_tool_gateway.connector_gateway_origin() is None
        assert managed_tool_gateway.managed_vendor_endpoints("bfl") is None
        with pytest.raises(ValueError):
            # The vendor builder's contract has always been to raise.
            managed_tool_gateway.build_vendor_gateway_url("firecrawl")


def test_managed_gateway_auth_headers_carry_the_bearer():
    with gateway_env(), patch.object(
        managed_tool_gateway, "managed_nous_tools_enabled", return_value=True
    ):
        headers = managed_tool_gateway.managed_gateway_auth_headers(
            "https://tool-gateway.nousresearch.com/api/bfl/generations",
            token_reader=lambda: "nous-token",
        )

    assert headers == {"Authorization": "Bearer nous-token"}


def test_managed_gateway_auth_headers_reflect_a_rotated_token():
    # Read fresh on every call: a Nous access token expires within the hour,
    # and a long session must not keep presenting a dead bearer.
    tokens = iter(["first-token", "second-token"])
    url = "https://tool-gateway.nousresearch.com/api/bfl/generations"

    with gateway_env(), patch.object(
        managed_tool_gateway, "managed_nous_tools_enabled", return_value=True
    ):
        first = managed_tool_gateway.managed_gateway_auth_headers(url, lambda: next(tokens))
        second = managed_tool_gateway.managed_gateway_auth_headers(url, lambda: next(tokens))

    assert first["Authorization"] == "Bearer first-token"
    assert second["Authorization"] == "Bearer second-token"


def test_managed_gateway_auth_headers_refuse_a_url_off_the_gateway_origin():
    # Gated on the URL, never a name: our bearer must never be handed to a
    # host that merely looks managed.
    with gateway_env(), patch.object(
        managed_tool_gateway, "managed_nous_tools_enabled", return_value=True
    ):
        assert managed_tool_gateway.managed_gateway_auth_headers(
            "https://attacker.example/api/bfl/generations",
            token_reader=lambda: "nous-token",
        ) == {}


def test_managed_gateway_auth_headers_empty_without_a_token():
    # Empty rather than raising, so a caller can say "sign in" instead of
    # sending an unauthenticated request.
    with gateway_env(), patch.object(
        managed_tool_gateway, "managed_nous_tools_enabled", return_value=True
    ):
        assert managed_tool_gateway.managed_gateway_auth_headers(
            "https://tool-gateway.nousresearch.com/api/bfl/generations",
            token_reader=lambda: None,
        ) == {}


class TestManagedMediaUploader:
    """The presign -> PUT -> ``nous-upload:<token>`` protocol.

    This is the only way a local image or video reaches a managed vendor, and
    the pieces it gets right are not incidental: the presigned URL signs the
    content type and byte length, so a PUT that disagrees with the presign is
    rejected by storage rather than by us.
    """

    # The real deployed shared origin, reached through the real trust gate —
    # the gateway_builder seam this used to inject was also the switch that
    # turned that gate off, so the protocol was never tested with it on.
    GATEWAY = "https://tool-gateway.nousresearch.com"
    BASE_URL = f"{GATEWAY}/api/bfl"
    UPLOAD_PATH = "/api/uploads/bfl"

    @pytest.fixture(autouse=True)
    def _default_gateway_env(self):
        """No gateway env at all: the hardcoded default origin, which is trusted."""
        with gateway_env():
            yield

    def _uploader(self, **kwargs):
        return managed_tool_gateway.build_managed_media_uploader(
            kwargs.pop("server_url", self.BASE_URL),
            kwargs.pop("upload_path", self.UPLOAD_PATH),
            token_reader=kwargs.pop("token_reader", lambda: "nous-token"),
        )

    @staticmethod
    def _response(status_code=200, payload=None):
        class _R:
            def __init__(self):
                self.status_code = status_code

            def json(self):
                if payload is None:
                    raise ValueError("no json")
                return payload

        return _R()

    def _run(self, uploader, data=b"bytes", mime="image/png", presign=None, put=None):
        """Drive one upload with both HTTP legs stubbed; returns the calls made."""
        import httpx

        from tools import url_safety

        calls = {"presign": [], "put": []}
        presign = presign if presign is not None else self._response(
            200, {"uploadUrl": "https://storage.example/put?sig=abc", "token": "tok-1"}
        )
        put = put if put is not None else self._response(200)

        class _PresignClient:
            def __init__(self, **_kw):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_exc):
                return False

            async def post(self, url, headers=None, json=None):
                calls["presign"].append({"url": url, "headers": headers, "json": json})
                return presign

        class _PutClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_exc):
                return False

            async def put(self, url, content=None, headers=None):
                calls["put"].append({"url": url, "content": content, "headers": headers})
                return put

        with patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True), \
                patch.object(httpx, "AsyncClient", _PresignClient), \
                patch.object(url_safety, "create_ssrf_safe_async_client", lambda **_kw: _PutClient()):
            calls["result"] = asyncio.run(uploader(data, mime))
        return calls

    def test_presign_declares_the_exact_type_and_length_the_put_then_sends(self):
        # Storage validates the PUT against what was signed, so a mismatch
        # between these two is a rejection with no useful error.
        with patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True):
            uploader = self._uploader()
        data = b"\x89PNG\r\n\x1a\n" + b"payload" * 100

        calls = self._run(uploader, data=data, mime="image/png")

        assert calls["presign"][0]["url"] == f"{self.GATEWAY}{self.UPLOAD_PATH}"
        assert calls["presign"][0]["json"] == {
            "contentType": "image/png",
            "contentLength": len(data),
        }
        assert calls["presign"][0]["headers"]["Authorization"] == "Bearer nous-token"
        assert calls["put"][0]["url"] == "https://storage.example/put?sig=abc"
        assert calls["put"][0]["content"] == data
        assert calls["put"][0]["headers"] == {"Content-Type": "image/png"}
        assert calls["result"] == "nous-upload:tok-1"

    def test_the_bytes_go_to_storage_and_never_through_the_gateway(self):
        # The whole point of presigning is that the gateway's request-size
        # ceiling does not apply to a 50MB clip.
        with patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True):
            uploader = self._uploader()

        calls = self._run(uploader, data=b"v" * 4096, mime="video/mp4")

        assert len(calls["presign"]) == 1 and len(calls["put"]) == 1
        assert self.GATEWAY not in calls["put"][0]["url"]
        assert calls["presign"][0]["json"]["contentType"] == "video/mp4"

    def test_no_uploader_when_the_url_is_not_a_managed_gateway(self):
        # Refusing to build is what makes the caller say "pass a URL instead"
        # rather than forwarding a raw local path to a third party.
        with patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True):
            assert self._uploader(server_url="https://attacker.example/api/bfl") is None

    def test_no_uploader_when_the_shared_origin_is_an_untrusted_override(self):
        # The trust gate reaches the uploader too: an env-shaped origin with no
        # trust-list entry disables local uploads entirely rather than sending
        # the user's files (and bearer) to whatever the environment names.
        with gateway_env(TOOL_GATEWAY_URL="https://attacker.example"), patch.object(
            managed_tool_gateway, "managed_nous_tools_enabled", return_value=True
        ):
            assert managed_tool_gateway.build_managed_media_uploader(
                "https://attacker.example/api/bfl",
                self.UPLOAD_PATH,
                token_reader=lambda: "nous-token",
            ) is None

    def test_uploader_is_built_for_a_trusted_loopback_override(self):
        # The local harness pins TOOL_GATEWAY_URL to loopback and needs no
        # trust-list entry, so uploads keep working there.
        with gateway_env(TOOL_GATEWAY_URL="http://127.0.0.1:3009"), patch.object(
            managed_tool_gateway, "managed_nous_tools_enabled", return_value=True
        ):
            assert managed_tool_gateway.build_managed_media_uploader(
                "http://127.0.0.1:3009/api/bfl",
                self.UPLOAD_PATH,
                token_reader=lambda: "nous-token",
            ) is not None

    @pytest.mark.parametrize("upload_path", [None, "", "api/uploads/bfl", 42])
    def test_no_uploader_without_a_rooted_upload_path(self, upload_path):
        with patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True):
            assert self._uploader(upload_path=upload_path) is None

    def test_a_missing_credential_fails_before_any_request(self):
        with patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True):
            uploader = self._uploader()

        with patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True), \
                patch.object(managed_tool_gateway, "managed_gateway_auth_headers", return_value={}):
            with pytest.raises(RuntimeError, match="no Nous credential"):
                asyncio.run(uploader(b"x", "image/png"))

    def test_a_gateway_refusal_surfaces_its_own_message(self):
        # Quota and size refusals carry guidance written for the model; a bare
        # status code would throw that away.
        with patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True):
            uploader = self._uploader()
        refusal = self._response(
            413, {"error": {"message": "That file is 82MB; the limit for video is 50MB."}}
        )

        with pytest.raises(RuntimeError, match="the limit for video is 50MB"):
            self._run(uploader, presign=refusal)

    def test_an_unreadable_refusal_still_reports_the_status(self):
        with patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True):
            uploader = self._uploader()

        with pytest.raises(RuntimeError, match="HTTP 502"):
            self._run(uploader, presign=self._response(502, None))

    @pytest.mark.parametrize(
        "payload",
        [
            {},
            {"uploadUrl": "https://storage.example/put"},
            {"token": "tok-1"},
            {"uploadUrl": "", "token": "tok-1"},
            {"uploadUrl": "https://storage.example/put", "token": ""},
        ],
    )
    def test_a_malformed_presign_response_is_refused_rather_than_guessed(self, payload):
        # Half a presign must not become a PUT to nowhere or an empty token
        # that later reads as a valid reference.
        with patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True):
            uploader = self._uploader()

        with pytest.raises(RuntimeError, match="malformed"):
            self._run(uploader, presign=self._response(200, payload))

    def test_a_storage_rejection_is_not_reported_as_a_successful_upload(self):
        # A signature mismatch answers non-200 with an XML body; returning a
        # token here would hand the vendor a reference to nothing.
        with patch.object(managed_tool_gateway, "managed_nous_tools_enabled", return_value=True):
            uploader = self._uploader()

        with pytest.raises(RuntimeError, match="storage refused the upload"):
            self._run(uploader, put=self._response(403))


def test_is_managed_tool_gateway_ready_skips_refresh_for_expired_cached_token(tmp_path, monkeypatch):
    monkeypatch.delenv("TOOL_GATEWAY_USER_TOKEN", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    expired_at = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()
    (tmp_path / "auth.json").write_text(json.dumps({
        "providers": {
            "nous": {
                "access_token": "expired-token",
                "refresh_token": "refresh-token",
                "expires_at": expired_at,
            }
        }
    }))
    refresh_calls = []

    def _record_refresh(*, refresh_skew_seconds=120, **_kwargs):
        refresh_calls.append(refresh_skew_seconds)
        return "fresh-token"

    monkeypatch.setattr(
        "hermes_cli.auth.resolve_nous_access_token",
        _record_refresh,
    )

    with gateway_env(), patch.object(
        managed_tool_gateway, "managed_nous_tools_enabled", return_value=True
    ):
        assert is_managed_tool_gateway_ready("modal") is True

    assert refresh_calls == []
