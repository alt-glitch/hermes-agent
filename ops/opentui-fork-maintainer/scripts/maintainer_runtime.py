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
REQUIRED_GATES = frozenset({
    "opentui-install",
    "focused-contracts",
    "opentui-check",
    "opentui-build",
    "termctrl-smoke",
    "adversarial-review",
    "video-analysis",
})
SHA_RE = __import__("re").compile(r"^[0-9a-f]{40}$")
SHORT_SHA_RE = __import__("re").compile(r"^[0-9a-fA-F]{7,40}$")
GATE_SCHEMA_VERSION = 2
LEASE_TTL_SECONDS = 6 * 60 * 60
PACKET_TIMEOUT_SECONDS = 4 * 60 * 60
WORKER_SLOT_COUNT = 2
NODE26_DIR = Path(
    "/home/daimon/.local/share/fnm/node-versions/v26.3.0/installation/bin"
)
NODE26 = NODE26_DIR / "node"
NPM26 = NODE26_DIR / "npm"
TERMCTRL = Path("/home/daimon/.cargo/bin/termctrl")
FORK_SOURCE_ROOT = Path("/home/daimon/side-quests/hermes-agent")
FORK_VENV_PYTHON = FORK_SOURCE_ROOT / ".venv/bin/python"
CONTROLLED_PATH = f"{NODE26_DIR}:/usr/local/bin:/usr/bin:/bin"
CANONICAL_CODE_GATES = {
    "opentui-install": [str(NPM26), "--prefix", "ui-opentui", "ci"],
    "opentui-check": [str(NPM26), "--prefix", "ui-opentui", "run", "check"],
    "opentui-build": [str(NPM26), "--prefix", "ui-opentui", "run", "build"],
}
VIDEO_MODEL = "google/gemini-3.5-flash"
VIDEO_TAIL_MS = 3_000
TERMCTRL_READY_HOLD_SECONDS = 1.5
TERMCTRL_MIN_ACTION_TIMELINE_MS = 1_000
VIDEO_ANALYSIS_TIMEOUT_SECONDS = 10 * 60
REVIEW_TIMEOUT_SECONDS = 15 * 60
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
            artifacts.append({
                "kind": kind,
                "path": str(artifact.resolve()),
                "sha256": _file_sha256(artifact),
            })
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
        value["expires_unix"] = now + ttl_seconds
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
    if argv[:3] == ["uv", "run", "pytest"]:
        return len(argv) > 3 and any(
            "::" in arg or arg.endswith(".py") or "/tests/" in f"/{arg}"
            for arg in argv[3:]
        )
    vitest_prefix = [
        str(NPM26),
        "--prefix",
        "ui-opentui",
        "exec",
        "vitest",
        "--",
        "run",
    ]
    return argv[: len(vitest_prefix)] == vitest_prefix and any(
        arg.endswith((".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"))
        or "/test" in arg
        for arg in argv[len(vitest_prefix) :]
    )


def _validate_code_command(gate_id: str, argv: list[str]) -> None:
    expected = CANONICAL_CODE_GATES.get(gate_id)
    if expected is not None and argv != expected:
        raise ControlError(f"{gate_id} must use its canonical command")
    if gate_id == "focused-contracts" and not _is_focused_contract_command(argv):
        raise ControlError("focused-contracts must run targeted pytest or vitest")


