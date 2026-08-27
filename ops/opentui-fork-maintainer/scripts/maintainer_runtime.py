#!/usr/bin/env python3
"""Transactional control-plane primitives for the OpenTUI maintainer.

This module deliberately performs no implementation work.  It owns the small
set of operations which must not depend on an agent following prose correctly:
run exclusion, one-shot request claiming, gate-manifest validation, and the
guarded remote fast-forward which publishes a green candidate.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import fcntl
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


BRANCH = "sid/opentui"
REMOTE = "origin"
UPSTREAM_URL = "https://github.com/NousResearch/hermes-agent.git"
REQUIRED_GATES = frozenset(
    {
        "opentui-install",
        "focused-contracts",
        "opentui-check",
        "opentui-build",
        "termctrl-smoke",
        "adversarial-review",
        "video-analysis",
    }
)
SHA_RE = __import__("re").compile(r"^[0-9a-f]{40}$")
SHORT_SHA_RE = __import__("re").compile(r"^[0-9a-fA-F]{7,40}$")
GATE_SCHEMA_VERSION = 3
LEASE_TTL_SECONDS = 11 * 60 * 60
POST_PUBLISH_LEASE_TTL_SECONDS = 15 * 60
PACKET_TIMEOUT_SECONDS = 4 * 60 * 60
WORKER_SLOT_COUNT = 2
NODE26_DIR = Path(
    "/home/daimon/.local/share/fnm/node-versions/v26.3.0/installation/bin"
)
NODE26 = NODE26_DIR / "node"
NPM26 = NODE26_DIR / "npm"
TERMCTRL = Path("/home/daimon/.cargo/bin/termctrl")
MAINTAINER_WORKTREE_ROOT = Path(
    "/home/daimon/projects/opentui-fork-maintainer/worktrees"
)
FORK_SOURCE_ROOT = Path("/home/daimon/side-quests/hermes-agent")
FORK_VENV_PYTHON = FORK_SOURCE_ROOT / ".venv/bin/python"
CONTROLLED_PATH = f"{NODE26_DIR}:/usr/local/bin:/usr/bin:/bin"
CANONICAL_CODE_GATES = {
    "opentui-install": [str(NPM26), "--prefix", "ui-opentui", "ci"],
    "opentui-check": [str(NPM26), "--prefix", "ui-opentui", "run", "check"],
    "opentui-build": [str(NPM26), "--prefix", "ui-opentui", "run", "build"],
}
SHARED_VENV_PYTEST_PREFIX = [
    "uv",
    "run",
    "--no-project",
    "--python",
    str(FORK_VENV_PYTHON),
    "-m",
    "pytest",
]
VIDEO_MODEL = "google/gemini-3.5-flash"
VIDEO_TAIL_MS = 3_000
TERMCTRL_READY_HOLD_SECONDS = 1.5
TERMCTRL_MIN_ACTION_TIMELINE_MS = 1_000
TERMCTRL_HYDRATION_TIMEOUT_SECONDS = 60
TERMCTRL_HYDRATION_POLL_SECONDS = 0.25
VIDEO_ANALYSIS_TIMEOUT_SECONDS = 10 * 60
REVIEW_TIMEOUT_SECONDS = 30 * 60
REVIEW_PROMPT_MAX_BYTES = 350_000
TRUSTED_FETCH_TIMEOUT_SECONDS = 10 * 60
TRUSTED_FETCH_ATTEMPTS = 3
REVIEW_PREREQUISITE_GATES = (
    "opentui-install",
    "focused-contracts",
    "opentui-check",
    "opentui-build",
)
VIDEO_RESULT_PREFIX = b"HERMES_VIDEO_RESULT_B64="
VIDEO_PROMPT = (
    "Review this Hermes OpenTUI acceptance recording. End with exactly "
    "VERDICT: PASS only if the tested flow is visibly complete and there is no "
    "crash, clipping, corruption, duplicate content, or stuck overlay; otherwise "
    "end with exactly VERDICT: FAIL and explain every finding. The final line "
    "must be plain ASCII with no Markdown, punctuation, or suffix after PASS or FAIL."
)

REVIEWER_COMMANDS: dict[tuple[str, str], list[str]] = {
    ("codex", "gpt-5.6-sol"): [
        "/home/daimon/.local/bin/codex",
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-m",
        "gpt-5.6-sol",
        "-",
    ],
    ("claude", "fable-5"): [
        "/home/daimon/.local/bin/claude",
        "-p",
        "--model",
        "claude-fable-5",
        "--safe-mode",
        "--tools",
        "",
        "--no-session-persistence",
        "--output-format",
        "text",
    ],
    ("claude", "opus-4.8"): [
        "/home/daimon/.local/bin/claude",
        "-p",
        "--model",
        "opus",
        "--safe-mode",
        "--tools",
        "",
        "--no-session-persistence",
        "--output-format",
        "text",
    ],
}

# Chunk reviewers receive only the bounded diff.  The final verifier must be
# able to resolve provisional findings against the candidate that will ship,
# but remains strictly read-only: no shell, edits, writes, or agent fan-out.
REVIEWER_VERIFIER_COMMANDS: dict[tuple[str, str], list[str]] = {
    ("codex", "gpt-5.6-sol"): [
        "/home/daimon/.local/bin/codex",
        "exec",
        "-s",
        "read-only",
        "--skip-git-repo-check",
        "-m",
        "gpt-5.6-sol",
        "-",
    ],
    ("claude", "fable-5"): [
        "/home/daimon/.local/bin/claude",
        "-p",
        "--model",
        "claude-fable-5",
        "--safe-mode",
        "--tools",
        "Read,Grep",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--output-format",
        "text",
    ],
    ("claude", "opus-4.8"): [
        "/home/daimon/.local/bin/claude",
        "-p",
        "--model",
        "opus",
        "--safe-mode",
        "--tools",
        "Read,Grep",
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
        "--output-format",
        "text",
    ],
}


class ControlError(RuntimeError):
    """A state transition was unsafe or its preconditions were not proven."""


def _reject_symlink_path(path: Path, root: Path) -> Path:
    """Return an absolute in-root path after rejecting every symlink component."""
    root = Path(os.path.abspath(root))
    path = Path(os.path.abspath(path))
    if not path.is_relative_to(root):
        raise ControlError("evidence path escapes the evidence root")
    if root.is_symlink():
        raise ControlError("evidence root must not be a symlink")
    current = root
    for part in path.relative_to(root).parts:
        current = current / part
        if current.is_symlink():
            raise ControlError("evidence paths must not contain symlinks")
    if not path.resolve(strict=False).is_relative_to(root.resolve()):
        raise ControlError("evidence path escapes the evidence root")
    return path


def _safe_output_path(root: Path, *parts: str) -> Path:
    root = Path(os.path.abspath(root))
    root.mkdir(parents=True, exist_ok=True)
    path = _reject_symlink_path(root.joinpath(*parts), root)
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    _reject_symlink_path(parent, root)
    if path.is_symlink() or path.exists() and not path.is_file():
        raise ControlError("generated evidence target is unsafe")
    return path


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def _atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass


def _record_run_outcome(
    state_dir: Path, evidence_dir: Path, value: dict[str, Any]
) -> dict[str, Any]:
    evidence_root = Path(os.path.abspath(evidence_dir))
    outcome = {
        "schema_version": 1,
        "recorded_unix": int(time.time()),
        **value,
    }
    evidence_path = _safe_output_path(evidence_root, "run-outcome.json")
    _atomic_json(evidence_path, outcome)
    durable = {
        **outcome,
        "evidence_path": str(evidence_path),
        "evidence_sha256": _file_sha256(evidence_path),
    }
    _atomic_json(state_dir / "last-run.json", durable)
    return outcome


@contextmanager
def run_lock(state_dir: Path) -> Iterator[None]:
    """Acquire the maintainer lock without waiting."""
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / "maintainer.lock"
    with path.open("a+", encoding="utf-8") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ControlError(
                "another maintainer run holds the nonblocking lock"
            ) from exc
        handle.seek(0)
        handle.truncate()
        handle.write(
            json.dumps({"pid": os.getpid(), "acquired_unix": int(time.time())}) + "\n"
        )
        handle.flush()
        os.fsync(handle.fileno())
        try:
            yield
        finally:
            handle.seek(0)
            handle.truncate()
            handle.write(
                json.dumps(
                    {
                        "pid": os.getpid(),
                        "acquired_unix": int(time.time()),
                        "active": False,
                        "released_unix": int(time.time()),
                    }
                )
                + "\n"
            )
            handle.flush()
            os.fsync(handle.fileno())
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def _request_lock(state_dir: Path) -> Iterator[None]:
    """Serialize queue/in-flight transitions with the cron wrapper."""
    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / "run-request.lock").open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _validate_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"mode", "commits"}:
        raise ControlError("request must contain exactly mode and commits")
    commits = value.get("commits")
    if value.get("mode") != "backport" or not isinstance(commits, list):
        raise ControlError("request must be a backport with a commit list")
    if not 1 <= len(commits) <= 20 or len(set(commits)) != len(commits):
        raise ControlError("request must contain 1 to 20 unique commits")
    if not all(isinstance(sha, str) and SHORT_SHA_RE.fullmatch(sha) for sha in commits):
        raise ControlError("request contains an invalid commit id")
    return {"mode": "backport", "commits": [sha.lower() for sha in commits]}


def _record_retry_context(
    state_dir: Path, evidence_dir: Path, request_value: dict[str, Any]
) -> None:
    """Bind a recovered request to the newest matching failed-run evidence.

    Artifact contents remain untrusted data.  The control plane records only
    canonical in-state paths and hashes so a fresh parent can inspect the
    prior verdict without silently trusting or losing it.
    """
    runs_dir = state_dir / "runs"
    if not runs_dir.is_dir():
        return
    request_bytes = json.dumps(
        request_value, sort_keys=True, separators=(",", ":")
    ).encode()
    current = Path(os.path.abspath(evidence_dir))
    candidates: list[Path] = []
    for run_dir in runs_dir.iterdir():
        absolute = Path(os.path.abspath(run_dir))
        if not run_dir.is_dir() or run_dir.is_symlink() or absolute == current:
            continue
        claimed = run_dir / "request.claimed.json"
        try:
            prior = _validate_request(json.loads(claimed.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError, ControlError):
            continue
        if prior == request_value:
            candidates.append(run_dir)
    if not candidates:
        return
    previous = max(candidates, key=lambda path: (path.stat().st_mtime_ns, path.name))
    artifacts = []
    for kind, relative in (
        ("handoff", "handoff.md"),
        ("gate", "gate.json"),
        ("review", "review-verified/stdout.txt"),
        ("termctrl", "gate-logs/termctrl-smoke.log"),
    ):
        artifact = previous / relative
        if artifact.is_file() and not artifact.is_symlink():
            artifacts.append(
                {
                    "kind": kind,
                    "path": str(artifact.resolve()),
                    "sha256": _file_sha256(artifact),
                }
            )
    if not artifacts:
        return
    _atomic_json(
        evidence_dir / "retry-context.json",
        {
            "schema_version": 1,
            "previous_run": previous.name,
            "request_sha256": hashlib.sha256(request_bytes).hexdigest(),
            "artifacts": artifacts,
        },
    )


def _claim_request_unlocked(
    state_dir: Path, evidence_dir: Path
) -> dict[str, Any] | None:
    """Atomically claim a request, recovering a prior interrupted claim.

    The shared ``run-request.inflight.json`` is the durable ownership marker.
    An interrupted run leaves it behind; the next lock holder resumes that same
    request instead of losing it or accepting a newer request over it.
    """
    request = state_dir / "run-request.json"
    inflight = state_dir / "run-request.inflight.json"
    if request.exists() and inflight.exists():
        raise ControlError(
            "both queued and in-flight requests exist; manual repair required"
        )
    source = inflight if inflight.exists() else request
    if not source.exists():
        return None
    try:
        value = _validate_request(json.loads(source.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError) as exc:
        raise ControlError(f"invalid request file: {type(exc).__name__}") from exc
    if source == request:
        os.replace(request, inflight)
    _atomic_json(evidence_dir / "request.claimed.json", value)
    _record_retry_context(state_dir, evidence_dir, value)
    return value


def _recover_request_unlocked(state_dir: Path) -> None:
    request = state_dir / "run-request.json"
    inflight = state_dir / "run-request.inflight.json"
    if request.exists() and inflight.exists():
        raise ControlError("cannot recover over a newer queued request")
    if inflight.exists():
        os.replace(inflight, request)


def _consume_request_unlocked(state_dir: Path, evidence_dir: Path) -> None:
    inflight = state_dir / "run-request.inflight.json"
    if not inflight.exists():
        raise ControlError("there is no in-flight request to consume")
    destination = evidence_dir / "request.consumed.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.replace(inflight, destination)


def claim_request(state_dir: Path, evidence_dir: Path) -> dict[str, Any] | None:
    with _request_lock(state_dir):
        return _claim_request_unlocked(state_dir, evidence_dir)


def recover_request(state_dir: Path) -> None:
    with _request_lock(state_dir):
        _recover_request_unlocked(state_dir)


def consume_request(state_dir: Path, evidence_dir: Path) -> None:
    with _request_lock(state_dir):
        _consume_request_unlocked(state_dir, evidence_dir)


def _read_bound_request(path: Path, root: Path, *, label: str) -> dict[str, Any]:
    """Load one canonical request file without permitting path substitution."""
    safe_path = _evidence_path(str(path), root, label=label)
    try:
        value = json.loads(safe_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ControlError(f"{label} is invalid: {type(exc).__name__}") from exc
    return _validate_request(value)


def _canonical_json_sha256(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _derive_run_binding(
    state_dir: Path, evidence_dir: Path, token: str
) -> dict[str, Any]:
    """Bind a gate to either the scheduled sync or one exact claimed backport."""
    evidence_root = Path(os.path.abspath(evidence_dir))
    with _request_lock(state_dir):
        queued = state_dir / "run-request.json"
        inflight = state_dir / "run-request.inflight.json"
        claimed = evidence_root / "request.claimed.json"
        if claimed.exists():
            if queued.exists() or not inflight.exists():
                raise ControlError("claimed backport request state is inconsistent")
            claimed_value = _read_bound_request(
                claimed, evidence_root, label="claimed request"
            )
            inflight_value = _read_bound_request(
                inflight, state_dir, label="in-flight request"
            )
            if claimed_value != inflight_value:
                raise ControlError(
                    "claimed backport request does not match in-flight state"
                )
            mode = "backport"
            request_sha = _canonical_json_sha256(claimed_value)
        else:
            if queued.exists() or inflight.exists():
                raise ControlError("a pending request must be claimed before gating")
            mode = "scheduled"
            request_sha = None
    marker = state_dir / "last_synced_upstream.sha"
    last_synced = (
        marker.read_text(encoding="utf-8").strip() if marker.exists() else None
    )
    if last_synced is not None and not SHA_RE.fullmatch(last_synced):
        raise ControlError("last synced upstream marker is invalid")
    context_path = evidence_root / "run-context.json"
    try:
        context = json.loads(context_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ControlError("captured run context is missing or invalid") from exc
    expected_context = {
        "schema_version",
        "run_id",
        "execution_id",
        "lease_token_sha256",
        "base_sha",
        "upstream_sha",
    }
    if not isinstance(context, dict) or set(context) != expected_context:
        raise ControlError("captured run context has an invalid shape")
    lease = _lease_value(state_dir)
    if (
        context.get("schema_version") != 1
        or not isinstance(context.get("run_id"), str)
        or not isinstance(context.get("execution_id"), str)
        or not context["execution_id"]
        or context.get("lease_token_sha256")
        != hashlib.sha256(token.encode()).hexdigest()
        or lease.get("run_id") != context["run_id"]
        or lease.get("evidence_dir") != str(evidence_root)
        or lease.get("captured_base") != context.get("base_sha")
        or lease.get("captured_upstream") != context.get("upstream_sha")
        or lease.get("run_context_sha256") != _file_sha256(context_path)
        or not SHA_RE.fullmatch(str(context.get("base_sha", "")))
        or not SHA_RE.fullmatch(str(context.get("upstream_sha", "")))
    ):
        raise ControlError("captured run context does not match the active lease")
    return {
        "mode": mode,
        "request_sha256": request_sha,
        "last_synced_upstream": last_synced,
        "captured_upstream": context["upstream_sha"],
        "captured_base": context["base_sha"],
    }


@contextmanager
def _lease_lock(state_dir: Path) -> Iterator[None]:
    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / "run.lease.lock").open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _lease_value(state_dir: Path) -> dict[str, Any]:
    try:
        value = json.loads((state_dir / "run.lease.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise ControlError("run lease is missing or invalid") from exc
    if not isinstance(value, dict):
        raise ControlError("run lease is missing or invalid")
    return value


def _validate_lease_value(value: dict[str, Any], token: str, now: int) -> None:
    try:
        expires = int(value.get("expires_unix", 0))
    except (TypeError, ValueError) as exc:
        raise ControlError("run lease token is invalid or expired") from exc
    if value.get("token") != token or expires <= now:
        raise ControlError("run lease token is invalid or expired")


def validate_lease(state_dir: Path, token: str, now: int | None = None) -> None:
    now = int(time.time()) if now is None else now
    with _lease_lock(state_dir):
        _validate_lease_value(_lease_value(state_dir), token, now)


def renew_lease(
    state_dir: Path,
    token: str,
    *,
    now: int | None = None,
    ttl_seconds: int = LEASE_TTL_SECONDS,
) -> None:
    now = int(time.time()) if now is None else now
    if ttl_seconds <= 0:
        raise ControlError("lease renewal ttl must be positive")
    with _lease_lock(state_dir):
        value = _lease_value(state_dir)
        _validate_lease_value(value, token, now)
        journal = _load_publish_journal(state_dir)
        if journal is not None and journal["phase"] in {
            "prepared",
            "published",
            "finalizing",
            "finalized",
        }:
            ttl_seconds = min(ttl_seconds, POST_PUBLISH_LEASE_TTL_SECONDS)
        try:
            max_expires = int(value.get("max_expires_unix", 0))
        except (TypeError, ValueError) as exc:
            raise ControlError("run lease absolute deadline is invalid") from exc
        if max_expires <= now:
            raise ControlError("run lease reached its absolute deadline")
        expires = min(now + ttl_seconds, max_expires)
        if journal is not None and journal["phase"] in {
            "prepared",
            "published",
            "finalizing",
            "finalized",
        }:
            post_publish_deadline = (
                int(journal["prepared_unix"]) + POST_PUBLISH_LEASE_TTL_SECONDS
            )
            if post_publish_deadline <= now:
                raise ControlError("post-publish lease reached its fixed deadline")
            expires = min(
                expires,
                post_publish_deadline,
            )
        value["expires_unix"] = expires
        _atomic_json(state_dir / "run.lease.json", value)


def release_lease(state_dir: Path, token: str) -> None:
    with _lease_lock(state_dir):
        value = _lease_value(state_dir)
        if value.get("token") != token:
            raise ControlError("run lease token is invalid")
        try:
            (state_dir / "run.lease.json").unlink()
        except FileNotFoundError as exc:
            raise ControlError("run lease changed before release") from exc


def _git(repo: Path, args: list[str], *, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if check and result.returncode != 0:
        raise ControlError(f"git operation failed: {args[0]}")
    return result.stdout.strip()


def _git_status(repo: Path, args: list[str]) -> int:
    return subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=180
    ).returncode


def capture_base(repo: Path, remote: str = REMOTE, branch: str = BRANCH) -> str:
    sha = _git(repo, ["rev-parse", f"refs/remotes/{remote}/{branch}"])
    if not SHA_RE.fullmatch(sha):
        raise ControlError("remote tracking base is not a full commit id")
    return sha


def _load_gate(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ControlError(f"gate manifest unavailable: {type(exc).__name__}") from exc
    if not isinstance(value, dict):
        raise ControlError("gate manifest must be an object")
    return value


def _evidence_path(
    raw_path: Any,
    evidence_root: Path,
    *,
    label: str,
    must_exist: bool = True,
) -> Path:
    if not isinstance(raw_path, str) or not raw_path:
        raise ControlError(f"{label} path is missing")
    root = Path(os.path.abspath(evidence_root))
    path = _reject_symlink_path(Path(raw_path), root)
    if must_exist and not path.is_file():
        raise ControlError(f"{label} path is missing")
    return path


def _worktree_proof(worktree: Path, candidate_sha: str) -> dict[str, str]:
    root = worktree.resolve()
    if not root.is_dir():
        raise ControlError("gate cwd is not a directory")
    top = Path(_git(root, ["rev-parse", "--show-toplevel"])).resolve()
    if top != root:
        raise ControlError("gate cwd must be the Git worktree root")
    head = _git(root, ["rev-parse", "HEAD^{commit}"])
    if head != candidate_sha:
        raise ControlError("gate worktree HEAD is not the candidate")
    tree = _git(root, ["rev-parse", "HEAD^{tree}"])
    if not SHA_RE.fullmatch(tree):
        raise ControlError("gate worktree tree id is invalid")
    flags = _git(root, ["ls-files", "-v"])
    hidden = [
        line
        for line in flags.splitlines()
        if line and (line[0].islower() or line[0] == "S")
    ]
    if hidden:
        raise ControlError("gate worktree has assume-unchanged or skip-worktree files")
    if _git_status(root, ["diff-files", "--quiet", "--ignore-submodules", "--"]) != 0:
        raise ControlError("gate worktree tracked bytes differ from the candidate")
    if _git_status(root, ["diff-index", "--cached", "--quiet", "HEAD", "--"]) != 0:
        raise ControlError("gate worktree index differs from the candidate")
    status = _git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
    if status:
        raise ControlError("gate worktree is dirty")
    lockfile = _git(
        root, ["ls-files", "--error-unmatch", "ui-opentui/package-lock.json"]
    )
    if lockfile != "ui-opentui/package-lock.json":
        raise ControlError("OpenTUI package lockfile is not committed")
    return {
        "worktree": str(root),
        "head_sha": head,
        "tree_sha": tree,
        "status_porcelain": status,
    }


def _validate_recorded_worktree(value: Any, candidate_sha: str) -> Path:
    if not isinstance(value, dict) or set(value) != {
        "worktree",
        "before",
        "after",
    }:
        raise ControlError("gate worktree proof has an invalid shape")
    worktree = value.get("worktree")
    before, after = value.get("before"), value.get("after")
    if not isinstance(worktree, str) or not worktree:
        raise ControlError("gate worktree proof is missing its path")
    expected_keys = {"head_sha", "tree_sha", "status_porcelain"}
    if (
        not isinstance(before, dict)
        or not isinstance(after, dict)
        or set(before) != expected_keys
        or set(after) != expected_keys
    ):
        raise ControlError("gate worktree snapshots have an invalid shape")
    if (
        before["head_sha"] != candidate_sha
        or after["head_sha"] != candidate_sha
        or before["tree_sha"] != after["tree_sha"]
        or before["status_porcelain"] != ""
        or after["status_porcelain"] != ""
    ):
        raise ControlError("gate worktree proof is not clean and candidate-bound")
    current = _worktree_proof(Path(worktree), candidate_sha)
    if current["tree_sha"] != after["tree_sha"]:
        raise ControlError("gate worktree tree changed after proof capture")
    return Path(worktree).resolve()


def _is_focused_contract_command(argv: list[str]) -> bool:
    denied = {
        "--collect-only",
        "--co",
        "--list",
        "--help",
        "-h",
        "--version",
        "--dry-run",
    }
    if any(
        arg in denied
        or any(arg.startswith(f"{flag}=") for flag in denied if flag.startswith("--"))
        for arg in argv
    ):
        return False
    pytest_args = None
    if argv[: len(SHARED_VENV_PYTEST_PREFIX)] == SHARED_VENV_PYTEST_PREFIX:
        pytest_args = argv[len(SHARED_VENV_PYTEST_PREFIX) :]
    elif argv[:3] == ["uv", "run", "pytest"]:
        pytest_args = argv[3:]
    elif argv[:5] == ["uv", "run", "--with", "pytest", "pytest"]:
        # Fresh detached worktrees do not necessarily have pytest installed in
        # their shared project venv. Keep the dependency declaration fixed and
        # explicit instead of mutating the candidate environment before the
        # trusted gate can run.
        pytest_args = argv[5:]
    elif argv[:7] == [
        "uv",
        "run",
        "--with",
        "pytest",
        "--with",
        "pytest-asyncio",
        "pytest",
    ]:
        # Async upstream contracts need one additional, fixed plugin. Do not
        # accept arbitrary repeated --with values at this trust boundary.
        pytest_args = argv[7:]
    if pytest_args is not None:
        return bool(pytest_args) and any(
            "::" in arg or arg.endswith(".py") or "/tests/" in f"/{arg}"
            for arg in pytest_args
        )
    # Run the already-installed Vitest entrypoint directly under pinned Node 26.
    # The runtime supplies ui-opentui as cwd; no candidate-controlled npm script
    # or npm-exec package resolution participates in this trusted gate.
    vitest_prefix = [
        str(NODE26),
        "node_modules/vitest/vitest.mjs",
        "run",
    ]
    vitest_args = argv[len(vitest_prefix) :]
    return (
        argv[: len(vitest_prefix)] == vitest_prefix
        and bool(vitest_args)
        and all(
            not arg.startswith("-")
            and (
                arg.endswith((".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"))
                or "/test" in arg
            )
            for arg in vitest_args
        )
    )


def _validate_code_command(gate_id: str, argv: list[str]) -> None:
    expected = CANONICAL_CODE_GATES.get(gate_id)
    if expected is not None and argv != expected:
        raise ControlError(f"{gate_id} must use its canonical command")
    if gate_id == "focused-contracts" and not _is_focused_contract_command(argv):
        raise ControlError("focused-contracts must run targeted pytest or vitest")


def _focused_output_proves_execution(argv: list[str], output: str) -> bool:
    plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output)
    if (
        argv[: len(SHARED_VENV_PYTEST_PREFIX)] == SHARED_VENV_PYTEST_PREFIX
        or argv[:3] == ["uv", "run", "pytest"]
        or argv[:5] == ["uv", "run", "--with", "pytest", "pytest"]
        or argv[:7]
        == [
            "uv",
            "run",
            "--with",
            "pytest",
            "--with",
            "pytest-asyncio",
            "pytest",
        ]
    ):
        counts = re.findall(r"\b(\d+)\s+(?:passed|failed|xfailed|xpassed)\b", plain)
        return sum(int(value) for value in counts) > 0
    counts = re.findall(r"\bTests\s+(\d+)\s+(?:passed|failed)\b", plain)
    return sum(int(value) for value in counts) > 0


def _validate_node_runtime() -> dict[str, str]:
    if not NODE26.is_file() or not NPM26.exists():
        raise ControlError("pinned Node 26 runtime is unavailable")
    result = subprocess.run(
        [str(NODE26), "--version"],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
        env={**os.environ, "PATH": CONTROLLED_PATH},
    )
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)\s*", result.stdout)
    if result.returncode != 0 or match is None:
        raise ControlError("pinned Node version could not be verified")
    version = tuple(int(value) for value in match.groups())
    if version < (26, 3, 0) or version >= (27, 0, 0):
        raise ControlError("OpenTUI gates require Node >=26.3 and <27")
    return {
        "node": str(NODE26),
        "version": result.stdout.strip(),
        "path": CONTROLLED_PATH,
    }


def _review_diff_hash(repo: Path, base_sha: str, candidate_sha: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), "diff", "--binary", base_sha, candidate_sha, "--"],
        check=False,
        capture_output=True,
        timeout=180,
    )
    if result.returncode != 0:
        raise ControlError("could not produce the reviewed candidate diff")
    return hashlib.sha256(result.stdout).hexdigest()


def validate_gate_manifest(
    repo: Path,
    manifest_path: Path,
    *,
    base_sha: str,
    candidate_sha: str,
    token: str,
    branch: str = BRANCH,
) -> dict[str, Any]:
    value = _load_gate(manifest_path)
    if (
        value.get("schema_version") != GATE_SCHEMA_VERSION
        or value.get("branch") != branch
    ):
        raise ControlError("gate manifest schema or branch is invalid")
    if value.get("base_sha") != base_sha or value.get("candidate_sha") != candidate_sha:
        raise ControlError(
            "gate manifest does not bind the requested base and candidate"
        )
    _validate_recorded_worktree(value.get("worktree_proof"), candidate_sha)
    if value.get("lease_token_sha256") != hashlib.sha256(token.encode()).hexdigest():
        raise ControlError("gate manifest is not bound to the active run lease")
    checks = value.get("checks")
    if not isinstance(checks, list):
        raise ControlError("gate manifest checks must be a list")
    seen: set[str] = set()
    review_log: Path | None = None
    for check in checks:
        if not isinstance(check, dict) or set(check) != {
            "id",
            "argv",
            "exit_code",
            "status",
            "output_path",
            "output_sha256",
        }:
            raise ControlError("gate check has an invalid shape")
        gate_id = check.get("id")
        argv = check.get("argv")
        if not isinstance(gate_id, str) or gate_id in seen:
            raise ControlError("gate ids must be unique strings")
        if (
            not isinstance(argv, list)
            or not argv
            or not all(isinstance(v, str) for v in argv)
        ):
            raise ControlError("gate argv must be a nonempty fixed argument vector")
        _validate_code_command(gate_id, argv)
        output_path, output_hash = check.get("output_path"), check.get("output_sha256")
        if (
            not isinstance(output_path, str)
            or not output_path
            or not isinstance(output_hash, str)
            or len(output_hash) != 64
        ):
            raise ControlError("gate output evidence is invalid")
        evidence_root = Path(os.path.abspath(manifest_path.parent / "gate-logs"))
        try:
            resolved_output = _evidence_path(
                output_path, evidence_root, label="gate output"
            )
        except ControlError as exc:
            raise ControlError(
                "gate output evidence is missing, escaped, or changed"
            ) from exc
        if _file_sha256(resolved_output) != output_hash:
            raise ControlError("gate output evidence is missing, escaped, or changed")
        if check.get("status") != "passed" or check.get("exit_code") != 0:
            raise ControlError(f"gate did not pass: {gate_id}")
        seen.add(gate_id)
        if gate_id == "adversarial-review":
            review_log = resolved_output
    missing = REQUIRED_GATES - seen
    if missing:
        raise ControlError(
            "required gate evidence missing: " + ", ".join(sorted(missing))
        )
    binding = value.get("run_binding")
    if (
        not isinstance(binding, dict)
        or set(binding)
        != {
            "mode",
            "request_sha256",
            "last_synced_upstream",
            "captured_upstream",
            "captured_base",
        }
        or binding.get("mode") not in {"scheduled", "backport"}
    ):
        raise ControlError("gate manifest run binding is invalid")
    proof = value.get("review_proof")
    if not isinstance(proof, dict) or review_log is None:
        raise ControlError("gate manifest review proof is missing")
    try:
        logged_proof = json.loads(review_log.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ControlError("gate manifest review proof is invalid") from exc
    if proof != logged_proof:
        raise ControlError("gate manifest review proof does not match hashed evidence")
    expected_review_mode = (
        "upstream-merge" if binding["mode"] == "scheduled" else "linear-candidate"
    )
    if proof.get("review_mode") != expected_review_mode:
        raise ControlError("gate manifest review mode does not match run binding")
    resolved_base = _git(repo, ["rev-parse", f"{base_sha}^{{commit}}"])
    resolved_candidate = _git(repo, ["rev-parse", f"{candidate_sha}^{{commit}}"])
    if resolved_base != base_sha or resolved_candidate != candidate_sha:
        raise ControlError("gate commit ids do not resolve exactly")
    return value


def _remote_sha(repo: Path, remote: str, branch: str) -> str:
    output = _git(repo, ["ls-remote", "--heads", remote, f"refs/heads/{branch}"])
    parts = output.split()
    if len(parts) != 2 or not SHA_RE.fullmatch(parts[0]):
        raise ControlError("could not resolve the remote branch exactly")
    return parts[0]


def _journal_path(state_dir: Path) -> Path:
    return state_dir / "publish-journal.json"


def _load_publish_journal(state_dir: Path) -> dict[str, Any] | None:
    path = _journal_path(state_dir)
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ControlError("publish journal is invalid") from exc
    required = {
        "schema_version",
        "phase",
        "repo",
        "remote",
        "branch",
        "base_sha",
        "candidate_sha",
        "manifest_path",
        "manifest_sha256",
        "evidence_dir",
        "worktree",
        "upstream_sha",
        "run_binding",
        "prepared_unix",
    }
    if (
        not isinstance(value, dict)
        or not required.issubset(value)
        or value.get("schema_version") != 1
        or value.get("phase")
        not in {"prepared", "published", "finalizing", "finalized", "aborted"}
        or not SHA_RE.fullmatch(str(value.get("base_sha", "")))
        or not SHA_RE.fullmatch(str(value.get("candidate_sha", "")))
    ):
        raise ControlError("publish journal has an invalid shape")
    manifest = Path(str(value["manifest_path"]))
    if not manifest.is_file() or _file_sha256(manifest) != value["manifest_sha256"]:
        raise ControlError("publish journal manifest evidence changed")
    return value


def _publication_identity(value: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(
        value[key]
        for key in (
            "repo",
            "remote",
            "branch",
            "base_sha",
            "candidate_sha",
            "manifest_path",
            "manifest_sha256",
            "evidence_dir",
        )
    )


def ship_candidate(
    repo: Path,
    manifest_path: Path,
    *,
    state_dir: Path,
    base_sha: str,
    candidate_sha: str,
    token: str,
    remote: str = REMOTE,
    branch: str = BRANCH,
) -> None:
    """Publish a proven candidate without touching the local daily-driver ref."""
    manifest = validate_gate_manifest(
        repo,
        manifest_path,
        base_sha=base_sha,
        candidate_sha=candidate_sha,
        token=token,
        branch=branch,
    )
    if _git_status(repo, ["merge-base", "--is-ancestor", base_sha, candidate_sha]) != 0:
        raise ControlError("candidate is not a fast-forward of the captured base")
    # Fence publication with the same lock used by lease claim/renew/release.
    # The live token is checked at the last possible point and no replacement
    # holder can take ownership between that check and the remote CAS.
    with _lease_lock(state_dir):
        lease = _lease_value(state_dir)
        _validate_lease_value(lease, token, int(time.time()))
        # All expensive implementation and acceptance work is complete. Bound
        # the only remaining crash window before touching the remote so a
        # post-push process death can be retried after minutes, not six hours.
        lease["expires_unix"] = int(time.time()) + POST_PUBLISH_LEASE_TTL_SECONDS
        _atomic_json(state_dir / "run.lease.json", lease)
        prepared = {
            "schema_version": 1,
            "phase": "prepared",
            "repo": str(repo.resolve()),
            "remote": remote,
            "branch": branch,
            "base_sha": base_sha,
            "candidate_sha": candidate_sha,
            "manifest_path": str(manifest_path.resolve()),
            "manifest_sha256": _file_sha256(manifest_path),
            "evidence_dir": str(manifest_path.parent.resolve()),
            "worktree": manifest["worktree_proof"]["worktree"],
            "upstream_sha": manifest["review_proof"].get("upstream_sha"),
            "run_binding": manifest["run_binding"],
            "prepared_unix": int(time.time()),
        }
        prior = _load_publish_journal(state_dir)
        if prior is not None and prior["phase"] not in {"finalized", "aborted"}:
            if _publication_identity(prior) != _publication_identity(prepared):
                raise ControlError("another publication requires finalization first")
            prepared = prior
        else:
            _atomic_json(_journal_path(state_dir), prepared)
        current_remote = _remote_sha(repo, remote, branch)
        if current_remote not in {base_sha, candidate_sha}:
            raise ControlError("remote branch moved since base capture")
        if current_remote == base_sha:
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repo),
                    "push",
                    "--porcelain",
                    f"--force-with-lease=refs/heads/{branch}:{base_sha}",
                    remote,
                    f"{candidate_sha}:refs/heads/{branch}",
                ],
                capture_output=True,
                text=True,
                timeout=180,
            )
            reconciled = _remote_sha(repo, remote, branch)
            if reconciled != candidate_sha:
                raise ControlError("guarded remote fast-forward was refused")
        published = {
            **prepared,
            "phase": "published",
            "published_unix": int(time.time()),
        }
        _atomic_json(_journal_path(state_dir), published)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@contextmanager
def _worker_slot(state_dir: Path, token: str) -> Iterator[tuple[Path, int, str]]:
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_path = state_dir / "worker-slots.lock"
    with lock_path.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        chosen: Path | None = None
        for index in range(WORKER_SLOT_COUNT):
            slot = state_dir / f"worker-slot-{index}.json"
            if slot.exists():
                try:
                    value = json.loads(slot.read_text(encoding="utf-8"))
                    alive = isinstance(value, dict) and _pid_alive(
                        int(value.get("pid", 0))
                    )
                except (OSError, ValueError, TypeError, json.JSONDecodeError):
                    alive = False
                if not alive:
                    slot.unlink(missing_ok=True)
            if chosen is None and not slot.exists():
                chosen = slot
        if chosen is None:
            raise ControlError("two worker packets are already running")
        started = int(time.time())
        slot_id = f"{os.getpid()}-{time.time_ns()}"
        _atomic_json(
            chosen,
            {
                "token": token,
                "pid": os.getpid(),
                "start_unix": started,
                "slot_id": slot_id,
            },
        )
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    try:
        yield chosen, started, slot_id
    finally:
        with lock_path.open("a+", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                value = json.loads(chosen.read_text(encoding="utf-8"))
            except (OSError, ValueError, json.JSONDecodeError):
                value = None
            if (
                isinstance(value, dict)
                and value.get("token") == token
                and value.get("start_unix") == started
                and value.get("slot_id") == slot_id
            ):
                chosen.unlink(missing_ok=True)


def _set_worker_pid(
    slot: Path, token: str, started: int, slot_id: str, pid: int
) -> None:
    _atomic_json(
        slot, {"token": token, "pid": pid, "start_unix": started, "slot_id": slot_id}
    )


def _terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    process.wait(timeout=5)


def run_packet(packet_path: Path, *, cwd: Path, state_dir: Path, token: str) -> int:
    """Run a fixed-argv packet under a two-worker, process-group-safe lease."""
    evidence_root = Path(os.path.abspath(packet_path.parent))
    packet_path = _evidence_path(str(packet_path), evidence_root, label="task packet")
    try:
        packet = json.loads(packet_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ControlError(f"invalid task packet: {type(exc).__name__}") from exc
    if not isinstance(packet, dict) or set(packet) != {
        "argv",
        "stdin",
        "stdout",
        "stderr",
    }:
        raise ControlError("task packet must contain argv and explicit stream files")
    argv = packet["argv"]
    if (
        not isinstance(argv, list)
        or not argv
        or not all(isinstance(v, str) for v in argv)
    ):
        raise ControlError("task packet argv must be a nonempty string list")
    stdin_path = _evidence_path(packet.get("stdin"), evidence_root, label="stdin")
    stdout_path = _safe_output_path(evidence_root, Path(str(packet.get("stdout"))).name)
    stderr_path = _safe_output_path(evidence_root, Path(str(packet.get("stderr"))).name)
    if str(stdout_path) != os.path.abspath(str(packet.get("stdout"))) or str(
        stderr_path
    ) != os.path.abspath(str(packet.get("stderr"))):
        raise ControlError("task packet output paths must be direct evidence files")
    with _worker_slot(state_dir, token) as (slot, started, slot_id):
        with (
            stdin_path.open("rb") as incoming,
            stdout_path.open("wb") as outgoing,
            stderr_path.open("wb") as errors,
        ):
            process = subprocess.Popen(
                argv,
                cwd=cwd,
                shell=False,
                stdin=incoming,
                stdout=outgoing,
                stderr=errors,
                start_new_session=True,
            )
            _set_worker_pid(slot, token, started, slot_id, process.pid)
            try:
                return process.wait(timeout=PACKET_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired as exc:
                _terminate_process_group(process)
                raise ControlError(
                    "worker packet exceeded the four-hour lease-safe timeout"
                ) from exc


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verified_file(
    value: Any,
    path_key: str,
    hash_key: str,
    evidence_root: Path,
) -> Path:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get(path_key), str)
        or not isinstance(value.get(hash_key), str)
    ):
        raise ControlError(f"missing evidence fields: {path_key}, {hash_key}")
    path = _evidence_path(value[path_key], evidence_root, label=path_key)
    if path.stat().st_size <= 0 or _file_sha256(path) != value[hash_key]:
        raise ControlError(f"evidence file failed verification: {path_key}")
    return path


def _run_termctrl(
    argv: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[bytes]:
    if not TERMCTRL.is_file():
        raise ControlError("pinned termctrl binary was not found")
    result = subprocess.run(
        [str(TERMCTRL), *argv],
        check=False,
        capture_output=True,
        timeout=600,
        cwd=cwd,
        env=env,
    )
    if result.returncode != 0:
        raise ControlError(f"termctrl command failed: {argv[0]}")
    return result


def _marker_names(value: Any) -> tuple[set[str], dict[str, int]]:
    entries = value.get("markers") if isinstance(value, dict) else value
    if not isinstance(entries, list):
        raise ControlError("termctrl markers output was not a list")
    names: set[str] = set()
    times: dict[str, int] = {}
    for entry in entries:
        if isinstance(entry, str):
            names.add(entry)
        elif isinstance(entry, dict) and isinstance(entry.get("name"), str):
            name = entry["name"]
            names.add(name)
            for key in ("at_ms", "timestamp_ms", "elapsed_ms"):
                if isinstance(entry.get(key), int):
                    times[name] = entry[key]
                    break
    return names, times


def _validate_drive(value: Any) -> tuple[int, int, list[dict[str, Any]], list[str]]:
    if not isinstance(value, dict) or set(value) != {
        "cols",
        "rows",
        "actions",
        "required_text",
    }:
        raise ControlError("termctrl drive packet has an invalid shape")
    cols, rows = value.get("cols"), value.get("rows")
    actions, required = value.get("actions"), value.get("required_text")
    if (
        not isinstance(cols, int)
        or not 80 <= cols <= 200
        or not isinstance(rows, int)
        or not 24 <= rows <= 80
    ):
        raise ControlError("termctrl dimensions are outside bounded limits")
    if not isinstance(actions, list) or not 1 <= len(actions) <= 8:
        raise ControlError("termctrl drive requires one to eight actions")
    allowed_keys = {
        "enter",
        "escape",
        "up",
        "down",
        "left",
        "right",
        "tab",
        "backspace",
        "ctrl-c",
    }
    for action in actions:
        if not isinstance(action, dict) or set(action) != {
            "send",
            "wait",
            "timeout_ms",
        }:
            raise ControlError("termctrl action has an invalid shape")
        atoms, wait, timeout_ms = (
            action.get("send"),
            action.get("wait"),
            action.get("timeout_ms"),
        )
        if (
            not isinstance(atoms, list)
            or not 1 <= len(atoms) <= 8
            or not all(isinstance(atom, str) for atom in atoms)
        ):
            raise ControlError("termctrl send atoms are invalid")
        for atom in atoms:
            if atom not in allowed_keys and not (
                atom.startswith("text:")
                and 5 < len(atom) <= 261
                and "\n" not in atom
                and "\r" not in atom
            ):
                raise ControlError("termctrl send atom is not allowlisted")
        if not isinstance(wait, str) or not wait.strip() or len(wait) > 200:
            raise ControlError("termctrl wait text is invalid")
        if not isinstance(timeout_ms, int) or not 1_000 <= timeout_ms <= 120_000:
            raise ControlError("termctrl wait timeout is outside bounded limits")
    if (
        not isinstance(required, list)
        or not required
        or not all(
            isinstance(text, str) and text.strip() and len(text) <= 200
            for text in required
        )
    ):
        raise ControlError("termctrl drive must require visible acceptance text")
    if actions[-1]["wait"] not in required:
        raise ControlError("termctrl final wait text must be required at acceptance")
    if (
        actions[0]["send"] != ["text:/help", "enter"]
        or actions[0]["wait"] != "Available Commands"
        or not {"Hermes Agent", "Available Commands"}.issubset(required)
    ):
        raise ControlError(
            "termctrl drive must begin with the canonical /help acceptance flow"
        )
    return cols, rows, actions, required


def _wait_for_hydrated_session(
    session: str,
    *,
    cwd: Path,
    env: dict[str, str],
    timeout_seconds: float = TERMCTRL_HYDRATION_TIMEOUT_SECONDS,
) -> str:
    """Wait for backend hydration, not merely the optimistic ready header."""
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        visible = _run_termctrl(
            ["show", session], cwd=cwd, env=env
        ).stdout.decode("utf-8", errors="replace")
        starting = "starting session…" in visible or "starting session..." in visible
        if "Welcome to Hermes Agent!" in visible and not starting:
            return visible
        time.sleep(TERMCTRL_HYDRATION_POLL_SECONDS)
    raise ControlError("OpenTUI did not finish session hydration before smoke actions")


def verify_termctrl_drive(
    value: Any, evidence_root: Path, candidate: Path
) -> dict[str, Any]:
    cols, rows, actions, required_text = _validate_drive(value)
    generated = _safe_output_path(
        evidence_root, "termctrl-verified", "placeholder"
    ).parent
    recording = _safe_output_path(generated, "run.termctrl")
    marker_path = _safe_output_path(generated, "markers.json")
    text_path = _safe_output_path(generated, "accepted.txt")
    png_path = _safe_output_path(generated, "accepted.png")
    video_path = _safe_output_path(generated, "acceptance.mp4")
    edit_path = _safe_output_path(generated, "video-edit.json")
    for output in (
        recording,
        marker_path,
        text_path,
        png_path,
        video_path,
        edit_path,
    ):
        output.unlink(missing_ok=True)
    session = f"maintainer-{os.getpid()}-{time.time_ns()}"
    if not FORK_VENV_PYTHON.is_file():
        raise ControlError("the fork dependency-complete Python runtime is unavailable")
    child_env = {
        **os.environ,
        "PATH": CONTROLLED_PATH,
        "PYTHONPATH": str(candidate),
        "HERMES_PYTHON": str(FORK_VENV_PYTHON),
        "HERMES_PYTHON_SRC_ROOT": str(candidate),
        "HERMES_TUI_ENGINE": "opentui",
        "HERMES_CWD": str(candidate),
    }
    child_env.pop("PYTHONHOME", None)
    launch = [
        "start",
        session,
        "--host",
        "opentui",
        "--cols",
        str(cols),
        "--rows",
        str(rows),
        "--record",
        str(recording),
        "--",
        str(FORK_VENV_PYTHON),
        "-m",
        "hermes_cli.main",
        "--tui",
        "--yolo",
    ]
    started = False
    try:
        _run_termctrl(launch, cwd=candidate, env=child_env)
        started = True
        _run_termctrl(
            ["wait", session, "opentui · ready", "--timeout", "60000"],
            cwd=candidate,
            env=child_env,
        )
        _wait_for_hydrated_session(session, cwd=candidate, env=child_env)
        _run_termctrl(["mark", session, "ready"], cwd=candidate, env=child_env)
        time.sleep(TERMCTRL_READY_HOLD_SECONDS)
        for action in actions:
            before = _run_termctrl(
                ["show", session], cwd=candidate, env=child_env
            ).stdout.decode("utf-8", errors="replace")
            if action["wait"].casefold() in before.casefold():
                raise ControlError(
                    "termctrl wait text was already visible before action"
                )
            _run_termctrl(
                ["send", session, *action["send"]], cwd=candidate, env=child_env
            )
            _run_termctrl(
                [
                    "wait",
                    session,
                    action["wait"],
                    "--timeout",
                    str(action["timeout_ms"]),
                ],
                cwd=candidate,
                env=child_env,
            )
            after = _run_termctrl(
                ["show", session], cwd=candidate, env=child_env
            ).stdout.decode("utf-8", errors="replace")
            if action["wait"].casefold() not in after.casefold():
                raise ControlError("termctrl wait text was not visible after action")
        _run_termctrl(["mark", session, "accepted"], cwd=candidate, env=child_env)
        shown = _run_termctrl(["show", session], cwd=candidate, env=child_env).stdout
        text_path.write_bytes(shown)
        visible = shown.decode("utf-8", errors="replace")
        if not all(text in visible for text in required_text):
            raise ControlError("accepted frame is missing required visible text")
    finally:
        if started:
            try:
                _run_termctrl(["stop", session], cwd=candidate, env=child_env)
            except ControlError:
                pass
    marker_result = _run_termctrl(
        ["markers", str(recording), "--json"], cwd=candidate, env=child_env
    )
    marker_path.write_bytes(marker_result.stdout)
    try:
        marker_value = json.loads(marker_result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ControlError("termctrl markers output was invalid JSON") from exc
    names, times = _marker_names(marker_value)
    if not {"ready", "accepted"}.issubset(names):
        raise ControlError("recording is missing ready or accepted markers")
    if "ready" in times and "accepted" in times:
        elapsed = times["accepted"] - times["ready"]
        if elapsed < 0:
            raise ControlError("recording accepted marker precedes ready marker")
        if elapsed < TERMCTRL_MIN_ACTION_TIMELINE_MS:
            raise ControlError("recording is too short to show the tested interaction")
    _run_termctrl(
        [
            "save",
            "--recording",
            str(recording),
            "--at-marker",
            "accepted",
            "--format",
            "png",
            "--out",
            str(png_path),
        ],
        cwd=candidate,
        env=child_env,
    )
    _atomic_json(edit_path, {"clips": [{"from": "ready", "to": "accepted"}]})
    _run_termctrl(
        [
            "video",
            str(recording),
            "--edit",
            str(edit_path),
            "--tail-ms",
            str(VIDEO_TAIL_MS),
            "--out",
            str(video_path),
        ],
        cwd=candidate,
        env=child_env,
    )
    for output in (recording, marker_path, text_path, png_path, video_path, edit_path):
        if not output.is_file() or output.is_symlink() or output.stat().st_size <= 0:
            raise ControlError(f"termctrl did not regenerate {output.name}")
    return {
        "launch_argv": launch,
        "recording_path": str(recording),
        "recording_sha256": _file_sha256(recording),
        "markers_path": str(marker_path),
        "markers_sha256": _file_sha256(marker_path),
        "text_path": str(text_path),
        "text_sha256": _file_sha256(text_path),
        "png_path": str(png_path),
        "png_sha256": _file_sha256(png_path),
        "video_path": str(video_path),
        "video_sha256": _file_sha256(video_path),
        "video_edit_path": str(edit_path),
        "video_edit_sha256": _file_sha256(edit_path),
    }


def _candidate_diff(repo: Path, base_sha: str, candidate_sha: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repo), "diff", "--binary", base_sha, candidate_sha, "--"],
        check=False,
        capture_output=True,
        timeout=180,
    )
    if result.returncode != 0:
        raise ControlError("could not produce the reviewed candidate diff")
    return result.stdout


def _commit_parents(repo: Path, commit: str) -> list[str]:
    line = _git(repo, ["show", "-s", "--format=%P", commit])
    parents = line.split()
    if not all(SHA_RE.fullmatch(parent) for parent in parents):
        raise ControlError("candidate ancestry contains an invalid parent")
    return parents


def _first_parent_commits(repo: Path, base_sha: str, candidate_sha: str) -> list[str]:
    if _git_status(repo, ["merge-base", "--is-ancestor", base_sha, candidate_sha]) != 0:
        raise ControlError("review candidate is not a descendant of the captured base")
    output = _git(
        repo,
        ["rev-list", "--first-parent", "--reverse", f"{base_sha}..{candidate_sha}"],
    )
    commits = output.splitlines() if output else []
    if not commits or not all(SHA_RE.fullmatch(commit) for commit in commits):
        raise ControlError("review candidate has no valid first-parent delta")
    return commits


def _synthetic_merge_tree(repo: Path, base_sha: str, upstream_sha: str) -> str:
    result = subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "merge-tree",
            "--write-tree",
            base_sha,
            upstream_sha,
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=180,
    )
    # Git returns 1 when conflicts exist while still emitting the deterministic
    # conflicted tree as the first stdout line.
    if result.returncode not in {0, 1}:
        raise ControlError("could not derive the synthetic upstream merge tree")
    first_line = result.stdout.splitlines()[0].strip() if result.stdout else ""
    if not SHA_RE.fullmatch(first_line):
        raise ControlError("synthetic upstream merge did not produce a tree")
    if _git_status(repo, ["cat-file", "-e", f"{first_line}^{{tree}}"]):
        raise ControlError("synthetic upstream merge tree is unavailable")
    return first_line


def _trusted_git_environment(root: Path) -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("GIT_")
        and key not in {"HOME", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK"}
    }
    env.update(
        {
            "HOME": str(root),
            "XDG_CONFIG_HOME": str(root / "xdg"),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_TERMINAL_PROMPT": "0",
        }
    )
    return env


def _trusted_upstream_tip(repo: Path) -> str:
    """Fetch canonical main without honoring repository or user Git config."""
    with tempfile.TemporaryDirectory(prefix="hermes-upstream-quarantine-") as raw:
        root = Path(raw)
        quarantine = root / "repo.git"
        bundle = root / "canonical.bundle"
        env = _trusted_git_environment(root)

        def trusted_git(
            *args: str, timeout_seconds: int = 180
        ) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [
                    "/usr/bin/git",
                    "-c",
                    "protocol.allow=never",
                    "-c",
                    "protocol.https.allow=always",
                    *args,
                ],
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                env=env,
            )

        if trusted_git("init", "--bare", "--template=", str(quarantine)).returncode:
            raise ControlError("could not initialize canonical upstream quarantine")
        fetched: subprocess.CompletedProcess[str] | None = None
        for attempt in range(TRUSTED_FETCH_ATTEMPTS):
            try:
                fetched = trusted_git(
                    "-C",
                    str(quarantine),
                    "fetch",
                    "--no-tags",
                    "--force",
                    "--quiet",
                    UPSTREAM_URL,
                    "refs/heads/main:refs/heads/main",
                    timeout_seconds=TRUSTED_FETCH_TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired:
                fetched = None
            if fetched is not None and fetched.returncode == 0:
                break
            if attempt + 1 < TRUSTED_FETCH_ATTEMPTS:
                time.sleep(2**attempt)
        if fetched is None or fetched.returncode != 0:
            raise ControlError("could not resolve canonical upstream main")
        resolved = trusted_git(
            "-C", str(quarantine), "rev-parse", "refs/heads/main^{commit}"
        )
        tip = resolved.stdout.strip()
        if resolved.returncode or not SHA_RE.fullmatch(tip):
            raise ControlError("canonical upstream main is not a full commit id")
        created = trusted_git(
            "-C", str(quarantine), "bundle", "create", str(bundle), "refs/heads/main"
        )
        if created.returncode:
            raise ControlError("could not package canonical upstream objects")
        imported = trusted_git("-C", str(repo), "bundle", "unbundle", str(bundle))
        if imported.returncode:
            raise ControlError("could not import canonical upstream objects")
        if _git_status(repo, ["cat-file", "-e", f"{tip}^{{commit}}"]):
            raise ControlError("canonical upstream commit was not imported")
        return tip


def _review_scope(
    repo: Path,
    base_sha: str,
    candidate_sha: str,
    expected_mode: str | None = None,
    last_synced_upstream: str | None = None,
    captured_upstream: str | None = None,
) -> dict[str, Any]:
    """Derive the trusted-upstream boundary and fork-owned review ranges."""
    commits = _first_parent_commits(repo, base_sha, candidate_sha)
    first = commits[0]
    parents = _commit_parents(repo, first)
    if len(parents) == 1:
        if expected_mode == "scheduled":
            raise ControlError("scheduled review requires an upstream merge candidate")
        if any(len(_commit_parents(repo, commit)) != 1 for commit in commits):
            raise ControlError("linear review candidate contains a hidden merge")
        return {
            "mode": "linear-candidate",
            "ranges": [("candidate", base_sha, candidate_sha)],
            "upstream_sha": None,
            "merge_commit": None,
            "synthetic_merge_tree": None,
        }
    if len(parents) != 2 or parents[0] != base_sha:
        raise ControlError(
            "scheduled review candidate must begin with a two-parent upstream merge"
        )
    if expected_mode == "backport":
        raise ControlError("manual backport review requires a linear candidate")
    if any(len(_commit_parents(repo, commit)) != 1 for commit in commits[1:]):
        raise ControlError("post-merge adaptation history must be linear")
    upstream_sha = parents[1]
    if expected_mode == "scheduled":
        if not isinstance(captured_upstream, str) or not SHA_RE.fullmatch(
            captured_upstream
        ):
            raise ControlError("scheduled review has no captured upstream snapshot")
        if upstream_sha != captured_upstream:
            raise ControlError(
                "scheduled review merge parent does not match captured upstream snapshot"
            )
    trusted_tip = _trusted_upstream_tip(repo)
    # Bind the run to the canonical upstream snapshot captured when integration
    # began. A later upstream advance belongs to the next run; it must not
    # starve an otherwise-green candidate. Still fail closed if history was
    # replaced and the captured commit is no longer canonical.
    if _git_status(
        repo,
        ["merge-base", "--is-ancestor", upstream_sha, trusted_tip],
    ):
        raise ControlError(
            "scheduled review merge parent is not in canonical upstream main"
        )
    if _git_status(repo, ["merge-base", "--is-ancestor", upstream_sha, base_sha]) == 0:
        raise ControlError(
            "scheduled review cannot merge an already-integrated upstream"
        )
    if last_synced_upstream is not None:
        if not SHA_RE.fullmatch(last_synced_upstream):
            raise ControlError("last synced upstream marker is invalid")
        if _git_status(
            repo,
            ["merge-base", "--is-ancestor", last_synced_upstream, upstream_sha],
        ):
            raise ControlError(
                "scheduled review would regress canonical upstream history"
            )
    synthetic_tree = _synthetic_merge_tree(repo, base_sha, upstream_sha)
    return {
        "mode": "upstream-merge",
        "ranges": [
            ("conflict-resolution", synthetic_tree, first),
            ("post-merge-adaptation", first, candidate_sha),
        ],
        "upstream_sha": upstream_sha,
        "merge_commit": first,
        "synthetic_merge_tree": synthetic_tree,
    }


def _canonical_range_diff(repo: Path, before: str, after: str) -> bytes:
    result = subprocess.run(
        [
            "git",
            "-c",
            "core.quotePath=true",
            "-C",
            str(repo),
            "diff",
            "--binary",
            "--full-index",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--find-renames",
            "--find-copies-harder",
            "--ignore-submodules=none",
            "--diff-algorithm=myers",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            before,
            after,
            "--",
        ],
        check=False,
        capture_output=True,
        timeout=180,
    )
    if result.returncode != 0:
        raise ControlError("could not produce the canonical bounded review diff")
    return result.stdout


def _split_diff_patches(diff: bytes) -> list[bytes]:
    if not diff:
        return []
    offsets = [match.start() for match in re.finditer(rb"(?m)^diff --git ", diff)]
    if not offsets or offsets[0] != 0:
        raise ControlError("canonical review diff has an invalid patch boundary")
    patches = [
        diff[start:end] for start, end in zip(offsets, [*offsets[1:], len(diff)])
    ]
    if b"".join(patches) != diff:
        raise ControlError("canonical review diff could not be split exactly")
    return patches


def _split_review_patch(patch: bytes, max_bytes: int) -> list[bytes]:
    """Split one canonical file patch losslessly at line boundaries.

    A mechanical extraction can make a single file patch larger than a
    reviewer's practical prompt budget.  The canonical range hash remains the
    integrity proof; these segments are only a transport framing, and must
    concatenate byte-for-byte back to the original patch.
    """
    if max_bytes <= 0:
        raise ControlError("review segment budget must be positive")
    segments: list[bytes] = []
    start = 0
    while start < len(patch):
        end = min(start + max_bytes, len(patch))
        if end < len(patch):
            newline = patch.rfind(b"\n", start, end)
            if newline >= start:
                end = newline + 1
        if end <= start:
            end = min(start + max_bytes, len(patch))
        segments.append(patch[start:end])
        start = end
    if b"".join(segments) != patch:
        raise ControlError("review patch segmentation was not lossless")
    return segments or [b""]


def _review_chunks(
    repo: Path, scope: dict[str, Any]
) -> tuple[list[bytes], list[dict[str, Any]]]:
    chunks: list[bytes] = []
    current = bytearray()
    ranges: list[dict[str, Any]] = []
    for label, before, after in scope["ranges"]:
        canonical = _canonical_range_diff(repo, before, after)
        patches = _split_diff_patches(canonical)
        segmented = [
            _split_review_patch(patch, REVIEW_PROMPT_MAX_BYTES - 1024)
            for patch in patches
        ]
        range_hash = hashlib.sha256(canonical).hexdigest()
        ranges.append(
            {
                "label": label,
                "before": before,
                "after": after,
                "patches": len(patches),
                "segments": sum(len(parts) for parts in segmented),
                "diff_bytes": len(canonical),
                "diff_sha256": range_hash,
            }
        )
        for patch_index, parts in enumerate(segmented, start=1):
            for segment_index, diff in enumerate(parts, start=1):
                framed = (
                    f"\n--- SCOPE {label} PATCH {patch_index}/{len(patches)} "
                    f"SEGMENT {segment_index}/{len(parts)} ---\n".encode()
                    + diff
                )
                if len(framed) > REVIEW_PROMPT_MAX_BYTES:
                    raise ControlError(
                        f"review segment exceeds the bounded reviewer limit: {label}"
                    )
                if current and len(current) + len(framed) > REVIEW_PROMPT_MAX_BYTES:
                    chunks.append(bytes(current))
                    current.clear()
                current.extend(framed)
    if current:
        chunks.append(bytes(current))
    if not chunks:
        chunks = [b"\n(no fork-owned diff; topology proof only)\n"]
    return chunks, ranges


def _run_reviewer(
    argv: list[str], prompt: bytes, cwd: Path
) -> subprocess.CompletedProcess[bytes]:
    process = subprocess.Popen(
        argv,
        cwd=cwd,
        shell=False,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(
            input=prompt, timeout=REVIEW_TIMEOUT_SECONDS
        )
    except subprocess.TimeoutExpired as exc:
        _terminate_process_group(process)
        raise ControlError("adversarial reviewer timed out") from exc
    return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)


def _verified_review_gate_evidence(
    evidence_root: Path, checks: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Authenticate the deterministic checks supplied to final synthesis."""
    if not isinstance(checks, list) or len(checks) != len(REVIEW_PREREQUISITE_GATES):
        raise ControlError("review requires all preceding deterministic gates")
    verified: list[dict[str, Any]] = []
    required_keys = {
        "id",
        "argv",
        "exit_code",
        "status",
        "output_path",
        "output_sha256",
    }
    gate_logs = Path(os.path.abspath(evidence_root / "gate-logs"))
    for expected_id, check in zip(REVIEW_PREREQUISITE_GATES, checks, strict=True):
        if not isinstance(check, dict) or set(check) != required_keys:
            raise ControlError("review gate evidence has an invalid shape")
        gate_id = check.get("id")
        if gate_id != expected_id:
            raise ControlError("review gate evidence is missing or out of order")
        if (
            check.get("status") != "passed"
            or check.get("exit_code") != 0
            or not isinstance(check.get("argv"), list)
            or not all(isinstance(value, str) for value in check["argv"])
        ):
            raise ControlError("review received an unproven deterministic gate")
        _validate_code_command(gate_id, check["argv"])
        path = _evidence_path(
            check.get("output_path"), evidence_root, label=f"{gate_id} output"
        )
        digest = check.get("output_sha256")
        if path.parent != gate_logs or path.name != f"{gate_id}.log":
            raise ControlError("review gate evidence used a noncanonical output path")
        if (
            not isinstance(digest, str)
            or not re.fullmatch(r"[0-9a-f]{64}", digest)
            or _file_sha256(path) != digest
        ):
            raise ControlError("review gate evidence hash mismatch")
        command_sha256 = hashlib.sha256(
            json.dumps(check["argv"], separators=(",", ":")).encode()
        ).hexdigest()
        verified.append({
            "id": gate_id,
            "exit_code": 0,
            "status": "passed",
            "output_sha256": digest,
            "command_sha256": command_sha256,
        })
    return verified


