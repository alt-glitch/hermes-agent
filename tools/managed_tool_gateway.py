"""Managed-tool gateway helpers: host resolution, bearer trust, media uploads.

Three shapes of first-party gateway host live behind these helpers, all named
``{label}.{domain}`` and all built by the one formula in
:func:`_gateway_origin`:

* ``connector-gateway`` — the connectors API (``/v1/connectors/*``). Its own
  deployment, its own canonical host, its own ``CONNECTOR_GATEWAY_URL``
  override. Resolved by :func:`connector_gateway_origin`.
* ``tool-gateway`` — the vendors the gateway serves on its own origin under
  ``/api/{vendor}``, plus the media upload endpoints. Overridden with
  ``TOOL_GATEWAY_URL``. Resolved by :func:`managed_gateway_origin`.
* ``{vendor}-gateway`` — per-vendor passthroughs (Firecrawl, BFL, ...), each
  overridable on its own with ``{VENDOR}_GATEWAY_URL``. Resolved by
  :func:`build_vendor_gateway_url`.

Two separable questions live here, and keeping them apart is the whole design:

* WHERE do requests go — :func:`build_vendor_gateway_url`,
  :func:`managed_gateway_origin`, :func:`connector_gateway_origin`,
  :func:`managed_vendor_endpoints`. Every env override steers this freely; that
  is what local and staging setups use.
* Which origin earns the user's Nous bearer — :func:`_bearer_is_allowed`. Trust
  is provenance: the hardcoded default is trusted, loopback is trusted, and
  ANY origin the environment shaped (including a ``TOOL_GATEWAY_SCHEME`` /
  ``TOOL_GATEWAY_DOMAIN`` reshape, not just an exact-origin override) needs an
  entry in ``HERMES_TRUSTED_GATEWAY_ORIGINS``. Deliberate: one settable env var
  must not be enough to harvest the token. Because the answer is a property of
  each origin's own provenance, adding a second first-party host needed no new
  trust rule.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from dataclasses import dataclass
from typing import Callable, Optional
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

from hermes_constants import get_hermes_home
from tools.tool_backend_helpers import managed_nous_tools_enabled

_DEFAULT_TOOL_GATEWAY_DOMAIN = "nousresearch.com"
_DEFAULT_TOOL_GATEWAY_SCHEME = "https"
_NOUS_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 120


@dataclass(frozen=True)
class ManagedToolGatewayConfig:
    vendor: str
    gateway_origin: str
    nous_user_token: str
    managed_mode: bool


def auth_json_path():
    """Return the Hermes auth store path, respecting HERMES_HOME overrides."""
    return get_hermes_home() / "auth.json"


def _read_nous_provider_state() -> Optional[dict]:
    try:
        path = auth_json_path()
        if not path.is_file():
            return None
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        providers = data.get("providers", {})
        if not isinstance(providers, dict):
            return None
        nous_provider = providers.get("nous", {})
        if isinstance(nous_provider, dict):
            return nous_provider
    except Exception:
        pass
    return None


def _parse_timestamp(value: object) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _access_token_is_expiring(expires_at: object, skew_seconds: int) -> bool:
    expires = _parse_timestamp(expires_at)
    if expires is None:
        return True
    remaining = (expires - datetime.now(timezone.utc)).total_seconds()
    return remaining <= max(0, int(skew_seconds))


def _read_user_token_override() -> Optional[str]:
    """Read the TOOL_GATEWAY_USER_TOKEN env override through the secret scope.

    Availability scans run both inside agent turns (scope installed) and in
    unscoped CLI paths, so this uses the Slack pattern: honor the scope's
    verdict when installed (a scoped miss does NOT borrow the process env
    under multiplex), fall back to ``os.environ`` only when unscoped.
    """
    try:
        from agent.secret_scope import UnscopedSecretError, get_secret

        try:
            explicit = get_secret("TOOL_GATEWAY_USER_TOKEN")
        except UnscopedSecretError:
            explicit = os.getenv("TOOL_GATEWAY_USER_TOKEN")
    except Exception:
        explicit = os.getenv("TOOL_GATEWAY_USER_TOKEN")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    return None


def peek_nous_access_token() -> Optional[str]:
    """Cheap probe for a Nous gateway token without triggering refresh.

    Availability scans (`hermes tools`, banner/status paint, provider
    `is_available()` checks) must stay off the synchronous OAuth refresh path.
    This helper therefore only inspects the explicit env override and the
    cached auth-store token, without checking expiry and without making any
    network calls. Truthful refresh handling stays in request/session paths
    that call :func:`read_nous_access_token`.
    """
    explicit = _read_user_token_override()
    if explicit:
        return explicit

    nous_provider = _read_nous_provider_state() or {}
    access_token = nous_provider.get("access_token")
    if isinstance(access_token, str) and access_token.strip():
        return access_token.strip()
    return None


def read_nous_access_token() -> Optional[str]:
    """Read a Nous Subscriber OAuth access token from auth store or env override."""
    explicit = _read_user_token_override()
    if explicit:
        return explicit
    nous_provider = _read_nous_provider_state() or {}
    cached_token = peek_nous_access_token()

    if cached_token and not _access_token_is_expiring(
        nous_provider.get("expires_at"),
        _NOUS_ACCESS_TOKEN_REFRESH_SKEW_SECONDS,
    ):
        return cached_token

    try:
        from hermes_cli.auth import resolve_nous_access_token

        refreshed_token = resolve_nous_access_token(
            refresh_skew_seconds=_NOUS_ACCESS_TOKEN_REFRESH_SKEW_SECONDS,
        )
        if isinstance(refreshed_token, str) and refreshed_token.strip():
            return refreshed_token.strip()
    except Exception as exc:
        logger.debug("Nous access token refresh failed: %s", exc)

    return cached_token


def get_tool_gateway_scheme() -> str:
    """Return configured shared gateway URL scheme."""
    scheme = os.getenv("TOOL_GATEWAY_SCHEME", "").strip().lower()
    if not scheme:
        return _DEFAULT_TOOL_GATEWAY_SCHEME

    if scheme in {"http", "https"}:
        return scheme

    raise ValueError("TOOL_GATEWAY_SCHEME must be 'http' or 'https'")


# ---------------------------------------------------------------------------
# Origin provenance
# ---------------------------------------------------------------------------
#
# Every gateway origin this module hands out comes from ONE formula, and that
# formula records WHERE the origin came from. Trust is then a property of
# provenance, not a string comparison against a re-derived "expected" value:
# the two inline deployed-origin f-strings this replaces were the same formula
# written a third and fourth time, and they could drift from the real one
# silently.

_TRUSTED_GATEWAY_ORIGINS_ENV = "HERMES_TRUSTED_GATEWAY_ORIGINS"
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

# (label, origin) pairs already warned about. is_managed_tool_gateway_ready
# runs on every availability scan — once per paint — so without this the log
# fills with the same line forever (30-F5).
_warned_untrusted_origins: set = set()
_warned_untrusted_lock = threading.Lock()


@dataclass(frozen=True)
class ResolvedOrigin:
    """A gateway origin plus the answer to "did the environment shape it?".

    ``from_env`` is False ONLY on the fully-hardcoded default branch: no
    ``*_GATEWAY_URL`` override, no ``TOOL_GATEWAY_SCHEME``, no
    ``TOOL_GATEWAY_DOMAIN``. Anything the environment touched is env-derived,
    which is what the bearer gate keys on.
    """

    origin: str
    from_env: bool


def _gateway_origin(env_key: str, host_label: str) -> Optional[ResolvedOrigin]:
    """The one formula for a gateway origin. ``None`` when none can be built.

    Precedence: ``env_key`` (an exact origin) beats the derived
    ``{scheme}://{host_label}.{domain}``, where scheme and domain honor
    ``TOOL_GATEWAY_SCHEME`` / ``TOOL_GATEWAY_DOMAIN``.

    ``None`` means a misconfigured ``TOOL_GATEWAY_SCHEME`` — the only way this
    can fail. The ValueError is mapped HERE so no caller carries a try/except
    for it; :func:`build_vendor_gateway_url` restates it as a raise because
    that has always been its contract.
    """
    explicit = os.getenv(env_key, "").strip().rstrip("/")
    if explicit:
        return ResolvedOrigin(origin=explicit, from_env=True)

    raw_scheme = os.getenv("TOOL_GATEWAY_SCHEME", "").strip()
    raw_domain = os.getenv("TOOL_GATEWAY_DOMAIN", "").strip().strip("/")
    try:
        scheme = get_tool_gateway_scheme()
    except ValueError:
        return None
    domain = raw_domain or _DEFAULT_TOOL_GATEWAY_DOMAIN
    return ResolvedOrigin(
        origin=f"{scheme}://{host_label}.{domain}",
        from_env=bool(raw_scheme or raw_domain),
    )


@dataclass(frozen=True)
class _GatewaySurface:
    """One first-party gateway host: how to resolve it, what to call it.

    The two surfaces are declared once, below, and everything that needs one —
    the public origin resolvers, the bearer gate's URL matching, the untrusted
    warning's wording — reads it from here. Same ``{label}.{domain}`` formula
    as a ``{vendor}-gateway`` passthrough, because the naming scheme is the
    same; what differs is which env key pins each one.
    """

    env_key: str
    host_label: str
    log_label: str

    def resolve(self) -> Optional[ResolvedOrigin]:
        """This surface's origin WITH its provenance, for the bearer gate."""
        return _gateway_origin(self.env_key, self.host_label)