def _focused_output_proves_execution(argv: list[str], output: str) -> bool:
    plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output)
    if argv[:3] == ["uv", "run", "pytest"]:
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
    missing = REQUIRED_GATES - seen
    if missing:
        raise ControlError(
            "required gate evidence missing: " + ", ".join(sorted(missing))
        )
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
    validate_gate_manifest(
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
        _validate_lease_value(_lease_value(state_dir), token, int(time.time()))
        current_remote = _remote_sha(repo, remote, branch)
        if current_remote != base_sha:
            raise ControlError("remote branch moved since base capture")
        result = subprocess.run(
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
        if result.returncode != 0:
            raise ControlError("guarded remote fast-forward was refused")


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
    return cols, rows, actions, required


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


def run_adversarial_review(
    reviewer: Any,
    evidence_root: Path,
    repo: Path,
    base_sha: str,
    candidate_sha: str,
) -> dict[str, Any]:
    if not isinstance(reviewer, dict) or set(reviewer) != {"tool", "model"}:
        raise ControlError("adversarial review must select an allowlisted reviewer")
    key = (reviewer.get("tool"), reviewer.get("model"))
    template = REVIEWER_COMMANDS.get(key)
    if template is None:
        raise ControlError("adversarial reviewer tool/model is not allowlisted")
    if not Path(template[0]).is_file():
        raise ControlError("allowlisted adversarial reviewer executable is unavailable")
    diff = _candidate_diff(repo, base_sha, candidate_sha)
    diff_hash = hashlib.sha256(diff).hexdigest()
    prompt = (
        (
            "Perform an independent adversarial code review of the exact candidate diff below.\n"
            f"BASE_SHA: {base_sha}\nCANDIDATE_SHA: {candidate_sha}\nDIFF_SHA256: {diff_hash}\n"
            "Find correctness, race, security, UX, and test-fidelity defects. Do not modify files.\n"
            "For every release-blocking issue emit a line beginning exactly BLOCKER:.\n"
            "The final non-empty output line must be exactly VERDICT: APPROVED only when no blocker remains; otherwise VERDICT: REJECTED.\n"
            "--- BEGIN EXACT DIFF ---\n"
        ).encode()
        + diff
        + b"\n--- END EXACT DIFF ---\n"
    )
    review_dir = _safe_output_path(
        evidence_root, "review-verified", "placeholder"
    ).parent
    stdout_path = _safe_output_path(review_dir, "stdout.txt")
    stderr_path = _safe_output_path(review_dir, "stderr.txt")
    stdout_path.unlink(missing_ok=True)
    stderr_path.unlink(missing_ok=True)
    argv = list(template)
    result = _run_reviewer(argv, prompt, repo)
    stdout_path.write_bytes(result.stdout)
    stderr_path.write_bytes(result.stderr)
    output = result.stdout.decode("utf-8", errors="replace")
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if result.returncode != 0:
        raise ControlError("adversarial reviewer exited unsuccessfully")
    if not lines or lines[-1] != "VERDICT: APPROVED" or "BLOCKER:" in output:
        raise ControlError("adversarial review did not approve the candidate")
    return {
        "reviewer": {"tool": key[0], "model": key[1]},
        "argv": argv,
        "base_sha": base_sha,
        "candidate_sha": candidate_sha,
        "reviewed_diff_sha256": diff_hash,
        "prompt_sha256": hashlib.sha256(prompt).hexdigest(),
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


def run_gate(
    packet_path: Path,
    manifest_path: Path,
    *,
    cwd: Path,
    branch: str,
    base_sha: str,
    candidate_sha: str,
    token: str,
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
    before = _worktree_proof(cwd, candidate_sha)
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
    for gate_id in order:
        item = by_id[gate_id]
        output_path = _safe_output_path(evidence_root, "gate-logs", f"{gate_id}.log")
        output_path.unlink(missing_ok=True)
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
                        item["reviewer"], evidence_root, cwd, base_sha, candidate_sha
                    )
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
                else None
            )
            with output_path.open("wb") as output_handle:
                if gate_id == "opentui-install":
                    output_handle.write(
                        (json.dumps(node_proof, sort_keys=True) + "\n").encode()
                    )
                result = subprocess.run(
                    argv,
                    cwd=cwd,
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
        recorded.append({
            "id": gate_id,
            "argv": argv,
            "exit_code": returncode,
            "status": "passed" if returncode == 0 else "failed",
            "output_path": str(output_path),
            "output_sha256": _file_sha256(output_path),
        })
    after_raw = _worktree_proof(cwd, candidate_sha)
    if before["tree_sha"] != after_raw["tree_sha"]:
        raise ControlError("gate worktree tree changed while gates ran")
    manifest = {
        "schema_version": GATE_SCHEMA_VERSION,
        "branch": branch,
        "base_sha": base_sha,
        "candidate_sha": candidate_sha,
        "lease_token_sha256": hashlib.sha256(token.encode()).hexdigest(),
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
    result = run_gate(
        packet_path,
        manifest_path,
        cwd=cwd,
        branch=branch,
        base_sha=base_sha,
        candidate_sha=candidate_sha,
        token=token,
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
    packet = sub.add_parser("run-packet")
    packet.add_argument("--packet", type=Path, required=True)
    packet.add_argument("--cwd", type=Path, required=True)
    packet.add_argument("--state", type=Path, required=True)
    packet.add_argument("--token", required=True)
    release = sub.add_parser("release-lease")
    release.add_argument("--state", type=Path, required=True)
    release.add_argument("--token", required=True)
    renew = sub.add_parser("renew-lease")
    renew.add_argument("--state", type=Path, required=True)
    renew.add_argument("--token", required=True)
    publish = sub.add_parser("gate-and-ship")
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
        renew_lease(args.state, args.token)
        return 0
    if args.command == "renew-lease":
        renew_lease(args.state, args.token)
        return 0
    if args.command == "release-lease":
        with run_lock(args.state):
            release_lease(args.state, args.token)
        return 0
    raise ControlError("unknown runtime command")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ControlError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