def run_adversarial_review(
    reviewer: Any,
    evidence_root: Path,
    repo: Path,
    base_sha: str,
    candidate_sha: str,
    *,
    expected_mode: str | None = None,
    last_synced_upstream: str | None = None,
    captured_upstream: str | None = None,
    verified_checks: list[dict[str, Any]],
) -> dict[str, Any]:
    if not isinstance(reviewer, dict) or set(reviewer) != {"tool", "model"}:
        raise ControlError("adversarial review must select an allowlisted reviewer")
    key = (reviewer.get("tool"), reviewer.get("model"))
    template = REVIEWER_COMMANDS.get(key)
    verifier_template = REVIEWER_VERIFIER_COMMANDS.get(key)
    if template is None or verifier_template is None:
        raise ControlError("adversarial reviewer tool/model is not allowlisted")
    if not Path(template[0]).is_file() or not Path(verifier_template[0]).is_file():
        raise ControlError("allowlisted adversarial reviewer executable is unavailable")
    gate_evidence = _verified_review_gate_evidence(evidence_root, verified_checks)
    scope = _review_scope(
        repo,
        base_sha,
        candidate_sha,
        expected_mode=expected_mode,
        last_synced_upstream=last_synced_upstream,
        captured_upstream=captured_upstream,
    )
    chunks, ranges = _review_chunks(repo, scope)
    scope_hash = hashlib.sha256(
        json.dumps(ranges, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    review_dir = _safe_output_path(
        evidence_root, "review-verified", "placeholder"
    ).parent
    stdout_path = _safe_output_path(review_dir, "stdout.txt")
    stderr_path = _safe_output_path(review_dir, "stderr.txt")
    stdout_path.unlink(missing_ok=True)
    stderr_path.unlink(missing_ok=True)
    argv = list(template)
    stdout_parts: list[bytes] = []
    stderr_parts: list[bytes] = []
    prompt_hashes: list[str] = []
    for index, chunk in enumerate(chunks, start=1):
        prompt = (
            (
                "Perform an independent adversarial review of this bounded fork-owned sync delta.\n"
                f"BASE_SHA: {base_sha}\nCANDIDATE_SHA: {candidate_sha}\n"
                f"REVIEW_MODE: {scope['mode']}\nREVIEW_SCOPE_SHA256: {scope_hash}\n"
                f"CHUNK: {index}/{len(chunks)}\n"
                "Trusted upstream commits are not reproduced here. The runtime proved the exact merge topology and derived the conflict-resolution baseline with git merge-tree.\n"
                "This reviewer process intentionally has no filesystem, shell, or agent tools. The bounded exact diff below is the complete review input for this chunk. Review it directly: do not ask to run commands, inspect the tree, or defer the verdict to a later turn.\n"
                "Perform the review directly in this process. Do not spawn, delegate to, or invoke other Codex, Claude, or agent processes; the parent maintainer already bounded this review and recursive fan-out violates the gate's resource budget.\n"
                "Find correctness, race, security, UX, and test-fidelity defects. Do not modify files.\n"
                "This is one ordered slice of a multi-range delta. A later slice may intentionally repair code shown here, so report precise provisional findings but do not issue the release verdict yet.\n"
                "For every possible release-blocking issue emit a line beginning exactly CANDIDATE_BLOCKER:.\n"
                "The final non-empty output line must be exactly CHUNK_REVIEW: COMPLETE.\n"
                "--- BEGIN BOUNDED EXACT DIFF ---\n"
            ).encode()
            + chunk
            + b"\n--- END BOUNDED EXACT DIFF ---\n"
        )
        if len(prompt) > REVIEW_PROMPT_MAX_BYTES + 4096:
            raise ControlError("bounded reviewer prompt exceeds the runtime limit")
        prompt_hashes.append(hashlib.sha256(prompt).hexdigest())
        result = _run_reviewer(argv, prompt, repo)
        stdout_parts.append(
            f"--- CHUNK {index}/{len(chunks)} ---\n".encode() + result.stdout
        )
        stderr_parts.append(
            f"--- CHUNK {index}/{len(chunks)} ---\n".encode() + result.stderr
        )
        output = result.stdout.decode("utf-8", errors="replace")
        lines = [line.strip() for line in output.splitlines() if line.strip()]
        if result.returncode != 0:
            stdout_path.write_bytes(b"\n".join(stdout_parts))
            stderr_path.write_bytes(b"\n".join(stderr_parts))
            raise ControlError("adversarial reviewer exited unsuccessfully")
        if not lines or lines[-1] != "CHUNK_REVIEW: COMPLETE":
            stdout_path.write_bytes(b"\n".join(stdout_parts))
            stderr_path.write_bytes(b"\n".join(stderr_parts))
            raise ControlError("adversarial chunk review was incomplete")

    gate_evidence_json = json.dumps(gate_evidence, sort_keys=True, indent=2).encode()
    candidate_before = _worktree_proof(repo, candidate_sha)
    synthesis = (
        "Issue the final release verdict for the complete ordered fork sync delta.\n"
        f"BASE_SHA: {base_sha}\nCANDIDATE_SHA: {candidate_sha}\n"
        f"REVIEW_MODE: {scope['mode']}\nREVIEW_SCOPE_SHA256: {scope_hash}\n"
        "Your cwd is the clean, candidate-bound worktree at CANDIDATE_SHA. You have read-only Read/Grep tools solely to verify provisional findings against the final candidate. Do not use shell, network, writes, edits, or agent delegation.\n"
        f"CANDIDATE_TREE_SHA: {candidate_before['tree_sha']}\n"
        "The runtime authenticated the deterministic gate records below by re-reading each canonical in-root log and matching its SHA-256. Only safe hashes and statuses are included; do not seek or read gate logs. Treat a passed gate as authoritative evidence that its allowlisted command completed successfully.\n"
        "Ranges and chunks are ordered. The conflict-resolution range compares a synthetic conflicted merge tree to the resolved merge commit: lines prefixed '-' are removed from the resolved candidate and MUST NOT be reported as retained conflict markers or live code. A later fork-adaptation slice may repair an earlier finding.\n"
        "Investigate every provisional CANDIDATE_BLOCKER with Read/Grep in the final candidate. Reject only a concrete release blocker proven to remain at an exact final-candidate path. Hypothetical, conditional, stale, or unverified concerns are not blockers.\n"
        "Do not modify files.\n"
        "For every release-blocking issue that remains in the final candidate emit a line beginning exactly BLOCKER:.\n"
        "The final non-empty output line must be exactly VERDICT: APPROVED only when no blocker remains; otherwise VERDICT: REJECTED.\n"
        "--- BEGIN AUTHENTICATED DETERMINISTIC GATE EVIDENCE ---\n"
    ).encode() + gate_evidence_json + (
        "\n--- END AUTHENTICATED DETERMINISTIC GATE EVIDENCE ---\n"
        "--- BEGIN ORDERED CHUNK REVIEWS ---\n"
    ).encode() + b"\n".join(stdout_parts) + b"\n--- END ORDERED CHUNK REVIEWS ---\n"
    if len(synthesis) > REVIEW_PROMPT_MAX_BYTES:
        stdout_path.write_bytes(b"\n".join(stdout_parts))
        stderr_path.write_bytes(b"\n".join(stderr_parts))
        raise ControlError("review synthesis exceeds the bounded reviewer limit")
    prompt_hashes.append(hashlib.sha256(synthesis).hexdigest())
    verifier_argv = list(verifier_template)
    result = _run_reviewer(verifier_argv, synthesis, repo)
    candidate_after = _worktree_proof(repo, candidate_sha)
    if candidate_after["tree_sha"] != candidate_before["tree_sha"]:
        raise ControlError("candidate changed during adversarial review synthesis")
    stdout_parts.append(b"--- SYNTHESIS ---\n" + result.stdout)
    stderr_parts.append(b"--- SYNTHESIS ---\n" + result.stderr)
    stdout_path.write_bytes(b"\n".join(stdout_parts))
    stderr_path.write_bytes(b"\n".join(stderr_parts))
    output = result.stdout.decode("utf-8", errors="replace")
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if result.returncode != 0:
        raise ControlError("adversarial review synthesis exited unsuccessfully")
    if not lines or lines[-1] != "VERDICT: APPROVED" or "BLOCKER:" in output:
        raise ControlError("adversarial review did not approve the candidate")
    return {
        "reviewer": {"tool": key[0], "model": key[1]},
        "argv": verifier_argv,
        "chunk_argv": argv,
        "verifier_argv": verifier_argv,
        "base_sha": base_sha,
        "candidate_sha": candidate_sha,
        "review_mode": scope["mode"],
        "merge_commit": scope["merge_commit"],
        "upstream_sha": scope["upstream_sha"],
        "synthetic_merge_tree": scope["synthetic_merge_tree"],
        "review_ranges": ranges,
        "review_scope_sha256": scope_hash,
        "chunk_count": len(chunks),
        "review_call_count": len(chunks) + 1,
        "prompt_sha256": prompt_hashes,
        "verified_gate_evidence": gate_evidence,
        "candidate_tree_sha": candidate_before["tree_sha"],
        "verdict": "approved",
        "stdout_path": str(stdout_path),
        "stdout_sha256": _file_sha256(stdout_path),
        "stderr_path": str(stderr_path),
        "stderr_sha256": _file_sha256(stderr_path),
    }


def _canonical_openrouter(value: Any) -> bool:
    return str(value).rstrip("/") == "https://openrouter.ai/api/v1"


def _invoke_video_analyze_in_process(video_path: Path) -> str:
    try:
        from agent.auxiliary_client import (
            _resolve_task_provider_model,
            resolve_vision_provider_client,
        )
        from tools.vision_tools import video_analyze_tool
    except ImportError as exc:
        raise ControlError("video_analyze callable is unavailable") from exc
    provider, model, base_url, api_key, _api_mode = _resolve_task_provider_model(
        "vision", model=VIDEO_MODEL
    )
    if (
        provider != "openrouter"
        or model != VIDEO_MODEL
        or (base_url is not None and not _canonical_openrouter(base_url))
    ):
        raise ControlError(
            "video_analyze is not configured for canonical OpenRouter Gemini 3.5 Flash"
        )
    effective_provider, client, final_model = resolve_vision_provider_client(
        provider=provider,
        model=model,
        base_url=base_url,
        api_key=api_key,
        async_mode=True,
    )
    if (
        client is None
        or effective_provider != "openrouter"
        or final_model != VIDEO_MODEL
        or not _canonical_openrouter(getattr(client, "base_url", None))
    ):
        raise ControlError("the canonical OpenRouter Gemini video route is unavailable")
    raw = asyncio.run(video_analyze_tool(str(video_path), VIDEO_PROMPT, VIDEO_MODEL))
    if not _canonical_openrouter(getattr(client, "base_url", None)):
        raise ControlError("video analysis client route changed during verification")
    return raw


def _invoke_video_analyze(video_path: Path) -> str:
    """Run Hermes video analysis through the dependency-complete fork venv.

    The control-plane script itself is a PEP 723 isolated program and therefore
    cannot import Hermes' optional inference dependencies. Keep that isolation:
    launch the fixed fork interpreter in isolated mode, load this trusted runtime
    by exact path, and import the verdict-producing Hermes code only from the
    trusted deployed fork. The candidate contributes the hashed MP4, never judge code.
    """
    video_path = Path(os.path.abspath(video_path))
    trusted_root = Path(os.path.abspath(FORK_SOURCE_ROOT))
    runtime_path = Path(__file__).resolve()
    if not FORK_VENV_PYTHON.is_file():
        raise ControlError("dependency-complete fork Python is unavailable")
    if not trusted_root.is_dir() or trusted_root.is_symlink():
        raise ControlError(
            "trusted video analysis source root is unavailable or unsafe"
        )
    if not video_path.is_file() or video_path.is_symlink():
        raise ControlError("video analysis input is unavailable or unsafe")
    helper = r"""
import base64
import importlib.util
import pathlib
import sys

runtime_path = pathlib.Path(sys.argv[1])
trusted_root = pathlib.Path(sys.argv[2])
video_path = pathlib.Path(sys.argv[3])
sys.path.insert(0, str(trusted_root))
spec = importlib.util.spec_from_file_location("_hermes_maintainer_runtime", runtime_path)
if spec is None or spec.loader is None:
    raise RuntimeError("could not load trusted maintainer runtime")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
raw = runtime._invoke_video_analyze_in_process(video_path)
encoded = base64.b64encode(raw.encode("utf-8")).decode("ascii")
print("HERMES_VIDEO_RESULT_B64=" + encoded)
"""
    env = {
        **os.environ,
        # -I ignores this for the primary interpreter; descendants inherit it.
        "PYTHONPATH": str(trusted_root),
        "PYTHONSAFEPATH": "1",
        "HERMES_PYTHON_SRC_ROOT": str(trusted_root),
        "HERMES_PYTHON": str(FORK_VENV_PYTHON),
        "HERMES_CWD": str(trusted_root),
        "TERMINAL_CWD": str(trusted_root),
    }
    env.pop("PYTHONHOME", None)
    argv = [
        str(FORK_VENV_PYTHON),
        "-I",
        "-c",
        helper,
        str(runtime_path),
        str(trusted_root),
        str(video_path),
    ]
    try:
        result = subprocess.run(
            argv,
            cwd=trusted_root,
            env=env,
            shell=False,
            capture_output=True,
            check=False,
            timeout=VIDEO_ANALYSIS_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise ControlError("video analysis subprocess timed out") from exc
    if result.returncode != 0:
        raise ControlError("video analysis subprocess exited unsuccessfully")
    framed = [
        line.removeprefix(VIDEO_RESULT_PREFIX)
        for line in result.stdout.splitlines()
        if line.startswith(VIDEO_RESULT_PREFIX)
    ]
    if len(framed) != 1:
        raise ControlError("video analysis subprocess returned no unique result frame")
    try:
        return base64.b64decode(framed[0], validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as exc:
        raise ControlError(
            "video analysis subprocess returned an invalid result frame"
        ) from exc


def verify_video_request(
    value: Any,
    evidence_root: Path,
    termctrl_evidence: dict[str, Any],
) -> dict[str, Any]:
    if value != {"provider": "openrouter", "model": VIDEO_MODEL}:
        raise ControlError("video analysis used the wrong provider or model")
    video_path = _verified_file(
        termctrl_evidence, "video_path", "video_sha256", evidence_root
    )
    raw = _invoke_video_analyze(video_path)
    raw_path = _safe_output_path(evidence_root, "video-analysis.raw.json")
    raw_path.unlink(missing_ok=True)
    raw_path.write_text(raw, encoding="utf-8")
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ControlError("video_analyze returned invalid JSON") from exc
    analysis = result.get("analysis") if isinstance(result, dict) else None
    if (
        not isinstance(result, dict)
        or result.get("success") is not True
        or not isinstance(analysis, str)
    ):
        raise ControlError("video_analyze did not succeed")
    if not analysis.rstrip().endswith("VERDICT: PASS"):
        raise ControlError("video_analyze did not return a passing verdict")
    return {
        "provider": "openrouter",
        "model": VIDEO_MODEL,
        "video_path": str(video_path),
        "video_sha256": _file_sha256(video_path),
        "raw_output_path": str(raw_path),
        "raw_output_sha256": _file_sha256(raw_path),
    }


def _validate_gate_packet_item(gate_id: str, item: Any) -> None:
    """Validate every gate packet before the first gate spends resources."""
    if gate_id == "termctrl-smoke":
        if not isinstance(item, dict) or set(item) != {"id", "drive"}:
            raise ControlError("termctrl gate must contain a bounded drive packet")
        _validate_drive(item["drive"])
        return
    if gate_id == "video-analysis":
        if not isinstance(item, dict) or set(item) != {"id", "request"}:
            raise ControlError("video gate must contain an inline route request")
        if item["request"] != {"provider": "openrouter", "model": VIDEO_MODEL}:
            raise ControlError("video analysis used the wrong provider or model")
        return
    if gate_id == "adversarial-review":
        if not isinstance(item, dict) or set(item) != {"id", "reviewer"}:
            raise ControlError("review gate must select an external reviewer")
        reviewer = item["reviewer"]
        if (
            not isinstance(reviewer, dict)
            or set(reviewer) != {"tool", "model"}
            or (reviewer.get("tool"), reviewer.get("model")) not in REVIEWER_COMMANDS
        ):
            raise ControlError("adversarial review must select an allowlisted reviewer")
        return
    argv = (
        item.get("argv")
        if isinstance(item, dict) and set(item) == {"id", "argv"}
        else None
    )
    if (
        not isinstance(argv, list)
        or not argv
        or not all(isinstance(value, str) for value in argv)
    ):
        raise ControlError("gate check must contain id and a fixed argv")
    _validate_code_command(gate_id, argv)


def run_gate(
    packet_path: Path,
    manifest_path: Path,
    *,
    cwd: Path,
    branch: str,
    base_sha: str,
    candidate_sha: str,
    token: str,
    run_binding: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Execute candidate-bound gates and atomically record their real results."""
    evidence_root = Path(os.path.abspath(manifest_path.parent))
    manifest_path = _safe_output_path(evidence_root, manifest_path.name)
    packet_path = _evidence_path(str(packet_path), evidence_root, label="gate packet")
    try:
        packet = json.loads(packet_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ControlError(f"invalid gate packet: {type(exc).__name__}") from exc
    checks = (
        packet.get("checks")
        if isinstance(packet, dict) and set(packet) == {"checks"}
        else None
    )
    if not isinstance(checks, list):
        raise ControlError("gate packet must contain exactly checks")
    ids = [item.get("id") for item in checks if isinstance(item, dict)]
    if (
        len(ids) != len(checks)
        or set(ids) != REQUIRED_GATES
        or len(ids) != len(set(ids))
    ):
        raise ControlError("gate packet must contain each required gate exactly once")
    for item in checks:
        _validate_gate_packet_item(item["id"], item)
    before = _worktree_proof(cwd, candidate_sha)
    if run_binding is None:
        # Internal direct callers (principally tests) retain an explicit legacy
        # path. The production gate-and-ship boundary always supplies a binding.
        run_binding = {
            "mode": "backport",
            "request_sha256": None,
            "last_synced_upstream": None,
            "captured_upstream": None,
            "captured_base": None,
        }
    if (
        not isinstance(run_binding, dict)
        or set(run_binding)
        != {
            "mode",
            "request_sha256",
            "last_synced_upstream",
            "captured_upstream",
            "captured_base",
        }
        or run_binding.get("mode") not in {"scheduled", "backport"}
    ):
        raise ControlError("gate run binding is invalid")
    node_proof = _validate_node_runtime()
    by_id = {item["id"]: item for item in checks}
    order = (
        "opentui-install",
        "focused-contracts",
        "opentui-check",
        "opentui-build",
        "adversarial-review",
        "termctrl-smoke",
        "video-analysis",
    )
    recorded: list[dict[str, Any]] = []
    termctrl_evidence: dict[str, Any] | None = None
    review_evidence: dict[str, Any] | None = None
    failed_gate: str | None = None
    for gate_id in order:
        item = by_id[gate_id]
        output_path = _safe_output_path(evidence_root, "gate-logs", f"{gate_id}.log")
        output_path.unlink(missing_ok=True)
        if failed_gate is not None:
            if gate_id in {"termctrl-smoke", "video-analysis", "adversarial-review"}:
                argv = ["runtime-verifier", gate_id]
            else:
                argv = item["argv"]
            output_path.write_text(
                f"skipped: prerequisite gate {failed_gate} failed\n",
                encoding="utf-8",
            )
            recorded.append(
                {
                    "id": gate_id,
                    "argv": argv,
                    "exit_code": 125,
                    "status": "skipped",
                    "output_path": str(output_path),
                    "output_sha256": _file_sha256(output_path),
                }
            )
            continue
        if gate_id in {"termctrl-smoke", "video-analysis", "adversarial-review"}:
            try:
                if gate_id == "termctrl-smoke":
                    if not isinstance(item, dict) or set(item) != {"id", "drive"}:
                        raise ControlError(
                            "termctrl gate must contain a bounded drive packet"
                        )
                    termctrl_evidence = verify_termctrl_drive(
                        item["drive"], evidence_root, cwd
                    )
                    details: Any = termctrl_evidence
                    argv = [str(TERMCTRL), *details["launch_argv"]]
                elif gate_id == "video-analysis":
                    if not isinstance(item, dict) or set(item) != {"id", "request"}:
                        raise ControlError(
                            "video gate must contain an inline route request"
                        )
                    if termctrl_evidence is None:
                        raise ControlError(
                            "video gate has no verified termctrl recording"
                        )
                    details = verify_video_request(
                        item["request"], evidence_root, termctrl_evidence
                    )
                    argv = ["hermes-video-analyze", VIDEO_MODEL]
                else:
                    if not isinstance(item, dict) or set(item) != {"id", "reviewer"}:
                        raise ControlError(
                            "review gate must select an external reviewer"
                        )
                    details = run_adversarial_review(
                        item["reviewer"],
                        evidence_root,
                        cwd,
                        base_sha,
                        candidate_sha,
                        expected_mode=run_binding["mode"],
                        last_synced_upstream=run_binding["last_synced_upstream"],
                        captured_upstream=run_binding["captured_upstream"],
                        verified_checks=recorded,
                    )
                    review_evidence = details
                    argv = details["argv"]
                returncode, output = 0, json.dumps(details, sort_keys=True) + "\n"
            except ControlError as exc:
                returncode, output = 1, f"{exc}\n"
                argv = ["runtime-verifier", gate_id]
            output_path.write_text(output, encoding="utf-8")
        else:
            argv = (
                item.get("argv")
                if isinstance(item, dict) and set(item) == {"id", "argv"}
                else None
            )
            if (
                not isinstance(argv, list)
                or not argv
                or not all(isinstance(value, str) for value in argv)
            ):
                raise ControlError("gate check must contain id and a fixed argv")
            _validate_code_command(gate_id, argv)
            gate_env = (
                {**os.environ, "PATH": CONTROLLED_PATH}
                if gate_id.startswith("opentui-")
                or (gate_id == "focused-contracts" and argv[0] == str(NODE26))
                else None
            )
            command_cwd = (
                cwd / "ui-opentui"
                if gate_id == "focused-contracts" and argv[0] == str(NODE26)
                else cwd
            )
            with output_path.open("wb") as output_handle:
                if gate_id == "opentui-install":
                    output_handle.write(
                        (json.dumps(node_proof, sort_keys=True) + "\n").encode()
                    )
                result = subprocess.run(
                    argv,
                    cwd=command_cwd,
                    shell=False,
                    stdout=output_handle,
                    stderr=subprocess.STDOUT,
                    timeout=1800,
                    env=gate_env,
                )
            returncode = result.returncode
            if gate_id == "focused-contracts" and returncode == 0:
                output = output_path.read_text(encoding="utf-8", errors="replace")
                if not _focused_output_proves_execution(argv, output):
                    returncode = 1
                    with output_path.open("a", encoding="utf-8") as handle:
                        handle.write("runtime: no executed focused test was proven\n")
        recorded.append(
            {
                "id": gate_id,
                "argv": argv,
                "exit_code": returncode,
                "status": "passed" if returncode == 0 else "failed",
                "output_path": str(output_path),
                "output_sha256": _file_sha256(output_path),
            }
        )
        if returncode != 0:
            failed_gate = gate_id
    after_raw = _worktree_proof(cwd, candidate_sha)
    if before["tree_sha"] != after_raw["tree_sha"]:
        raise ControlError("gate worktree tree changed while gates ran")
    manifest = {
        "schema_version": GATE_SCHEMA_VERSION,
        "branch": branch,
        "base_sha": base_sha,
        "candidate_sha": candidate_sha,
        "lease_token_sha256": hashlib.sha256(token.encode()).hexdigest(),
        "run_binding": run_binding,
        "review_proof": review_evidence,
        "worktree_proof": {
            "worktree": before["worktree"],
            "before": {
                key: before[key] for key in ("head_sha", "tree_sha", "status_porcelain")
            },
            "after": {
                key: after_raw[key]
                for key in ("head_sha", "tree_sha", "status_porcelain")
            },
        },
        "checks": recorded,
    }
    _atomic_json(manifest_path, manifest)
    return manifest


def gate_and_ship(
    repo: Path,
    packet_path: Path,
    manifest_path: Path,
    *,
    state_dir: Path,
    cwd: Path,
    base_sha: str,
    candidate_sha: str,
    token: str,
    remote: str = REMOTE,
    branch: str = BRANCH,
) -> dict[str, Any]:
    """Run every gate and immediately publish by remote CAS in one invocation."""
    run_binding = _derive_run_binding(state_dir, manifest_path.parent, token)
    if run_binding["captured_base"] != base_sha:
        raise ControlError("gate base does not match captured fork snapshot")
    result = run_gate(
        packet_path,
        manifest_path,
        cwd=cwd,
        branch=branch,
        base_sha=base_sha,
        candidate_sha=candidate_sha,
        token=token,
        run_binding=run_binding,
    )
    failed = [item["id"] for item in result["checks"] if item["status"] != "passed"]
    if failed:
        raise ControlError("candidate gates failed: " + ", ".join(failed))
    ship_candidate(
        repo,
        manifest_path,
        state_dir=state_dir,
        base_sha=base_sha,
        candidate_sha=candidate_sha,
        token=token,
        remote=remote,
        branch=branch,
    )
    return result


def finalize_success(
    repo: Path,
    manifest_path: Path,
    *,
    state_dir: Path,
    evidence_dir: Path,
    cwd: Path,
    token: str,
    remote: str = REMOTE,
    branch: str = BRANCH,
) -> dict[str, Any]:
    """Consume any claimed request and remove a proven shipped worktree.

    Publication has already happened through ``gate_and_ship``. This boundary
    makes the remaining success cleanup deterministic and candidate-bound so a
    parent cannot consume a failed request or remove an arbitrary checkout.
    """
    evidence_root = Path(os.path.abspath(manifest_path.parent))
    if Path(os.path.abspath(evidence_dir)) != evidence_root:
        raise ControlError("success evidence must match the gate manifest directory")
    manifest_path = _evidence_path(
        str(manifest_path), evidence_root, label="success gate manifest"
    )
    journal = _load_publish_journal(state_dir)
    if journal is None:
        raise ControlError("success finalization requires a publication journal")
    if (
        Path(journal["manifest_path"]).resolve() != manifest_path.resolve()
        or Path(journal["evidence_dir"]).resolve() != evidence_root.resolve()
        or Path(journal["repo"]).resolve() != repo.resolve()
        or journal["remote"] != remote
        or journal["branch"] != branch
    ):
        raise ControlError("publication journal does not match success finalization")
    base_sha = journal["base_sha"]
    candidate_sha = journal["candidate_sha"]
    if journal["phase"] == "finalized":
        final_path = evidence_root / "success-finalization.json"
        if not final_path.is_file():
            raise ControlError("finalized publication is missing success evidence")
        result = json.loads(final_path.read_text(encoding="utf-8"))
        upstream_sha = journal["upstream_sha"]
        if isinstance(upstream_sha, str):
            _atomic_text(state_dir / "last_synced_upstream.sha", upstream_sha + "\n")
        _record_run_outcome(
            state_dir,
            evidence_root,
            {
                "status": "success",
                "stage": "finalized",
                "base_sha": journal["base_sha"],
                "candidate_sha": journal["candidate_sha"],
                "upstream_sha": upstream_sha,
                "published": True,
            },
        )
        return result
    current_remote = _remote_sha(repo, remote, branch)
    if current_remote != candidate_sha:
        raise ControlError("remote branch does not match the published candidate")
    if journal["phase"] == "prepared":
        journal = {
            **journal,
            "phase": "published",
            "published_unix": int(time.time()),
        }
    if journal["phase"] == "published":
        journal = {
            **journal,
            "phase": "finalizing",
            "finalizing_unix": int(time.time()),
        }
        _atomic_json(_journal_path(state_dir), journal)
    if journal["phase"] != "finalizing":
        raise ControlError("publication journal is not finalizable")
    recorded_cwd = Path(journal["worktree"]).resolve()
    resolved_cwd = cwd.resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    managed_roots = {
        MAINTAINER_WORKTREE_ROOT.resolve(),
        (state_dir / "worktrees").resolve(),
    }
    is_scratch_worktree = resolved_cwd.is_relative_to(
        temp_root
    ) and resolved_cwd.name.startswith("opentui-maint-")
    is_managed_worktree = (
        resolved_cwd.parent in managed_roots and resolved_cwd.name.startswith("sync-")
    )
    if (
        resolved_cwd != recorded_cwd
        or resolved_cwd == repo.resolve()
        or not (is_scratch_worktree or is_managed_worktree)
    ):
        raise ControlError("success cleanup path is not the proven maintainer worktree")
    if _git_status(resolved_cwd, ["symbolic-ref", "-q", "HEAD"]) == 0:
        raise ControlError("success cleanup refuses a branch-attached worktree")

    claimed = evidence_root / "request.claimed.json"
    consumed = evidence_root / "request.consumed.json"
    inflight = state_dir / "run-request.inflight.json"
    request_consumed = False
    if claimed.exists():
        claimed_value = _read_bound_request(
            claimed, evidence_root, label="claimed request"
        )
        if consumed.exists():
            if inflight.exists():
                raise ControlError("a consumed request cannot also remain in flight")
            if (
                _read_bound_request(consumed, evidence_root, label="consumed request")
                != claimed_value
            ):
                raise ControlError("consumed request does not match this run claim")
            request_consumed = True
        else:
            if not inflight.exists():
                raise ControlError("the claimed request is no longer in flight")
            if (
                _read_bound_request(inflight, state_dir, label="in-flight request")
                != claimed_value
            ):
                raise ControlError("in-flight request does not match this run claim")
            consume_request(state_dir, evidence_root)
            request_consumed = True
    elif inflight.exists():
        raise ControlError("in-flight request is not bound to this run evidence")

    # The finalizing phase is durable before cleanup, so absence is safe on retry.
    worktree_removed: str | None = None
    if resolved_cwd.exists():
        _worktree_proof(resolved_cwd, candidate_sha)
        _git(repo, ["worktree", "remove", str(resolved_cwd)])
        worktree_removed = str(resolved_cwd)
    upstream_sha = journal["upstream_sha"]
    result = {
        "schema_version": 1,
        "candidate_sha": candidate_sha,
        "remote": remote,
        "branch": branch,
        "request_consumed": request_consumed,
        "worktree_removed": worktree_removed,
        "upstream_sha": upstream_sha,
    }
    if isinstance(upstream_sha, str):
        _atomic_text(state_dir / "last_synced_upstream.sha", upstream_sha + "\n")
    _atomic_json(evidence_root / "success-finalization.json", result)
    _atomic_json(
        _journal_path(state_dir),
        {**journal, "phase": "finalized", "finalized_unix": int(time.time())},
    )
    # The terminal outcome is the final durable commit. Reconciliation can
    # reconstruct it from the finalized journal and success evidence after a
    # crash at any earlier point, but must never release a lease for a partial
    # success transaction.
    _record_run_outcome(
        state_dir,
        evidence_root,
        {
            "status": "success",
            "stage": "finalized",
            "base_sha": base_sha,
            "candidate_sha": candidate_sha,
            "upstream_sha": upstream_sha,
            "published": True,
        },
    )
    return result


def finalize_failure(
    state_dir: Path,
    evidence_dir: Path,
    *,
    stage: str,
    reason_code: str,
) -> dict[str, Any]:
    allowed_stages = {
        "integration",
        "worker",
        "gate",
        "publish",
        "finalization",
        "external",
    }
    allowed_reasons = {
        "integration-failed",
        "worker-failed",
        "gate-failed",
        "publish-refused",
        "finalization-failed",
        "external-blocker",
    }
    if stage not in allowed_stages or reason_code not in allowed_reasons:
        raise ControlError("failure outcome is not an allowlisted stage/reason")
    evidence_root = Path(os.path.abspath(evidence_dir))
    journal = _load_publish_journal(state_dir)
    journal_matches = (
        journal is not None
        and Path(journal["evidence_dir"]).resolve() == evidence_root.resolve()
    )
    if journal_matches and journal is not None:
        if journal["phase"] == "finalized":
            raise ControlError("a finalized publication cannot be recorded as failed")
        repo = Path(journal["repo"])
        remote_sha = _remote_sha(repo, journal["remote"], journal["branch"])
        if remote_sha == journal["candidate_sha"]:
            if journal["phase"] == "prepared":
                journal = {
                    **journal,
                    "phase": "published",
                    "published_unix": int(time.time()),
                }
                _atomic_json(_journal_path(state_dir), journal)
            return _record_run_outcome(
                state_dir,
                evidence_root,
                {
                    "status": "failed",
                    "stage": stage,
                    "reason_code": reason_code,
                    "published": True,
                    "needs_finalization": True,
                    "candidate_sha": journal["candidate_sha"],
                    "request_recovered": False,
                },
            )
        if journal["phase"] == "prepared" and remote_sha == journal["base_sha"]:
            _atomic_json(
                _journal_path(state_dir),
                {**journal, "phase": "aborted", "aborted_unix": int(time.time())},
            )
        elif journal["phase"] in {"prepared", "published", "finalizing"}:
            raise ControlError(
                "publication outcome is indeterminate; request preserved"
            )
    claimed = evidence_root / "request.claimed.json"
    inflight = state_dir / "run-request.inflight.json"
    request_recovered = False
    if claimed.exists():
        claimed_value = _read_bound_request(
            claimed, evidence_root, label="claimed request"
        )
        if not inflight.exists():
            raise ControlError("failed run claim is no longer in flight")
        if (
            _read_bound_request(inflight, state_dir, label="in-flight request")
            != claimed_value
        ):
            raise ControlError("failed run claim does not match the in-flight request")
        recover_request(state_dir)
        request_recovered = True
    elif inflight.exists():
        raise ControlError("in-flight request is not bound to this failed run")
    return _record_run_outcome(
        state_dir,
        evidence_root,
        {
            "status": "failed",
            "stage": stage,
            "reason_code": reason_code,
            "published": False,
            "needs_finalization": False,
            "request_recovered": request_recovered,
        },
    )


def _bound_terminal_outcome(state_dir: Path, evidence_dir: Path) -> dict[str, Any]:
    evidence_root = Path(os.path.abspath(evidence_dir))
    outcome_path = evidence_root / "run-outcome.json"
    if not outcome_path.is_file() or outcome_path.is_symlink():
        raise ControlError("run outcome is missing")
    try:
        outcome = json.loads(outcome_path.read_text(encoding="utf-8"))
        durable = json.loads((state_dir / "last-run.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ControlError("run outcome is invalid") from exc
    if not isinstance(outcome, dict) or outcome.get("status") not in {
        "success",
        "failed",
    }:
        raise ControlError("run outcome is not terminal")
    if (
        not isinstance(durable, dict)
        or durable.get("evidence_path") != str(outcome_path)
        or durable.get("evidence_sha256") != _file_sha256(outcome_path)
        or durable.get("status") != outcome.get("status")
    ):
        raise ControlError("run outcome is not bound to durable state")
    if outcome.get("status") == "success":
        journal = _load_publish_journal(state_dir)
        final_path = evidence_root / "success-finalization.json"
        if (
            journal is None
            or journal.get("phase") != "finalized"
            or Path(journal["evidence_dir"]).resolve() != evidence_root.resolve()
            or not final_path.is_file()
        ):
            raise ControlError("success outcome is not fully finalized")
        upstream_sha = outcome.get("upstream_sha")
        if isinstance(upstream_sha, str):
            marker = state_dir / "last_synced_upstream.sha"
            if (
                not marker.is_file()
                or marker.read_text(encoding="utf-8").strip() != upstream_sha
            ):
                raise ControlError("success upstream marker is not finalized")
    return outcome


def release_completed_lease(
    state_dir: Path, evidence_dir: Path, token: str
) -> dict[str, Any]:
    outcome = _bound_terminal_outcome(state_dir, evidence_dir)
    release_lease(state_dir, token)
    return outcome


def reconcile_run(
    state_dir: Path,
    evidence_dir: Path,
    *,
    token: str,
    allow_expired: bool = False,
) -> dict[str, Any]:
    """Deterministically close a run after its Hermes parent has exited."""
    evidence_root = Path(os.path.abspath(evidence_dir))
    if allow_expired:
        with _lease_lock(state_dir):
            lease = _lease_value(state_dir)
            if lease.get("token") != token:
                raise ControlError("run lease token changed before stale recovery")
            try:
                expires = int(lease.get("expires_unix", 0))
            except (TypeError, ValueError) as exc:
                raise ControlError("stale run lease expiry is invalid") from exc
            if expires > int(time.time()):
                raise ControlError("stale recovery requires an expired lease")
            if (
                lease.get("run_id") != evidence_root.name
                or lease.get("evidence_dir") != str(evidence_root)
            ):
                raise ControlError("stale run lease is not bound to this evidence")
    else:
        validate_lease(state_dir, token)

    outcome_path = evidence_root / "run-outcome.json"
    journal = _load_publish_journal(state_dir)
    journal_matches = (
        journal is not None
        and Path(journal["evidence_dir"]).resolve() == evidence_root.resolve()
        and journal["phase"] in {"prepared", "published", "finalizing", "finalized"}
    )
    if outcome_path.is_file() and not outcome_path.is_symlink():
        try:
            return release_completed_lease(state_dir, evidence_root, token)
        except ControlError:
            # A success outcome written by an older/interrupted runtime is not
            # terminal authority until the publication journal is finalized.
            # Continue through journal recovery instead of releasing the lease.
            if not journal_matches:
                raise

    if (
        journal_matches
        and journal is not None
    ):
        repo = Path(journal["repo"])
        remote_sha = _remote_sha(repo, journal["remote"], journal["branch"])
        if remote_sha == journal["candidate_sha"]:
            result = finalize_success(
                repo,
                Path(journal["manifest_path"]),
                state_dir=state_dir,
                evidence_dir=evidence_root,
                cwd=Path(journal["worktree"]),
                token=token,
                remote=journal["remote"],
                branch=journal["branch"],
            )
            release_lease(state_dir, token)
            return {"status": "success", **result}

    outcome = finalize_failure(
        state_dir,
        evidence_root,
        stage="external",
        reason_code="external-blocker",
    )
    release_lease(state_dir, token)
    return outcome


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    claim = sub.add_parser("claim-request")
    claim.add_argument("--state", type=Path, required=True)
    claim.add_argument("--evidence", type=Path, required=True)
    claim.add_argument("--token", required=True)
    recover = sub.add_parser("recover-request")
    recover.add_argument("--state", type=Path, required=True)
    recover.add_argument("--token", required=True)
    consume = sub.add_parser("consume-request")
    consume.add_argument("--state", type=Path, required=True)
    consume.add_argument("--evidence", type=Path, required=True)
    consume.add_argument("--token", required=True)
    finalize = sub.add_parser("finalize-success")
    finalize.add_argument("--state", type=Path, required=True)
    finalize.add_argument("--evidence", type=Path, required=True)
    finalize.add_argument("--token", required=True)
    finalize.add_argument("--manifest", type=Path, required=True)
    finalize.add_argument("--cwd", type=Path, required=True)
    finalize.add_argument("--repo", type=Path, required=True)
    finalize.add_argument("--remote", default=REMOTE)
    finalize.add_argument("--branch", default=BRANCH)
    failure = sub.add_parser("finalize-failure")
    failure.add_argument("--state", type=Path, required=True)
    failure.add_argument("--evidence", type=Path, required=True)
    failure.add_argument("--token", required=True)
    failure.add_argument("--stage", required=True)
    failure.add_argument("--reason-code", required=True)
    packet = sub.add_parser("run-packet")
    packet.add_argument("--packet", type=Path, required=True)
    packet.add_argument("--cwd", type=Path, required=True)
    packet.add_argument("--state", type=Path, required=True)
    packet.add_argument("--token", required=True)
    release = sub.add_parser("release-lease")
    release.add_argument("--state", type=Path, required=True)
    release.add_argument("--evidence", type=Path, required=True)
    release.add_argument("--token", required=True)
    renew = sub.add_parser("renew-lease")
    renew.add_argument("--state", type=Path, required=True)
    renew.add_argument("--token", required=True)
    publish = sub.add_parser("gate-and-ship")
    reconcile = sub.add_parser("reconcile-run")
    reconcile.add_argument("--state", type=Path, required=True)
    reconcile.add_argument("--evidence", type=Path, required=True)
    reconcile.add_argument("--token", required=True)
    reconcile.add_argument("--allow-expired", action="store_true")
    publish.add_argument("--state", type=Path, required=True)
    publish.add_argument("--token", required=True)
    publish.add_argument("--packet", type=Path, required=True)
    publish.add_argument("--manifest", type=Path, required=True)
    publish.add_argument("--cwd", type=Path, required=True)
    publish.add_argument("--repo", type=Path, required=True)
    publish.add_argument("--base", required=True)
    publish.add_argument("--candidate", required=True)
    publish.add_argument("--remote", default=REMOTE)
    publish.add_argument("--branch", default=BRANCH)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "claim-request":
        with run_lock(args.state):
            validate_lease(args.state, args.token)
            value = claim_request(args.state, args.evidence)
        print(json.dumps(value))
        return 0
    if args.command == "recover-request":
        with run_lock(args.state):
            validate_lease(args.state, args.token)
            recover_request(args.state)
        return 0
    if args.command == "consume-request":
        with run_lock(args.state):
            validate_lease(args.state, args.token)
            consume_request(args.state, args.evidence)
        return 0
    if args.command == "finalize-success":
        with run_lock(args.state):
            validate_lease(args.state, args.token)
            finalize_success(
                args.repo,
                args.manifest,
                state_dir=args.state,
                evidence_dir=args.evidence,
                cwd=args.cwd,
                token=args.token,
                remote=args.remote,
                branch=args.branch,
            )
        return 0
    if args.command == "finalize-failure":
        with run_lock(args.state):
            validate_lease(args.state, args.token)
            finalize_failure(
                args.state,
                args.evidence,
                stage=args.stage,
                reason_code=args.reason_code,
            )
        return 0
    if args.command == "run-packet":
        # Lease renewal already serializes on the blocking token-gated lease
        # lock. Do not put concurrent workers behind the nonblocking run lock.
        renew_lease(args.state, args.token)
        returncode = run_packet(
            args.packet, cwd=args.cwd, state_dir=args.state, token=args.token
        )
        renew_lease(args.state, args.token)
        return returncode
    if args.command == "gate-and-ship":
        renew_lease(args.state, args.token)
        with run_lock(args.state):
            validate_lease(args.state, args.token)
            gate_and_ship(
                args.repo,
                args.packet,
                args.manifest,
                state_dir=args.state,
                cwd=args.cwd,
                base_sha=args.base,
                candidate_sha=args.candidate,
                token=args.token,
                remote=args.remote,
                branch=args.branch,
            )
            # Publication and deterministic cleanup are one trusted CLI
            # transaction. No release can interleave before finalization.
            finalize_success(
                args.repo,
                args.manifest,
                state_dir=args.state,
                evidence_dir=args.manifest.parent,
                cwd=args.cwd,
                token=args.token,
                remote=args.remote,
                branch=args.branch,
            )
            release_lease(args.state, args.token)
        return 0
    if args.command == "renew-lease":
        renew_lease(args.state, args.token)
        return 0
    if args.command == "reconcile-run":
        with run_lock(args.state):
            result = reconcile_run(
                args.state,
                args.evidence,
                token=args.token,
                allow_expired=args.allow_expired,
            )
        print(json.dumps(result, sort_keys=True))
        return 0
    if args.command == "release-lease":
        with run_lock(args.state):
            release_completed_lease(args.state, args.evidence, args.token)
        return 0
    raise ControlError("unknown runtime command")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ControlError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
