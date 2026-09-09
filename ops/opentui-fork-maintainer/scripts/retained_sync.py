#!/usr/bin/env python3
"""Authenticate an explicitly approved retained scheduled-sync repair."""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any


REPOSITORY = "alt-glitch/hermes-agent"
BASE_BRANCH = "sid/opentui"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
PROVENANCE_FIELDS = (
    "source_run",
    "manifest_sha256",
    "context_sha256",
    "outcome_sha256",
    "pr_sha256",
    "repair_sha",
)
RUN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
PR_FIELDS = {
    "number",
    "url",
    "base_branch",
    "head_branch",
    "head_sha",
    "head_repository",
}

class RetainedSyncError(RuntimeError):
    """The retained scheduled-sync evidence no longer proves its owner."""


def _json(path: Path, expected_sha256: str, label: str) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise RetainedSyncError(f"retained sync {label} evidence is missing or changed")
    try:
        contents = path.read_bytes()
    except OSError as exc:
        raise RetainedSyncError(
            f"retained sync {label} evidence is missing or changed"
        ) from exc
    if hashlib.sha256(contents).hexdigest() != expected_sha256:
        raise RetainedSyncError(f"retained sync {label} evidence is missing or changed")
    try:
        value = json.loads(contents)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RetainedSyncError(f"retained sync {label} evidence is invalid") from exc
    if not isinstance(value, dict):
        raise RetainedSyncError(f"retained sync {label} evidence is invalid")
    return value


def validate_request_provenance(value: dict[str, Any]) -> dict[str, str] | None:
    """Validate explicit pins without changing ordinary linear repairs."""
    provenance = value.get("retained_sync")
    if provenance is None:
        return None
    if (
        not isinstance(provenance, dict)
        or set(provenance) != set(PROVENANCE_FIELDS)
        or type(value.get("pr")) is not int
        or value["pr"] <= 0
        or not isinstance(provenance.get("source_run"), str)
        or not RUN_RE.fullmatch(provenance["source_run"])
        or not all(
            isinstance(provenance.get(key), str)
            and SHA256_RE.fullmatch(provenance[key])
            for key in (
                "manifest_sha256",
                "context_sha256",
                "outcome_sha256",
                "pr_sha256",
            )
        )
        or not isinstance(provenance.get("repair_sha"), str)
        or not SHA_RE.fullmatch(provenance["repair_sha"])
        or provenance.get("repair_sha") == value.get("source_sha")
    ):
        raise RetainedSyncError("retained sync repair provenance has an invalid shape")
    return {key: provenance[key] for key in PROVENANCE_FIELDS}


