"""OpenTUI build freshness and transactional runtime packaging.

This module is deliberately independent from :mod:`hermes_cli.main`.  The CLI
owns Node selection and user-facing fallback policy; this module owns the
cohesive filesystem/npm mechanics and accepts the CLI's bounded subprocess
runner as a dependency.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import platform
import shutil
import stat
import subprocess
import tempfile
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path


logger = logging.getLogger(__name__)

BUILD_INPUT_DIRS = ("src",)
BUILD_INPUT_FILES = (
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "scripts/build.mjs",
)
OPTIONAL_BUILD_INPUT_FILES = (".npmrc",)
DEPENDENCY_INPUT_FILES = ("package.json", "package-lock.json")
DEPENDENCY_STAMP = ".hermes-opentui-dependencies.sha256"
BUILD_INPUT_SUFFIXES = frozenset({
    ".cjs",
    ".js",
    ".jsx",
    ".json",
    ".mjs",
    ".ts",
    ".tsx",
})
COMMAND_IDLE_TIMEOUT_SECONDS = 180
FAILURE_BACKOFF_SECONDS = 300
FAILED_REFRESH_FILE = "failed-refresh.json"
FAILED_REFRESH_DIR = "failed-refresh"
PACKAGED_SEED_SCHEMA = 1
PACKAGED_SEED_STAMP = ".hermes-opentui-packaged-seed.json"

BUILD_TOOLCHAIN_PACKAGES = (
    "@babel/core",
    "@babel/preset-typescript",
    "babel-preset-solid",
    "esbuild",
)

Runner = Callable[..., subprocess.CompletedProcess]


@dataclass(frozen=True)
class NodeIdentity:
    """Identity reported by the exact Node executable selected for OpenTUI."""

    executable: str
    version: str
    platform: str
    arch: str


@dataclass(frozen=True)
class RuntimeInspection:
    """One coherent freshness/payload decision for launch or update policy."""

    payload_present: bool
    dependencies_current: bool
    bundle_stale: bool
    dependency_refresh_required: bool
    refresh_required: bool


@dataclass(frozen=True)
class PackagedSeed:
    """Immutable OpenTUI build inputs shipped beside an installed Python package."""

    source_dir: Path
    source_key: str
    input_digest: str
    bundle_digest: str
    fingerprint: str


@dataclass(frozen=True)
class RuntimeLocation:
    """Selected source seed and writable runtime root for this installation."""

    seed_dir: Path
    runtime_dir: Path
    packaged_seed: PackagedSeed | None = None

    @property
    def is_packaged(self) -> bool:
        return self.packaged_seed is not None


@dataclass(frozen=True)
class _PromotionEntry:
    """One live destination and its retained predecessor."""

    destination: Path
    backup: Path
    had_previous: bool


class PromotionTransaction:
    """A promoted runtime generation awaiting caller validation.

    Promotion is intentionally two-phase: filesystem swaps make the candidate
    live, but its predecessor remains beside it until the caller validates the
    complete generation. ``commit`` discards that predecessor; ``rollback``
    restores it (or removes a first-install destination that had no predecessor).
    """

    def __init__(self, entries: tuple[_PromotionEntry, ...]) -> None:
        self._entries = tuple(entries)
        self._active = True

    @property
    def active(self) -> bool:
        return self._active

    def commit(self) -> None:
        """Accept the promoted generation and discard retained predecessors."""
        if not self._active:
            return
        for entry in self._entries:
            try:
                _remove_path(entry.backup)
            except (OSError, shutil.Error):
                # The live generation is already validated. Leaving a backup is
                # safe: the next locked launch prunes it as promotion debris.
                logger.debug(
                    "Could not remove committed OpenTUI predecessor %s", entry.backup
                )
        self._active = False

    def rollback(self) -> None:
        """Restore every predecessor as one coherent generation."""
        if not self._active:
            return

        # Validate every required predecessor before touching the candidate. A
        # damaged transaction must fail without deleting its only runnable copy.
        for entry in self._entries:
            if entry.had_previous and not (
                entry.backup.exists() or entry.backup.is_symlink()
            ):
                raise FileNotFoundError(
                    f"OpenTUI promotion predecessor is missing: {entry.backup}"
                )

        # Remove the candidate generation first. If removal fails, all retained
        # predecessors remain available to crash recovery.
        for entry in self._entries:
            _remove_path(entry.destination)

        restored: list[_PromotionEntry] = []
        try:
            for entry in self._entries:
                if not entry.had_previous:
                    continue
                if not (entry.backup.exists() or entry.backup.is_symlink()):
                    raise FileNotFoundError(
                        f"OpenTUI promotion predecessor is missing: {entry.backup}"
                    )
                os.replace(entry.backup, entry.destination)
                restored.append(entry)
        except BaseException:
            # Keep the on-disk state recoverable as a set of backups rather than
            # exposing a partially restored paired generation.
            for entry in reversed(restored):
                if entry.destination.exists() or entry.destination.is_symlink():
                    os.replace(entry.destination, entry.backup)
            raise
        self._active = False


PromotionResult = tuple[bool, subprocess.CompletedProcess, PromotionTransaction | None]


def probe_node_identity(node_bin: str) -> NodeIdentity | None:
    """Ask the selected Node process for its platform, architecture, and version.

    This deliberately is not cached. Managed Node installations can replace an
    executable in place while a long-lived dashboard process is still running;
    every promotion decision must therefore fence against the process that will
    actually launch OpenTUI, not an earlier process that occupied the same path.
    """
    expression = (
        "JSON.stringify({version:process.version,platform:process.platform,"
        "arch:process.arch})"
    )
    try:
        result = subprocess.run(
            [node_bin, "-p", expression],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if result.returncode != 0:
            return None
        payload = json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    version = payload.get("version")
    node_platform = payload.get("platform")
    arch = payload.get("arch")
    if not all(
        isinstance(value, str) and value for value in (version, node_platform, arch)
    ):
        return None
    try:
        executable = str(Path(node_bin).expanduser().resolve())
    except OSError:
        executable = str(Path(node_bin).expanduser())
    return NodeIdentity(
        executable=executable,
        version=version,
        platform=node_platform,
        arch=arch,
    )


def _refresh_lock_path(app_dir: Path, lock_root: Path | None = None) -> Path:
    """Return a resource-adjacent lock path shared across temp namespaces."""
    if lock_root is None:
        # TMPDIR and /tmp namespaces differ between interactive shells,
        # systemd PrivateTmp services, and macOS launch sessions. Anchor the
        # lock beside the mutable runtime so every process that can promote it
        # necessarily resolves the same inode. The repository-level .hermes/
        # directory is gitignored for source checkouts; installed runtimes
        # already live below the profile-private cache.
        lock_root = app_dir.parent / ".hermes" / "opentui-runtime-locks"
    lock_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        lock_root.chmod(0o700)
    except OSError:
        pass
    try:
        resolved = str(app_dir.resolve())
    except OSError:
        resolved = str(app_dir.absolute())
    name = hashlib.sha256(resolved.encode("utf-8")).hexdigest()
    return lock_root / f"{name}.lock"


@contextmanager
def refresh_lock(app_dir: Path, *, lock_root: Path | None = None) -> Iterator[None]:
    """Serialize refresh/promotion across processes for one OpenTUI checkout.

    OpenTUI is unsupported on Windows, so its mutation path is POSIX-only. The
    no-op non-POSIX branch keeps import-time helpers portable without implying a
    cross-process guarantee on an unsupported runtime.
    """
    if os.name != "posix":
        yield
        return

    import fcntl

    lock_path = _refresh_lock_path(app_dir, lock_root)
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(lock_path, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "a+b", closefd=False) as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        os.close(fd)


def refresh_failure_key(app_dir: Path, digest: str, identity: NodeIdentity) -> str:
    """Key a failed attempt by inputs, exact Node, and Node-reported platform."""
    try:
        resolved_app = str(app_dir.resolve())
    except OSError:
        resolved_app = str(app_dir.absolute())
    payload = {
        "app": resolved_app,
        "digest": digest,
        "node": identity.executable,
        "node_version": identity.version,
        "platform": identity.platform,
        "arch": identity.arch,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def refresh_backoff_remaining(
    state_dir: Path,
    key: str,
    *,
    now: float | None = None,
    retry_seconds: int = FAILURE_BACKOFF_SECONDS,
) -> float:
    """Seconds left before retrying this exact failed refresh, or zero."""
    marker_name = hashlib.sha256(key.encode("utf-8")).hexdigest() + ".json"
    payload = None
    for marker in (
        state_dir / FAILED_REFRESH_DIR / marker_name,
        state_dir / FAILED_REFRESH_FILE,
    ):
        try:
            candidate = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        if (
            isinstance(candidate, dict)
            and candidate.get("schema") == 1
            and candidate.get("key") == key
        ):
            payload = candidate
            break
    if payload is None:
        return 0.0
    try:
        failed_at = float(payload["failed_at"])
    except (ValueError, TypeError, KeyError):
        return 0.0
    current = time.time() if now is None else now
    age = current - failed_at
    # A future timestamp (clock rollback/corruption) cannot suppress retries
    # indefinitely. Any valid marker expires within retry_seconds.
    if age < 0 or age >= retry_seconds:
        return 0.0
    return retry_seconds - age


def record_refresh_failure(
    state_dir: Path, key: str, *, now: float | None = None
) -> bool:
    """Best-effort atomic write of the internal failed-refresh marker."""
    try:
        state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            state_dir.chmod(0o700)
        except OSError:
            pass
        marker_dir = state_dir / FAILED_REFRESH_DIR
        marker_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            marker_dir.chmod(0o700)
        except OSError:
            pass
        failed_at = time.time() if now is None else now
        # Keys include source inputs, so edits/upgrades intentionally create a
        # new marker. Reap only expired/corrupt siblings; active markers for
        # other installations sharing this profile remain independent.
        for old_marker in marker_dir.glob("*.json"):
            try:
                old_payload = json.loads(old_marker.read_text(encoding="utf-8"))
                old_failed_at = float(old_payload["failed_at"])
                expired = (
                    old_failed_at > failed_at
                    or failed_at - old_failed_at >= FAILURE_BACKOFF_SECONDS
                )
            except (
                OSError,
                ValueError,
                TypeError,
                KeyError,
                json.JSONDecodeError,
            ):
                expired = True
            if expired:
                old_marker.unlink(missing_ok=True)
        payload = {
            "schema": 1,
            "key": key,
            "failed_at": failed_at,
        }
        marker_name = hashlib.sha256(key.encode("utf-8")).hexdigest() + ".json"
        fd, temporary = tempfile.mkstemp(
            prefix=".failed-refresh-", dir=str(marker_dir)
        )
        temporary_path = Path(temporary)
        try:
            os.fchmod(fd, 0o600)
            handle = os.fdopen(fd, "w", encoding="utf-8")
            fd = -1
            with handle:
                json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, marker_dir / marker_name)
        finally:
            if fd >= 0:
                os.close(fd)
            temporary_path.unlink(missing_ok=True)
    except OSError:
        return False
    return True


def clear_refresh_failure(state_dir: Path, key: str | None = None) -> None:
    """Best-effort removal after a successful refresh of this exact target."""
    try:
        if key is not None:
            marker_name = hashlib.sha256(key.encode("utf-8")).hexdigest() + ".json"
            marker_dir = state_dir / FAILED_REFRESH_DIR
            (marker_dir / marker_name).unlink(missing_ok=True)
            try:
                marker_dir.rmdir()
            except OSError:
                pass
        # Clean the pre-v1 singleton only when it belongs to this target.
        legacy = state_dir / FAILED_REFRESH_FILE
        if key is not None and legacy.is_file():
            try:
                payload = json.loads(legacy.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                payload = None
            if isinstance(payload, dict) and payload.get("key") == key:
                legacy.unlink(missing_ok=True)
    except OSError:
        pass


def dependency_digest(root: Path) -> str | None:
    """Hash the exact package manifest + lock that produced node_modules."""
    digest = hashlib.sha256()
    for rel in DEPENDENCY_INPUT_FILES:
        try:
            payload = (root / rel).read_bytes()
        except OSError:
            return None
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return digest.hexdigest()


def _installed_lock_matches(root: Path, identity: NodeIdentity) -> bool:
    """Validate an un-stamped legacy install without contacting the network.

    npm's hidden ``node_modules/.package-lock.json`` describes what is actually
    installed. Compare every required entry with the checked-in lock and verify
    the on-disk package versions. Missing platform-optional entries are allowed.
    This one-time path lets existing install/Docker runtimes acquire the new
    stamp offline instead of attempting ``npm ci`` on every launch.
    """
    try:
        package = json.loads((root / "package.json").read_text(encoding="utf-8"))
        expected_lock = json.loads(
            (root / "package-lock.json").read_text(encoding="utf-8")
        )
        installed_lock = json.loads(
            (root / "node_modules" / ".package-lock.json").read_text(encoding="utf-8")
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False

    if not all(
        isinstance(value, dict) for value in (package, expected_lock, installed_lock)
    ):
        return False

    expected_packages = expected_lock.get("packages")
    installed_packages = installed_lock.get("packages")
    if not isinstance(expected_packages, dict) or not isinstance(
        installed_packages, dict
    ):
        return False
    if expected_lock.get("lockfileVersion") != installed_lock.get("lockfileVersion"):
        return False

    root_lock_entry = expected_packages.get("")
    if not isinstance(root_lock_entry, dict):
        return False
    for section in ("dependencies", "devDependencies", "optionalDependencies"):
        if package.get(section, {}) != root_lock_entry.get(section, {}):
            return False

    # npm ci removes extraneous packages. Requiring the hidden lock to remain a
    # subset of the checked-in lock catches a runtime from another graph.
    if any(path not in expected_packages for path in installed_packages):
        return False

    for package_path, expected in expected_packages.items():
        if package_path == "" or not isinstance(expected, dict):
            continue
        if expected.get("dev") is True:
            # Runtime validity is independent from the build toolchain. Docker
            # intentionally prunes dev packages after emitting dist/main.js.
            continue
        installed = installed_packages.get(package_path)
        if installed is None:
            if expected.get("optional") is True:
                continue
            return False
        if not isinstance(installed, dict):
            return False
        for field in ("version", "integrity"):
            if expected.get(field) != installed.get(field):
                return False

        expected_version = expected.get("version")
        if expected_version is not None:
            try:
                installed_manifest = json.loads(
                    (root / package_path / "package.json").read_text(encoding="utf-8")
                )
            except (OSError, UnicodeError, json.JSONDecodeError):
                return False
            if not isinstance(installed_manifest, dict):
                return False
            if installed_manifest.get("version") != expected_version:
                return False

    return runtime_sentinels_current(root, identity)


def selected_native_package_name(
    identity: NodeIdentity, *, env: dict[str, str] | None = None
) -> str | None:
    """Return the native package chosen by the exact selected Node process."""
    if identity.arch not in {"x64", "arm64"}:
        return None
    if node_platform := {
        "darwin": "darwin",
        "linux": "linux",
        "win32": "win32",
    }.get(identity.platform):
        suffix = ""
        if node_platform == "linux":
            libc = linux_libc_name(env=env)
            if libc is None:
                return None
            if libc == "musl":
                suffix = "-musl"
        return f"@opentui/core-{node_platform}-{identity.arch}{suffix}"
    return None


def linux_libc_name(*, env: dict[str, str] | None = None) -> str | None:
    """Mirror OpenTUI's Linux libc selection, including musl auto-detection."""
    current_env = os.environ if env is None else env
    override = (current_env.get("OPENTUI_LIBC") or "").strip().lower()
    if override:
        return override if override in {"glibc", "musl"} else None

    libc_name = (platform.libc_ver()[0] or "").strip().lower()
    if "musl" in libc_name:
        return "musl"
    if libc_name in {"glibc", "gnu libc", "libc"}:
        return "glibc"
    if Path("/etc/alpine-release").is_file():
        return "musl"
    try:
        if any(Path("/lib").glob("ld-musl-*.so.1")):
            return "musl"
    except OSError:
        pass
    # OpenTUI's non-musl Linux package is the conservative default, matching
    # Node/native package conventions on mainstream distributions.
    return "glibc"


