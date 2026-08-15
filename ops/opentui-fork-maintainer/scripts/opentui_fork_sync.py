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
import hashlib
import sqlite3
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
LEASE_TTL_SECONDS = 11 * 60 * 60
CRON_JOB_ID = os.environ.get("OPENTUI_MAINTAINER_CRON_JOB_ID", "c57fe4db4d43")
CRON_EXECUTIONS_DB = Path.home() / ".hermes" / "cron" / "executions.db"
RUNTIME = PROJECT_HOME / "scripts" / "maintainer_runtime.py"
WATCHDOG_POLL_SECONDS = 15
WATCHDOG_GRACE_SECONDS = 5 * 60
POST_PUBLISH_LEASE_TTL_SECONDS = 15 * 60


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
                if all(
                    isinstance(value.get(key), str) and value.get(key)
                    for key in ("token", "run_id", "evidence_dir")
                ):
                    # A structured expired run must be reconciled by the
                    # runtime state machine before another owner can replace
                    # it. main() performs that recovery before retrying claim.
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
            run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(now)) + f"-{token[:8]}"
            evidence_dir = STATE_DIR / "runs" / run_id
            evidence_dir.mkdir(parents=True, exist_ok=False)
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
                        "max_expires_unix": now + LEASE_TTL_SECONDS,
                        "run_id": run_id,
                        "evidence_dir": str(evidence_dir),
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
            max_expires = int(value.get("max_expires_unix", 0))
        except (TypeError, ValueError):
            return False
        if value.get("token") != token or expires <= now or max_expires <= now:
            return False
        try:
            if lease_file.read_bytes() != raw:
                return False
        except FileNotFoundError:
            return False
        renewed = dict(value)
        renewed_expires = min(now + ttl_seconds, max_expires)
        post_publish_deadline = _post_publish_deadline(
            Path(str(value.get("evidence_dir", "")))
        )
        if post_publish_deadline is not None:
            if post_publish_deadline <= now:
                return False
            renewed_expires = min(renewed_expires, post_publish_deadline)
        renewed["expires_unix"] = renewed_expires
        _write_text_atomic(lease_file, json.dumps(renewed) + "\n")
        return True


renew_lease = _renew_lease


def _post_publish_deadline(evidence_dir: Path) -> int | None:
    path = STATE_DIR / "publish-journal.json"
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if (
            not isinstance(value, dict)
            or value.get("phase")
            not in {"prepared", "published", "finalizing", "finalized"}
            or Path(str(value.get("evidence_dir", ""))).resolve()
            != evidence_dir.resolve()
        ):
            return None
        return int(value["prepared_unix"]) + POST_PUBLISH_LEASE_TTL_SECONDS
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        # An unreadable journal is publication state, not permission to widen
        # the lease. Force reconciliation to fail closed.
        return 0


def _invoke_reconcile(
    token: str,
    evidence_dir: Path,
    *,
    allow_expired: bool = False,
) -> subprocess.CompletedProcess[str]:
    argv = [
        sys.executable,
        str(RUNTIME),
        "reconcile-run",
        "--state",
        str(STATE_DIR),
        "--evidence",
        str(evidence_dir),
        "--token",
        token,
    ]
    if allow_expired:
        argv.append("--allow-expired")
    return subprocess.run(
        argv,
        cwd=PROJECT_HOME,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )


def _reconcile_stale_lease(now: int | None = None) -> bool:
    """Close one expired structured run before the next claim attempt."""
    now = int(time.time()) if now is None else now
    with _lease_lock():
        current = _read_lease_raw(STATE_DIR / "run.lease.json")
    if current is None:
        return True
    value = current[1]
    try:
        expires = int(value.get("expires_unix", 0))
    except (TypeError, ValueError):
        return True
    if expires > now:
        return True
    token = value.get("token")
    run_id = value.get("run_id")
    evidence = value.get("evidence_dir")
    if not all(isinstance(item, str) and item for item in (token, run_id, evidence)):
        return True
    evidence_dir = Path(evidence)
    if evidence_dir.name != run_id:
        return False
    return _invoke_reconcile(token, evidence_dir, allow_expired=True).returncode == 0


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


def _owned_run(token: str) -> dict[str, Any]:
    with _lease_lock():
        current = _read_lease_raw(STATE_DIR / "run.lease.json")
        if current is None or current[1].get("token") != token:
            raise RuntimeError("maintainer lease ownership changed")
        value = dict(current[1])
    if not isinstance(value.get("run_id"), str):
        raise RuntimeError("maintainer lease has no run id")
    evidence = Path(str(value.get("evidence_dir", "")))
    expected = STATE_DIR / "runs" / value["run_id"]
    if evidence != expected or not evidence.is_dir() or evidence.is_symlink():
        raise RuntimeError("maintainer evidence directory is invalid")
    return value