def authenticate(
    state_dir: Path,
    request: dict[str, Any],
    *,
    current_run_id: str,
) -> dict[str, Any] | None:
    """Bind a fresh repair owner to immutable terminal scheduled-run evidence."""
    provenance = validate_request_provenance(request)
    if provenance is None:
        return None
    source_root = Path(
        os.path.abspath(state_dir / "runs" / provenance["source_run"])
    )
    runs_root = Path(os.path.abspath(state_dir / "runs"))
    if (
        source_root.parent != runs_root
        or source_root.is_symlink()
        or not source_root.is_dir()
        or current_run_id == provenance["source_run"]
    ):
        raise RetainedSyncError("retained sync source owner is not terminal")

    context = _json(source_root / "run-context.json", provenance["context_sha256"], "context")
    outcome = _json(source_root / "run-outcome.json", provenance["outcome_sha256"], "outcome")
    manifest = _json(source_root / "gate.json", provenance["manifest_sha256"], "manifest")
    pr = _json(source_root / "pr-evidence.json", provenance["pr_sha256"], "PR")

    if (
        context.get("run_id") != provenance["source_run"]
        or context.get("base_sha") != request["base_sha"]
        or not isinstance(context.get("upstream_sha"), str)
        or not SHA_RE.fullmatch(context["upstream_sha"])
        or not isinstance(context.get("lease_token_sha256"), str)
        or not SHA256_RE.fullmatch(context["lease_token_sha256"])
        or outcome.get("status") != "failed"
        or outcome.get("published") is not False
        or outcome.get("needs_finalization") is not False
    ):
        raise RetainedSyncError("retained sync terminal owner evidence changed")

    binding = manifest.get("run_binding")
    review = manifest.get("review_proof")
    # A first gate-and-ship has no recovery receipt. Bind its original lease
    # directly; when a later observation receipt exists, validate that too.
    recovery = manifest.get("publication_recovery")
    owner = manifest.get("owner_preflight")
    upstream_sha = context["upstream_sha"]
    last_synced_upstream = binding.get("last_synced_upstream") if isinstance(binding, dict) else None
    merge_commit = review.get("merge_commit") if isinstance(review, dict) else None
    if (
        manifest.get("base_sha") != request["base_sha"]
        or manifest.get("lease_token_sha256") != context["lease_token_sha256"]
        or manifest.get("candidate_sha") != request["source_sha"]
        or not isinstance(binding, dict)
        or binding.get("mode") != "scheduled"
        or binding.get("request_sha256") is not None
        or binding.get("captured_base") != request["base_sha"]
        or binding.get("captured_upstream") != upstream_sha
        or (
            last_synced_upstream is not None
            and (
                not isinstance(last_synced_upstream, str)
                or not SHA_RE.fullmatch(last_synced_upstream)
            )
        )
        or not isinstance(review, dict)
        or review.get("review_mode") != "upstream-merge"
        or review.get("base_sha") != request["base_sha"]
        or review.get("candidate_sha") != request["source_sha"]
        or review.get("upstream_sha") != upstream_sha
        or not isinstance(merge_commit, str)
        or not SHA_RE.fullmatch(merge_commit)
        or (
            "publication_recovery" in manifest
            and (
                not isinstance(recovery, dict)
                or recovery.get("source_owner") != "live-owner"
                or recovery.get("source_evidence_dir") != str(source_root)
                or recovery.get("context_path") != str(source_root / "run-context.json")
                or recovery.get("context_sha256") != provenance["context_sha256"]
                or recovery.get("number") != request["pr"]
            )
        )
        or not isinstance(owner, dict)
        or owner.get("repository") != REPOSITORY
        or owner.get("base_sha") != request["base_sha"]
        or owner.get("candidate_sha") != request["source_sha"]
        or owner.get("number") != request["pr"]
        or not isinstance(owner.get("head_branch"), str)
        or not owner["head_branch"]
    ):
        raise RetainedSyncError("retained sync manifest provenance changed")

    if (
        pr.get("repository") != REPOSITORY
        or pr.get("base_branch") != BASE_BRANCH
        or pr.get("base_sha") != request["base_sha"]
        or pr.get("candidate_sha") != request["source_sha"]
        or pr.get("head_branch") != owner["head_branch"]
        or pr.get("number") != request["pr"]
        or pr.get("url") != f"https://github.com/{REPOSITORY}/pull/{request['pr']}"
        or pr.get("issue") is not None
    ):
        raise RetainedSyncError("retained sync PR provenance changed")

    return {
        **provenance,
        "source_sha": request["source_sha"],
        "upstream_sha": upstream_sha,
        "merge_commit": merge_commit,
        "last_synced_upstream": last_synced_upstream,
        "pr": {
            "number": request["pr"],
            "url": f"https://github.com/{REPOSITORY}/pull/{request['pr']}",
            "base_branch": BASE_BRANCH,
            "head_branch": owner["head_branch"],
            "head_sha": request["source_sha"],
            "head_repository": REPOSITORY,
        },
    }


def valid_binding(value: Any) -> bool:
    """Validate persisted provenance without rereading historical evidence."""
    if not isinstance(value, dict) or set(value) != set(PROVENANCE_FIELDS) | {
        "source_sha",
        "upstream_sha",
        "merge_commit",
        "last_synced_upstream",
        "pr",
    }:
        return False
    if not all(
        isinstance(value.get(key), str) and SHA_RE.fullmatch(value[key])
        for key in ("source_sha", "repair_sha", "upstream_sha", "merge_commit")
    ) or (
        value.get("last_synced_upstream") is not None
        and (
            not isinstance(value["last_synced_upstream"], str)
            or not SHA_RE.fullmatch(value["last_synced_upstream"])
        )
    ):
        return False
    if not all(
        isinstance(value.get(key), str) and SHA256_RE.fullmatch(value[key])
        for key in (
            "manifest_sha256",
            "context_sha256",
            "outcome_sha256",
            "pr_sha256",
        )
    ):
        return False
    pr = value.get("pr")
    if not (
        isinstance(value.get("source_run"), str)
        and RUN_RE.fullmatch(value["source_run"]) is not None
        and isinstance(pr, dict)
        and set(pr) == PR_FIELDS
        and type(pr.get("number")) is int
        and pr["number"] > 0
        and pr.get("url") == f"https://github.com/{REPOSITORY}/pull/{pr['number']}"
        and pr.get("base_branch") == BASE_BRANCH
        and isinstance(pr.get("head_branch"), str)
        and bool(pr["head_branch"])
        and isinstance(pr.get("head_sha"), str)
        and SHA_RE.fullmatch(pr["head_sha"]) is not None
        and pr.get("head_sha") == value.get("source_sha")
        and pr.get("head_repository") == REPOSITORY
    ):
        return False
    return value["source_sha"] != value["repair_sha"]


def retained_pr(run_binding: Any) -> dict[str, Any] | None:
    if (
        not isinstance(run_binding, dict)
        or run_binding.get("mode") != "repair"
        or not valid_binding(run_binding.get("retained_sync"))
    ):
        return None
    return dict(run_binding["retained_sync"]["pr"])
