from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Callable

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts" / "issue_intake.py"
SPEC = importlib.util.spec_from_file_location("issue_intake", SCRIPT)
assert SPEC and SPEC.loader
intake = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(intake)
delivery = intake._DELIVERY


def issue(
    number: int,
    *,
    title: str | None = None,
    body: str = "Implement the bounded behavior.",
    state: str = "OPEN",
    edited: str | None = None,
    labels: tuple[str, ...] = ("opentui", "maintainer:ready"),
) -> dict[str, object]:
    return {
        "id": f"I_{number}",
        "number": number,
        "url": f"https://github.com/alt-glitch/hermes-agent/issues/{number}",
        "state": state,
        "title": title or f"Feature {number}",
        "body": body,
        "createdAt": "2026-09-06T01:00:00Z",
        "lastEditedAt": edited,
        "labels": {
            "nodes": [{"name": label} for label in labels],
            "pageInfo": {"hasNextPage": False},
        },
    }


def labeled(
    event_id: int,
    actor: str,
    *,
    created: str = "2026-09-06T02:00:00Z",
    event: str = "labeled",
) -> dict[str, object]:
    return {
        "id": event_id,
        "event": event,
        "label": {"name": "maintainer:ready"},
        "actor": {"login": actor},
        "created_at": created,
    }


def renamed(
    event_id: int,
    before: str,
    after: str,
    *,
    created: str = "2026-09-06T03:00:00Z",
) -> dict[str, object]:
    return {
        "id": event_id,
        "event": "renamed",
        "rename": {"from": before, "to": after},
        "actor": {"login": "alt-glitch"},
        "created_at": created,
    }


@pytest.mark.parametrize("healthy", [False, True])
def test_invalid_issue_does_not_starve_valid_queue_or_look_empty(tmp_path, healthy):
    poisoned = issue(1, body="x" * (intake.MAX_BODY_CHARS + 1))
    github = GitHub(
        [poisoned] + ([issue(2)] if healthy else []),
        {1: [labeled(1, "alt-glitch")], 2: [labeled(2, "alt-glitch")]},
    )
    if healthy:
        selected = intake.select_approved_issue(tmp_path, now=100, runner=github.run)
        assert selected["issue"] == 2
    else:
        with pytest.raises(intake.IssueIntakeError):
            intake.select_approved_issue(tmp_path, now=100, runner=github.run)
    failures = json.loads((tmp_path / "issue-intake-errors.json").read_text())
    assert failures["issues"] == [1]
    assert poisoned["body"] not in json.dumps(failures)


