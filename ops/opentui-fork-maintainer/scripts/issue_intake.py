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


class IssueAuthorizationChanged(IssueIntakeError):
    """The remote issue no longer matches its captured approval."""


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
        approval_event_id = record.get("approval_event_id")
        if approval_event_id is not None and (
            not isinstance(approval_event_id, str)
            or not approval_event_id
            or len(approval_event_id) > 128
        ):
            raise IssueIntakeError("issue intake state has an invalid approval owner")
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
        closure_reason = record.get("closure_withheld_reason")
        if closure_reason is not None and (
            record["status"] != "delivered"
            or closure_reason != "approved_revision_changed_or_revoked"
        ):
            raise IssueIntakeError("issue intake state has an invalid closure result")
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
    if (
        not isinstance(issue, dict)
        or issue.get("number") != number
        or issue.get("state") not in {"OPEN", "CLOSED"}
    ):
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


def _event_order(event: dict[str, Any], label: str) -> tuple[datetime, int, str]:
    event_id = event.get("id")
    if not isinstance(event_id, (int, str)) or isinstance(event_id, bool):
        raise IssueIntakeError(f"{label} history is invalid")
    event_id_text = str(event_id)
    return (
        _parse_time(event.get("created_at"), label),
        int(event_id_text) if event_id_text.isdigit() else -1,
        event_id_text,
    )


def _title_revision_time(
    issue: dict[str, Any], timeline: list[Any]
) -> datetime | None:
    renames: list[tuple[tuple[datetime, int, str], dict[str, Any]]] = []
    for event in timeline:
        if not isinstance(event, dict) or event.get("event") != "renamed":
            continue
        rename = event.get("rename")
        if (
            not isinstance(rename, dict)
            or not isinstance(rename.get("from"), str)
            or not isinstance(rename.get("to"), str)
            or not rename["to"].strip()
            or len(rename["to"]) > 512
        ):
            raise IssueIntakeError("issue rename history is invalid")
        renames.append((_event_order(event, "rename"), event))
    if not renames:
        return None
    order, latest = max(renames, key=lambda item: item[0])
    if latest["rename"]["to"] != issue.get("title"):
        raise IssueIntakeError("issue title and rename timeline were inconsistent")
    return order[0]


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
        actor = (event.get("actor") or {}).get("login")
        if not isinstance(actor, str) or not LOGIN_RE.fullmatch(actor):
            raise IssueIntakeError("approval label history is invalid")
        order = _event_order(event, "approval")
        transitions.append((order[0], order[2], event))
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
    content_time = _parse_time(
        issue.get("lastEditedAt") or issue.get("createdAt"), "revision"
    )
    title_time = _title_revision_time(issue, timeline)
    revision_time = max(content_time, title_time) if title_time else content_time
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


def _same_authorization(record: Any, request: dict[str, Any]) -> bool:
    return (
        isinstance(record, dict)
        and record.get("revision_sha256") == request["revision_sha256"]
        and record.get("approval_event_id", request["approval"]["event_id"])
        == request["approval"]["event_id"]
    )


def _eligible_by_state(record: Any, request: dict[str, Any], now: int) -> bool:
    if not _same_authorization(record, request):
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
        if _eligible_by_state(record, request, now):
            prior_selection = (
                record.get("updated_unix", -1)
                if isinstance(record, dict)
                and _same_authorization(record, request)
                else -1
            )
            eligible.append((prior_selection, number, request))
    return min(eligible, key=lambda item: (item[0], item[1]))[2] if eligible else None


def _revalidate_snapshot(
    state_dir: Path,
    expected: dict[str, Any],
    snapshot: dict[str, Any],
    timeline: list[Any],
    runner: Runner,
    *,
    allow_closed: bool = False,
) -> dict[str, Any]:
    source = (
        {**snapshot, "state": "OPEN"}
        if allow_closed and snapshot.get("state") == "CLOSED"
        else snapshot
    )
    current = _request(
        source, timeline, _trusted_approvers(state_dir), state_dir, runner
    )
    if current is None:
        raise IssueAuthorizationChanged("issue approval is no longer valid")
    fixed_fields = set(expected) - {"existing_prs"}
    if any(current.get(key) != expected.get(key) for key in fixed_fields):
        raise IssueAuthorizationChanged("issue revision or approval changed")
    return current


