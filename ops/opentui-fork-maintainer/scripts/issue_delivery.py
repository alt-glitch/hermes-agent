"""Delivery receipts and authorization-safe issue finalization.

GitHub does not offer a compare-and-set precondition for issue state updates.
When authorization changes at the close edge, this module therefore reopens
only a close that can be tied to this invocation's acknowledged mutation and
to the newly observed close event. Ambiguous ownership is persisted as a
failure instead of being reported as successful delivery.
See docs/handoffs/opentui-issue-close-api.md for the live-verified GraphQL
rationale/intent fields; older schema snapshots omit these fields.
"""

from __future__ import annotations

import re
import secrets
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, NamedTuple, NoReturn


CLOSE_ISSUE_MUTATION = """mutation CloseIssue($issue:ID!,$marker:String!){
  closeIssue(input:{issueId:$issue,stateReason:COMPLETED,rationale:$marker,
                   clientMutationId:$marker}){
    clientMutationId
    issue{number state stateReason closedAt
      timelineItems(last:20,itemTypes:[CLOSED_EVENT]){nodes{
        __typename ... on ClosedEvent{id createdAt actor{login} intent{rationale}}
      }}}
  }
}"""


class DeliveryIO(NamedTuple):
    gh: Path
    repository: str
    repository_owner: str
    sha_re: re.Pattern[str]
    issue_error: type[Exception]
    authorization_changed: type[Exception]
    validate_request: Callable[[Any], dict[str, Any]]
    issue_snapshot: Callable[[int, Path, Callable[..., str]], dict[str, Any]]
    timeline: Callable[[int, Path, Callable[..., str]], list[Any]]
    revalidate_snapshot: Callable[..., dict[str, Any]]
    pages: Callable[..., list[Any]]
    json_output: Callable[..., Any]
    read_state: Callable[[Path], dict[str, Any]]
    write_state: Callable[[Path, dict[str, Any]], None]
    same_authorization: Callable[[Any, dict[str, Any]], bool]
    parse_time: Callable[[Any, str], datetime]


def delivery_marker(request: dict[str, Any], candidate_sha: str) -> str:
    return (
        f"<!-- opentui-maintainer-delivery:v1:{request['issue']}:"
        f"{request['revision_sha256']}:{candidate_sha} -->"
    )


def delivery_body(request: dict[str, Any], candidate_sha: str, pr_url: str) -> str:
    return (
        f"Delivered approved revision `{request['revision_sha256'][:12]}` as "
        f"candidate `{candidate_sha}` through {pr_url}.\n\n"
        f"{delivery_marker(request, candidate_sha)}"
    )


