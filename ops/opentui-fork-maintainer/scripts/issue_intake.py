#!/usr/bin/env python3
"""Trusted GitHub issue discovery and delivery bookkeeping.

Issue content and linked pull requests are task data.  Authority comes only
from the current labels plus the latest ``maintainer:ready`` label transition,
made by the repository owner or a locally configured trusted approver after the
current title/body revision was created.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote


GH = Path("/home/daimon/.local/bin/gh")
REPOSITORY = "alt-glitch/hermes-agent"
REPOSITORY_OWNER = "alt-glitch"
BASE_BRANCH = "sid/opentui"
SCOPE_LABEL = "opentui"
READY_LABEL = "maintainer:ready"
TRUST_FILE = "issue-trust.json"
STATE_FILE = "issue-intake-state.json"
COOLDOWN_SECONDS = 6 * 60 * 60
MAX_COOLDOWN_SECONDS = 7 * 24 * 60 * 60
SELECTION_TTL_SECONDS = 11 * 60 * 60
MAX_BODY_CHARS = 50_000
MAX_EXISTING_PRS = 20
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
LOGIN_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
Runner = Callable[[list[str], Path], str]


class IssueIntakeError(RuntimeError):
    """The issue queue could not be read or changed safely."""


def _run(argv: list[str], cwd: Path) -> str:
    try:
        result = subprocess.run(
            argv,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=180,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise IssueIntakeError("GitHub issue API invocation failed") from exc
    if result.returncode:
        # GitHub diagnostics may echo issue or comment text.  Keep task data
        # out of control-plane logs while preserving the failed operation.
        operation = argv[2] if len(argv) > 2 else "request"
        raise IssueIntakeError(f"GitHub issue API {operation} failed")
    return result.stdout


def _json_output(runner: Runner, argv: list[str], cwd: Path, label: str) -> Any:
    try:
        return json.loads(runner(argv, cwd))
    except IssueIntakeError:
        raise
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise IssueIntakeError(f"GitHub {label} response was invalid") from exc


def _pages(runner: Runner, endpoint: str, cwd: Path, label: str) -> list[Any]:
    value = _json_output(
        runner,
        [str(GH), "api", "--paginate", "--slurp", endpoint],
        cwd,
        label,
    )
    if not isinstance(value, list) or not all(isinstance(page, list) for page in value):
        raise IssueIntakeError(f"GitHub {label} pagination was incomplete")
    return [item for page in value for item in page]


def _parse_time(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not 1 <= len(value) <= 64:
        raise IssueIntakeError(f"issue {label} timestamp is missing")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise IssueIntakeError(f"issue {label} timestamp is invalid") from exc
    if parsed.tzinfo is None:
        raise IssueIntakeError(f"issue {label} timestamp has no timezone")
    return parsed.astimezone(timezone.utc)


def _canonical_sha(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise IssueIntakeError("issue intake state must not be a symlink")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _trusted_approvers(state_dir: Path) -> frozenset[str]:
    trusted = {REPOSITORY_OWNER.casefold()}
    path = state_dir / TRUST_FILE
    if not path.exists():
        return frozenset(trusted)
    if path.is_symlink():
        raise IssueIntakeError("issue trust configuration must not be a symlink")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise IssueIntakeError("issue trust configuration is invalid") from exc
    if (
        not isinstance(value, dict)
        or set(value) != {"schema_version", "repository", "trusted_approvers"}
        or value.get("schema_version") != 1
        or value.get("repository") != REPOSITORY
        or not isinstance(value.get("trusted_approvers"), list)
        or not all(
            isinstance(login, str) and LOGIN_RE.fullmatch(login)
            for login in value["trusted_approvers"]
        )
    ):
        raise IssueIntakeError("issue trust configuration has an invalid shape")
    trusted.update(login.casefold() for login in value["trusted_approvers"])
    return frozenset(trusted)


def _state(state_dir: Path) -> dict[str, Any]:
    path = state_dir / STATE_FILE
    if not path.exists():
        return {"schema_version": 1, "issues": {}}
    if path.is_symlink():
        raise IssueIntakeError("issue intake state must not be a symlink")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise IssueIntakeError("issue intake state is invalid") from exc
    if (
        not isinstance(value, dict)
        or set(value) != {"schema_version", "issues"}
        or value.get("schema_version") != 1
        or not isinstance(value.get("issues"), dict)
    ):
        raise IssueIntakeError("issue intake state has an invalid shape")
    for number, record in value["issues"].items():
        if (
            not isinstance(number, str)
            or not number.isdigit()
            or not isinstance(record, dict)
            or not SHA256_RE.fullmatch(str(record.get("revision_sha256", "")))
            or record.get("status") not in {"selected", "cooldown", "delivered"}
            or type(record.get("attempts")) is not int
            or record["attempts"] < 0
            or type(record.get("updated_unix")) is not int
        ):
            raise IssueIntakeError("issue intake state contains an invalid record")
        if (
            record["status"] in {"selected", "cooldown"}
            and type(record.get("retry_after_unix")) is not int
        ):
            raise IssueIntakeError("issue intake state has an invalid retry deadline")
        if record["status"] == "cooldown" and not isinstance(
            record.get("last_failure_run"), str
        ):
            raise IssueIntakeError("issue intake state has an invalid failure owner")
        if record["status"] == "delivered" and (
            not SHA_RE.fullmatch(str(record.get("candidate_sha", "")))
            or not isinstance(record.get("pr_url"), str)
            or not re.fullmatch(
                rf"https://github\.com/{re.escape(REPOSITORY)}/pull/[1-9][0-9]*",
                record["pr_url"],
            )
        ):
            raise IssueIntakeError("issue intake state has an invalid delivery")
    return value


def _write_state(state_dir: Path, value: dict[str, Any]) -> None:
    _atomic_json(state_dir / STATE_FILE, value)


ISSUE_QUERY = """query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){issue(number:$number){
    number url state title body createdAt lastEditedAt
    labels(first:100){nodes{name} pageInfo{hasNextPage}}
  }}
}"""


def _issue_snapshot(number: int, cwd: Path, runner: Runner) -> dict[str, Any]:
    owner, repository = REPOSITORY.split("/", 1)
    value = _json_output(
        runner,
        [
            str(GH),
            "api",
            "graphql",
            "-f",
            f"query={ISSUE_QUERY}",
            "-f",
            f"owner={owner}",
            "-f",
            f"repo={repository}",
            "-F",
            f"number={number}",
        ],
        cwd,
        "issue",
    )
    if not isinstance(value, dict) or value.get("errors"):
        raise IssueIntakeError("GitHub issue query failed")
    issue = ((value.get("data") or {}).get("repository") or {}).get("issue")
    if not isinstance(issue, dict) or issue.get("number") != number:
        raise IssueIntakeError("GitHub issue could not be resolved exactly")
    labels = issue.get("labels")
    if (
        not isinstance(labels, dict)
        or not isinstance(labels.get("nodes"), list)
        or not isinstance(labels.get("pageInfo"), dict)
        or labels["pageInfo"].get("hasNextPage") is not False
    ):
        raise IssueIntakeError("GitHub issue labels were incomplete")
    return issue


def _timeline(number: int, cwd: Path, runner: Runner) -> list[Any]:
    return _pages(
        runner,
        f"repos/{REPOSITORY}/issues/{number}/timeline?per_page=100",
        cwd,
        "issue timeline",
    )


def _labels(issue: dict[str, Any]) -> set[str]:
    nodes = issue["labels"]["nodes"]
    if not all(
        isinstance(node, dict) and isinstance(node.get("name"), str) for node in nodes
    ):
        raise IssueIntakeError("GitHub issue labels were invalid")
    return {node["name"] for node in nodes}


def _revision(issue: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    number = issue.get("number")
    title, body = issue.get("title"), issue.get("body")
    created, edited = issue.get("createdAt"), issue.get("lastEditedAt")
    url = issue.get("url")
    if (
        type(number) is not int
        or number <= 0
        or not isinstance(title, str)
        or not title.strip()
        or len(title) > 512
        or not isinstance(body, str)
        or len(body) > MAX_BODY_CHARS
        or url != f"https://github.com/{REPOSITORY}/issues/{number}"
        or not isinstance(created, str)
        or edited is not None
        and not isinstance(edited, str)
    ):
        raise IssueIntakeError("GitHub issue content has an invalid shape")
    _parse_time(created, "creation")
    if edited is not None:
        _parse_time(edited, "edit")
    identity = {
        "repository": REPOSITORY,
        "issue": number,
        "issue_url": url,
        "title": title,
        "body": body,
        "created_at": created,
        "last_edited_at": edited,
    }
    return _canonical_sha(identity), identity


def _approval(
    issue: dict[str, Any],
    timeline: list[Any],
    trusted: frozenset[str],
    revision_sha256: str,
) -> dict[str, str] | None:
    transitions: list[tuple[datetime, str, dict[str, Any]]] = []
    for event in timeline:
        if (
            not isinstance(event, dict)
            or event.get("event") not in {"labeled", "unlabeled"}
            or (event.get("label") or {}).get("name") != READY_LABEL
        ):
            continue
        event_id = event.get("id")
        actor = (event.get("actor") or {}).get("login")
        created = event.get("created_at")
        if (
            not isinstance(event_id, (int, str))
            or isinstance(event_id, bool)
            or not isinstance(actor, str)
            or not LOGIN_RE.fullmatch(actor)
        ):
            raise IssueIntakeError("approval label history is invalid")
        transitions.append((_parse_time(created, "approval"), str(event_id), event))
    if not transitions:
        return None
    _, event_id, latest = max(
        transitions,
        key=lambda item: (
            item[0],
            int(item[1]) if item[1].isdigit() else -1,
            item[1],
        ),
    )
    actor = latest["actor"]["login"]
    approval_time = _parse_time(latest["created_at"], "approval")
    revision_time = _parse_time(
        issue.get("lastEditedAt") or issue.get("createdAt"), "revision"
    )
    if (
        latest.get("event") != "labeled"
        or actor.casefold() not in trusted
        or approval_time <= revision_time
    ):
        return None
    return {
        "actor": actor,
        "event_id": event_id,
        "created_at": latest["created_at"],
        "revision_sha256": revision_sha256,
    }


def _references_issue(body: Any, number: int) -> bool:
    if not isinstance(body, str):
        return False
    target = rf"(?:#{number}\b|{re.escape(REPOSITORY)}#{number}\b|https://github\.com/{re.escape(REPOSITORY)}/issues/{number}\b)"
    return (
        re.search(rf"(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+{target}", body)
        is not None
    )


def _existing_prs(
    number: int, timeline: list[Any], cwd: Path, runner: Runner
) -> list[dict[str, Any]]:
    candidates: set[int] = set()
    for event in timeline:
        source = (
            (event.get("source") or {}).get("issue")
            if isinstance(event, dict)
            else None
        )
        if (
            isinstance(event, dict)
            and event.get("event") == "cross-referenced"
            and isinstance(source, dict)
            and "pull_request" in source
            and source.get("repository_url")
            == f"https://api.github.com/repos/{REPOSITORY}"
            and _references_issue(source.get("body"), number)
        ):
            candidate = source.get("number")
            if type(candidate) is int and candidate > 0:
                candidates.add(candidate)
    if len(candidates) > MAX_EXISTING_PRS:
        raise IssueIntakeError("issue has too many implementing pull requests")
    result: list[dict[str, Any]] = []
    for pr_number in sorted(candidates):
        pr = _json_output(
            runner,
            [str(GH), "api", f"repos/{REPOSITORY}/pulls/{pr_number}"],
            cwd,
            "pull request",
        )
        base = pr.get("base") if isinstance(pr, dict) else None
        head = pr.get("head") if isinstance(pr, dict) else None
        if (
            not isinstance(pr, dict)
            or pr.get("number") != pr_number
            or pr.get("state") != "open"
            or not isinstance(base, dict)
            or base.get("ref") != BASE_BRANCH
            or not isinstance(head, dict)
            or not SHA_RE.fullmatch(str(head.get("sha", "")))
            or not isinstance(head.get("repo"), dict)
            or not isinstance(head["repo"].get("full_name"), str)
            or not isinstance(head.get("ref"), str)
            or not _references_issue(pr.get("body"), number)
            or pr.get("html_url") != f"https://github.com/{REPOSITORY}/pull/{pr_number}"
        ):
            continue
        result.append({
            "number": pr_number,
            "url": pr["html_url"],
            "base_branch": base["ref"],
            "head_branch": head["ref"],
            "head_sha": head["sha"],
            "head_repository": head["repo"]["full_name"],
        })
    return result


def _request(
    issue: dict[str, Any],
    timeline: list[Any],
    trusted: frozenset[str],
    cwd: Path,
    runner: Runner,
) -> dict[str, Any] | None:
    if issue.get("state") != "OPEN" or not {SCOPE_LABEL, READY_LABEL}.issubset(
        _labels(issue)
    ):
        return None
    revision_sha256, identity = _revision(issue)
    approval = _approval(issue, timeline, trusted, revision_sha256)
    if approval is None:
        return None
    return {
        "mode": "issue",
        **identity,
        "revision_sha256": revision_sha256,
        "approval": approval,
        "existing_prs": _existing_prs(issue["number"], timeline, cwd, runner),
    }


def validate_issue_request(value: Any) -> dict[str, Any]:
    required = {
        "mode",
        "repository",
        "issue",
        "issue_url",
        "title",
        "body",
        "created_at",
        "last_edited_at",
        "revision_sha256",
        "approval",
        "existing_prs",
    }
    if (
        not isinstance(value, dict)
        or set(value) != required
        or value.get("mode") != "issue"
    ):
        raise IssueIntakeError("issue request has an invalid shape")
    identity = {
        key: value[key]
        for key in (
            "repository",
            "issue",
            "issue_url",
            "title",
            "body",
            "created_at",
            "last_edited_at",
        )
    }
    revision = value.get("revision_sha256")
    approval = value.get("approval")
    existing = value.get("existing_prs")
    if (
        value.get("repository") != REPOSITORY
        or type(value.get("issue")) is not int
        or value["issue"] <= 0
        or value.get("issue_url")
        != f"https://github.com/{REPOSITORY}/issues/{value['issue']}"
        or not isinstance(value.get("title"), str)
        or not value["title"].strip()
        or len(value["title"]) > 512
        or not isinstance(value.get("body"), str)
        or len(value["body"]) > MAX_BODY_CHARS
        or not isinstance(value.get("created_at"), str)
        or value.get("last_edited_at") is not None
        and not isinstance(value.get("last_edited_at"), str)
        or not isinstance(revision, str)
        or revision != _canonical_sha(identity)
        or not isinstance(approval, dict)
        or set(approval) != {"actor", "event_id", "created_at", "revision_sha256"}
        or not isinstance(approval.get("actor"), str)
        or not LOGIN_RE.fullmatch(approval["actor"])
        or not isinstance(approval.get("event_id"), str)
        or not approval["event_id"]
        or len(approval["event_id"]) > 128
        or approval.get("revision_sha256") != revision
        or not isinstance(existing, list)
        or len(existing) > MAX_EXISTING_PRS
    ):
        raise IssueIntakeError("issue request has an invalid binding")
    _parse_time(value["created_at"], "creation")
    if value["last_edited_at"] is not None:
        _parse_time(value["last_edited_at"], "edit")
    _parse_time(approval["created_at"], "approval")
    pr_keys = {
        "number",
        "url",
        "base_branch",
        "head_branch",
        "head_sha",
        "head_repository",
    }
    if any(
        not isinstance(pr, dict)
        or set(pr) != pr_keys
        or type(pr.get("number")) is not int
        or pr["number"] <= 0
        or pr.get("url") != f"https://github.com/{REPOSITORY}/pull/{pr['number']}"
        or pr.get("base_branch") != BASE_BRANCH
        or not isinstance(pr.get("head_branch"), str)
        or not 1 <= len(pr["head_branch"]) <= 256
        or not SHA_RE.fullmatch(str(pr.get("head_sha", "")))
        or not isinstance(pr.get("head_repository"), str)
        or not 1 <= len(pr["head_repository"]) <= 200
        for pr in existing
    ) or [pr["number"] for pr in existing] != sorted({pr["number"] for pr in existing}):
        raise IssueIntakeError("issue request has invalid implementing pull requests")
    return value


def _eligible_by_state(record: Any, revision: str, now: int) -> bool:
    if not isinstance(record, dict) or record.get("revision_sha256") != revision:
        return True
    if record.get("status") == "delivered":
        return False
    retry_after = record.get("retry_after_unix")
    return type(retry_after) is int and retry_after <= now


def select_approved_issue(
    state_dir: Path,
    *,
    now: int | None = None,
    runner: Runner | None = None,
) -> dict[str, Any] | None:
    """Return one deterministic approved issue without mutating the queue."""
    runner = _run if runner is None else runner
    now = int(time.time()) if now is None else now
    labels = quote(f"{SCOPE_LABEL},{READY_LABEL}", safe="")
    rows = _pages(
        runner,
        f"repos/{REPOSITORY}/issues?state=open&labels={labels}&per_page=100&sort=created&direction=asc",
        state_dir,
        "issue list",
    )
    if any(
        not isinstance(row, dict)
        or type(row.get("number")) is not int
        or row["number"] <= 0
        for row in rows
    ):
        raise IssueIntakeError("GitHub issue list contained an invalid item")
    numbers = sorted({
        row["number"]
        for row in rows
        if isinstance(row, dict)
        and type(row.get("number")) is int
        and row["number"] > 0
        and "pull_request" not in row
    })
    trusted = _trusted_approvers(state_dir)
    intake_state = _state(state_dir)
    eligible: list[tuple[int, int, dict[str, Any]]] = []
    for number in numbers:
        snapshot = _issue_snapshot(number, state_dir, runner)
        timeline = _timeline(number, state_dir, runner)
        request = _request(snapshot, timeline, trusted, state_dir, runner)
        if request is None:
            continue
        validate_issue_request(request)
        record = intake_state["issues"].get(str(number))
        if _eligible_by_state(record, request["revision_sha256"], now):
            prior_selection = (
                record.get("updated_unix", -1)
                if isinstance(record, dict)
                and record.get("revision_sha256") == request["revision_sha256"]
                else -1
            )
            eligible.append((prior_selection, number, request))
    return min(eligible, key=lambda item: (item[0], item[1]))[2] if eligible else None


def revalidate_approved_issue(
    state_dir: Path, request: Any, *, runner: Runner | None = None
) -> dict[str, Any]:
    """Re-read authorization and require the exact captured content/approval."""
    runner = _run if runner is None else runner
    expected = validate_issue_request(request)
    snapshot = _issue_snapshot(expected["issue"], state_dir, runner)
    timeline = _timeline(expected["issue"], state_dir, runner)
    current = _request(
        snapshot, timeline, _trusted_approvers(state_dir), state_dir, runner
    )
    if current is None:
        raise IssueIntakeError("issue approval is no longer valid")
    if current != expected:
        raise IssueIntakeError(
            "issue revision, approval, or implementing pull request changed"
        )
    return current


def mark_selected(
    state_dir: Path, request: Any, *, now: int | None = None
) -> dict[str, Any]:
    now = int(time.time()) if now is None else now
    request = validate_issue_request(request)
    state = _state(state_dir)
    prior = state["issues"].get(str(request["issue"]), {})
    attempts = (
        prior.get("attempts", 0)
        if prior.get("revision_sha256") == request["revision_sha256"]
        else 0
    )
    record = {
        "revision_sha256": request["revision_sha256"],
        "status": "selected",
        "attempts": attempts,
        "retry_after_unix": now + SELECTION_TTL_SECONDS,
        "updated_unix": now,
    }
    state["issues"][str(request["issue"])] = record
    _write_state(state_dir, state)
    return record


def defer_issue(
    state_dir: Path,
    request: Any,
    *,
    run_id: str,
    now: int | None = None,
) -> dict[str, Any]:
    now = int(time.time()) if now is None else now
    request = validate_issue_request(request)
    if not isinstance(run_id, str) or not run_id or len(run_id) > 128:
        raise IssueIntakeError("issue failure run identity is invalid")
    state = _state(state_dir)
    prior = state["issues"].get(str(request["issue"]), {})
    if (
        prior.get("revision_sha256") == request["revision_sha256"]
        and prior.get("status") == "cooldown"
        and prior.get("last_failure_run") == run_id
    ):
        return prior
    attempts = (
        prior.get("attempts", 0) + 1
        if prior.get("revision_sha256") == request["revision_sha256"]
        else 1
    )
    delay = min(COOLDOWN_SECONDS * (2 ** min(attempts - 1, 8)), MAX_COOLDOWN_SECONDS)
    record = {
        "revision_sha256": request["revision_sha256"],
        "status": "cooldown",
        "attempts": attempts,
        "retry_after_unix": now + delay,
        "updated_unix": now,
        "last_failure_run": run_id,
    }
    state["issues"][str(request["issue"])] = record
    _write_state(state_dir, state)
    return record


def _delivery_marker(request: dict[str, Any], candidate_sha: str) -> str:
    return (
        f"<!-- opentui-maintainer-delivery:v1:{request['issue']}:"
        f"{request['revision_sha256']}:{candidate_sha} -->"
    )


def _mark_delivered(
    state_dir: Path,
    request: dict[str, Any],
    candidate_sha: str,
    pr_url: str,
    now: int,
) -> dict[str, Any]:
    state = _state(state_dir)
    prior = state["issues"].get(str(request["issue"]), {})
    attempts = (
        prior.get("attempts", 0)
        if prior.get("revision_sha256") == request["revision_sha256"]
        else 0
    )
    record = {
        "revision_sha256": request["revision_sha256"],
        "status": "delivered",
        "attempts": attempts,
        "updated_unix": now,
        "candidate_sha": candidate_sha,
        "pr_url": pr_url,
    }
    state["issues"][str(request["issue"])] = record
    _write_state(state_dir, state)
    return record


def _post_delivery_receipt(
    state_dir: Path,
    request: dict[str, Any],
    candidate_sha: str,
    pr_url: str,
    marker: str,
    runner: Runner,
) -> None:
    body = (
        f"Delivered approved revision `{request['revision_sha256'][:12]}` as "
        f"candidate `{candidate_sha}` through {pr_url}.\n\n{marker}"
    )
    posted = _json_output(
        runner,
        [
            str(GH),
            "api",
            f"repos/{REPOSITORY}/issues/{request['issue']}/comments",
            "--method",
            "POST",
            "--raw-field",
            f"body={body}",
        ],
        state_dir,
        "delivery comment",
    )
    if not isinstance(posted, dict) or marker not in str(posted.get("body", "")):
        raise IssueIntakeError("issue delivery comment was not acknowledged")


def finalize_delivered_issue(
    state_dir: Path,
    request: Any,
    *,
    candidate_sha: str,
    pr_url: str,
    now: int | None = None,
    runner: Runner | None = None,
) -> dict[str, Any]:
    """Close only an exactly authorized issue after its candidate was delivered."""
    runner = _run if runner is None else runner
    now = int(time.time()) if now is None else now
    request = validate_issue_request(request)
    if not SHA_RE.fullmatch(candidate_sha):
        raise IssueIntakeError("delivered issue candidate is invalid")
    if not re.fullmatch(
        rf"https://github\.com/{re.escape(REPOSITORY)}/pull/[1-9][0-9]*", pr_url
    ):
        raise IssueIntakeError("delivered issue pull request is invalid")
    marker = _delivery_marker(request, candidate_sha)
    snapshot = _issue_snapshot(request["issue"], state_dir, runner)
    comments = _pages(
        runner,
        f"repos/{REPOSITORY}/issues/{request['issue']}/comments?per_page=100",
        state_dir,
        "issue comments",
    )
    has_receipt = any(
        isinstance(comment, dict)
        and isinstance(comment.get("body"), str)
        and marker in comment["body"]
        for comment in comments
    )
    if snapshot.get("state") == "CLOSED":
        if not has_receipt:
            # A reused implementing PR can auto-close its linked issue when
            # the guarded target CAS lands the exact head. The runtime proves
            # that ancestry before entering this function, so finish the
            # receipt transaction without attempting a second close.
            _post_delivery_receipt(
                state_dir,
                request,
                candidate_sha,
                pr_url,
                marker,
                runner,
            )
        record = _mark_delivered(state_dir, request, candidate_sha, pr_url, now)
        return {
            "issue": request["issue"],
            "closed": True,
            "already_closed": True,
            "receipt_reused": has_receipt,
            **record,
        }
    revalidate_approved_issue(state_dir, request, runner=runner)
    if not has_receipt:
        _post_delivery_receipt(
            state_dir,
            request,
            candidate_sha,
            pr_url,
            marker,
            runner,
        )
    closed = _json_output(
        runner,
        [
            str(GH),
            "api",
            f"repos/{REPOSITORY}/issues/{request['issue']}",
            "--method",
            "PATCH",
            "--field",
            "state=closed",
            "--field",
            "state_reason=completed",
        ],
        state_dir,
        "issue closure",
    )
    if (
        not isinstance(closed, dict)
        or str(closed.get("state", "")).casefold() != "closed"
    ):
        raise IssueIntakeError("issue closure was not acknowledged")
    record = _mark_delivered(state_dir, request, candidate_sha, pr_url, now)
    return {
        "issue": request["issue"],
        "closed": True,
        "receipt_reused": has_receipt,
        **record,
    }
