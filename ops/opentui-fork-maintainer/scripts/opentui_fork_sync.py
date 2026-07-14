#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Scanner-safe cron entrypoint for the OpenTUI fork maintainer.

The probe output is untrusted repository metadata.  It is persisted as data and
never interpolated into the assembled cron prompt.  Stdout contains only a
small, fixed-shape bootstrap result that tells the agent where to read it.
"""

from __future__ import annotations

import json
import os
import subprocess
import secrets
import time
import sys
import tempfile
import fcntl
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

DEFAULT_PROJECT_HOME = Path("/home/daimon/projects/opentui-fork-maintainer")
PROJECT_HOME = Path(os.environ.get("OPENTUI_MAINTAINER_HOME", DEFAULT_PROJECT_HOME))
STATE_DIR = PROJECT_HOME / "state"
PROBE = PROJECT_HOME / "scripts" / "sync_probe.py"
INGEST_FILE = STATE_DIR / "ingest.latest.json"
FAIL_COUNT_FILE = STATE_DIR / "consecutive_probe_failures"
LEASE_TTL_SECONDS = 6 * 60 * 60


@contextmanager
def _lease_lock() -> Iterator[None]:
    """Serialize every lease transition across wrapper/runtime processes."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    lock_file = STATE_DIR / "run.lease.lock"
    with lock_file.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _read_lease_raw(lease_file: Path) -> tuple[bytes, dict[str, Any]] | None:
    try:
        raw = lease_file.read_bytes()
        value = json.loads(raw)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return (raw, value) if isinstance(value, dict) else None


def _claim_lease(now: int | None = None) -> str | None:
    """Atomically claim a bounded whole-run lease; recover only after expiry."""
    now = int(time.time()) if now is None else now
    lease_file = STATE_DIR / "run.lease.json"
    with _lease_lock():
        for _ in range(2):
            current = _read_lease_raw(lease_file)
            if current is not None:
                raw, value = current
                try:
                    expires = int(value.get("expires_unix", 0))
                except (TypeError, ValueError):
                    expires = 0
                if expires > now:
                    return None
                try:
                    if lease_file.read_bytes() != raw:
                        continue
                except FileNotFoundError:
                    continue
            elif lease_file.exists():
                try:
                    raw = lease_file.read_bytes()
                    if lease_file.read_bytes() != raw:
                        continue
                except FileNotFoundError:
                    continue
            try:
                lease_file.unlink()
            except FileNotFoundError:
                pass
            token = secrets.token_hex(16)
            try:
                fd = os.open(lease_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                continue
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "token": token,
                        "acquired_unix": now,
                        "expires_unix": now + LEASE_TTL_SECONDS,
                    },
                    handle,
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            return token
    return None


def _renew_lease(
    token: str,
    *,
    now: int | None = None,
    ttl_seconds: int = LEASE_TTL_SECONDS,
) -> bool:
    """Extend an unexpired lease iff the token still owns its exact content."""
    now = int(time.time()) if now is None else now
    if ttl_seconds <= 0:
        raise ValueError("ttl_seconds must be positive")
    lease_file = STATE_DIR / "run.lease.json"
    with _lease_lock():
        current = _read_lease_raw(lease_file)
        if current is None:
            return False
        raw, value = current
        try:
            expires = int(value.get("expires_unix", 0))
        except (TypeError, ValueError):
            return False
        if value.get("token") != token or expires <= now:
            return False
        try:
            if lease_file.read_bytes() != raw:
                return False
        except FileNotFoundError:
            return False
        renewed = dict(value)
        renewed["expires_unix"] = now + ttl_seconds
        _write_text_atomic(lease_file, json.dumps(renewed) + "\n")
        return True


renew_lease = _renew_lease


def _release_lease(token: str) -> bool:
    """Remove only the exact lease still owned by token."""
    lease_file = STATE_DIR / "run.lease.json"
    with _lease_lock():
        current = _read_lease_raw(lease_file)
        if current is None:
            return False
        raw, value = current
        if value.get("token") != token:
            return False
        try:
            if lease_file.read_bytes() != raw:
                return False
            lease_file.unlink()
        except FileNotFoundError:
            return False
        return True