def _manifest_version(root: Path, package_name: str) -> str | None:
    try:
        manifest = json.loads(
            (root / "node_modules" / package_name / "package.json").read_text(
                encoding="utf-8"
            )
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(manifest, dict):
        return None
    version = manifest.get("version")
    return version if isinstance(version, str) else None


def runtime_payload_present(root: Path, identity: NodeIdentity) -> bool:
    """Version-independent guard for whether a prior bundle is safe to launch."""
    try:
        package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False

    if not isinstance(package, dict):
        return False
    direct_dependencies = package.get("dependencies", {})
    if not isinstance(direct_dependencies, dict):
        return False
    if not direct_dependencies:
        return False
    for package_name in direct_dependencies:
        if _manifest_version(root, package_name) is None:
            return False

    native_name = selected_native_package_name(identity)
    if native_name is None:
        return False
    try:
        core_manifest = json.loads(
            (root / "node_modules" / "@opentui" / "core" / "package.json").read_text(
                encoding="utf-8"
            )
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    if not isinstance(core_manifest, dict):
        return False
    optional_dependencies = core_manifest.get("optionalDependencies", {})
    if not isinstance(optional_dependencies, dict):
        return False
    if native_name not in optional_dependencies:
        return False
    if _manifest_version(root, native_name) is None:
        return False
    native_dir = root / "node_modules" / native_name
    for pattern in ("*.so", "*.dylib", "*.dll"):
        for path in native_dir.rglob(pattern):
            try:
                if path.is_file() and path.stat().st_size > 0:
                    return True
            except OSError:
                continue
    return False


def runtime_sentinels_current(
    root: Path,
    identity: NodeIdentity,
    *,
    payload_present: bool | None = None,
) -> bool:
    """Validate current-lock versions after the payload-presence fast guard."""
    if payload_present is None:
        payload_present = runtime_payload_present(root, identity)
    if not payload_present:
        return False
    try:
        package = json.loads((root / "package.json").read_text(encoding="utf-8"))
        lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    if not isinstance(package, dict) or not isinstance(lock, dict):
        return False
    packages = lock.get("packages")
    if not isinstance(packages, dict):
        return False
    direct_dependencies = package.get("dependencies", {})
    if not isinstance(direct_dependencies, dict):
        return False
    for package_name in direct_dependencies:
        expected = packages.get(f"node_modules/{package_name}")
        if not isinstance(expected, dict):
            return False
        expected_version = expected.get("version")
        if not isinstance(expected_version, str):
            return False
        if _manifest_version(root, package_name) != expected_version:
            return False

    native_name = selected_native_package_name(identity)
    if native_name is None:
        return False
    try:
        core_manifest = json.loads(
            (root / "node_modules" / "@opentui" / "core" / "package.json").read_text(
                encoding="utf-8"
            )
        )
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    if not isinstance(core_manifest, dict):
        return False
    optional_dependencies = core_manifest.get("optionalDependencies", {})
    if not isinstance(optional_dependencies, dict):
        return False
    expected_native_version = optional_dependencies.get(native_name)
    return (
        isinstance(expected_native_version, str)
        and _manifest_version(root, native_name) == expected_native_version
    )


def build_toolchain_available(root: Path) -> bool:
    """Whether the exact dev packages imported by scripts/build.mjs exist."""
    try:
        lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    if not isinstance(lock, dict):
        return False
    packages = lock.get("packages")
    if not isinstance(packages, dict):
        return False
    for package_name in BUILD_TOOLCHAIN_PACKAGES:
        expected = packages.get(f"node_modules/{package_name}")
        if not isinstance(expected, dict):
            return False
        expected_version = expected.get("version")
        if not isinstance(expected_version, str):
            return False
        if _manifest_version(root, package_name) != expected_version:
            return False
    return True


def _write_dependency_stamp(root: Path, digest: str) -> None:
    node_modules = root / "node_modules"
    stamp = node_modules / DEPENDENCY_STAMP
    fd, temporary = tempfile.mkstemp(prefix=f".{DEPENDENCY_STAMP}-", dir=node_modules)
    temporary_path = Path(temporary)
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, "w", encoding="ascii") as handle:
            fd = -1
            handle.write(f"{digest}\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, stamp)
    finally:
        if fd >= 0:
            os.close(fd)
        temporary_path.unlink(missing_ok=True)


def dependencies_current(
    root: Path,
    identity: NodeIdentity,
    *,
    sentinels_current: bool | None = None,
) -> bool:
    """Whether node_modules is proven to match package.json + package-lock."""
    if not dependencies_current_readonly(
        root, identity, sentinels_current=sentinels_current
    ):
        return False
    digest = dependency_digest(root)
    if digest is None:
        return False
    stamp = root / "node_modules" / DEPENDENCY_STAMP
    try:
        if stamp.read_text(encoding="ascii").strip() == digest:
            return True
    except (OSError, UnicodeError):
        pass
    try:
        _write_dependency_stamp(root, digest)
    except OSError:
        # A read-only packaged install is still verified for this process. It
        # repeats the cheap local validation next launch, never contacts npm.
        logger.debug("Could not bootstrap OpenTUI dependency stamp in %s", root)
    return True


def dependencies_current_readonly(
    root: Path,
    identity: NodeIdentity,
    *,
    sentinels_current: bool | None = None,
) -> bool:
    """Read-only dependency validation for immutable packaged runtimes."""
    if not (root / "node_modules" / "@opentui").is_dir():
        return False
    if sentinels_current is None:
        sentinels_current = runtime_sentinels_current(root, identity)
    if not sentinels_current:
        return False
    digest = dependency_digest(root)
    if digest is None:
        return False

    stamp = root / "node_modules" / DEPENDENCY_STAMP
    try:
        stamped_digest = stamp.read_text(encoding="ascii").strip()
    except (OSError, UnicodeError):
        stamped_digest = ""
    if stamped_digest:
        return stamped_digest == digest
    return _installed_lock_matches(root, identity)


def _iter_build_inputs(root: Path) -> Iterator[Path]:
    """Yield runtime source/config inputs for ``dist/main.js``."""
    for rel in (*BUILD_INPUT_FILES, *OPTIONAL_BUILD_INPUT_FILES):
        path = root / rel
        if path.is_file():
            yield path

    for rel in BUILD_INPUT_DIRS:
        base = root / rel
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or path.suffix not in BUILD_INPUT_SUFFIXES:
                continue
            relative = path.relative_to(base)
            if relative.parts and relative.parts[0] == "test":
                continue
            yield path


def _iter_build_input_directories(root: Path) -> Iterator[Path]:
    """Yield runtime source dirs whose mtimes expose deletions and renames."""
    for rel in BUILD_INPUT_DIRS:
        base = root / rel
        if not base.is_dir():
            continue
        for dirpath, dirnames, _filenames in os.walk(base):
            current = Path(dirpath)
            if current == base:
                dirnames[:] = [name for name in dirnames if name != "test"]
            yield current


def refresh_digest(root: Path) -> str | None:
    """Content digest for backoff invalidation across every build input."""
    digest = hashlib.sha256()
    for rel in BUILD_INPUT_FILES:
        path = root / rel
        if not path.is_file():
            digest.update(f"missing:{rel}".encode("utf-8"))

    source_root = root / "src"
    if not source_root.is_dir():
        digest.update(b"missing:src")

    paths = sorted(
        set(_iter_build_inputs(root)),
        key=lambda path: path.relative_to(root).as_posix(),
    )
    for path in paths:
        relative = path.relative_to(root).as_posix().encode("utf-8")
        try:
            payload = path.read_bytes()
        except OSError:
            return None
        digest.update(b"file\0")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return digest.hexdigest()


def _file_digest(path: Path) -> str | None:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _nonempty_file(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def bundle_payload_present(root: Path) -> bool:
    """Whether the production entry bundle exists and contains bytes."""
    return _nonempty_file(root / "dist" / "main.js")


def launch_argv(node_bin: str, root: Path) -> list[str]:
    """Return the production Node argv for one validated runtime root."""
    bundle = root / "dist" / "main.js"
    if not bundle_payload_present(root):
        raise FileNotFoundError(f"OpenTUI runtime bundle is missing or empty: {bundle}")
    return [
        node_bin,
        "--experimental-ffi",
        "--no-warnings",
        "--expose-gc",
        str(bundle),
    ]


def packaged_seed(root: Path) -> PackagedSeed | None:
    """Fingerprint a complete immutable wheel/sdist OpenTUI seed."""
    if any(not (root / rel).is_file() for rel in BUILD_INPUT_FILES):
        return None
    if not (root / "src").is_dir():
        return None
    bundle = root / "dist" / "main.js"
    if not bundle_payload_present(root):
        return None

    input_digest = refresh_digest(root)
    bundle_digest = _file_digest(bundle)
    if input_digest is None or bundle_digest is None:
        return None
    try:
        source_path = str(root.resolve())
    except OSError:
        source_path = str(root.absolute())
    source_key = hashlib.sha256(source_path.encode("utf-8")).hexdigest()
    encoded = json.dumps(
        {
            "schema": PACKAGED_SEED_SCHEMA,
            "source": source_path,
            "inputs": input_digest,
            "bundle": bundle_digest,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    fingerprint = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    return PackagedSeed(
        source_dir=root,
        source_key=source_key,
        input_digest=input_digest,
        bundle_digest=bundle_digest,
        fingerprint=fingerprint,
    )


def select_runtime_location(
    project_root: Path, state_dir: Path
) -> RuntimeLocation | None:
    """Use checkout-local runtime for git sources, otherwise a writable cache."""
    seed_dir = project_root / "ui-opentui"
    git_marker = project_root / ".git"
    if git_marker.is_dir() or git_marker.is_file():
        return RuntimeLocation(seed_dir=seed_dir, runtime_dir=seed_dir)

    seed = packaged_seed(seed_dir)
    if seed is None:
        return None
    runtime_dir = state_dir / "artifacts" / seed.source_key / "runtime"
    return RuntimeLocation(
        seed_dir=seed_dir,
        runtime_dir=runtime_dir,
        packaged_seed=seed,
    )


def packaged_runtime_current(location: RuntimeLocation) -> bool:
    """Whether a cached runtime exactly matches its immutable packaged seed."""
    seed = location.packaged_seed
    if seed is None:
        return True
    stamp = location.runtime_dir / PACKAGED_SEED_STAMP
    try:
        payload = json.loads(stamp.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    if not isinstance(payload, dict):
        return False
    if (
        payload.get("schema") != PACKAGED_SEED_SCHEMA
        or payload.get("fingerprint") != seed.fingerprint
        or payload.get("source_key") != seed.source_key
        or payload.get("input_digest") != seed.input_digest
        or payload.get("seed_bundle_digest") != seed.bundle_digest
    ):
        return False
    if refresh_digest(location.runtime_dir) != seed.input_digest:
        return False
    runtime_bundle_digest = payload.get("runtime_bundle_digest")
    return (
        isinstance(runtime_bundle_digest, str)
        and bundle_payload_present(location.runtime_dir)
        and _file_digest(location.runtime_dir / "dist" / "main.js")
        == runtime_bundle_digest
    )


def _write_packaged_runtime_stamp(root: Path, seed: PackagedSeed) -> None:
    runtime_bundle_digest = _file_digest(root / "dist" / "main.js")
    if runtime_bundle_digest is None:
        raise FileNotFoundError("built OpenTUI runtime is missing dist/main.js")
    payload = {
        "schema": PACKAGED_SEED_SCHEMA,
        "fingerprint": seed.fingerprint,
        "source_key": seed.source_key,
        "input_digest": seed.input_digest,
        "seed_bundle_digest": seed.bundle_digest,
        "runtime_bundle_digest": runtime_bundle_digest,
    }
    stamp = root / PACKAGED_SEED_STAMP
    with stamp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    stamp.chmod(0o644)


def force_build_requested(*, env: dict[str, str] | None = None) -> bool:
    """Whether the explicit developer force-build switch is enabled."""
    current_env = os.environ if env is None else env
    force = (current_env.get("HERMES_TUI_FORCE_BUILD") or "").strip().lower()
    return force in {"1", "true", "yes", "on"}


def bundle_needs_rebuild(root: Path, *, env: dict[str, str] | None = None) -> bool:
    """Whether the production bundle is absent or older than its inputs."""
    if force_build_requested(env=env):
        return True

    # Deleted required configs must not make an old output look current merely
    # because there is no surviving input mtime to compare.
    if any(not (root / rel).is_file() for rel in BUILD_INPUT_FILES):
        return True

    output = root / "dist" / "main.js"
    try:
        output_stat = output.stat()
    except OSError:
        return True
    if not bundle_payload_present(root):
        return True
    output_mtime = output_stat.st_mtime

    for path in (*_iter_build_inputs(root), *_iter_build_input_directories(root)):
        try:
            if path.stat().st_mtime > output_mtime:
                return True
        except OSError:
            return True
    return False


def packaged_prebuilt_runtime_current(
    location: RuntimeLocation, identity: NodeIdentity
) -> bool:
    """Whether an immutable packaged seed can launch directly without hydration."""
    seed = location.packaged_seed
    if seed is None:
        return False
    root = seed.source_dir
    return dependencies_current_readonly(
        root, identity
    ) and not bundle_needs_rebuild(root, env={})


def needs_rebuild(
    root: Path,
    identity: NodeIdentity,
    *,
    env: dict[str, str] | None = None,
) -> bool:
    """Canonical runtime freshness check for dependencies and the bundle."""
    return not dependencies_current(root, identity) or bundle_needs_rebuild(
        root, env=env
    )


def inspect_runtime(
    root: Path,
    identity: NodeIdentity,
    *,
    rebuild_requested: bool = False,
    env: dict[str, str] | None = None,
) -> RuntimeInspection:
    """Inspect runtime state once; callers re-run this after taking the lock."""
    payload_present = runtime_payload_present(root, identity)
    sentinels_current = runtime_sentinels_current(
        root, identity, payload_present=payload_present
    )
    dependencies_are_current = dependencies_current(
        root, identity, sentinels_current=sentinels_current
    )
    bundle_stale = bundle_needs_rebuild(root, env=env)
    refresh_required = rebuild_requested or not dependencies_are_current or bundle_stale
    dependency_refresh_required = not dependencies_are_current or (
        refresh_required and not build_toolchain_available(root)
    )
    return RuntimeInspection(
        payload_present=payload_present,
        dependencies_current=dependencies_are_current,
        bundle_stale=bundle_stale,
        dependency_refresh_required=dependency_refresh_required,
        refresh_required=refresh_required,
    )


def npm_command(node_bin: str) -> list[str] | None:
    """Return the npm CLI paired with *node_bin*, never an ambient npm."""
    original = Path(node_bin).expanduser()
    try:
        resolved = original.resolve()
    except OSError:
        resolved = original

    prefixes: list[Path] = []
    for node_path in (resolved, original):
        prefix = node_path.parent.parent
        if prefix not in prefixes:
            prefixes.append(prefix)

    for prefix in prefixes:
        for rel in (
            "lib/node_modules/npm/bin/npm-cli.js",
            "node_modules/npm/bin/npm-cli.js",
            "share/nodejs/npm/bin/npm-cli.js",
        ):
            cli = prefix / rel
            if cli.is_file():
                return [node_bin, str(cli)]

    for node_path in (resolved, original):
        sibling = node_path.with_name("npm")
        if sibling.is_file() and os.access(sibling, os.X_OK):
            return [str(sibling)]
    return None


def build_environment(node_bin: str) -> dict[str, str]:
    """Environment for npm install/build with dev dependencies guaranteed."""
    env = os.environ.copy()
    for key in list(env):
        if key.lower() in {
            "node_env",
            "npm_config_include",
            "npm_config_omit",
            "npm_config_production",
        }:
            env.pop(key, None)

    original_bin = str(Path(node_bin).expanduser().parent)
    try:
        resolved_bin = str(Path(node_bin).expanduser().resolve().parent)
    except OSError:
        resolved_bin = original_bin
    path_parts = [resolved_bin]
    if original_bin != resolved_bin:
        path_parts.append(original_bin)
    inherited = env.get("PATH", "")
    if inherited:
        path_parts.append(inherited)
    env["PATH"] = os.pathsep.join(path_parts)
    env["CI"] = "1"
    env["npm_config_production"] = "false"
    env["npm_config_include"] = "dev"
    return env


def _remove_path(path: Path) -> None:
    """Remove a file/symlink/tree without following directory symlinks."""
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.exists():
        # copytree preserves immutable seed modes. Runtime/cache generations are
        # owned by the current user, but their nested directories can therefore
        # be 0555 and make shutil.rmtree fail while unlinking children. Restore
        # owner traversal/write bits without following package symlinks.
        try:
            path.chmod(stat.S_IMODE(path.stat().st_mode) | stat.S_IRWXU)
        except OSError:
            pass
        for directory, dirnames, _filenames in os.walk(path, followlinks=False):
            current = Path(directory)
            for name in dirnames:
                child = current / name
                if child.is_symlink():
                    continue
                try:
                    child.chmod(
                        stat.S_IMODE(child.stat().st_mode) | stat.S_IRWXU
                    )
                except OSError:
                    pass
        shutil.rmtree(path)


def _newest_directory(paths: Iterator[Path]) -> Path | None:
    candidates = []
    for path in paths:
        try:
            if path.is_dir():
                candidates.append((path.stat().st_mtime_ns, path.name, path))
        except OSError:
            continue
    return max(candidates, default=(0, "", None))[2]


def recover_interrupted_promotion(app_dir: Path) -> bool:
    """Restore backups left by a hard crash during an atomic-ish directory swap.

    Callers hold :func:`refresh_lock`. A full packaged-runtime swap can leave the
    root absent; a source-runtime two-directory swap can leave one new directory
    beside the old paired backups. In the latter case roll both directories back
    together so we never manufacture a mixed dependency/bundle generation.
    """
    recovered = False
    if not app_dir.exists():
        full_backup = _newest_directory(
            app_dir.parent.glob(f".{app_dir.name}.previous-*")
        )
        if full_backup is not None:
            os.replace(full_backup, app_dir)
            recovered = True

    if not app_dir.is_dir():
        return recovered

    node_prefix = ".node_modules.previous-"
    dist_prefix = ".dist.previous-"
    node_backups = {
        path.name.removeprefix(node_prefix): path
        for path in app_dir.glob(f"{node_prefix}*")
        if path.is_dir()
    }
    dist_backups = {
        path.name.removeprefix(dist_prefix): path
        for path in app_dir.glob(f"{dist_prefix}*")
        if path.is_dir()
    }
    paired = set(node_backups).intersection(dist_backups)
    if paired and (
        not (app_dir / "node_modules").is_dir() or not (app_dir / "dist").is_dir()
    ):
        suffix = max(
            paired,
            key=lambda value: max(
                node_backups[value].stat().st_mtime_ns,
                dist_backups[value].stat().st_mtime_ns,
            ),
        )
        _remove_path(app_dir / "node_modules")
        _remove_path(app_dir / "dist")
        node_restored = False
        try:
            os.replace(node_backups[suffix], app_dir / "node_modules")
            node_restored = True
            os.replace(dist_backups[suffix], app_dir / "dist")
        except BaseException:
            if node_restored and (app_dir / "node_modules").is_dir():
                os.replace(app_dir / "node_modules", node_backups[suffix])
            raise
        recovered = True

    if not (app_dir / "node_modules").is_dir() and (app_dir / "dist").is_dir():
        node_backup = _newest_directory(iter(node_backups.values()))
        if node_backup is not None:
            os.replace(node_backup, app_dir / "node_modules")
            recovered = True
    if not (app_dir / "dist").is_dir() and (app_dir / "node_modules").is_dir():
        dist_backup = _newest_directory(iter(dist_backups.values()))
        if dist_backup is not None:
            os.replace(dist_backup, app_dir / "dist")
            recovered = True
    return recovered


def promotion_backups_present(app_dir: Path) -> bool:
    """Whether a prior hard-killed promotion left a recoverable predecessor."""
    patterns = (
        (app_dir.parent, f".{app_dir.name}.previous-*"),
        (app_dir, ".node_modules.previous-*"),
        (app_dir, ".dist.previous-*"),
    )
    for parent, pattern in patterns:
        try:
            if next(parent.glob(pattern), None) is not None:
                return True
        except OSError:
            continue
    return False


def promotion_debris_present(app_dir: Path) -> bool:
    """Whether a prior promotion left a backup or abandoned staging tree."""
    if promotion_backups_present(app_dir):
        return True
    patterns = (
        (app_dir.parent, ".runtime-next-*"),
        (app_dir.parent, ".ui-opentui-update-*"),
        (app_dir, ".dist-next-*"),
    )
    for parent, pattern in patterns:
        try:
            if next(parent.glob(pattern), None) is not None:
                return True
        except OSError:
            continue
    return False


def prune_abandoned_staging(app_dir: Path) -> bool:
    """Remove hard-crash staging trees while the caller holds the refresh lock."""
    removed = False
    patterns = (
        (app_dir.parent, ".runtime-next-*"),
        (app_dir.parent, ".ui-opentui-update-*"),
        (app_dir, ".dist-next-*"),
    )
    for parent, pattern in patterns:
        for candidate in parent.glob(pattern):
            try:
                _remove_path(candidate)
                removed = True
            except (OSError, shutil.Error):
                logger.debug(
                    "Could not remove abandoned OpenTUI staging %s", candidate
                )
    return removed


def prune_obsolete_promotion_backups(
    app_dir: Path,
    *,
    full_root_current: bool = False,
    runtime_dirs_current: bool = False,
) -> bool:
    """Remove predecessors only after callers validate the live generation.

    Callers hold :func:`refresh_lock`. The explicit validation flags keep the
    sole recoverable predecessor intact when the replacement root or its paired
    ``node_modules``/``dist`` generation is absent, partial, or stale.
    """
    removed = False
    candidates: list[Path] = []
    if full_root_current and app_dir.is_dir():
        candidates.extend(app_dir.parent.glob(f".{app_dir.name}.previous-*"))
    if (
        runtime_dirs_current
        and (app_dir / "node_modules").is_dir()
        and (app_dir / "dist").is_dir()
    ):
        candidates.extend(app_dir.glob(".node_modules.previous-*"))
        candidates.extend(app_dir.glob(".dist.previous-*"))

    for candidate in candidates:
        try:
            _remove_path(candidate)
            removed = True
        except (OSError, shutil.Error):
            logger.debug(
                "Could not remove obsolete OpenTUI runtime backup %s", candidate
            )
    return removed


def _promote_directory(staged: Path, destination: Path) -> PromotionTransaction:
    """Swap one directory while retaining its predecessor for validation."""
    backup = destination.parent / f".{destination.name}.previous-{staged.name}"
    _remove_path(backup)
    had_previous = destination.exists() or destination.is_symlink()
    if had_previous:
        os.replace(destination, backup)
    try:
        os.replace(staged, destination)
    except BaseException:
        if had_previous and (backup.exists() or backup.is_symlink()):
            os.replace(backup, destination)
        raise
    entry = _PromotionEntry(
        destination=destination,
        backup=backup,
        had_previous=had_previous,
    )
    return PromotionTransaction((entry,))


def build_bundle(
    app_dir: Path,
    *,
    npm: list[str],
    env: dict[str, str],
    runner: Runner,
) -> PromotionResult:
    """Build into a staging directory and promote only a complete bundle."""
    base_command = [*npm, "run", "build"]
    source_digest = refresh_digest(app_dir)
    if source_digest is None:
        return (
            False,
            subprocess.CompletedProcess(
                base_command,
                1,
                stdout="",
                stderr="could not fingerprint OpenTUI build inputs",
            ),
            None,
        )
    try:
        staged_dist = Path(tempfile.mkdtemp(prefix=".dist-next-", dir=str(app_dir)))
    except OSError as exc:
        return (
            False,
            subprocess.CompletedProcess(
                base_command,
                1,
                stdout="",
                stderr=f"could not create bundle staging: {exc}",
            ),
            None,
        )
    command = [
        *base_command,
        "--",
        "src/entry/main.tsx",
        str(staged_dist),
    ]
    try:
        try:
            result = runner(
                command,
                cwd=app_dir,
                idle_timeout_seconds=COMMAND_IDLE_TIMEOUT_SECONDS,
                env=env,
            )
        except Exception as exc:
            return (
                False,
                subprocess.CompletedProcess(
                    command,
                    1,
                    stdout="",
                    stderr=f"build command failed: {exc}",
                ),
                None,
            )
        if result.returncode != 0:
            return False, result, None
        if not _nonempty_file(staged_dist / "main.js"):
            return (
                False,
                subprocess.CompletedProcess(
                    command,
                    1,
                    stdout=result.stdout,
                    stderr="build completed without a non-empty dist/main.js",
                ),
                None,
            )
        if refresh_digest(app_dir) != source_digest:
            return (
                False,
                subprocess.CompletedProcess(
                    command,
                    1,
                    stdout=result.stdout,
                    stderr="OpenTUI build inputs changed during compilation; retrying is safe",
                ),
                None,
            )
        try:
            promotion = _promote_directory(staged_dist, app_dir / "dist")
        except (OSError, shutil.Error) as exc:
            return (
                False,
                subprocess.CompletedProcess(
                    command,
                    1,
                    stdout=result.stdout,
                    stderr=f"could not promote OpenTUI bundle: {exc}",
                ),
                None,
            )
        return True, result, promotion
    finally:
        try:
            _remove_path(staged_dist)
        except (OSError, shutil.Error):
            logger.debug("Could not remove OpenTUI build staging %s", staged_dist)


def _copy_update_tree(app_dir: Path, staging: Path) -> None:
    """Copy only the standalone package inputs needed for npm ci + build."""
    for rel in BUILD_INPUT_FILES:
        source = app_dir / rel
        if not source.is_file():
            raise FileNotFoundError(f"missing OpenTUI build input: {source}")
        destination = staging / rel
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)

    source_tree = app_dir / "src"
    if not source_tree.is_dir():
        raise FileNotFoundError(f"missing OpenTUI source tree: {source_tree}")

    def ignore_tests(directory: str, names: list[str]) -> set[str]:
        if Path(directory) == source_tree and "test" in names:
            return {"test"}
        return set()

    shutil.copytree(source_tree, staging / "src", ignore=ignore_tests)

    npmrc = app_dir / ".npmrc"
    if npmrc.is_file():
        shutil.copy2(npmrc, staging / ".npmrc")


def promote_runtime(app_dir: Path, staging: Path) -> PromotionTransaction:
    """Promote a paired runtime while retaining both predecessors."""
    names = ("node_modules", "dist")
    for name in names:
        if not (staging / name).is_dir():
            raise FileNotFoundError(f"staged OpenTUI runtime is missing {name}")

    backups = {name: app_dir / f".{name}.previous-{staging.name}" for name in names}
    had_previous = {
        name: (app_dir / name).exists() or (app_dir / name).is_symlink()
        for name in names
    }
    promoted: list[str] = []
    try:
        for name in names:
            destination = app_dir / name
            backup = backups[name]
            _remove_path(backup)
            if had_previous[name]:
                os.replace(destination, backup)

        for name in names:
            os.replace(staging / name, app_dir / name)
            promoted.append(name)
    except BaseException:
        for name in promoted:
            _remove_path(app_dir / name)
        for name in reversed(names):
            backup = backups[name]
            if backup.exists() or backup.is_symlink():
                destination = app_dir / name
                _remove_path(destination)
                os.replace(backup, destination)
        raise

    return PromotionTransaction(
        tuple(
            _PromotionEntry(
                destination=app_dir / name,
                backup=backups[name],
                had_previous=had_previous[name],
            )
            for name in names
        )
    )


def _npm_ci_command(npm: list[str]) -> list[str]:
    return [
        *npm,
        "ci",
        "--include=dev",
        "--no-fund",
        "--no-audit",
        "--progress=false",
    ]


def _install_and_build(
    staging: Path,
    *,
    identity: NodeIdentity,
    npm: list[str],
    env: dict[str, str],
    runner: Runner,
) -> tuple[bool, subprocess.CompletedProcess]:
    """Install, validate, stamp, and build one already-populated staging tree."""
    install_command = _npm_ci_command(npm)
    install_result = runner(
        install_command,
        cwd=staging,
        idle_timeout_seconds=COMMAND_IDLE_TIMEOUT_SECONDS,
        env=env,
    )
    if install_result.returncode != 0:
        return False, install_result
    if not runtime_sentinels_current(staging, identity):
        return False, subprocess.CompletedProcess(
            install_command,
            1,
            stdout=install_result.stdout,
            stderr="npm ci completed without a valid OpenTUI runtime graph",
        )

    digest = dependency_digest(staging)
    if digest is None:
        return False, subprocess.CompletedProcess(
            install_command,
            1,
            stdout=install_result.stdout,
            stderr="could not hash staged OpenTUI dependency inputs",
        )
    _write_dependency_stamp(staging, digest)
    success, result, promotion = build_bundle(staging, npm=npm, env=env, runner=runner)
    if success:
        if promotion is None:
            raise RuntimeError("successful staged OpenTUI build has no promotion")
        # This is an isolated staging root with no caller-visible predecessor.
        # Its complete runtime is validated again before the live-root swap.
        promotion.commit()
    return success, result


def refresh_packaged_runtime(
    location: RuntimeLocation,
    *,
    identity: NodeIdentity,
    npm: list[str],
    env: dict[str, str],
    runner: Runner,
) -> PromotionResult:
    """Hydrate and build an installed runtime off-tree, then swap one root."""
    seed = location.packaged_seed
    if seed is None:
        raise ValueError(
            "refresh_packaged_runtime requires a packaged runtime location"
        )

    install_command = _npm_ci_command(npm)
    runtime_parent = location.runtime_dir.parent
    try:
        runtime_parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            runtime_parent.chmod(0o700)
        except OSError:
            pass
        staging = Path(
            tempfile.mkdtemp(prefix=".runtime-next-", dir=str(runtime_parent))
        )
    except OSError as exc:
        return (
            False,
            subprocess.CompletedProcess(
                install_command,
                1,
                stdout="",
                stderr=f"could not create packaged runtime staging: {exc}",
            ),
            None,
        )

    try:
        _copy_update_tree(seed.source_dir, staging)
        success, build_result = _install_and_build(
            staging,
            identity=identity,
            npm=npm,
            env=env,
            runner=runner,
        )
        if not success:
            return False, build_result, None

        _write_packaged_runtime_stamp(staging, seed)
        staged_location = RuntimeLocation(
            seed_dir=location.seed_dir,
            runtime_dir=staging,
            packaged_seed=seed,
        )
        if not packaged_runtime_current(staged_location):
            return (
                False,
                subprocess.CompletedProcess(
                    install_command,
                    1,
                    stdout=build_result.stdout,
                    stderr="staged OpenTUI runtime fingerprint validation failed",
                ),
                None,
            )
        promotion = _promote_directory(staging, location.runtime_dir)
        return True, build_result, promotion
    except Exception as exc:
        return (
            False,
            subprocess.CompletedProcess(
                install_command,
                1,
                stdout="",
                stderr=f"packaged runtime transaction failed: {exc}",
            ),
            None,
        )
    finally:
        try:
            _remove_path(staging)
        except (OSError, shutil.Error):
            logger.debug("Could not remove packaged OpenTUI staging %s", staging)


def refresh_runtime(
    app_dir: Path,
    *,
    identity: NodeIdentity,
    npm: list[str],
    env: dict[str, str],
    runner: Runner,
) -> PromotionResult:
    """Run npm ci + build off to the side, then promote both runtime dirs."""
    install_command = _npm_ci_command(npm)
    source_digest = refresh_digest(app_dir)
    if source_digest is None:
        return (
            False,
            subprocess.CompletedProcess(
                install_command,
                1,
                stdout="",
                stderr="could not fingerprint OpenTUI update inputs",
            ),
            None,
        )
    try:
        staging = Path(
            tempfile.mkdtemp(prefix=".ui-opentui-update-", dir=str(app_dir.parent))
        )
    except OSError as exc:
        return (
            False,
            subprocess.CompletedProcess(
                install_command,
                1,
                stdout="",
                stderr=f"could not create staging: {exc}",
            ),
            None,
        )

    try:
        _copy_update_tree(app_dir, staging)
        success, build_result = _install_and_build(
            staging,
            identity=identity,
            npm=npm,
            env=env,
            runner=runner,
        )
        if not success:
            return False, build_result, None

        if refresh_digest(app_dir) != source_digest:
            return (
                False,
                subprocess.CompletedProcess(
                    install_command,
                    1,
                    stdout=build_result.stdout,
                    stderr="OpenTUI update inputs changed during staging; retrying is safe",
                ),
                None,
            )

        promotion = promote_runtime(app_dir, staging)
        return True, build_result, promotion
    except Exception as exc:
        return (
            False,
            subprocess.CompletedProcess(
                install_command,
                1,
                stdout="",
                stderr=f"transaction failed: {exc}",
            ),
            None,
        )
    finally:
        try:
            _remove_path(staging)
        except (OSError, shutil.Error):
            logger.debug("Could not remove OpenTUI update staging %s", staging)


def failure_preview(result: subprocess.CompletedProcess) -> str:
    """Return the bounded tail used in launch/update failure diagnostics."""
    combined = f"{result.stdout or ''}\n{result.stderr or ''}".strip()
    return "\n".join(combined.splitlines()[-30:])