_MANAGED_VENDOR_SURFACE = _GatewaySurface(
    env_key="TOOL_GATEWAY_URL",
    host_label="tool-gateway",
    log_label="the managed vendor gateway",
)
_CONNECTOR_SURFACE = _GatewaySurface(
    env_key="CONNECTOR_GATEWAY_URL",
    host_label="connector-gateway",
    log_label="the connectors gateway",
)

# Each surface is a separate resolution with its own provenance, so the bearer
# gate rules on each independently — a trusted media host says nothing about
# the connectors host.
_FIRST_PARTY_GATEWAY_SURFACES = (_MANAGED_VENDOR_SURFACE, _CONNECTOR_SURFACE)


def _vendor_origin_env_key(vendor: str) -> str:
    return f"{vendor.upper().replace('-', '_')}_GATEWAY_URL"


def build_vendor_gateway_url(vendor: str) -> str:
    """Return the gateway origin for a specific vendor.

    Raises ``ValueError`` when ``TOOL_GATEWAY_SCHEME`` is not http/https —
    unchanged contract, restated from the ``None`` :func:`_gateway_origin`
    returns.
    """
    resolved = _gateway_origin(_vendor_origin_env_key(vendor), f"{vendor}-gateway")
    if resolved is None:
        raise ValueError("TOOL_GATEWAY_SCHEME must be 'http' or 'https'")
    return resolved.origin


