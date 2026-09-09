#!/usr/bin/env python3
"""Authenticate the one coordinator-approved retained scheduled-sync repair."""

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
)
PR_FIELDS = {
    "number",
    "url",
    "base_branch",
    "head_branch",
    "head_sha",
    "head_repository",
}

# This source evidence was inspected and hash-bound by approved issue #96. A
# repair request must repeat every hash; nearby failed runs or PR prose cannot
# opt themselves into merge-shaped repair history.
RETAINED_SYNC_REPAIRS: dict[int, dict[str, Any]] = {
    95: {
        "source_run": "20260909T125428Z-216c997c",
        "manifest_sha256": "59a17d0e8773ddfaed243712151dd65f0267f2d8e7dcab8326a9e6bec0ba7e99",
        "context_sha256": "970d22bd8152762718471bb8ef8e3867c3f73b1b259c237ade5dd23adf9e5fa4",
        "outcome_sha256": "4b3de4d74dedca69970240f2820e8e2fb7d7e24dd1603b61f960b93208463a06",
        "pr_sha256": "2b1be9b695bc95ccd7e8bf0ee5f61e710d48120c07e9d8a14d7de0550f217617",
        "base_sha": "e55bce4630c73218d91a2f874f38946ac23844d9",
        "source_sha": "a4ba79d9f3bca7ed4a3823393507d7ed15d99de5",
        "repair_sha": "b14ab20f16b9d224e99f6bb00adc2a356e10bda0",
        "upstream_sha": "9e6c4100cbf5222fb473ecc2b51fd17874f6ee75",
        "merge_commit": "40e6b5d58be0cc8c028b70a318f02936d6bd3ac7",
        "last_synced_upstream": "693641aa8b4359c602283bdbbc14041e03bc47bc",
        "head_branch": "codex/opentui-maint-fc1ce2cbea7a2d28c9e10a93",
    }
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
    """Validate the optional evidence grant without changing ordinary repairs."""
    provenance = value.get("retained_sync")
    if provenance is None:
        return None
    if (
        not isinstance(provenance, dict)
        or set(provenance) != set(PROVENANCE_FIELDS)
        or not isinstance(value.get("pr"), int)
    ):
        raise RetainedSyncError("retained sync repair provenance has an invalid shape")
    grant = RETAINED_SYNC_REPAIRS.get(value["pr"])
    if grant is None or any(provenance.get(key) != grant[key] for key in PROVENANCE_FIELDS):
        raise RetainedSyncError("retained sync repair is not coordinator-approved")
    if value.get("base_sha") != grant["base_sha"] or value.get("source_sha") != grant["source_sha"]:
        raise RetainedSyncError("retained sync repair source identity changed")
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
    grant = RETAINED_SYNC_REPAIRS[request["pr"]]
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
        or context.get("base_sha") != grant["base_sha"]
        or context.get("upstream_sha") != grant["upstream_sha"]
        or not SHA256_RE.fullmatch(str(context.get("lease_token_sha256", "")))
        or outcome.get("status") != "failed"
        or outcome.get("published") is not False
        or outcome.get("needs_finalization") is not False
    ):
        raise RetainedSyncError("retained sync terminal owner evidence changed")

    binding = manifest.get("run_binding")
    review = manifest.get("review_proof")
    recovery = manifest.get("publication_recovery")
    owner = manifest.get("owner_preflight")
    if (
        manifest.get("base_sha") != grant["base_sha"]
        or manifest.get("candidate_sha") != grant["source_sha"]
        or not isinstance(binding, dict)
        or binding.get("mode") != "scheduled"
        or binding.get("request_sha256") is not None
        or binding.get("captured_base") != grant["base_sha"]
        or binding.get("captured_upstream") != grant["upstream_sha"]
        or binding.get("last_synced_upstream") != grant["last_synced_upstream"]
        or not isinstance(review, dict)
        or review.get("review_mode") != "upstream-merge"
        or review.get("base_sha") != grant["base_sha"]
        or review.get("candidate_sha") != grant["source_sha"]
        or review.get("upstream_sha") != grant["upstream_sha"]
        or review.get("merge_commit") != grant["merge_commit"]
        or not isinstance(recovery, dict)
        or recovery.get("source_owner") != "live-owner"
        or recovery.get("source_evidence_dir") != str(source_root)
        or recovery.get("context_path") != str(source_root / "run-context.json")
        or recovery.get("context_sha256") != provenance["context_sha256"]
        or recovery.get("number") != request["pr"]
        or not isinstance(owner, dict)
        or owner.get("repository") != REPOSITORY
        or owner.get("base_sha") != grant["base_sha"]
        or owner.get("candidate_sha") != grant["source_sha"]
        or owner.get("number") != request["pr"]
        or owner.get("head_branch") != grant["head_branch"]
    ):
        raise RetainedSyncError("retained sync manifest provenance changed")

    if (
        pr.get("repository") != REPOSITORY
        or pr.get("base_branch") != BASE_BRANCH
        or pr.get("base_sha") != grant["base_sha"]
        or pr.get("candidate_sha") != grant["source_sha"]
        or pr.get("head_branch") != grant["head_branch"]
        or pr.get("number") != request["pr"]
        or pr.get("url") != f"https://github.com/{REPOSITORY}/pull/{request['pr']}"
        or pr.get("issue") is not None
    ):
        raise RetainedSyncError("retained sync PR provenance changed")

    return {
        **provenance,
        "source_sha": grant["source_sha"],
        "repair_sha": grant["repair_sha"],
        "upstream_sha": grant["upstream_sha"],
        "merge_commit": grant["merge_commit"],
        "last_synced_upstream": grant["last_synced_upstream"],
        "pr": {
            "number": request["pr"],
            "url": f"https://github.com/{REPOSITORY}/pull/{request['pr']}",
            "base_branch": BASE_BRANCH,
            "head_branch": grant["head_branch"],
            "head_sha": grant["source_sha"],
            "head_repository": REPOSITORY,
        },
    }


