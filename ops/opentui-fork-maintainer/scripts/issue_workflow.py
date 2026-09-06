#!/usr/bin/env python3
"""Approved-issue lifecycle owner for the OpenTUI maintainer.

The central ``maintainer_runtime.py`` owns run exclusion, request queueing,
gate-manifest validation and the guarded remote publish for every mode.  This
sibling owns the parts that are specific to an approved GitHub issue: request
validation, run-binding identity, live revalidation of the exact approved
revision and approval, candidate pull-request reconciliation, delivery
finalization and post-failure cooldown.

It is the single place that knows about ``issue_intake.py`` and issue-shaped
state.  The runtime loads it strictly beside itself and never imports
issue-intake code directly, so the deployed control plane stays free of any
candidate implementation module.  Issue content and linked pull requests are
task data, not authority.
"""

from __future__ import annotations

import re
import runpy
from pathlib import Path
from typing import Any


REPOSITORY = "alt-glitch/hermes-agent"
BASE_BRANCH = "sid/opentui"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class IssueWorkflowError(RuntimeError):
    """An approved-issue lifecycle invariant was violated.

    The runtime translates this into its own ``ControlError`` at the boundary,
    preserving the message so failure reporting stays identical.
    """


def _issue_intake() -> dict[str, Any]:
    # Load only the installed sibling issue-intake module, never candidate code.
    return runpy.run_path(str(Path(__file__).with_name("issue_intake.py")))


def validate_issue_request(value: Any) -> dict[str, Any]:
    """Bind an issue request to its trusted intake-side validation."""
    return _issue_intake()["validate_issue_request"](value)


def select_approved_issue(state_dir: Path, *, now: int | None = None) -> Any:
    """Pick at most one approved issue, or ``None`` when the queue is empty."""
    return _issue_intake()["select_approved_issue"](state_dir, now=now)


def mark_selected(
    state_dir: Path, request: dict[str, Any], *, now: int | None = None
) -> None:
    """Record that a durable request was queued for the chosen issue."""
    _issue_intake()["mark_selected"](state_dir, request, now=now)


def defer_issue(
    state_dir: Path, request: dict[str, Any], *, run_id: str
) -> dict[str, Any]:
    """Enter a durable cooldown for a failed issue and report its deadline."""
    return _issue_intake()["defer_issue"](state_dir, request, run_id=run_id)


def binding_issue_fields(claimed_value: dict[str, Any]) -> dict[str, Any]:
    """Project the issue identity carried by a gate's run binding."""
    return {
        "repository": claimed_value["repository"],
        "number": claimed_value["issue"],
        "revision_sha256": claimed_value["revision_sha256"],
        "approval_event_id": claimed_value["approval"]["event_id"],
    }


def valid_issue_binding(value: dict[str, Any], common: set[str]) -> bool:
    """Validate an issue run binding on top of the common binding fields."""
    issue = value.get("issue")
    return (
        set(value) == common | {"issue"}
        and isinstance(issue, dict)
        and set(issue)
        == {"repository", "number", "revision_sha256", "approval_event_id"}
        and issue.get("repository") == REPOSITORY
        and type(issue.get("number")) is int
        and issue["number"] > 0
        and SHA256_RE.fullmatch(str(issue.get("revision_sha256", ""))) is not None
        and isinstance(issue.get("approval_event_id"), str)
        and bool(issue["approval_event_id"])
    )


def reconcile_issue_candidate_prs(
    current: dict[str, Any],
    candidate_sha: str,
    expected_pr: dict[str, Any] | None = None,
) -> None:
    """Refuse any ambiguous or conflicting implementing PR for the candidate."""
    if not SHA_RE.fullmatch(candidate_sha):
        raise IssueWorkflowError("issue candidate identity is invalid")
    prs = current.get("existing_prs")
    if not isinstance(prs, list) or any(not isinstance(pr, dict) for pr in prs):
        raise IssueWorkflowError("approved issue implementing PR evidence is invalid")
    if expected_pr is None:
        if len(prs) > 1 or any(pr.get("head_sha") != candidate_sha for pr in prs):
            raise IssueWorkflowError(
                "approved issue has an ambiguous or conflicting implementing PR"
            )
        return
    if (
        not isinstance(expected_pr, dict)
        or expected_pr.get("candidate_sha") != candidate_sha
        or type(expected_pr.get("number")) is not int
        or expected_pr.get("url")
        != f"https://github.com/{REPOSITORY}/pull/{expected_pr.get('number')}"
        or expected_pr.get("base_branch") != BASE_BRANCH
        or not isinstance(expected_pr.get("head_branch"), str)
    ):
        raise IssueWorkflowError("published issue candidate PR evidence is invalid")
    if not prs:
        # The maintainer-created PR deliberately does not use an auto-closing
        # keyword, so it need not appear in the issue's implementing-PR set.
        return
    expected = {
        "number": expected_pr["number"],
        "url": expected_pr["url"],
        "base_branch": expected_pr["base_branch"],
        "head_branch": expected_pr["head_branch"],
        "head_sha": candidate_sha,
    }
    if len(prs) != 1 or any(prs[0].get(key) != value for key, value in expected.items()):
        raise IssueWorkflowError(
            "approved issue has an ambiguous or conflicting implementing PR"
        )


def revalidate(
    state_dir: Path,
    request: dict[str, Any],
    *,
    candidate_sha: str,
    expected_pr: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Recheck the exact issue revision and approval under this live run."""
    try:
        current = _issue_intake()["revalidate_approved_issue"](state_dir, request)
    except (RuntimeError, ValueError, KeyError, OSError) as exc:
        raise IssueWorkflowError(
            "approved issue changed or could not be revalidated"
        ) from exc
    fixed_fields = set(request) - {"existing_prs"}
    if (
        not isinstance(current, dict)
        or set(current) != set(request)
        or any(current.get(key) != request.get(key) for key in fixed_fields)
    ):
        raise IssueWorkflowError("approved issue changed during revalidation")
    reconcile_issue_candidate_prs(current, candidate_sha, expected_pr)
    return current


def finalize_delivered(
    state_dir: Path,
    request: dict[str, Any],
    *,
    candidate_sha: str,
    pr_evidence: Any,
) -> dict[str, Any]:
    """Finalize a shipped issue candidate against its published pull request."""
    if request.get("mode") != "issue":
        raise IssueWorkflowError("issue publication is not bound to an issue request")
    if (
        not isinstance(pr_evidence, dict)
        or pr_evidence.get("candidate_sha") != candidate_sha
        or not isinstance(pr_evidence.get("url"), str)
    ):
        raise IssueWorkflowError(
            "issue publication has no candidate pull request evidence"
        )
    try:
        return _issue_intake()["finalize_delivered_issue"](
            state_dir,
            request,
            candidate_sha=candidate_sha,
            pr_url=pr_evidence["url"],
        )
    except (RuntimeError, ValueError, KeyError, OSError) as exc:
        raise IssueWorkflowError("delivered issue could not be finalized") from exc