def revalidate_approved_issue(
    state_dir: Path, request: Any, *, runner: Runner | None = None
) -> dict[str, Any]:
    """Re-read the approval and refresh only implementing-PR observations."""
    runner = _run if runner is None else runner
    expected = validate_issue_request(request)
    snapshot = _issue_snapshot(expected["issue"], state_dir, runner)
    timeline = _timeline(expected["issue"], state_dir, runner)
    return _revalidate_snapshot(state_dir, expected, snapshot, timeline, runner)


def mark_selected(
    state_dir: Path, request: Any, *, now: int | None = None
) -> dict[str, Any]:
    now = int(time.time()) if now is None else now
    request = validate_issue_request(request)
    state = _state(state_dir)
    prior = state["issues"].get(str(request["issue"]), {})
    attempts = (
        prior.get("attempts", 0)
        if _same_authorization(prior, request)
        else 0
    )
    record = {
        "revision_sha256": request["revision_sha256"],
        "approval_event_id": request["approval"]["event_id"],
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
        _same_authorization(prior, request)
        and prior.get("status") == "cooldown"
        and prior.get("last_failure_run") == run_id
    ):
        return prior
    attempts = (
        prior.get("attempts", 0) + 1
        if _same_authorization(prior, request)
        else 1
    )
    delay = min(COOLDOWN_SECONDS * (2 ** min(attempts - 1, 8)), MAX_COOLDOWN_SECONDS)
    record = {
        "revision_sha256": request["revision_sha256"],
        "approval_event_id": request["approval"]["event_id"],
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


def _delivery_body(
    request: dict[str, Any], candidate_sha: str, pr_url: str
) -> str:
    return (
        f"Delivered approved revision `{request['revision_sha256'][:12]}` as "
        f"candidate `{candidate_sha}` through {pr_url}.\n\n"
        f"{_delivery_marker(request, candidate_sha)}"
    )


def _mark_delivered(
    state_dir: Path,
    request: dict[str, Any],
    candidate_sha: str,
    pr_url: str,
    now: int,
    *,
    closure_withheld_reason: str | None = None,
) -> dict[str, Any]:
    state = _state(state_dir)
    prior = state["issues"].get(str(request["issue"]), {})
    attempts = (
        prior.get("attempts", 0)
        if _same_authorization(prior, request)
        else 0
    )
    record = {
        "revision_sha256": request["revision_sha256"],
        "approval_event_id": request["approval"]["event_id"],
        "status": "delivered",
        "attempts": attempts,
        "updated_unix": now,
        "candidate_sha": candidate_sha,
        "pr_url": pr_url,
    }
    if closure_withheld_reason is not None:
        record["closure_withheld_reason"] = closure_withheld_reason
    state["issues"][str(request["issue"])] = record
    _write_state(state_dir, state)
    return record


def _trusted_delivery_receipt(
    comment: Any, request: dict[str, Any], body: str
) -> bool:
    comment_id = comment.get("id") if isinstance(comment, dict) else None
    user = comment.get("user") if isinstance(comment, dict) else None
    return (
        type(comment_id) is int
        and comment_id > 0
        and comment.get("body") == body
        and isinstance(user, dict)
        and user.get("login") == REPOSITORY_OWNER
        and comment.get("url")
        == f"https://api.github.com/repos/{REPOSITORY}/issues/comments/{comment_id}"
        and comment.get("issue_url")
        == f"https://api.github.com/repos/{REPOSITORY}/issues/{request['issue']}"
        and comment.get("html_url")
        == f"https://github.com/{REPOSITORY}/issues/{request['issue']}#issuecomment-{comment_id}"
    )


def _read_delivery_receipt(
    state_dir: Path,
    request: dict[str, Any],
    comment_id: int,
    body: str,
    runner: Runner,
) -> dict[str, Any]:
    comment = _json_output(
        runner,
        [str(GH), "api", f"repos/{REPOSITORY}/issues/comments/{comment_id}"],
        state_dir,
        "delivery comment readback",
    )
    if not _trusted_delivery_receipt(comment, request, body):
        raise IssueIntakeError("issue delivery comment readback did not match")
    return comment


def _post_delivery_receipt(
    state_dir: Path,
    request: dict[str, Any],
    body: str,
    runner: Runner,
) -> dict[str, Any]:
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
    comment_id = posted.get("id") if isinstance(posted, dict) else None
    if type(comment_id) is not int or comment_id <= 0:
        raise IssueIntakeError("issue delivery comment was not acknowledged")
    return _read_delivery_receipt(state_dir, request, comment_id, body, runner)


def _withhold_closure(
    state_dir: Path,
    request: dict[str, Any],
    candidate_sha: str,
    pr_url: str,
    now: int,
    snapshot: dict[str, Any],
    *,
    receipt_reused: bool,
) -> dict[str, Any]:
    record = _mark_delivered(
        state_dir,
        request,
        candidate_sha,
        pr_url,
        now,
        closure_withheld_reason="approved_revision_changed_or_revoked",
    )
    already_closed = snapshot.get("state") == "CLOSED"
    return {
        "issue": request["issue"],
        "closed": already_closed,
        "already_closed": already_closed,
        "receipt_reused": receipt_reused,
        **record,
    }


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
    body = _delivery_body(request, candidate_sha, pr_url)
    snapshot = _issue_snapshot(request["issue"], state_dir, runner)
    timeline = _timeline(request["issue"], state_dir, runner)
    try:
        _revalidate_snapshot(
            state_dir,
            request,
            snapshot,
            timeline,
            runner,
            allow_closed=True,
        )
    except IssueAuthorizationChanged:
        return _withhold_closure(
            state_dir,
            request,
            candidate_sha,
            pr_url,
            now,
            snapshot,
            receipt_reused=False,
        )
    comments = _pages(
        runner,
        f"repos/{REPOSITORY}/issues/{request['issue']}/comments?per_page=100",
        state_dir,
        "issue comments",
    )
    receipts = [
        comment
        for comment in comments
        if _trusted_delivery_receipt(comment, request, body)
    ]
    receipt = max(receipts, key=lambda comment: comment["id"], default=None)
    receipt_reused = receipt is not None
    if receipt is None:
        receipt = _post_delivery_receipt(state_dir, request, body, runner)

    # Posting a receipt is not authority to close. Re-read the exact issue and
    # approval at the final edge so an edit or revocation leaves it open.
    snapshot = _issue_snapshot(request["issue"], state_dir, runner)
    timeline = _timeline(request["issue"], state_dir, runner)
    try:
        _revalidate_snapshot(
            state_dir,
            request,
            snapshot,
            timeline,
            runner,
            allow_closed=True,
        )
    except IssueAuthorizationChanged:
        return _withhold_closure(
            state_dir,
            request,
            candidate_sha,
            pr_url,
            now,
            snapshot,
            receipt_reused=receipt_reused,
        )
    if snapshot.get("state") == "CLOSED":
        _read_delivery_receipt(state_dir, request, receipt["id"], body, runner)
        record = _mark_delivered(state_dir, request, candidate_sha, pr_url, now)
        return {
            "issue": request["issue"],
            "closed": True,
            "already_closed": True,
            "receipt_reused": receipt_reused,
            **record,
        }
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

    # Mutation responses are not delivery proof. Read both durable remote
    # objects back independently before committing local delivered state.
    snapshot = _issue_snapshot(request["issue"], state_dir, runner)
    if snapshot.get("state") != "CLOSED":
        raise IssueIntakeError("issue closure readback did not match")
    timeline = _timeline(request["issue"], state_dir, runner)
    try:
        _revalidate_snapshot(
            state_dir,
            request,
            snapshot,
            timeline,
            runner,
            allow_closed=True,
        )
    except IssueAuthorizationChanged as exc:
        raise IssueIntakeError("issue changed during closure readback") from exc
    _read_delivery_receipt(state_dir, request, receipt["id"], body, runner)
    record = _mark_delivered(state_dir, request, candidate_sha, pr_url, now)
    return {
        "issue": request["issue"],
        "closed": True,
        "receipt_reused": receipt_reused,
        **record,
    }