def valid_binding(value: Any) -> bool:
    """Validate persisted provenance without rereading historical evidence."""
    if not isinstance(value, dict) or set(value) != set(PROVENANCE_FIELDS) | {
        "source_sha",
        "repair_sha",
        "upstream_sha",
        "merge_commit",
        "last_synced_upstream",
        "pr",
    }:
        return False
    if not all(SHA_RE.fullmatch(str(value.get(key, ""))) for key in (
        "source_sha",
        "repair_sha",
        "upstream_sha",
        "merge_commit",
        "last_synced_upstream",
    )):
        return False
    if not all(SHA256_RE.fullmatch(str(value.get(key, ""))) for key in (
        "manifest_sha256", "context_sha256", "outcome_sha256", "pr_sha256"
    )):
        return False
    pr = value.get("pr")
    if not (
        isinstance(value.get("source_run"), str)
        and isinstance(pr, dict)
        and set(pr) == PR_FIELDS
        and type(pr.get("number")) is int
        and pr["number"] > 0
        and pr.get("url") == f"https://github.com/{REPOSITORY}/pull/{pr['number']}"
        and pr.get("base_branch") == BASE_BRANCH
        and isinstance(pr.get("head_branch"), str)
        and bool(pr["head_branch"])
        and SHA_RE.fullmatch(str(pr.get("head_sha", ""))) is not None
        and pr.get("head_repository") == REPOSITORY
    ):
        return False
    grant = RETAINED_SYNC_REPAIRS.get(pr["number"])
    return grant is not None and all(
        value.get(key) == grant[key]
        for key in (
            *PROVENANCE_FIELDS,
            "source_sha",
            "repair_sha",
            "upstream_sha",
            "merge_commit",
            "last_synced_upstream",
        )
    ) and all(
        pr.get(key) == expected
        for key, expected in {
            "number": pr["number"],
            "url": f"https://github.com/{REPOSITORY}/pull/{pr['number']}",
            "base_branch": BASE_BRANCH,
            "head_branch": grant["head_branch"],
            "head_sha": grant["source_sha"],
            "head_repository": REPOSITORY,
        }.items()
    )


def retained_pr(run_binding: Any) -> dict[str, Any] | None:
    if (
        not isinstance(run_binding, dict)
        or run_binding.get("mode") != "repair"
        or not valid_binding(run_binding.get("retained_sync"))
    ):
        return None
    return dict(run_binding["retained_sync"]["pr"])