def _bind_run_context(token: str, context: dict[str, Any]) -> None:
    context_path = Path(str(context["evidence_dir"])) / "run-context.json"
    persisted = {key: value for key, value in context.items() if key != "evidence_dir"}
    context_text = json.dumps(persisted, indent=2, sort_keys=True) + "\n"
    context_digest = hashlib.sha256(context_text.encode()).hexdigest()
    with _lease_lock():
        current = _read_lease_raw(STATE_DIR / "run.lease.json")
        if current is None or current[1].get("token") != token:
            raise RuntimeError(
                "maintainer lease ownership changed before snapshot bind"
            )
        value = dict(current[1])
        if value.get("run_id") != persisted.get("run_id"):
            raise RuntimeError("maintainer run identity changed before snapshot bind")
        base_sha = persisted.get("base_sha")
        upstream_sha = persisted.get("upstream_sha")
        if not all(
            isinstance(sha, str) and len(sha) == 40 for sha in (base_sha, upstream_sha)
        ):
            raise RuntimeError("probe did not return full captured commit ids")
        _write_text_atomic(context_path, context_text)
        value["captured_base"] = base_sha
        value["captured_upstream"] = upstream_sha
        value["run_context_sha256"] = context_digest
        _write_text_atomic(STATE_DIR / "run.lease.json", json.dumps(value) + "\n")


def _current_execution_id() -> str | None:
    try:
        with sqlite3.connect(CRON_EXECUTIONS_DB, timeout=5) as conn:
            row = conn.execute(
                """
                SELECT id FROM executions
                WHERE job_id=? AND status='running'
                ORDER BY started_at DESC LIMIT 1
                """,
                (CRON_JOB_ID,),
            ).fetchone()
    except (OSError, sqlite3.Error):
        return None
    return str(row[0]) if row else None


def _execution_state(execution_id: str, acquired_unix: int) -> tuple[str, str | None]:
    if execution_id.startswith("legacy:"):
        return "untracked", None
    try:
        with sqlite3.connect(CRON_EXECUTIONS_DB, timeout=5) as conn:
            row = conn.execute(
                "SELECT status FROM executions WHERE id=? AND job_id=?",
                (execution_id, CRON_JOB_ID),
            ).fetchone()
    except (OSError, sqlite3.Error):
        return "error", None
    if row is None:
        return "missing", None
    return "ok", str(row[0])


def _queue_reconciliation_failure(run_id: str) -> None:
    queue = STATE_DIR / "pending_notifications.log"
    lock = STATE_DIR / "pending_notifications.lock"
    message = (
        f"OpenTUI maintainer run {run_id} ended or was fenced without a "
        "confirmed successful terminal outcome; inspect its durable evidence."
    )
    with lock.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        with queue.open("a", encoding="utf-8") as output:
            stamp = time.strftime("%Y-%m-%dT%H:%M", time.gmtime())
            output.write(f"{stamp} | PENDING | telegram:5837946924 | {message}\n")
            output.flush()
            os.fsync(output.fileno())
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _durable_outcome_bound(run_id: str, evidence_dir: Path) -> bool:
    outcome_path = evidence_dir / "run-outcome.json"
    durable_path = STATE_DIR / "last-run.json"
    try:
        outcome = json.loads(outcome_path.read_text(encoding="utf-8"))
        durable = json.loads(durable_path.read_text(encoding="utf-8"))
        digest = hashlib.sha256(outcome_path.read_bytes()).hexdigest()
    except (OSError, json.JSONDecodeError):
        return False
    return (
        isinstance(outcome, dict)
        and outcome.get("status") in {"success", "failed"}
        and isinstance(durable, dict)
        and durable.get("evidence_path") == str(outcome_path)
        and durable.get("evidence_sha256") == digest
        and durable.get("status") == outcome.get("status")
        and evidence_dir.name == run_id
    )