def _delivery_record(
    io: DeliveryIO,
    state_dir: Path,
    request: dict[str, Any],
    candidate_sha: str,
    pr_url: str,
    now: int,
    *,
    status: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    state = io.read_state(state_dir)
    prior = state["issues"].get(str(request["issue"]), {})
    attempts = prior.get("attempts", 0) if io.same_authorization(prior, request) else 0
    record = {
        "revision_sha256": request["revision_sha256"],
        "approval_event_id": request["approval"]["event_id"],
        "status": status,
        "attempts": attempts,
        "updated_unix": now,
        "candidate_sha": candidate_sha,
        "pr_url": pr_url,
    }
    state["issues"][str(request["issue"])] = record
    return state, record


def _mark_delivered(
    io: DeliveryIO,
    state_dir: Path,
    request: dict[str, Any],
    candidate_sha: str,
    pr_url: str,
    now: int,
    *,
    closure_withheld_reason: str | None = None,
) -> dict[str, Any]:
    state, record = _delivery_record(
        io,
        state_dir,
        request,
        candidate_sha,
        pr_url,
        now,
        status="delivered",
    )
    if closure_withheld_reason is not None:
        record["closure_withheld_reason"] = closure_withheld_reason
    io.write_state(state_dir, state)
    return record


def _mark_compensation_failure(
    io: DeliveryIO,
    state_dir: Path,
    request: dict[str, Any],
    candidate_sha: str,
    pr_url: str,
    now: int,
) -> None:
    state, record = _delivery_record(
        io,
        state_dir,
        request,
        candidate_sha,
        pr_url,
        now,
        status="delivery_failed",
    )
    record["delivery_failure_reason"] = "closure_compensation_unresolved"
    io.write_state(state_dir, state)


def _trusted_delivery_receipt(
    io: DeliveryIO,
    comment: Any,
    request: dict[str, Any],
    body: str,
) -> bool:
    comment_id = comment.get("id") if isinstance(comment, dict) else None
    user = comment.get("user") if isinstance(comment, dict) else None
    return (
        type(comment_id) is int
        and comment_id > 0
        and comment.get("body") == body
        and isinstance(user, dict)
        and user.get("login") == io.repository_owner
        and comment.get("url")
        == f"https://api.github.com/repos/{io.repository}/issues/comments/{comment_id}"
        and comment.get("issue_url")
        == f"https://api.github.com/repos/{io.repository}/issues/{request['issue']}"
        and comment.get("html_url")
        == f"https://github.com/{io.repository}/issues/{request['issue']}#issuecomment-{comment_id}"
    )


def _read_delivery_receipt(
    io: DeliveryIO,
    state_dir: Path,
    request: dict[str, Any],
    comment_id: int,
    body: str,
    runner: Callable[..., str],
) -> dict[str, Any]:
    comment = io.json_output(
        runner,
        [str(io.gh), "api", f"repos/{io.repository}/issues/comments/{comment_id}"],
        state_dir,
        "delivery comment readback",
    )
    if not _trusted_delivery_receipt(io, comment, request, body):
        raise io.issue_error("issue delivery comment readback did not match")
    return comment


def _post_delivery_receipt(
    io: DeliveryIO,
    state_dir: Path,
    request: dict[str, Any],
    body: str,
    runner: Callable[..., str],
) -> dict[str, Any]:
    posted = io.json_output(
        runner,
        [
            str(io.gh),
            "api",
            f"repos/{io.repository}/issues/{request['issue']}/comments",
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
        raise io.issue_error("issue delivery comment was not acknowledged")
    return _read_delivery_receipt(io, state_dir, request, comment_id, body, runner)


def _withhold_closure(
    io: DeliveryIO,
    state_dir: Path,
    request: dict[str, Any],
    candidate_sha: str,
    pr_url: str,
    now: int,
    snapshot: dict[str, Any],
    *,
    receipt_reused: bool,
    reason: str = "approved_revision_changed_or_revoked",
) -> dict[str, Any]:
    record = _mark_delivered(
        io,
        state_dir,
        request,
        candidate_sha,
        pr_url,
        now,
        closure_withheld_reason=reason,
    )
    already_closed = snapshot.get("state") == "CLOSED"
    return {
        "issue": request["issue"],
        "closed": already_closed,
        "already_closed": already_closed,
        "receipt_reused": receipt_reused,
        **record,
    }


def _state_events(io: DeliveryIO, timeline: list[Any]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for event in timeline:
        if not isinstance(event, dict) or event.get("event") not in {
            "closed",
            "reopened",
        }:
            continue
        event_id = event.get("id")
        actor = event.get("actor")
        if (
            type(event_id) is not int
            or event_id <= 0
            or not isinstance(actor, dict)
            or not isinstance(actor.get("login"), str)
        ):
            raise io.issue_error("issue state transition history is invalid")
        io.parse_time(event.get("created_at"), "state transition")
        events.append(event)
    return sorted(
        events,
        key=lambda event: (
            io.parse_time(event["created_at"], "state transition"),
            event["id"],
        ),
    )


def _new_state_events(
    io: DeliveryIO,
    before: list[Any],
    after: list[Any],
) -> list[dict[str, Any]]:
    previous_events = _state_events(io, before)
    current_events = _state_events(io, after)
    previous = {event["id"]: event for event in previous_events}
    current = {event["id"]: event for event in current_events}
    if len(previous) != len(previous_events) or len(current) != len(current_events):
        raise io.issue_error("issue state transition history has duplicate events")
    for event_id, event in previous.items():
        observed = current.get(event_id)
        if observed is None or any(
            observed.get(key) != event.get(key)
            for key in ("event", "created_at", "actor")
        ):
            raise io.issue_error("issue state transition history changed")
    return [event for event_id, event in current.items() if event_id not in previous]


def _close_acknowledgement(
    io: DeliveryIO,
    value: Any,
    request: dict[str, Any],
    marker: str,
) -> dict[str, Any] | None:
    payload = (value.get("data") or {}).get("closeIssue") if isinstance(value, dict) else None
    issue = payload.get("issue") if isinstance(payload, dict) else None
    timeline = issue.get("timelineItems") if isinstance(issue, dict) else None
    nodes = timeline.get("nodes") if isinstance(timeline, dict) else None
    if (
        (value.get("errors") if isinstance(value, dict) else True)
        or not isinstance(payload, dict)
        or payload.get("clientMutationId") != marker
        or not isinstance(issue, dict)
        or issue.get("number") != request["issue"]
        or issue.get("state") != "CLOSED"
        or issue.get("stateReason") != "COMPLETED"
        or not isinstance(issue.get("closedAt"), str)
        or not isinstance(nodes, list)
    ):
        return None
    matching = [
        event
        for event in nodes
        if isinstance(event, dict)
        and event.get("__typename") == "ClosedEvent"
        and isinstance(event.get("id"), str)
        and event["id"]
        and event.get("createdAt") == issue["closedAt"]
        and (event.get("actor") or {}).get("login") == io.repository_owner
        and (event.get("intent") or {}).get("rationale") == marker
    ]
    if len(matching) != 1:
        return None
    io.parse_time(issue["closedAt"], "closure")
    return {
        "number": issue["number"],
        "state": "closed",
        "state_reason": "completed",
        "closed_at": issue["closedAt"],
        "actor": matching[0]["actor"],
        "event_id": matching[0].get("id"),
    }


def _our_close_is_latest(
    io: DeliveryIO,
    request: dict[str, Any],
    closed: Any,
    before_timeline: list[Any],
    snapshot: dict[str, Any],
    after_timeline: list[Any],
) -> bool:
    actor = closed.get("actor") if isinstance(closed, dict) else None
    closed_at = closed.get("closed_at") if isinstance(closed, dict) else None
    if (
        not isinstance(closed, dict)
        or closed.get("number") != request["issue"]
        or str(closed.get("state", "")).casefold() != "closed"
        or closed.get("state_reason") != "completed"
        or not isinstance(actor, dict)
        or actor.get("login") != io.repository_owner
        or not isinstance(closed_at, str)
        or snapshot.get("state") != "CLOSED"
        or snapshot.get("closedAt") != closed_at
    ):
        return False
    io.parse_time(closed_at, "closure")
    new_events = _new_state_events(io, before_timeline, after_timeline)
    return (
        len(new_events) == 1
        and new_events[0].get("event") == "closed"
        and new_events[0].get("created_at") == closed_at
        and (new_events[0].get("actor") or {}).get("login")
        == io.repository_owner
    )


def _our_close_precedes_open_state(
    io: DeliveryIO,
    closed: dict[str, Any],
    before_timeline: list[Any],
    after_timeline: list[Any],
) -> bool:
    new_events = _new_state_events(io, before_timeline, after_timeline)
    return (
        len(new_events) >= 2
        and new_events[0].get("event") == "closed"
        and new_events[0].get("created_at") == closed["closed_at"]
        and (new_events[0].get("actor") or {}).get("login")
        == io.repository_owner
        and new_events[-1].get("event") == "reopened"
    )


def _persist_ambiguous_failure(
    io: DeliveryIO,
    state_dir: Path,
    request: dict[str, Any],
    candidate_sha: str,
    pr_url: str,
    now: int,
    cause: Exception | None = None,
) -> NoReturn:
    _mark_compensation_failure(io, state_dir, request, candidate_sha, pr_url, now)
    error = io.issue_error("issue closure compensation could not be completed safely")
    if cause is None:
        raise error
    raise error from cause


def _compensate_owned_close(
    io: DeliveryIO,
    state_dir: Path,
    request: dict[str, Any],
    candidate_sha: str,
    pr_url: str,
    now: int,
    body: str,
    receipt: dict[str, Any],
    receipt_reused: bool,
    closed: Any,
    before_timeline: list[Any],
    snapshot: dict[str, Any],
    after_timeline: list[Any],
    runner: Callable[..., str],
) -> dict[str, Any]:
    try:
        owned = _our_close_is_latest(
            io,
            request,
            closed,
            before_timeline,
            snapshot,
            after_timeline,
        )
    except io.issue_error as exc:
        _persist_ambiguous_failure(
            io, state_dir, request, candidate_sha, pr_url, now, exc
        )
    if not owned:
        _persist_ambiguous_failure(io, state_dir, request, candidate_sha, pr_url, now)

    reopen_error: Exception | None = None
    reopened: Any = None
    try:
        reopened = io.json_output(
            runner,
            [
                str(io.gh),
                "api",
                f"repos/{io.repository}/issues/{request['issue']}",
                "--method",
                "PATCH",
                "--field",
                "state=open",
                "--field",
                "state_reason=reopened",
            ],
            state_dir,
            "issue closure compensation",
        )
    except io.issue_error as exc:
        reopen_error = exc

    try:
        reopened_snapshot = io.issue_snapshot(request["issue"], state_dir, runner)
        reopened_timeline = io.timeline(request["issue"], state_dir, runner)
    except io.issue_error as exc:
        _persist_ambiguous_failure(
            io, state_dir, request, candidate_sha, pr_url, now, exc
        )
    if reopened_snapshot.get("state") != "OPEN":
        _persist_ambiguous_failure(
            io,
            state_dir,
            request,
            candidate_sha,
            pr_url,
            now,
            reopen_error,
        )
    if reopen_error is None:
        updated_at = reopened.get("updated_at") if isinstance(reopened, dict) else None
        new_events = _new_state_events(io, after_timeline, reopened_timeline)
        if (
            not isinstance(reopened, dict)
            or reopened.get("number") != request["issue"]
            or str(reopened.get("state", "")).casefold() != "open"
            or reopened.get("closed_at") is not None
            or not isinstance(updated_at, str)
            or len(new_events) != 1
            or new_events[0].get("event") != "reopened"
            or new_events[0].get("created_at") != updated_at
            or (new_events[0].get("actor") or {}).get("login") != io.repository_owner
        ):
            _persist_ambiguous_failure(
                io, state_dir, request, candidate_sha, pr_url, now
            )
    _read_delivery_receipt(io, state_dir, request, receipt["id"], body, runner)
    return _withhold_closure(
        io,
        state_dir,
        request,
        candidate_sha,
        pr_url,
        now,
        reopened_snapshot,
        receipt_reused=receipt_reused,
    )


def _durable_failure_for_request(
    io: DeliveryIO,
    state_dir: Path,
    request: dict[str, Any],
) -> bool:
    record = io.read_state(state_dir)["issues"].get(str(request["issue"]))
    return (
        io.same_authorization(record, request)
        and record.get("status") == "delivery_failed"
    )


def _preserved_transition_delivery(
    io: DeliveryIO,
    state_dir: Path,
    request: dict[str, Any],
    candidate_sha: str,
    pr_url: str,
) -> dict[str, Any] | None:
    record = io.read_state(state_dir)["issues"].get(str(request["issue"]))
    if (
        io.same_authorization(record, request)
        and record.get("status") == "delivered"
        and record.get("candidate_sha") == candidate_sha
        and record.get("pr_url") == pr_url
        and record.get("closure_withheld_reason") == "later_state_transition"
    ):
        return {
            "issue": request["issue"],
            "closed": False,
            "already_closed": False,
            "receipt_reused": True,
            **record,
        }
    return None


def finalize_delivered_issue(
    io: DeliveryIO,
    state_dir: Path,
    request: Any,
    *,
    candidate_sha: str,
    pr_url: str,
    now: int | None = None,
    runner: Callable[..., str],
) -> dict[str, Any]:
    """Close only an exactly authorized issue after its candidate was delivered."""
    now = int(time.time()) if now is None else now
    request = io.validate_request(request)
    if not io.sha_re.fullmatch(candidate_sha):
        raise io.issue_error("delivered issue candidate is invalid")
    if not re.fullmatch(
        rf"https://github\.com/{re.escape(io.repository)}/pull/[1-9][0-9]*",
        pr_url,
    ):
        raise io.issue_error("delivered issue pull request is invalid")
    if _durable_failure_for_request(io, state_dir, request):
        raise io.issue_error(
            "issue delivery has an unresolved closure compensation failure"
        )
    preserved = _preserved_transition_delivery(
        io, state_dir, request, candidate_sha, pr_url
    )
    if preserved is not None:
        return preserved

    body = delivery_body(request, candidate_sha, pr_url)
    snapshot = io.issue_snapshot(request["issue"], state_dir, runner)
    timeline = io.timeline(request["issue"], state_dir, runner)
    try:
        io.revalidate_snapshot(
            state_dir, request, snapshot, timeline, runner, allow_closed=True
        )
    except io.authorization_changed:
        return _withhold_closure(
            io,
            state_dir,
            request,
            candidate_sha,
            pr_url,
            now,
            snapshot,
            receipt_reused=False,
        )

    comments = io.pages(
        runner,
        f"repos/{io.repository}/issues/{request['issue']}/comments?per_page=100",
        state_dir,
        "issue comments",
    )
    receipts = [
        comment
        for comment in comments
        if _trusted_delivery_receipt(io, comment, request, body)
    ]
    receipt = max(receipts, key=lambda comment: comment["id"], default=None)
    receipt_reused = receipt is not None
    if receipt is None:
        receipt = _post_delivery_receipt(io, state_dir, request, body, runner)

    # Posting a receipt is not authority to close. Re-read the exact issue and
    # approval at the final edge so an edit or revocation leaves it open.
    snapshot = io.issue_snapshot(request["issue"], state_dir, runner)
    timeline = io.timeline(request["issue"], state_dir, runner)
    try:
        io.revalidate_snapshot(
            state_dir, request, snapshot, timeline, runner, allow_closed=True
        )
    except io.authorization_changed:
        return _withhold_closure(
            io,
            state_dir,
            request,
            candidate_sha,
            pr_url,
            now,
            snapshot,
            receipt_reused=receipt_reused,
        )
    if snapshot.get("state") == "CLOSED":
        _read_delivery_receipt(io, state_dir, request, receipt["id"], body, runner)
        record = _mark_delivered(io, state_dir, request, candidate_sha, pr_url, now)
        return {
            "issue": request["issue"],
            "closed": True,
            "already_closed": True,
            "receipt_reused": receipt_reused,
            **record,
        }

    before_timeline = timeline
    issue_id = snapshot.get("id")
    if not isinstance(issue_id, str) or not issue_id:
        raise io.issue_error("issue closure target was invalid")
    marker = (
        f"opentui-maintainer-close:{request['issue']}:"
        f"{request['revision_sha256'][:12]}:{candidate_sha[:12]}:"
        f"{receipt['id']}:{secrets.token_hex(8)}"
    )
    try:
        close_response = io.json_output(
            runner,
            [
                str(io.gh),
                "api",
                "graphql",
                "-f",
                f"query={CLOSE_ISSUE_MUTATION}",
                "-f",
                f"issue={issue_id}",
                "-f",
                f"marker={marker}",
            ],
            state_dir,
            "issue closure",
        )
    except io.issue_error as exc:
        try:
            uncertain_snapshot = io.issue_snapshot(request["issue"], state_dir, runner)
            uncertain_timeline = io.timeline(request["issue"], state_dir, runner)
            transitions = _new_state_events(io, before_timeline, uncertain_timeline)
        except io.issue_error as observation_error:
            _persist_ambiguous_failure(
                io,
                state_dir,
                request,
                candidate_sha,
                pr_url,
                now,
                observation_error,
            )
        if uncertain_snapshot.get("state") == "OPEN" and not transitions:
            raise exc
        _persist_ambiguous_failure(
            io, state_dir, request, candidate_sha, pr_url, now, exc
        )

    closed = _close_acknowledgement(io, close_response, request, marker)

    # Mutation responses are not delivery proof. Read both durable remote
    # objects back independently before committing local delivered state.
    try:
        snapshot = io.issue_snapshot(request["issue"], state_dir, runner)
        after_timeline = io.timeline(request["issue"], state_dir, runner)
    except io.issue_error as exc:
        _persist_ambiguous_failure(
            io, state_dir, request, candidate_sha, pr_url, now, exc
        )
    if snapshot.get("state") == "OPEN":
        try:
            transitions = _new_state_events(io, before_timeline, after_timeline)
            preserves_later_transition = (
                closed is not None
                and _our_close_precedes_open_state(
                    io, closed, before_timeline, after_timeline
                )
            )
        except io.issue_error as exc:
            _persist_ambiguous_failure(
                io, state_dir, request, candidate_sha, pr_url, now, exc
            )
        if preserves_later_transition:
            _read_delivery_receipt(
                io, state_dir, request, receipt["id"], body, runner
            )
            return _withhold_closure(
                io,
                state_dir,
                request,
                candidate_sha,
                pr_url,
                now,
                snapshot,
                receipt_reused=receipt_reused,
                reason="later_state_transition",
            )
        if transitions:
            _persist_ambiguous_failure(
                io, state_dir, request, candidate_sha, pr_url, now
            )
        raise io.issue_error("issue closure readback did not match")
    if snapshot.get("state") != "CLOSED":
        raise io.issue_error("issue closure readback did not match")
    if closed is None:
        _persist_ambiguous_failure(
            io, state_dir, request, candidate_sha, pr_url, now
        )
    try:
        io.revalidate_snapshot(
            state_dir,
            request,
            snapshot,
            after_timeline,
            runner,
            allow_closed=True,
        )
    except io.authorization_changed:
        return _compensate_owned_close(
            io,
            state_dir,
            request,
            candidate_sha,
            pr_url,
            now,
            body,
            receipt,
            receipt_reused,
            closed,
            before_timeline,
            snapshot,
            after_timeline,
            runner,
        )
    _read_delivery_receipt(io, state_dir, request, receipt["id"], body, runner)
    record = _mark_delivered(io, state_dir, request, candidate_sha, pr_url, now)
    return {
        "issue": request["issue"],
        "closed": True,
        "receipt_reused": receipt_reused,
        **record,
    }
