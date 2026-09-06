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

import hashlib
import json
import re
import runpy
from pathlib import Path
from typing import Any


REPOSITORY = "alt-glitch/hermes-agent"
BASE_BRANCH = "sid/opentui"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# PR fields this owner reads when reconciling an existing implementing PR.  The
# generic publisher owns its own media/attachment queries; this set only proves
# the reused PR still binds the exact candidate head, base and issue reference.
PR_FIELDS = "number,url,body,headRefName,headRefOid,baseRefName,state"
# Publication control tokens that untrusted issue-derived text must never carry,
# so an approved issue cannot forge maintainer evidence markers or leak paths.
BEFORE_AFTER_START = "<!-- before-and-after:start -->"
BEFORE_AFTER_END = "<!-- before-and-after:end -->"
SENSITIVE_TEXT = re.compile(
    r"(?i)(sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._-]{12,}|api[_ -]?key\s*[=:])"
)


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


# ---------------------------------------------------------------------------
# Issue publication plan
#
# The generic publisher owns media, GitHub transport, attachment and review; it
# stays free of issue policy.  This owner builds the issue-authored PR title and
# body from the claimed request and optional bounded metadata, and reconciles a
# live issue-scoped implementing PR at the create edge through the shared intake
# decoder.  Both entry points accept the needed data and the caller's transport
# explicitly so the publisher never embeds an issue seam or a second decoder.
# ---------------------------------------------------------------------------