def _watch_execution(
    run_id: str,
    evidence_dir: Path,
    execution_id: str,
) -> int:
    missing_polls = 0
    allow_expired_reconcile = False
    while True:
        with _lease_lock():
            lease = _read_lease_raw(STATE_DIR / "run.lease.json")
        if lease is None:
            if _durable_outcome_bound(run_id, evidence_dir):
                return 0
            _queue_reconciliation_failure(run_id)
            return 2
        value = lease[1]
        if value.get("run_id") != run_id or value.get("evidence_dir") != str(
            evidence_dir
        ):
            return 2
        token = str(value.get("token", ""))
        try:
            acquired_unix = int(value.get("acquired_unix", 0))
            expires_unix = int(value.get("expires_unix", 0))
            max_expires_unix = int(value.get("max_expires_unix", 0))
        except (TypeError, ValueError):
            return 2
        if not token:
            return 2
        ledger_state, status = _execution_state(execution_id, acquired_unix)
        now = int(time.time())
        if now >= expires_unix or now >= max_expires_unix:
            allow_expired_reconcile = True
            break
        if ledger_state in {"error", "untracked"}:
            time.sleep(WATCHDOG_POLL_SECONDS)
            continue
        if ledger_state == "missing":
            missing_polls += 1
            if missing_polls >= 3:
                break
            time.sleep(WATCHDOG_POLL_SECONDS)
            continue
        missing_polls = 0
        if status not in {"running", "claimed"}:
            break
        if status in {"running", "claimed"}:
            post_publish_deadline = _post_publish_deadline(evidence_dir)
            if (
                max_expires_unix - now <= WATCHDOG_GRACE_SECONDS
                or post_publish_deadline is not None
                and post_publish_deadline - now <= WATCHDOG_GRACE_SECONDS
            ):
                break
            if expires_unix - now <= WATCHDOG_GRACE_SECONDS:
                if not _renew_lease(token, now=now):
                    return 2
            time.sleep(WATCHDOG_POLL_SECONDS)
            continue

    result = _invoke_reconcile(
        token,
        evidence_dir,
        allow_expired=allow_expired_reconcile,
    )
    if result.returncode != 0:
        _queue_reconciliation_failure(run_id)
        return result.returncode
    try:
        outcome = json.loads(result.stdout)
    except json.JSONDecodeError:
        return 2
    if outcome.get("status") == "failed":
        _queue_reconciliation_failure(run_id)
    return 0


def _launch_watchdog(run: dict[str, Any], execution_id: str) -> None:
    evidence_dir = Path(run["evidence_dir"])
    log_path = evidence_dir / "reconciler.log"
    with log_path.open("ab") as log:
        subprocess.Popen(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--reconcile-watch",
                run["run_id"],
                str(evidence_dir),
                execution_id,
            ],
            cwd=PROJECT_HOME,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )


def _safe_summary(
    payload: dict[str, Any], *, wake_agent: bool = True
) -> dict[str, Any]:
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
        "run_id": payload.get("run_id"),
        "evidence_dir": payload.get("evidence_dir"),
        "execution_id": payload.get("execution_id"),
        "wakeAgent": wake_agent,
    }


def main() -> int:
    _reconcile_stale_lease()
    run_token = _claim_lease()
    if run_token is None:
        print(
            json.dumps(
                {
                    "status": "locked",
                    "ingest_file": str(INGEST_FILE),
                    "gap": 0,
                    "needs_port_count": 0,
                    "probe_failures": _read_failure_count(),
                    "run_token": None,
                    "wakeAgent": False,
                }
            )
        )
        return 0
    try:
        run = _owned_run(run_token)
        execution_id = _current_execution_id() or f"legacy:{run['run_id']}"
    except Exception:
        _release_lease(run_token)
        raise
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
                json.dumps(
                    {
                        "status": "error",
                        "ingest_file": str(INGEST_FILE),
                        "gap": 0,
                        "needs_port_count": 0,
                        "probe_failures": count,
                        "run_token": None,
                        "wakeAgent": True,
                    }
                )
            )
            return 0

        _set_failure_count(0)
        payload["run_token"] = run_token
        payload["run_id"] = run["run_id"]
        payload["evidence_dir"] = run["evidence_dir"]
        payload["execution_id"] = execution_id

        # A zero-gap probe is a complete cron tick, not an agent task. Handing
        # it to Hermes would spend a model call, leave a watchdog polling the
        # execution ledger, and hold the whole-run lease until the agent exits.
        # Persist the probe result first, then release the exact lease owner
        # before returning the scheduler's explicit no-wake gate.
        if payload.get("status") == "up_to_date":
            _write_text_atomic(INGEST_FILE, json.dumps(payload, indent=2) + "\n")
            if not _release_lease(run_token):
                raise RuntimeError("up-to-date lease release lost ownership")
            handed_off = True
            print(json.dumps(_safe_summary(payload, wake_agent=False)))
            return 0

        context = {
            "evidence_dir": run["evidence_dir"],
            "schema_version": 1,
            "run_id": run["run_id"],
            "execution_id": execution_id,
            "lease_token_sha256": hashlib.sha256(run_token.encode()).hexdigest(),
            "base_sha": payload.get("branch_sha"),
            "upstream_sha": payload.get("upstream_sha"),
        }
        _bind_run_context(run_token, context)
        _write_text_atomic(INGEST_FILE, json.dumps(payload, indent=2) + "\n")
        _launch_watchdog(run, execution_id)
        print(json.dumps(_safe_summary(payload)))
        handed_off = True
        return 0
    finally:
        if not handed_off:
            _release_lease(run_token)


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "--reconcile-watch":
        sys.exit(
            _watch_execution(
                sys.argv[2],
                Path(sys.argv[3]),
                sys.argv[4],
            )
        )
    sys.exit(main())