def _cron_env() -> dict[str, str]:
    env = os.environ.copy()
    home = str(Path.home())
    preferred = [
        f"{home}/.local/bin",
        f"{home}/.cargo/bin",
        f"{home}/.local/share/fnm/node-versions/v26.3.0/installation/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ]
    env["PATH"] = ":".join(preferred + [env.get("PATH", "")])
    return env


def _uv(env: dict[str, str]) -> str:
    for candidate in (Path.home() / ".local/bin/uv", Path.home() / ".cargo/bin/uv"):
        if candidate.exists():
            return str(candidate)
    return "uv"


def _read_failure_count() -> int:
    try:
        return int(FAIL_COUNT_FILE.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return 0


def _write_text_atomic(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def _set_failure_count(value: int) -> None:
    try:
        _write_text_atomic(FAIL_COUNT_FILE, f"{value}\n")
    except OSError:
        pass


def _safe_summary(payload: dict[str, Any]) -> dict[str, Any]:
    """Return the only data allowed onto cron stdout.

    Do not add commit subjects, authors, paths, errors, diffs, or tool output.
    Those fields are repository-controlled and must stay in ``INGEST_FILE``.
    """
    commits = payload.get("commits")
    needs_port_count = 0
    if isinstance(commits, list):
        needs_port_count = sum(
            1
            for item in commits
            if isinstance(item, dict) and item.get("needs_port") is True
        )
    return {
        "status": str(payload.get("status", "error")),
        "ingest_file": str(INGEST_FILE),
        "gap": int(payload.get("gap", 0) or 0),
        "needs_port_count": needs_port_count,
        "probe_failures": _read_failure_count(),
        "run_token": payload.get("run_token"),
        "wakeAgent": True,
    }


def main() -> int:
    run_token = _claim_lease()
    if run_token is None:
        print(
            json.dumps({
                "status": "locked",
                "ingest_file": str(INGEST_FILE),
                "gap": 0,
                "needs_port_count": 0,
                "probe_failures": _read_failure_count(),
                "run_token": None,
                "wakeAgent": False,
            })
        )
        return 0
    handed_off = False
    try:
        env = _cron_env()
        try:
            result = subprocess.run(
                [_uv(env), "run", str(PROBE)],
                cwd=PROJECT_HOME,
                env=env,
                capture_output=True,
                text=True,
                timeout=300,
                check=False,
            )
            stdout = (result.stdout or "").strip()
            if result.returncode != 0 or not stdout:
                raise RuntimeError(f"probe exited {result.returncode}")
            payload = json.loads(stdout)
            if not isinstance(payload, dict):
                raise ValueError("probe did not return an object")
        except Exception as exc:
            count = _read_failure_count() + 1
            _set_failure_count(count)
            failure = {
                "status": "error",
                "error_type": type(exc).__name__,
                "error_sha256": __import__("hashlib")
                .sha256(str(exc).encode())
                .hexdigest(),
                "consecutive_probe_failures": count,
            }
            try:
                _write_text_atomic(INGEST_FILE, json.dumps(failure, indent=2) + "\n")
            except OSError:
                pass
            print(
                json.dumps({
                    "status": "error",
                    "ingest_file": str(INGEST_FILE),
                    "gap": 0,
                    "needs_port_count": 0,
                    "probe_failures": count,
                    "run_token": None,
                    "wakeAgent": True,
                })
            )
            return 0

        _set_failure_count(0)
        payload["run_token"] = run_token
        _write_text_atomic(INGEST_FILE, json.dumps(payload, indent=2) + "\n")
        print(json.dumps(_safe_summary(payload)))
        handed_off = True
        return 0
    finally:
        if not handed_off:
            _release_lease(run_token)


if __name__ == "__main__":
    sys.exit(main())