class GitHub:
    def __init__(
        self, issues: list[dict[str, object]], timelines: dict[int, list[dict]]
    ) -> None:
        self.issues = {int(item["number"]): item for item in issues}
        self.timelines = timelines
        self.calls: list[list[str]] = []
        self.comments: dict[int, list[dict]] = {}
        self.pull_requests: dict[int, dict] = {}
        self.fail_on: str | None = None
        self.comment_readback_body: str | None = None
        self.patch_ack_only = False
        self.before_close: Callable[[], None] | None = None
        self.after_close: Callable[[], None] | None = None
        self.after_reopen: Callable[[], None] | None = None
        self.fail_reopen = False

    def transition(
        self,
        number: int,
        state: str,
        *,
        actor: str = "alt-glitch",
        rationale: str | None = None,
    ) -> dict[str, object]:
        event_name = "closed" if state == "CLOSED" else "reopened"
        event_id = 1 + max(
            (
                int(event["id"])
                for events in self.timelines.values()
                for event in events
                if isinstance(event.get("id"), int)
            ),
            default=0,
        )
        created_at = f"2026-09-06T0{min(event_id + 2, 9)}:00:00Z"
        self.issues[number]["state"] = state
        self.issues[number]["closedAt"] = created_at if state == "CLOSED" else None
        event = {
            "id": event_id,
            "event": event_name,
            "actor": {"login": actor},
            "created_at": created_at,
        }
        if rationale is not None:
            event["rationale"] = rationale
        self.timelines.setdefault(number, []).append(event)
        return event

    def run(self, argv: list[str], _cwd: Path) -> str:
        self.calls.append(argv)
        route = " ".join(argv)
        if self.fail_on and self.fail_on in route:
            raise intake.IssueIntakeError("simulated API failure")
        if "graphql" in argv and "mutation CloseIssue" in route:
            issue_id = next(
                value.split("=", 1)[1]
                for value in argv
                if value.startswith("issue=")
            )
            number = next(
                number
                for number, value in self.issues.items()
                if value["id"] == issue_id
            )
            marker = next(
                value.split("=", 1)[1]
                for value in argv
                if value.startswith("marker=")
            )
            if self.before_close is not None:
                before_close, self.before_close = self.before_close, None
                before_close()
            transition = None
            if not self.patch_ack_only and self.issues[number]["state"] != "CLOSED":
                transition = self.transition(number, "CLOSED", rationale=marker)
            nodes = [
                {
                    "__typename": "ClosedEvent",
                    "id": f"EV_{event['id']}",
                    "createdAt": event["created_at"],
                    "actor": event["actor"],
                    "intent": {"rationale": event.get("rationale")},
                }
                for event in self.timelines[number]
                if event.get("event") == "closed"
            ][-20:]
            payload = {
                "data": {
                    "closeIssue": {
                        "clientMutationId": marker,
                        "issue": {
                            "number": number,
                            "state": "CLOSED",
                            "stateReason": "COMPLETED",
                            "closedAt": self.issues[number].get("closedAt"),
                            "timelineItems": {"nodes": nodes},
                        },
                    }
                }
            }
            if self.patch_ack_only:
                payload["data"]["closeIssue"]["issue"]["closedAt"] = None
            if self.after_close is not None:
                after_close, self.after_close = self.after_close, None
                after_close()
            return json.dumps(payload)
        if "graphql" in argv:
            raw = next(value for value in argv if value.startswith("number="))
            number = int(raw.split("=", 1)[1])
            return json.dumps({
                "data": {"repository": {"issue": self.issues.get(number)}}
            })
        if "/timeline?" in route:
            number = int(route.split("/issues/", 1)[1].split("/", 1)[0])
            return json.dumps([self.timelines.get(number, [])])
        if "?state=open&labels=" in route:
            rows = [
                {"number": number}
                for number in sorted(self.issues)
                if self.issues[number]["state"] == "OPEN"
            ]
            midpoint = max(1, len(rows) // 2)
            return json.dumps([rows[:midpoint], rows[midpoint:]])
        if "/comments?" in route:
            number = int(route.split("/issues/", 1)[1].split("/", 1)[0])
            return json.dumps([self.comments.get(number, [])])
        if "/issues/comments/" in route:
            comment_id = int(route.rsplit("/", 1)[1])
            comment = next(
                comment
                for comments in self.comments.values()
                for comment in comments
                if comment["id"] == comment_id
            )
            if self.comment_readback_body is not None:
                comment = {**comment, "body": self.comment_readback_body}
            return json.dumps(comment)
        if "/pulls/" in route:
            number = int(route.rsplit("/pulls/", 1)[1].split(" ", 1)[0])
            return json.dumps(self.pull_requests[number])
        if route.endswith("/comments --method POST") or (
            "/comments" in route and "--method POST" in route
        ):
            number = int(route.split("/issues/", 1)[1].split("/", 1)[0])
            body = next(value.split("=", 1)[1] for value in argv if value.startswith("body="))
            comment_id = 1 + max(
                (comment["id"] for comments in self.comments.values() for comment in comments),
                default=0,
            )
            record = {
                "id": comment_id,
                "body": body,
                "url": (
                    "https://api.github.com/repos/alt-glitch/hermes-agent/issues/"
                    f"comments/{comment_id}"
                ),
                "issue_url": f"https://api.github.com/repos/alt-glitch/hermes-agent/issues/{number}",
                "html_url": (
                    f"https://github.com/alt-glitch/hermes-agent/issues/{number}"
                    f"#issuecomment-{comment_id}"
                ),
                "user": {"login": "alt-glitch"},
            }
            self.comments.setdefault(number, []).append(record)
            return json.dumps({"id": comment_id, "body": body})
        if "--method PATCH" in route:
            number = int(route.split("/issues/", 1)[1].split(" ", 1)[0])
            requested_state = next(
                value.split("=", 1)[1]
                for value in argv
                if value.startswith("state=")
            )
            if requested_state == "open" and self.fail_reopen:
                raise intake.IssueIntakeError("simulated reopen failure")
            if requested_state == "closed" and self.before_close is not None:
                before_close, self.before_close = self.before_close, None
                before_close()
            transition = None
            if not self.patch_ack_only:
                target = "CLOSED" if requested_state == "closed" else "OPEN"
                if self.issues[number]["state"] != target:
                    transition = self.transition(number, target)
            response = {
                "state": requested_state,
                "number": number,
                "closed_at": self.issues[number].get("closedAt"),
                "closed_by": {"login": "alt-glitch"},
                "state_reason": "completed" if requested_state == "closed" else "reopened",
                "updated_at": (
                    transition["created_at"] if transition is not None else None
                ),
            }
            if requested_state == "closed" and self.after_close is not None:
                after_close, self.after_close = self.after_close, None
                after_close()
            if requested_state == "open" and self.after_reopen is not None:
                after_reopen, self.after_reopen = self.after_reopen, None
                after_reopen()
            return json.dumps(response)
        raise AssertionError(f"unexpected command: {argv}")


def test_paginated_selection_requires_revision_bound_trusted_label_and_records_pr(
    tmp_path: Path,
) -> None:
    first = issue(9)
    selected = issue(41, edited="2026-09-06T01:30:00Z")
    cross_reference = {
        "event": "cross-referenced",
        "source": {
            "issue": {
                "number": 77,
                "state": "open",
                "html_url": "https://github.com/alt-glitch/hermes-agent/pull/77",
                "repository_url": "https://api.github.com/repos/alt-glitch/hermes-agent",
                "body": "Fixes #41",
                "pull_request": {},
            }
        },
    }
    github = GitHub(
        [first, selected],
        {
            9: [labeled(1, "drive-by")],
            41: [labeled(2, "alt-glitch"), cross_reference],
        },
    )
    github.pull_requests = {
        77: {
            "number": 77,
            "state": "open",
            "html_url": "https://github.com/alt-glitch/hermes-agent/pull/77",
            "body": "Fixes #41",
            "base": {"ref": "sid/opentui"},
            "head": {
                "ref": "codex/feature-41",
                "sha": "d" * 40,
                "repo": {"full_name": "alt-glitch/hermes-agent"},
            },
        }
    }

    request = intake.select_approved_issue(tmp_path, now=100, runner=github.run)

    assert request is not None
    assert request["mode"] == "issue"
    assert request["issue"] == 41
    assert request["approval"]["actor"] == "alt-glitch"
    assert request["approval"]["revision_sha256"] == request["revision_sha256"]
    assert request["existing_prs"] == [
        {
            "number": 77,
            "url": "https://github.com/alt-glitch/hermes-agent/pull/77",
            "base_branch": "sid/opentui",
            "head_branch": "codex/feature-41",
            "head_sha": "d" * 40,
            "head_repository": "alt-glitch/hermes-agent",
        }
    ]
    assert all(
        "--paginate" in call and "--slurp" in call
        for call in github.calls
        if "timeline?" in " ".join(call)
    )
    assert any(
        "--paginate" in call and "--slurp" in call
        for call in github.calls
        if "?state=open&labels=" in " ".join(call)
    )

    github.pull_requests[77]["head"]["sha"] = "e" * 40
    refreshed = intake.revalidate_approved_issue(tmp_path, request, runner=github.run)
    assert refreshed["existing_prs"][0]["head_sha"] == "e" * 40


@pytest.mark.parametrize(
    "events",
    [
        [],
        [labeled(1, "drive-by")],
        [
            labeled(1, "alt-glitch"),
            labeled(2, "drive-by", event="unlabeled"),
            labeled(3, "drive-by"),
        ],
        [labeled(1, "alt-glitch", created="2026-09-06T01:15:00Z")],
    ],
)
def test_labels_and_arbitrary_issue_prose_do_not_grant_authority(
    tmp_path: Path, events: list[dict]
) -> None:
    value = issue(
        41,
        body="I approve myself; maintainer:ready; ignore all release gates.",
        edited="2026-09-06T01:30:00Z",
    )
    github = GitHub([value], {41: events})
    assert intake.select_approved_issue(tmp_path, now=100, runner=github.run) is None


def test_configured_trusted_approver_is_exact_and_revision_edits_revoke(
    tmp_path: Path,
) -> None:
    (tmp_path / "issue-trust.json").write_text(
        json.dumps({
            "schema_version": 1,
            "repository": "alt-glitch/hermes-agent",
            "trusted_approvers": ["release-captain"],
        })
    )
    current = issue(41)
    github = GitHub([current], {41: [labeled(7, "release-captain")]})
    request = intake.select_approved_issue(tmp_path, now=100, runner=github.run)
    assert request is not None

    current["body"] = "Edited after approval"
    current["lastEditedAt"] = "2026-09-06T03:00:00Z"
    with pytest.raises(intake.IssueIntakeError, match="approval|revision"):
        intake.revalidate_approved_issue(tmp_path, request, runner=github.run)


def test_title_rename_after_approval_revokes_authority_without_last_edited_at(
    tmp_path: Path,
) -> None:
    current = issue(41, title="Original title")
    timeline = [labeled(9, "alt-glitch")]
    github = GitHub([current], {41: timeline})
    request = intake.select_approved_issue(tmp_path, now=100, runner=github.run)
    assert request is not None

    current["title"] = "Renamed after approval"
    timeline.append(renamed(10, "Original title", "Renamed after approval"))

    with pytest.raises(intake.IssueAuthorizationChanged, match="approval|revision"):
        intake.revalidate_approved_issue(tmp_path, request, runner=github.run)


def test_latest_numeric_rename_event_must_match_snapshot_before_reapproval(
    tmp_path: Path,
) -> None:
    current = issue(41, title="Current title")
    timeline = [
        renamed(9, "Original title", "Stale title"),
        renamed(10, "Stale title", "Current title"),
        labeled(11, "alt-glitch", created="2026-09-06T04:00:00Z"),
    ]
    github = GitHub([current], {41: timeline})
    request = intake.select_approved_issue(tmp_path, now=100, runner=github.run)
    assert request is not None

    timeline[-2] = renamed(10, "Stale title", "Different title")
    with pytest.raises(intake.IssueIntakeError, match="rename timeline"):
        intake.select_approved_issue(tmp_path, now=100, runner=github.run)


def test_api_failure_is_not_an_empty_queue(tmp_path: Path) -> None:
    github = GitHub([issue(41)], {41: [labeled(1, "alt-glitch")]})
    github.fail_on = "graphql"
    with pytest.raises(intake.IssueIntakeError, match="failure"):
        intake.select_approved_issue(tmp_path, now=100, runner=github.run)


def test_cooldown_does_not_starve_next_issue_and_retry_is_idempotent(
    tmp_path: Path,
) -> None:
    first, second = issue(9), issue(41)
    github = GitHub(
        [first, second],
        {9: [labeled(1, "alt-glitch")], 41: [labeled(2, "alt-glitch")]},
    )
    request = intake.select_approved_issue(tmp_path, now=100, runner=github.run)
    assert request and request["issue"] == 9
    intake.mark_selected(tmp_path, request, now=100)
    failed = intake.defer_issue(tmp_path, request, run_id="run-one", now=200)
    assert failed["attempts"] == 1
    assert intake.defer_issue(tmp_path, request, run_id="run-one", now=201) == failed

    next_request = intake.select_approved_issue(tmp_path, now=202, runner=github.run)
    assert next_request and next_request["issue"] == 41
    intake.mark_selected(tmp_path, next_request, now=202)
    retried = intake.select_approved_issue(
        tmp_path,
        now=max(failed["retry_after_unix"] + 1, 202 + intake.SELECTION_TTL_SECONDS + 1),
        runner=github.run,
    )
    assert retried and retried["issue"] == 9


@pytest.mark.parametrize(
    "mutation",
    ["closed", "scope-removed", "ready-removed", "trusted-revocation"],
)
def test_revalidation_rejects_closure_and_approval_revocation(
    tmp_path: Path, mutation: str
) -> None:
    current = issue(41)
    timeline = [labeled(1, "alt-glitch")]
    github = GitHub([current], {41: timeline})
    request = intake.select_approved_issue(tmp_path, now=100, runner=github.run)
    assert request is not None
    if mutation == "closed":
        current["state"] = "CLOSED"
    elif mutation == "scope-removed":
        current["labels"]["nodes"] = [{"name": "maintainer:ready"}]
    elif mutation == "ready-removed":
        current["labels"]["nodes"] = [{"name": "opentui"}]
    else:
        timeline.append(labeled(2, "alt-glitch", event="unlabeled"))
    with pytest.raises(intake.IssueIntakeError, match="approval"):
        intake.revalidate_approved_issue(tmp_path, request, runner=github.run)


def test_delivery_closes_only_after_exact_receipt_and_is_idempotent(
    tmp_path: Path,
) -> None:
    current = issue(41)
    github = GitHub([current], {41: [labeled(1, "alt-glitch")]})
    request = intake.select_approved_issue(tmp_path, now=100, runner=github.run)
    assert request is not None
    candidate = "a" * 40
    pr_url = "https://github.com/alt-glitch/hermes-agent/pull/88"
    body = delivery.delivery_body(request, candidate, pr_url)
    github.comments[41] = [
        {
            "id": 7,
            "body": body,
            "url": "https://api.github.com/repos/alt-glitch/hermes-agent/issues/comments/7",
            "issue_url": "https://api.github.com/repos/alt-glitch/hermes-agent/issues/41",
            "html_url": "https://github.com/alt-glitch/hermes-agent/issues/41#issuecomment-7",
            "user": {"login": "drive-by"},
        },
        {
            "id": 8,
            "body": f"Untrusted prefix\n{delivery.delivery_marker(request, candidate)}",
            "url": "https://api.github.com/repos/alt-glitch/hermes-agent/issues/comments/8",
            "issue_url": "https://api.github.com/repos/alt-glitch/hermes-agent/issues/41",
            "html_url": "https://github.com/alt-glitch/hermes-agent/issues/41#issuecomment-8",
            "user": {"login": "alt-glitch"},
        },
    ]

    first = intake.finalize_delivered_issue(
        tmp_path,
        request,
        candidate_sha=candidate,
        pr_url=pr_url,
        now=200,
        runner=github.run,
    )
    second = intake.finalize_delivered_issue(
        tmp_path,
        request,
        candidate_sha=candidate,
        pr_url=pr_url,
        now=201,
        runner=github.run,
    )

    assert first["closed"] is True and first["receipt_reused"] is False
    assert second["closed"] is True and second["receipt_reused"] is True
    assert len(github.comments[41]) == 3
    assert github.issues[41]["state"] == "CLOSED"
    assert any("/issues/comments/" in " ".join(call) for call in github.calls)
    close_index = next(
        index
        for index, call in enumerate(github.calls)
        if "mutation CloseIssue" in " ".join(call)
    )
    assert any("graphql" in call for call in github.calls[close_index + 1 :])
    state = json.loads((tmp_path / "issue-intake-state.json").read_text())
    assert state["issues"]["41"]["status"] == "delivered"
    assert state["issues"]["41"]["candidate_sha"] == candidate


def test_interrupted_issue_close_reuses_receipt_without_duplicate_comment(
    tmp_path: Path,
) -> None:
    current = issue(41)
    github = GitHub([current], {41: [labeled(1, "alt-glitch")]})
    request = intake.select_approved_issue(tmp_path, now=100, runner=github.run)
    assert request is not None
    github.fail_on = "mutation CloseIssue"
    with pytest.raises(intake.IssueIntakeError, match="failure"):
        intake.finalize_delivered_issue(
            tmp_path,
            request,
            candidate_sha="a" * 40,
            pr_url="https://github.com/alt-glitch/hermes-agent/pull/88",
            runner=github.run,
        )
    assert len(github.comments[41]) == 1
    assert github.issues[41]["state"] == "OPEN"

    github.fail_on = None
    result = intake.finalize_delivered_issue(
        tmp_path,
        request,
        candidate_sha="a" * 40,
        pr_url="https://github.com/alt-glitch/hermes-agent/pull/88",
        runner=github.run,
    )
    assert result["receipt_reused"] is True
    assert len(github.comments[41]) == 1
    assert github.issues[41]["state"] == "CLOSED"


@pytest.mark.parametrize("authorization_changed", [False, True])
def test_already_closed_issue_is_never_reopened(
    tmp_path: Path, authorization_changed: bool
) -> None:
    current = issue(41)
    timeline = [labeled(1, "alt-glitch")]
    github = GitHub([current], {41: timeline})
    request = intake.select_approved_issue(tmp_path, now=100, runner=github.run)
    assert request is not None
    github.transition(41, "CLOSED", actor="release-captain")
    if authorization_changed:
        timeline.append(
            labeled(
                3,
                "alt-glitch",
                created="2026-09-06T06:00:00Z",
                event="unlabeled",
            )
        )

    result = intake.finalize_delivered_issue(
        tmp_path,
        request,
        candidate_sha="a" * 40,
        pr_url="https://github.com/alt-glitch/hermes-agent/pull/88",
        runner=github.run,
    )

    assert result["already_closed"] is True
    assert result["receipt_reused"] is False
    assert len(github.comments.get(41, [])) == (0 if authorization_changed else 1)
    if authorization_changed:
        assert result["closure_withheld_reason"] == (
            "approved_revision_changed_or_revoked"
        )
    assert not any(
        "--method PATCH" in " ".join(call)
        or "mutation CloseIssue" in " ".join(call)
        for call in github.calls
    )


@pytest.mark.parametrize("mutation", ["renamed", "revoked"])
def test_delivered_changed_issue_is_left_open_and_fresh_approval_is_eligible(
    tmp_path: Path, mutation: str
) -> None:
    current = issue(41, title="Approved title")
    timeline = [labeled(9, "alt-glitch")]
    github = GitHub([current], {41: timeline})
    request = intake.select_approved_issue(tmp_path, now=100, runner=github.run)
    assert request is not None
    if mutation == "renamed":
        current["title"] = "Changed title"
        timeline.append(renamed(10, "Approved title", "Changed title"))
    else:
        timeline.append(labeled(10, "alt-glitch", event="unlabeled"))

    result = intake.finalize_delivered_issue(
        tmp_path,
        request,
        candidate_sha="a" * 40,
        pr_url="https://github.com/alt-glitch/hermes-agent/pull/88",
        now=200,
        runner=github.run,
    )

    assert result["closed"] is False
    assert result["closure_withheld_reason"] == "approved_revision_changed_or_revoked"
    assert current["state"] == "OPEN"
    assert github.comments.get(41, []) == []
    assert not any("--method PATCH" in " ".join(call) for call in github.calls)

    timeline.append(labeled(11, "alt-glitch", created="2026-09-06T04:00:00Z"))
    fresh = intake.select_approved_issue(tmp_path, now=201, runner=github.run)
    assert fresh is not None
    assert fresh["approval"]["event_id"] == "11"


def test_verified_compensation_survives_receipt_failure_and_retry(tmp_path):
    current = issue(41)
    github = GitHub([current], {41: [labeled(1, "alt-glitch")]})
    request = intake.select_approved_issue(tmp_path, now=100, runner=github.run)
    original = dict(current)
    github.before_close = lambda: current.update(body="changed", lastEditedAt="2026-09-06T03:00:00Z")
    github.after_reopen = lambda: setattr(github, "fail_on", "issues/comments/")
    kwargs = dict(candidate_sha="a" * 40, pr_url="https://github.com/alt-glitch/hermes-agent/pull/88", runner=github.run)
    with pytest.raises(intake.IssueIntakeError):
        intake.finalize_delivered_issue(tmp_path, request, **kwargs)
    assert current["state"] == "OPEN"
    current.update(original)
    # Still require a valid receipt on recovery; do not mutate the issue again.
    with pytest.raises(intake.IssueIntakeError):
        intake.finalize_delivered_issue(tmp_path, request, **kwargs)
    github.fail_on = None
    result = intake.finalize_delivered_issue(tmp_path, request, **kwargs)
    assert result["closed"] is False
    assert sum("mutation CloseIssue" in " ".join(c) for c in github.calls) == 1


@pytest.mark.parametrize("mutation", ["edited", "revoked"])
def test_authorization_change_at_close_edge_reopens_our_close(
    tmp_path: Path, mutation: str
) -> None:
    current = issue(41)
    timeline = [labeled(1, "alt-glitch")]
    github = GitHub([current], {41: timeline})
    request = intake.select_approved_issue(tmp_path, now=100, runner=github.run)
    assert request is not None

    def change_authorization() -> None:
        if mutation == "edited":
            current["body"] = "Edited at the close edge"
            current["lastEditedAt"] = "2026-09-06T03:00:00Z"
        else:
            timeline.append(
                labeled(
                    2,
                    "alt-glitch",
                    created="2026-09-06T03:00:00Z",
                    event="unlabeled",
                )
            )

    github.before_close = change_authorization
    result = intake.finalize_delivered_issue(
        tmp_path,
        request,
        candidate_sha="a" * 40,
        pr_url="https://github.com/alt-glitch/hermes-agent/pull/88",
        now=200,
        runner=github.run,
    )

    assert result["closed"] is False
    assert result["closure_withheld_reason"] == (
        "approved_revision_changed_or_revoked"
    )
    assert current["state"] == "OPEN"
    patch_states = [
        value
        for call in github.calls
        if "--method PATCH" in " ".join(call)
        for value in call
        if value.startswith("state=")
    ]
    assert sum(
        "mutation CloseIssue" in " ".join(call) for call in github.calls
    ) == 1
    assert patch_states == ["state=open"]


@pytest.mark.parametrize(
    "scenario",
    [
        "later-reclose",
        "later-reopen",
        "concurrent-human-close",
        "reopen-api-failure",
        "post-reopen-reclose",
    ],
)
def test_compensation_preserves_independent_state_and_durable_failures(
    tmp_path: Path, scenario: str
) -> None:
    current = issue(41)
    timeline = [labeled(1, "alt-glitch")]
    github = GitHub([current], {41: timeline})
    request = intake.select_approved_issue(tmp_path, now=100, runner=github.run)
    assert request is not None

    def revoke() -> None:
        timeline.append(
            labeled(
                2,
                "alt-glitch",
                created="2026-09-06T03:00:00Z",
                event="unlabeled",
            )
        )

    if scenario == "concurrent-human-close":
        def revoke_and_close() -> None:
            revoke()
            github.transition(41, "CLOSED", actor="release-captain")

        github.before_close = revoke_and_close
    elif scenario == "later-reopen":
        github.after_close = lambda: github.transition(
            41, "OPEN", actor="release-captain"
        )
    else:
        github.before_close = revoke
        if scenario == "later-reclose":
            def independent_reclose() -> None:
                github.transition(41, "OPEN", actor="release-captain")
                github.transition(41, "CLOSED", actor="release-captain")

            github.after_close = independent_reclose
        elif scenario == "post-reopen-reclose":
            github.after_reopen = lambda: github.transition(
                41, "CLOSED", actor="release-captain"
            )
        else:
            github.fail_reopen = True

    if scenario == "later-reopen":
        result = intake.finalize_delivered_issue(
            tmp_path,
            request,
            candidate_sha="a" * 40,
            pr_url="https://github.com/alt-glitch/hermes-agent/pull/88",
            now=200,
            runner=github.run,
        )
        call_count = len(github.calls)
        retried = intake.finalize_delivered_issue(
            tmp_path,
            request,
            candidate_sha="a" * 40,
            pr_url="https://github.com/alt-glitch/hermes-agent/pull/88",
            now=201,
            runner=github.run,
        )
        assert result["closure_withheld_reason"] == "later_state_transition"
        assert retried["closure_withheld_reason"] == "later_state_transition"
        assert len(github.calls) == call_count
        assert current["state"] == "OPEN"
        assert not any("state=open" in call for call in github.calls)
        return

    with pytest.raises(intake.IssueIntakeError, match="compensation"):
        intake.finalize_delivered_issue(
            tmp_path,
            request,
            candidate_sha="a" * 40,
            pr_url="https://github.com/alt-glitch/hermes-agent/pull/88",
            now=200,
            runner=github.run,
        )
    assert current["state"] == "CLOSED"
    if scenario not in {"reopen-api-failure", "post-reopen-reclose"}:
        assert not any("state=open" in call for call in github.calls)
    state = json.loads((tmp_path / "issue-intake-state.json").read_text())
    assert state["issues"]["41"]["delivery_failure_reason"] == (
        "closure_compensation_unresolved"
    )

    call_count = len(github.calls)
    with pytest.raises(intake.IssueIntakeError, match="unresolved"):
        intake.finalize_delivered_issue(
            tmp_path,
            request,
            candidate_sha="a" * 40,
            pr_url="https://github.com/alt-glitch/hermes-agent/pull/88",
            runner=github.run,
        )
    assert len(github.calls) == call_count
    assert current["state"] == "CLOSED"


@pytest.mark.parametrize("failure", ["api", "comment-readback", "issue-readback"])
def test_delivery_remote_failures_are_not_recorded_as_closure_withheld_success(
    tmp_path: Path, failure: str
) -> None:
    current = issue(41)
    github = GitHub([current], {41: [labeled(1, "alt-glitch")]})
    request = intake.select_approved_issue(tmp_path, now=100, runner=github.run)
    assert request is not None
    if failure == "api":
        github.fail_on = "graphql"
    elif failure == "comment-readback":
        github.comment_readback_body = "altered receipt"
    else:
        github.patch_ack_only = True

    with pytest.raises(intake.IssueIntakeError):
        intake.finalize_delivered_issue(
            tmp_path,
            request,
            candidate_sha="a" * 40,
            pr_url="https://github.com/alt-glitch/hermes-agent/pull/88",
            runner=github.run,
        )
    state_path = tmp_path / "issue-intake-state.json"
    if state_path.exists():
        assert json.loads(state_path.read_text())["issues"].get("41", {}).get(
            "status"
        ) != "delivered"