def _origin_key(value: object) -> Optional[tuple]:
    """Normalize an origin to a comparable ``(scheme, host, port)``.

    The (scheme, netloc) comparison the bearer gate promises, done properly:
    the host is lowercased (RFC 3986 makes it case-insensitive) and the port
    is kept as-is, because a port is significant. Practical consequence for
    ``HERMES_TRUSTED_GATEWAY_ORIGINS``: an entry must spell out the explicit
    port when the origin it authorizes carries one — ``https://stage.example``
    does not authorize ``https://stage.example:8443``, and no default-port
    folding happens either.

    ``None`` for anything that is not an http(s) origin.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parts = urlsplit(value.strip().rstrip("/"))
        if parts.scheme not in {"http", "https"} or not parts.netloc:
            return None
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        # urlsplit raises on a malformed port or IPv6 literal.
        return None
    if not host:
        return None
    return parts.scheme, host, port


def _is_loopback(origin: object) -> bool:
    """True for an origin on the local machine.

    Includes the ``.localhost`` name suffix, which an existing dev flow needs
    ({vendor}-gateway.localhost:3009). Be honest about what that is: RFC 6761
    INTENDS ``.localhost`` to resolve to loopback, but this is a name check,
    not a check of the resolved address — an OS resolver override could point
    it elsewhere. Acceptable, because setting one requires control of the local
    machine, which already owns the token this gate protects.
    """
    key = _origin_key(origin)
    if key is None:
        return False
    host = key[1]
    return host in _LOOPBACK_HOSTS or host.endswith(".localhost")


def _trusted_origin_keys() -> set:
    """``HERMES_TRUSTED_GATEWAY_ORIGINS`` normalized the same way as an origin."""
    raw = os.getenv(_TRUSTED_GATEWAY_ORIGINS_ENV, "")
    keys = set()
    for entry in raw.split(","):
        key = _origin_key(entry)
        if key is not None:
            keys.add(key)
    return keys


def _is_bearer_trusted_origin(origin: object) -> bool:
    """True when an ENV-DERIVED origin may still carry the Nous bearer.

    Exact ``(scheme, host, port)`` membership only, never a suffix rule — plus
    loopback, which needs no configuration.
    """
    key = _origin_key(origin)
    if key is None:
        return False
    if _is_loopback(origin):
        return True
    return key in _trusted_origin_keys()


def _bearer_is_allowed(resolved: ResolvedOrigin, label: str) -> bool:
    """Trust as provenance: the hardcoded default, loopback, or trust-listed.

    The security model, owner-approved and deliberate: an origin the
    environment shaped does NOT inherit the user's token, because an attacker
    who can set one env var must not be able to harvest the bearer. That
    includes ``TOOL_GATEWAY_SCHEME`` / ``TOOL_GATEWAY_DOMAIN`` reshapes, not
    just the exact-origin overrides — a reshaped host needs listing in
    ``HERMES_TRUSTED_GATEWAY_ORIGINS`` exactly like ``TOOL_GATEWAY_URL`` does.
    Loopback needs nothing.

    Warns at most once per (label, origin): this runs on the availability path,
    which repaints constantly.
    """
    if not resolved.from_env:
        return True
    if _is_bearer_trusted_origin(resolved.origin):
        return True
    seen_key = (label, resolved.origin)
    with _warned_untrusted_lock:
        first_time = seen_key not in _warned_untrusted_origins
        if first_time:
            _warned_untrusted_origins.add(seen_key)
    if first_time:
        logger.warning(
            "Refusing to attach the Nous token to untrusted gateway origin %s "
            "for %s; add the exact origin to %s to allow it.",
            resolved.origin,
            label,
            _TRUSTED_GATEWAY_ORIGINS_ENV,
        )
    return False


def resolve_managed_tool_gateway(
    vendor: str,
    token_reader: Optional[Callable[[], Optional[str]]] = None,
) -> Optional[ManagedToolGatewayConfig]:
    """Resolve shared managed-tool gateway config for a vendor.

    ``None`` means "not in managed mode", which covers three things: no
    entitlement, no resolvable origin, and — see :func:`_bearer_is_allowed` —
    an env-derived origin that is not trust-listed.
    """
    if not managed_nous_tools_enabled():
        return None

    resolved = _gateway_origin(_vendor_origin_env_key(vendor), f"{vendor}-gateway")
    if resolved is None or not resolved.origin:
        return None
    if not _bearer_is_allowed(resolved, f"vendor {vendor}"):
        return None

    nous_user_token = (token_reader or read_nous_access_token)()
    if not nous_user_token:
        return None

    return ManagedToolGatewayConfig(
        vendor=vendor,
        gateway_origin=resolved.origin,
        nous_user_token=nous_user_token,
        managed_mode=True,
    )


def is_managed_tool_gateway_ready(
    vendor: str,
    token_reader: Optional[Callable[[], Optional[str]]] = None,
) -> bool:
    """Return True when gateway URL and a likely-usable Nous token are present.

    Defaults to :func:`peek_nous_access_token` so read-only availability scans
    avoid synchronous OAuth refresh. Callers that are about to make a real
    gateway request should use :func:`resolve_managed_tool_gateway` (which
    still defaults to the refresh-aware :func:`read_nous_access_token`).
    """
    return resolve_managed_tool_gateway(
        vendor,
        token_reader=token_reader or peek_nous_access_token,
    ) is not None


# ---------------------------------------------------------------------------
# Managed vendor endpoints
# ---------------------------------------------------------------------------
#
# Vendors the gateway serves on its own origin — `tool-gateway`, rather than a
# `{vendor}-gateway` host — are pinned HERE, in code, the same way every other
# managed vendor's gateway URL is pinned: adding one is a Hermes release, and
# the exact URL a user's agent may connect to is reviewable in this file. A
# runtime discovery catalog was tried and deliberately removed — a remote
# endpoint that can add tools to every entitled install is a bigger trust
# surface than a code diff.
#
# The gateway exposes a Nous-owned REST contract per vendor; it names the
# vendor but not the vendor's own API, so nothing here needs to know the
# upstream's endpoint or field names.

def managed_gateway_origin() -> Optional[str]:
    """Origin for the shared managed gateway host, ``tool-gateway``.

    This serves the vendors the gateway hosts on its own origin under
    ``/api/{vendor}`` plus the media upload endpoints. It is NOT where the
    connectors API lives — see :func:`connector_gateway_origin`.

    Honors the same overrides as vendor hosts: ``TOOL_GATEWAY_URL`` pins the
    full origin (the local harness sets ``http://127.0.0.1:3009``), and
    ``TOOL_GATEWAY_SCHEME`` / ``TOOL_GATEWAY_DOMAIN`` reshape the default
    ``tool-gateway.<domain>``.

    ADDRESS ONLY. Every override here still steers where requests go; whether
    the origin also earns the bearer is :func:`_bearer_is_allowed`'s call.
    ``None`` when ``TOOL_GATEWAY_SCHEME`` is misconfigured, so callers need no
    try/except of their own.
    """
    resolved = _MANAGED_VENDOR_SURFACE.resolve()
    return resolved.origin if resolved is not None else None


def connector_gateway_origin() -> Optional[str]:
    """Origin for the connectors API host, ``connector-gateway``.

    The connectors API is its own deployment with its own canonical host, so it
    gets its own override key — ``CONNECTOR_GATEWAY_URL`` — rather than riding
    on the media host's. ``TOOL_GATEWAY_SCHEME`` / ``TOOL_GATEWAY_DOMAIN``
    reshape the default ``connector-gateway.<domain>`` the same way they
    reshape every other gateway host.

    ADDRESS ONLY, and ``None`` on a misconfigured scheme, exactly as
    :func:`managed_gateway_origin`.
    """
    resolved = _CONNECTOR_SURFACE.resolve()
    return resolved.origin if resolved is not None else None


def managed_vendor_base_path(vendor: str) -> str:
    """Base path for a managed vendor's REST routes on the gateway host."""
    return f"/api/{vendor}"


def managed_vendor_upload_path(vendor: str) -> str:
    """Media upload endpoint for a managed vendor, on the same host."""
    return f"/api/uploads/{vendor}"


def managed_vendor_endpoints(vendor: str) -> Optional[dict]:
    """Absolute URLs for a managed vendor, or ``None`` when none resolves.

    Address resolution only: entitlement is deliberately not consulted here.
    What an account may spend on a managed vendor is the gateway's own
    decision, stated in its refusals, and re-deciding it on the client can only
    ever disagree with the server. A caller that wants to hide its tools from
    users who could not call them at all does that in its ``check_fn``.

    The bearer gate is likewise not consulted: an untrusted origin still has an
    address, and the caller finds out it earns no token when
    :func:`managed_gateway_auth_headers` comes back empty.

    ``None`` means no origin could be resolved — a misconfigured
    ``TOOL_GATEWAY_SCHEME`` — so there is nothing to call.
    """
    origin = (managed_gateway_origin() or "").rstrip("/")
    if not origin:
        return None

    return {
        "origin": origin,
        "base_url": f"{origin}{managed_vendor_base_path(vendor)}",
        "upload_path": managed_vendor_upload_path(vendor),
    }


def is_managed_nous_gateway_url(url: object) -> bool:
    """True when ``url`` is on a first-party gateway origin that is trusted.

    Two origins qualify — the media/on-origin-vendor host and the connectors
    host — and the URL is matched to ONE of them before trust is decided, so
    each surface is judged on its own provenance. A trusted media host never
    lends its trust to a connectors URL, or the reverse.

    Anything granting a URL extra trust — our bearer, reading files off disk to
    upload — must gate on this rather than on a name, so an arbitrary URL can
    never inherit that trust.

    What a ``False`` actually does, in all three consumers (none of them sends
    an unauthenticated request):

    * the connectors client refuses before the wire, raising ``GatewayAuthError``
      ("no portal access token available") so the dispatch reports a gateway
      failure instead of a 401;
    * the managed media tool renders its sign-in message to the model in place
      of the call;
    * the media uploader is never built at all, so the owning tool refuses
      local file paths and asks for a URL.

    So a bad override fails loudly and early rather than handing the token to
    whatever the environment names.
    """
    actual = _origin_key(url)
    if actual is None:
        # Not an http(s) origin at all — nothing to compare, and no reason to
        # warn about the gateway's own configuration.
        return False

    for surface in _FIRST_PARTY_GATEWAY_SURFACES:
        resolved = surface.resolve()
        if resolved is None or actual != _origin_key(resolved.origin):
            continue
        # Trust is asked only of the surface this URL actually belongs to, so
        # the warn-once line names the origin being refused rather than an
        # unrelated one that happens to be misconfigured.
        return _bearer_is_allowed(resolved, surface.log_label)

    return False


def managed_gateway_auth_headers(
    url: object,
    token_reader: Optional[Callable[[], Optional[str]]] = None,
) -> dict:
    """Live auth headers for a managed gateway URL, or ``{}`` when not managed.

    Read fresh on every call rather than cached: a Nous access token expires
    within the hour, and a long session would otherwise keep presenting a dead
    bearer. Returns ``{}`` rather than raising when no token is available, so a
    caller can report "sign in" instead of sending an unauthenticated request.
    """
    if not is_managed_nous_gateway_url(url):
        return {}

    resolved_token_reader = token_reader or read_nous_access_token
    try:
        token = resolved_token_reader()
    except Exception as exc:  # pragma: no cover — defensive
        logger.debug("Managed gateway token read failed for %s: %s", url, exc)
        return {}
    if not isinstance(token, str) or not token.strip():
        return {}

    return {"Authorization": f"Bearer {token.strip()}"}


# ---------------------------------------------------------------------------
# Managed media uploads
# ---------------------------------------------------------------------------
#
# Media arguments used to be inlined as base64, which capped a whole tool call
# at ~2MB of real bytes under the gateway's request ceiling and ruled out video
# entirely. Each pinned managed server carries an upload endpoint
# (`upload_path`); the bytes go straight to storage via a presigned URL, and
# the tool argument carries an opaque `nous-upload:<token>` reference instead.
#
# The protocol lives HERE rather than in a vendor tool module: the presign
# request shape, the response contract, and the `nous-upload:` scheme are Nous
# gateway specifics shared by every managed vendor that takes media.

_MEDIA_UPLOAD_PRESIGN_TIMEOUT_SECONDS = 15.0
# The PUT carries up to 50MB of video; a flat 60s would fail a legitimate
# clip on an ordinary residential uplink, so only the write phase is long.
_MEDIA_UPLOAD_PUT_READ_TIMEOUT_SECONDS = 60.0
_MEDIA_UPLOAD_PUT_WRITE_TIMEOUT_SECONDS = 300.0


def _describe_media_upload_refusal(response) -> str:
    """A model-actionable reason from a gateway refusal, or a generic one.

    The gateway's 4xx bodies carry deliberate guidance (rate-limit waits, size
    caps, "you could not submit anyway"), so surface `error.message` verbatim
    rather than a bare status code.
    """
    try:
        payload = response.json()
        message = payload.get("error", {}).get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()
    except Exception:
        pass
    return f"the gateway refused the upload (HTTP {response.status_code})"


def build_managed_media_uploader(
    server_url: object,
    upload_path: object,
    token_reader: Optional[Callable[[], Optional[str]]] = None,
) -> Optional[Callable]:
    """Async ``(data, mime) -> argument value`` uploader for one managed vendor.

    Returns ``None`` when there is no usable upload endpoint (not a managed
    Nous URL, or no ``upload_path``); callers then refuse local paths with a
    clear message instead of silently forwarding them.

    The three steps of the protocol:

    1. POST ``origin + upload_path`` with the declared content type and exact
       byte length, using the same live auth headers as the vendor calls.
       The gateway answers with a presigned single-object PUT URL (short
       expiry; type and length are signed into it) and an upload token.
    2. PUT the bytes to that URL. This goes directly to storage — never
       through the gateway — which is what removes the request-size ceiling.
    3. Return ``nous-upload:<token>`` for the tool argument. The token is
       bound to this Nous principal and is redeemable only through the
       gateway, so it is inert anywhere else it might end up.
    """
    if not is_managed_nous_gateway_url(server_url):
        return None
    if not isinstance(upload_path, str) or not upload_path.startswith("/"):
        return None

    parts = urlsplit(str(server_url).strip())
    origin = f"{parts.scheme}://{parts.netloc}"
    presign_url = f"{origin}{upload_path}"

    async def upload(data: bytes, mime: str) -> str:
        import httpx

        from tools.url_safety import create_ssrf_safe_async_client

        headers = managed_gateway_auth_headers(server_url, token_reader)
        if not headers:
            raise RuntimeError("no Nous credential is available for the upload")

        # Two clients on purpose, split by whose address we are trusting.
        #
        # The presign POST goes to `presign_url`, which is entirely determined
        # by the managed gateway origin (already validated by
        # is_managed_nous_gateway_url) plus the pinned upload_path — the same
        # first-party host the vendor calls go to freely. SSRF-guarding it
        # protects against nothing and would reject a local gateway on
        # 127.0.0.1, so it uses a plain client. The PUT target, by contrast, is
        # a URL the gateway *returned*, so it keeps the SSRF-safe client as
        # defense in depth (real presigned URLs are public R2, which it allows).
        presign_timeout = httpx.Timeout(_MEDIA_UPLOAD_PRESIGN_TIMEOUT_SECONDS)
        async with httpx.AsyncClient(timeout=presign_timeout) as client:
            presign = await client.post(
                presign_url,
                headers=headers,
                json={"contentType": mime, "contentLength": len(data)},
            )
        if presign.status_code != 200:
            raise RuntimeError(_describe_media_upload_refusal(presign))

        try:
            payload = presign.json()
        except Exception:
            payload = None
        upload_url = payload.get("uploadUrl") if isinstance(payload, dict) else None
        token = payload.get("token") if isinstance(payload, dict) else None
        if not (isinstance(upload_url, str) and upload_url and isinstance(token, str) and token):
            raise RuntimeError("the gateway's upload response was malformed")

        put_timeout = httpx.Timeout(
            _MEDIA_UPLOAD_PRESIGN_TIMEOUT_SECONDS,
            read=_MEDIA_UPLOAD_PUT_READ_TIMEOUT_SECONDS,
            write=_MEDIA_UPLOAD_PUT_WRITE_TIMEOUT_SECONDS,
        )
        async with create_ssrf_safe_async_client(timeout=put_timeout) as client:
            # The presigned URL signs the exact Content-Type and Content-Length,
            # so this PUT must send precisely what was declared above.
            put = await client.put(upload_url, content=data, headers={"Content-Type": mime})
        if put.status_code != 200:
            raise RuntimeError(f"storage refused the upload (HTTP {put.status_code})")

        return f"nous-upload:{token}"

    return upload