def _canonical_sha(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _safe_metadata_text(value: str) -> str:
    if (
        BEFORE_AFTER_START in value
        or BEFORE_AFTER_END in value
        or "<!-- maintainer-" in value
        or "/home/" in value
        or "file:" in value.casefold()
        or SENSITIVE_TEXT.search(value)
        or any(ord(character) < 32 and character not in "\n\t" for character in value)
    ):
        raise IssueWorkflowError("issue PR metadata contains unsafe text")
    return value


def issue_publication_metadata(
    root: Path,
    manifest: dict[str, Any],
    issue_request: dict[str, Any] | None = None,
) -> tuple[str, str, dict[str, Any]]:
    """Build the issue-authored PR title, body prefix and evidence for a PR.

    ``manifest`` must already carry an issue run binding; the generic publisher
    handles non-issue candidate metadata itself.  ``issue_request`` is the
    caller's pre-publication refreshed request whose only mutable field is
    ``existing_prs``; it never widens the approved binding.
    """
    binding = manifest.get("run_binding")
    if not isinstance(binding, dict) or binding.get("mode") != "issue":
        raise IssueWorkflowError("issue publication is not bound to an issue request")
    request_path = root / "request.claimed.json"
    if request_path.is_symlink() or not request_path.is_file():
        raise IssueWorkflowError("issue candidate is missing its claimed request")
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise IssueWorkflowError("issue candidate request is invalid") from exc
    issue_binding = binding.get("issue")
    if (
        not isinstance(request, dict)
        or request.get("mode") != "issue"
        or not isinstance(issue_binding, dict)
        or request.get("repository") != REPOSITORY
        or request.get("issue") != issue_binding.get("number")
        or request.get("revision_sha256") != issue_binding.get("revision_sha256")
        or _canonical_sha(request) != binding.get("request_sha256")
        or not isinstance(request.get("title"), str)
    ):
        raise IssueWorkflowError(
            "issue candidate request does not match its gate binding"
        )
    if issue_request is not None:
        fixed_fields = set(request) - {"existing_prs"}
        if (
            not isinstance(issue_request, dict)
            or set(issue_request) != set(request)
            or any(issue_request.get(key) != request.get(key) for key in fixed_fields)
            or not isinstance(issue_request.get("existing_prs"), list)
        ):
            raise IssueWorkflowError(
                "refreshed issue request changed its approved binding"
            )
        request = {**request, "existing_prs": issue_request["existing_prs"]}
    title_text = " ".join(_safe_metadata_text(request["title"]).split())
    if not title_text:
        raise IssueWorkflowError("issue candidate title is empty")
    authored = {
        "title": title_text,
        "outcome": f"Implements approved issue #{request['issue']} at revision `{request['revision_sha256'][:12]}`.",
        "implementation": [
            "Built as a linear feature-only candidate from the captured fork base.",
            "This delivery does not advance the upstream synchronization watermark.",
        ],
        "verification": [
            "All seven candidate-bound code, review, terminal, and video gates passed."
        ],
        "limitations": [
            "The attached image is labeled Preview unless the registered synthetic flow proves the changed interaction."
        ],
    }
    metadata_path = root / "pr-metadata.json"
    metadata_sha256: str | None = None
    if metadata_path.exists():
        if metadata_path.is_symlink() or metadata_path.resolve().parent != root:
            raise IssueWorkflowError("issue PR metadata path is unsafe")
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise IssueWorkflowError("issue PR metadata is invalid") from exc
        keys = {
            "schema_version",
            "issue",
            "revision_sha256",
            "title",
            "outcome",
            "implementation",
            "verification",
            "limitations",
        }
        lists = ("implementation", "verification", "limitations")
        if (
            not isinstance(metadata, dict)
            or set(metadata) != keys
            or metadata.get("schema_version") != 1
            or metadata.get("issue") != request["issue"]
            or metadata.get("revision_sha256") != request["revision_sha256"]
            or not isinstance(metadata.get("title"), str)
            or not 1 <= len(metadata["title"].strip()) <= 160
            or not isinstance(metadata.get("outcome"), str)
            or not 1 <= len(metadata["outcome"].strip()) <= 2000
            or any(
                not isinstance(metadata.get(key), list)
                or len(metadata[key]) > 20
                or not all(
                    isinstance(item, str) and 1 <= len(item.strip()) <= 2000
                    for item in metadata[key]
                )
                for key in lists
            )
        ):
            raise IssueWorkflowError("issue PR metadata has an invalid bounded shape")
        authored = {key: metadata[key] for key in authored}
        metadata_sha256 = _hash(metadata_path)
    _safe_metadata_text(authored["title"])
    _safe_metadata_text(authored["outcome"])
    for key in ("implementation", "verification", "limitations"):
        for item in authored[key]:
            _safe_metadata_text(item)
    sections = [
        authored["outcome"].strip(),
        f"Approved issue: #{request['issue']} ({request['issue_url']})",
    ]
    for heading, key in (
        ("Implementation", "implementation"),
        ("Verification", "verification"),
        ("Limits and follow-ups", "limitations"),
    ):
        values = authored[key]
        if values:
            sections.append(
                f"## {heading}\n\n" + "\n".join(f"- {item.strip()}" for item in values)
            )
    return (
        f"feat(opentui): {' '.join(authored['title'].split())}"[:240],
        "\n\n".join(sections) + "\n\n",
        {
            "issue": request["issue"],
            "revision_sha256": request["revision_sha256"],
            "metadata_sha256": metadata_sha256,
            "existing_prs": request.get("existing_prs", []),
        },
    )


def reconcile_issue_pr(
    issue: dict[str, Any] | None,
    candidate: str,
    *,
    cwd: Path,
    runner: Any,
) -> dict[str, Any] | None:
    """Return one exact live implementing PR or refuse a duplicate.

    The issue-scoped open PR set is re-read live at the publication edge through
    the shared intake decoder, so a competitor PR appearing after the caller's
    snapshot is still seen immediately before the maintainer creates its own PR.
    GitHub offers no atomic compare-and-swap for PR creation; this narrows the
    final edge rather than claiming to close it.
    """
    if issue is None:
        return None
    if not SHA_RE.fullmatch(candidate):
        raise IssueWorkflowError("issue candidate identity is invalid")
    intake = _issue_intake()
    try:
        live = intake["live_existing_prs"](issue["issue"], cwd, runner=runner)
    except (RuntimeError, ValueError, KeyError, OSError) as exc:
        raise IssueWorkflowError(
            "approved issue implementing PRs could not be re-read before creation"
        ) from exc
    if not live:
        return None
    if len(live) != 1:
        raise IssueWorkflowError(
            "approved issue has ambiguous implementing PRs; refusing a duplicate PR"
        )
    expected = live[0]
    if not isinstance(expected, dict) or expected.get("head_sha") != candidate:
        raise IssueWorkflowError(
            "approved issue has a conflicting implementing PR; refusing a duplicate PR"
        )
    try:
        pr = json.loads(
            runner(
                [
                    str(intake["GH"]),
                    "pr",
                    "view",
                    str(expected["number"]),
                    "--repo",
                    REPOSITORY,
                    "--json",
                    PR_FIELDS,
                ],
                cwd,
            )
        )
    except (RuntimeError, ValueError, KeyError, OSError) as exc:
        raise IssueWorkflowError(
            "captured implementing PR could not be re-read"
        ) from exc
    if (
        not isinstance(pr, dict)
        or pr.get("number") != expected["number"]
        or pr.get("url") != expected.get("url")
        or pr.get("baseRefName") != expected.get("base_branch")
        or pr.get("headRefName") != expected.get("head_branch")
        or pr.get("headRefOid") != candidate
        or pr.get("state") != "OPEN"
        or not intake["_references_issue"](pr.get("body"), issue["issue"])
    ):
        raise IssueWorkflowError(
            "captured implementing PR changed; re-intake the approved issue"
        )
    return pr
