"""Publish synthetic acceptance evidence; never merge or update the target ref."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import struct
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

GH = Path("/home/daimon/.local/bin/gh")
FORMATTER = Path("/home/daimon/.agents/skills/before-and-after/scripts/format.mjs")
FORMATTER_SHA256 = "573f4c0e66e4d7010fdcd928dcca10915460a17e4df489d443be0812477dba59"
PROFILE = "/home/daimon/.hermes/profiles/opentui-maintainer"
REPOSITORY = "alt-glitch/hermes-agent"
BASE = "sid/opentui"
START = "<!-- before-and-after:start -->"
END = "<!-- before-and-after:end -->"
ATTACHMENT = re.compile(r"https://github\.com/user-attachments/assets/[a-zA-Z0-9-]+")
FIELDS = "number,url,body,headRefName,headRefOid,baseRefName,state,isDraft"
OWNERSHIP_FIELDS = ",baseRefOid,isCrossRepository,headRepositoryOwner,headRepository"
STATUS_START = "<!-- maintainer-evidence-status:start -->"
STATUS_END = "<!-- maintainer-evidence-status:end -->"
# Immutable GitHub App IDs, verified against this fork's live check suites.
REQUIRED_CHECK_APPS = {"All required checks pass": 15368}
REQUIRED_CONTEXTS = set(REQUIRED_CHECK_APPS)
# These rules add no check contexts; GitHub still enforces them at merge/push.
NON_CHECK_RULES = frozenset({
    "creation", "update", "deletion", "required_linear_history",
    "required_signatures", "pull_request", "non_fast_forward",
})
MAX_REVIEW_WAIT_SECONDS = 140 * 60
REVIEW_POLL_SECONDS = 30
MAX_FAILED_JOB_LOG_BYTES = 32 * 1024 * 1024
ACTION_JOB_URL = re.compile(
    rf"^https://github\.com/{re.escape(REPOSITORY)}/actions/runs/([1-9][0-9]*)/job/([1-9][0-9]*)/?$"
)


class PublicationError(RuntimeError):
    pass


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _run(argv: list[str], cwd: Path) -> str:
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=180)
    if result.returncode:
        # gh diagnostics can include submitted bodies; do not echo them into logs.
        raise PublicationError(
            f"publication command failed: {Path(argv[0]).name} {argv[1]}"
        )
    return result.stdout


def _issue_workflow() -> Any:
    """Load the approved-issue lifecycle owner strictly beside this publisher.

    This module owns generic media, GitHub transport, attachment and review;
    issue metadata, body construction and implementing-PR reconciliation belong
    to the issue-workflow owner, which alone knows the issue decoder.  Resolving
    it by filesystem adjacency keeps issue policy out of this transport module
    without importing any candidate implementation code.
    """
    path = Path(__file__).with_name("issue_workflow.py")
    spec = importlib.util.spec_from_file_location("_opentui_pub_issue_workflow", path)
    if not path.is_file() or spec is None or spec.loader is None:
        raise PublicationError(
            "issue workflow owner could not be located beside the publisher"
        )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write(path: Path, value: str) -> None:
    if path.is_symlink():
        raise PublicationError("publication state must not be a symlink")
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".pr-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def _file(root: Path, value: str, digest: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or path.is_symlink() or path.resolve() != path:
        raise PublicationError("preview evidence path is not canonical")
    if not path.is_relative_to(root) or not path.is_file() or _hash(path) != digest:
        raise PublicationError("preview evidence escaped or changed")
    return path


def preview(root: Path, manifest: dict[str, Any]) -> tuple[Path, str, tuple[int, int]]:
    checks = [c for c in manifest["checks"] if c["id"] == "termctrl-smoke"]
    if len(checks) != 1 or checks[0]["status"] != "passed":
        raise PublicationError("preview requires a passed runtime capture")
    check = checks[0]
    log = _file(root, check["output_path"], check["output_sha256"])
    proof = json.loads(log.read_text(encoding="utf-8"))
    if proof.get("publication_scope") != {
        "profile": PROFILE,
        "flow": "synthetic-startup-help",
        "personal_history": False,
        "environment": "allowlist-v1",
    }:
        raise PublicationError(
            "refusing upload: capture is not the isolated synthetic help flow"
        )
    path = _file(root, proof["png_path"], proof["png_sha256"])
    if path != root / "termctrl-verified/accepted.png":
        raise PublicationError("preview must be the runtime accepted frame")
    text = _file(root, proof["text_path"], proof["text_sha256"]).read_text(
        encoding="utf-8"
    )
    if "Available Commands" not in text or re.search(
        r"(?i)(sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._-]{12,}|api[_ -]?key\s*[=:])", text
    ):
        raise PublicationError("accepted frame failed the synthetic text safety check")
    data = path.read_bytes()
    if (
        len(data) < 24
        or len(data) > 10_000_000
        or data[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    ):
        raise PublicationError("accepted frame is not a bounded PNG")
    dimensions = struct.unpack(">II", data[16:24])
    if not all(0 < n <= 8192 for n in dimensions):
        raise PublicationError("accepted frame dimensions are invalid")
    return path, proof["png_sha256"], dimensions


def _block(body: str) -> str | None:
    if START not in body and END not in body:
        return None
    if (
        body.count(START) != 1
        or body.count(END) != 1
        or body.index(END) < body.index(START)
    ):
        raise PublicationError("PR contains ambiguous evidence markers")
    return body[body.index(START) : body.index(END) + len(END)]


def _replace(body: str, block: str) -> str:
    old = _block(body)
    if old is not None:
        return body.replace(old, block, 1)
    return body + ("\n\n" if body else "") + block


def _status_block(
    candidate: str,
    *,
    passed: list[str],
    pending: list[str],
) -> str:
    if (
        not re.fullmatch(r"[0-9a-f]{40}", candidate)
        or not passed
        or not pending
        or any(
            not isinstance(item, str) or not item.strip() or len(item) > 500
            for item in [*passed, *pending]
        )
    ):
        raise PublicationError("PR evidence status has an invalid bounded shape")
    sections = [
        STATUS_START,
        "## Prepared",
        f"- Task-owned candidate `{candidate}` is committed and bound to this PR.",
        "",
        "## Passed",
        *(f"- {item.strip()}" for item in passed),
        "",
        "## Pending",
        *(f"- {item.strip()}" for item in pending),
        "",
        "PR visibility or readiness is not release authorization; target publication still uses the guarded CAS.",
        STATUS_END,
    ]
    return "\n".join(sections)


def _replace_status(body: str, block: str) -> str:
    if STATUS_START not in body and STATUS_END not in body:
        if START in body:
            position = body.index(START)
            return body[:position] + block + "\n\n" + body[position:]
        return body + ("\n\n" if body else "") + block
    if (
        body.count(STATUS_START) != 1
        or body.count(STATUS_END) != 1
        or body.index(STATUS_END) < body.index(STATUS_START)
    ):
        raise PublicationError("PR contains ambiguous evidence status markers")
    before = body[: body.index(STATUS_START)]
    after = body[body.index(STATUS_END) + len(STATUS_END) :]
    return before + block + after


def _canonical_sha(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _candidate_head(manifest: dict[str, Any]) -> tuple[str, str, str]:
    """The task/revision and integration base own the PR, not each fix commit."""
    candidate, base = manifest.get("candidate_sha"), manifest.get("base_sha")
    if not all(
        isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha)
        for sha in (candidate, base)
    ):
        raise PublicationError("invalid candidate/base identity")
    binding = manifest.get("run_binding")
    request_identity: str | None = None
    if isinstance(binding, dict):
        if binding.get("mode") == "scheduled":
            upstream = binding.get("captured_upstream")
            if not isinstance(upstream, str) or not re.fullmatch(r"[0-9a-f]{40}", upstream):
                raise PublicationError("scheduled task has no captured upstream")
            request_identity = _canonical_sha({"mode": "scheduled", "upstream": upstream})
        if binding.get("mode") == "issue" and isinstance(binding.get("issue"), dict):
            request_identity = _canonical_sha(binding["issue"])
        if request_identity is None:
            request_identity = binding.get("request_sha256")
    if not isinstance(request_identity, str) or not re.fullmatch(
        r"[0-9a-f]{64}", request_identity
    ):
        request_identity = manifest.get("lease_token_sha256")
    if not isinstance(request_identity, str) or not re.fullmatch(
        r"[0-9a-f]{64}", request_identity
    ):
        raise PublicationError("candidate has no stable request identity")
    identity = _canonical_sha(
        {
            "schema_version": 2,
            "repository": REPOSITORY,
            "base_branch": BASE,
            "request_identity": request_identity,
            "base_sha": base,
        }
    )
    return f"codex/opentui-maint-{identity[:24]}", request_identity, identity


def _validate_pr(
    pr: dict[str, Any], head: str, candidate: str, identity: str | None = None
) -> None:
    if (
        pr.get("headRefName") != head
        or pr.get("headRefOid") != candidate
        or pr.get("baseRefName") != BASE
        or pr.get("state") != "OPEN"
        or not isinstance(pr.get("number"), int)
        or pr.get("url") != f"https://github.com/{REPOSITORY}/pull/{pr.get('number')}"
    ):
        raise PublicationError("PR does not bind the open expected base/head candidate")
    if identity is not None and identity not in str(pr.get("body", "")):
        raise PublicationError("PR does not bind the expected request/base/candidate")


def _published_block(body: str, identity: str) -> tuple[str, str] | None:
    block = _block(body)
    if block is None or identity not in block:
        return None
    urls = ATTACHMENT.findall(block)
    if len(urls) != 1 or "![Preview](" + urls[0] + ")" not in block:
        return None
    if "./" in block or "file:" in block or "/home/" in block:
        raise PublicationError("published evidence still contains a local reference")
    return block, urls[0]


def required_check_policy(root: Path) -> dict[str, Any]:
    """Read classic protection and active rulesets for the exact publication base."""
    query = """query($owner:String!, $repo:String!, $ref:String!){
      repository(owner:$owner,name:$repo){ref(qualifiedName:$ref){name
        branchProtectionRule{requiresStatusChecks requiredStatusCheckContexts
          requiredStatusChecks{context app{databaseId}}}
      }}
    }"""
    owner, repo = REPOSITORY.split("/")
    data = json.loads(_run([
        str(GH), "api", "graphql", "-f", f"query={query}",
        "-f", f"owner={owner}", "-f", f"repo={repo}", "-f", f"ref=refs/heads/{BASE}",
    ], root))
    ref = ((data.get("data") or {}).get("repository") or {}).get("ref")
    if data.get("errors") or not ref or ref.get("name") != BASE or "branchProtectionRule" not in ref:
        raise PublicationError("base branch check policy could not be determined")
    classic = ref["branchProtectionRule"]
    # The fork currently has no branch protection. CI's final aggregate is
    # still mandatory; otherwise an unstarted CI workflow looks like success.
    contexts = set(REQUIRED_CONTEXTS)
    app_ids = dict(REQUIRED_CHECK_APPS)

    def bind_app(context: str, app_id: int | None) -> None:
        if app_id is None:
            return
        if type(app_id) is not int or app_id <= 0 or app_ids.get(context, app_id) != app_id:
            raise PublicationError(f"unsupported required check app binding: {context}")
        app_ids[context] = app_id

    if classic is not None:
        if not isinstance(classic.get("requiresStatusChecks"), bool):
            raise PublicationError("unrecognized branch protection policy")
        if classic["requiresStatusChecks"]:
            contexts.update(classic["requiredStatusCheckContexts"] or [])
            contexts.update(check["context"] for check in classic["requiredStatusChecks"] or [])
            for check in classic["requiredStatusChecks"] or []:
                bind_app(check["context"], (check.get("app") or {}).get("databaseId"))
    pages = json.loads(_run([
        str(GH), "api", "--paginate", "--slurp",
        f"repos/{REPOSITORY}/rules/branches/{quote(BASE, safe='')}?per_page=100",
    ], root))
    if not isinstance(pages, list) or not all(isinstance(page, list) for page in pages):
        raise PublicationError("base branch ruleset policy could not be determined")
    rules = [rule for page in pages for rule in page]
    for rule in rules:
        if rule.get("type") in NON_CHECK_RULES:
            continue
        if rule.get("type") != "required_status_checks":
            # Workflow requirements cannot be identified by a job's display name.
            raise PublicationError(f"unsupported branch rule requires review: {rule.get('type')}")
        contexts.update(check["context"] for check in rule["parameters"]["required_status_checks"])
        for check in rule["parameters"]["required_status_checks"]:
            bind_app(check["context"], check.get("integration_id"))
    if any(not isinstance(context, str) or not context for context in contexts):
        raise PublicationError("invalid required check context")
    return {"base": BASE, "contexts": sorted(contexts), "app_ids": app_ids, "classic": classic, "rules": rules}


def candidate_checks(root: Path, candidate: str) -> list[dict[str, Any]]:
    """gh pr view omits producer identity; read the candidate's complete rollup."""
    query = """query($owner:String!, $repo:String!, $sha:String!, $endCursor:String){
      repository(owner:$owner,name:$repo){object(expression:$sha){... on Commit{
        oid statusCheckRollup{contexts(first:100,after:$endCursor){
          pageInfo{hasNextPage endCursor}
          nodes{__typename
            ... on CheckRun{name status conclusion checkSuite{app{databaseId}}}
            ... on StatusContext{context state creator{login}}
          }
        }}
      }}}
    }"""
    owner, repo = REPOSITORY.split("/")
    pages = json.loads(_run([
        str(GH), "api", "graphql", "--paginate", "--slurp", "-f", f"query={query}",
        "-f", f"owner={owner}", "-f", f"repo={repo}", "-f", f"sha={candidate}",
    ], root))
    checks = []
    if not isinstance(pages, list) or not pages:
        raise PublicationError("candidate check producers could not be determined")
    for page in pages:
        commit = ((page.get("data") or {}).get("repository") or {}).get("object")
        if page.get("errors") or not commit or commit.get("oid") != candidate:
            raise PublicationError("candidate check producers could not be determined")
        rollup = commit.get("statusCheckRollup")
        if rollup is not None:
            checks.extend(rollup["contexts"]["nodes"])
    return checks


def _api_pages(root: Path, endpoint: str, *, object_key: str | None = None) -> list[Any]:
    try:
        pages = json.loads(
            _run(
                [str(GH), "api", "--paginate", "--slurp", endpoint],
                root,
            )
        )
    except (json.JSONDecodeError, TypeError) as exc:
        raise PublicationError("PR review evidence could not be decoded") from exc
    if not isinstance(pages, list):
        raise PublicationError("PR review evidence pagination is invalid")
    values: list[Any] = []
    for page in pages:
        if object_key is not None:
            if not isinstance(page, dict) or not isinstance(page.get(object_key), list):
                raise PublicationError("PR review evidence page is invalid")
            page = page[object_key]
        if not isinstance(page, list):
            raise PublicationError("PR review evidence page is invalid")
        values.extend(page)
    return values


def _remote_text(value: Any) -> str:
    # Evidence must retain the whole source; any display excerpt is separate.
    # In particular, a changed tail must invalidate a prior disposition.
    if value is None:
        return ""
    if not isinstance(value, str):
        raise PublicationError("remote review text has an invalid shape")
    return value


def _actor(value: Any) -> str | None:
    login = (value.get("login") or value.get("slug")) if isinstance(value, dict) else None
    return login if isinstance(login, str) and login else None


def _review_item(
    surface: str,
    value: dict[str, Any],
    *,
    head: str | None = None,
    body: str = "",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    identifier = value.get("id")
    if not isinstance(identifier, (int, str)) or isinstance(identifier, bool):
        raise PublicationError(f"{surface} review evidence has no stable id")
    key = f"{surface}:{identifier}" + (f":{head}" if head is not None else "")
    item = {
        "key": key,
        "surface": surface,
        "id": identifier,
        "head_sha": head,
        "actor": _actor(value.get("user") or value.get("creator")),
        "created_at": value.get("created_at") or value.get("submitted_at"),
        "updated_at": value.get("updated_at"),
        "url": value.get("html_url") or value.get("details_url") or value.get("target_url"),
        "body": _remote_text(body),
    }
    if extra:
        item.update(extra)
    item["requires_disposition"] = (
        bool(item["body"])
        or surface in {"failed_checks", "failed_statuses"}
        or (
            surface == "formal_reviews"
            and str(item.get("state", "")).casefold() == "changes_requested"
        )
    )
    item["evidence_sha256"] = _canonical_sha(item)
    return item


def _failed_action_attempt(
    root: Path,
    value: dict[str, Any],
    head: str,
) -> dict[str, Any]:
    """Retain the actual failed Actions job log, not only its often-empty summary."""
    if _actor(value.get("app")) != "github-actions":
        return {}
    match = ACTION_JOB_URL.fullmatch(str(value.get("details_url", "")))
    if match is None:
        raise PublicationError("failed GitHub Actions check has no exact job identity")
    run_id, job_id = (int(part) for part in match.groups())
    endpoint = f"repos/{REPOSITORY}/actions/jobs/{job_id}"
    try:
        job = json.loads(_run([str(GH), "api", endpoint], root))
    except (json.JSONDecodeError, TypeError) as exc:
        raise PublicationError("failed GitHub Actions job metadata is invalid") from exc
    check_id = value.get("id")
    attempt = job.get("run_attempt") if isinstance(job, dict) else None
    if (
        not isinstance(job, dict)
        or job.get("id") != job_id
        or job.get("run_id") != run_id
        or job.get("head_sha") != head
        or type(attempt) is not int
        or attempt <= 0
        or str(job.get("check_run_url", "")).rsplit("/", 1)[-1]
        != str(check_id)
    ):
        raise PublicationError("failed GitHub Actions job does not bind the check attempt")
    # CI logs contain ANSI; retain them as untrusted files, never terminal output.
    log = _run([str(GH), "api", "--allow-escape-sequences", endpoint + "/logs"], root)
    size = len(log.encode("utf-8"))
    if not log or size > MAX_FAILED_JOB_LOG_BYTES:
        raise PublicationError("failed GitHub Actions job log is empty or exceeds its bound")
    identity = _canonical_sha(
        {"head": head, "check": check_id, "run": run_id, "job": job_id, "attempt": attempt}
    )
    path = root / f"pr-ci-attempt-{identity[:20]}.log"
    _write(path, log)
    return {
        "workflow_run_id": run_id,
        "workflow_job_id": job_id,
        "workflow_attempt": attempt,
        "workflow_job_name": job.get("name"),
        "log_path": str(path),
        "log_sha256": _hash(path),
        "log_bytes": size,
    }


def collect_review_surfaces(
    root: Path,
    number: int,
    candidate: str,
    *,
    observed_heads: list[str] | None = None,
    artifact_name: str = "pr-review-surfaces.json",
) -> dict[str, Any]:
    """Collect untrusted PR findings and all failed attempts as bounded evidence."""
    root = Path(os.path.abspath(root))
    if root.is_symlink() or not re.fullmatch(r"pr-[a-z0-9-]+\.json", artifact_name):
        raise PublicationError("PR review evidence destination is unsafe")
    heads = observed_heads or [candidate]
    if (
        type(number) is not int
        or number <= 0
        or not re.fullmatch(r"[0-9a-f]{40}", candidate)
        or not heads
        or any(not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{40}", head) for head in heads)
    ):
        raise PublicationError("PR review collection identity is invalid")
    prefix = f"repos/{REPOSITORY}"
    surfaces: dict[str, list[dict[str, Any]]] = {
        "issue_comments": [],
        "inline_comments": [],
        "formal_reviews": [],
        "failed_checks": [],
        "failed_statuses": [],
    }
    for value in _api_pages(
        root, f"{prefix}/issues/{number}/comments?per_page=100"
    ):
        if not isinstance(value, dict):
            raise PublicationError("issue comment review evidence is invalid")
        surfaces["issue_comments"].append(
            _review_item("issue_comments", value, body=value.get("body", ""))
        )
    for value in _api_pages(
        root, f"{prefix}/pulls/{number}/comments?per_page=100"
    ):
        if not isinstance(value, dict):
            raise PublicationError("inline comment review evidence is invalid")
        surfaces["inline_comments"].append(
            _review_item(
                "inline_comments",
                value,
                body=value.get("body", ""),
                extra={
                    "path": value.get("path"),
                    "line": value.get("line") or value.get("original_line"),
                    "commit_id": value.get("commit_id"),
                },
            )
        )
    for value in _api_pages(
        root, f"{prefix}/pulls/{number}/reviews?per_page=100"
    ):
        if not isinstance(value, dict):
            raise PublicationError("formal review evidence is invalid")
        surfaces["formal_reviews"].append(
            _review_item(
                "formal_reviews",
                value,
                body=value.get("body", ""),
                extra={
                    "state": value.get("state"),
                    "commit_id": value.get("commit_id"),
                },
            )
        )
    for head in dict.fromkeys(heads):
        check_runs = _api_pages(
            root,
            f"{prefix}/commits/{head}/check-runs?filter=all&per_page=100",
            object_key="check_runs",
        )
        for value in check_runs:
            if not isinstance(value, dict):
                raise PublicationError("failed check evidence is invalid")
            conclusion = value.get("conclusion")
            if conclusion is None or str(conclusion).casefold() in {
                "success",
                "skipped",
                "neutral",
            }:
                continue
            output = value.get("output") if isinstance(value.get("output"), dict) else {}
            surfaces["failed_checks"].append(
                _review_item(
                    "failed_checks",
                    value,
                    head=head,
                    body="\n".join(
                        part
                        for part in (
                            _remote_text(output.get("title")),
                            _remote_text(output.get("summary")),
                            _remote_text(output.get("text")),
                        )
                        if part
                    ),
                    extra={
                        "name": value.get("name"),
                        "status": value.get("status"),
                        "conclusion": conclusion,
                        "started_at": value.get("started_at"),
                        "completed_at": value.get("completed_at"),
                        "app": _actor(value.get("app")),
                        **_failed_action_attempt(root, value, head),
                    },
                )
            )
        for value in _api_pages(
            root, f"{prefix}/commits/{head}/statuses?per_page=100"
        ):
            if not isinstance(value, dict):
                raise PublicationError("failed status evidence is invalid")
            state = str(value.get("state", "")).casefold()
            if state in {"", "success", "pending", "expected"}:
                continue
            surfaces["failed_statuses"].append(
                _review_item(
                    "failed_statuses",
                    value,
                    head=head,
                    body=value.get("description", ""),
                    extra={"context": value.get("context"), "state": value.get("state")},
                )
            )
    for values in surfaces.values():
        unique = {item["key"]: item for item in values}
        values[:] = [unique[key] for key in sorted(unique)]
    identity = {
        "repository": REPOSITORY,
        "number": number,
        "candidate_sha": candidate,
        "observed_heads": list(dict.fromkeys(heads)),
        "surfaces": surfaces,
    }
    result = {
        "schema_version": 1,
        **identity,
        "observed_unix": int(time.time()),
        "observations_sha256": _canonical_sha(identity),
    }
    _write(root / artifact_name, json.dumps(result, indent=2) + "\n")
    return result


def require_review_disposition(
    root: Path,
    observations: dict[str, Any],
    *,
    snapshot_name: str | None = None,
) -> str | None:
    required = {
        item["key"]: item
        for values in observations["surfaces"].values()
        for item in values
        if item["requires_disposition"]
    }
    if not required:
        return None
    path = root / "pr-review-disposition.json"
    if path.is_symlink() or not path.is_file():
        raise PublicationError(
            "PR review findings require parent disposition in pr-review-disposition.json"
        )
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PublicationError("PR review disposition is invalid") from exc
    items = value.get("dispositions") if isinstance(value, dict) else None
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "schema_version",
            "repository",
            "number",
            "candidate_sha",
            "observations_sha256",
            "dispositions",
        }
        or value.get("schema_version") != 1
        or value.get("repository") != REPOSITORY
        or value.get("number") != observations["number"]
        or value.get("candidate_sha") != observations["candidate_sha"]
        or not isinstance(value.get("observations_sha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", value["observations_sha256"])
        or not isinstance(items, list)
    ):
        raise PublicationError("PR review disposition does not bind current evidence")
    by_key: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(items):
        key = item.get("key") if isinstance(item, dict) else None
        evidence_sha256 = (
            item.get("evidence_sha256") if isinstance(item, dict) else None
        )
        if (
            not isinstance(item, dict)
            or set(item) != {"key", "evidence_sha256", "decision", "evidence"}
            or not isinstance(key, str)
            or not key
            or key in by_key
            or not isinstance(evidence_sha256, str)
            or not re.fullmatch(r"[0-9a-f]{64}", evidence_sha256)
            or item.get("decision") not in {"resolved", "refuted", "irrelevant"}
            or not isinstance(item.get("evidence"), str)
            or not 1 <= len(item["evidence"].strip()) <= 2_000
        ):
            item_key = key if isinstance(key, str) and key else f"index {index}"
            raise PublicationError(
                f"PR review disposition item is invalid (malformed: {item_key})"
            )
        if key in required and evidence_sha256 != required[key]["evidence_sha256"]:
            raise PublicationError(
                f"PR review disposition item is invalid (stale: {key})"
            )
        by_key[key] = item
    if not set(required).issubset(by_key):
        missing = ", ".join(sorted(set(required) - set(by_key)))
        raise PublicationError(f"PR review disposition is incomplete (missing: {missing})")
    digest = _hash(path)
    if snapshot_name is not None:
        if not re.fullmatch(r"pr-[a-z0-9-]+\.json", snapshot_name):
            raise PublicationError("PR review disposition snapshot is unsafe")
        _write(root / snapshot_name, path.read_text(encoding="utf-8"))
    return digest


def review_status(pr: dict[str, Any], candidate: str, policy: dict[str, Any]) -> dict[str, Any] | None:
    """Require current-head CI and GitHub policy; independent review is a local gate."""
    if pr.get("headRefOid") != candidate or pr.get("state") != "OPEN" or pr.get("baseRefName") != BASE:
        raise PublicationError("review target changed or closed before publication")
    if policy.get("base") != BASE or not isinstance(policy.get("contexts"), list):
        raise PublicationError("verified base branch check policy is required")
    checks = pr.get("statusCheckRollup") or []
    if not checks:
        return None
    pending = False
    for check in checks:
        if (
            check.get("name") == "Greptile Review"
            and ((check.get("checkSuite") or {}).get("app") or {}).get("databaseId") == 867647
            and "Greptile Review" not in policy["contexts"]
        ):
            continue
        if check.get("__typename") == "CheckRun":
            if check.get("status") != "COMPLETED":
                pending = True
                continue
            if check.get("conclusion") not in {"SUCCESS", "SKIPPED", "NEUTRAL"}:
                raise PublicationError(f"PR check failed: {check.get('name', 'unknown')}")
        elif check.get("__typename") == "StatusContext":
            if check.get("state") in {"PENDING", "EXPECTED"}:
                pending = True
                continue
            if check.get("state") != "SUCCESS":
                raise PublicationError(f"PR status failed: {check.get('context', 'unknown')}")
        else:
            raise PublicationError("unknown PR check shape; refusing publication")
    app_ids = {**policy.get("app_ids", {}), **REQUIRED_CHECK_APPS}
    for context in set(policy["contexts"]) | REQUIRED_CONTEXTS:
        matches = [check for check in checks if (check.get("name") or check.get("context")) == context]
        if not matches:
            pending = True
            continue
        for check in matches:
            if context in app_ids:
                app_id = ((check.get("checkSuite") or {}).get("app") or {}).get("databaseId")
                if check.get("__typename") != "CheckRun" or app_id != app_ids[context]:
                    raise PublicationError(f"untrusted producer for required check: {context}")
            if check.get("__typename") == "CheckRun" and check.get("conclusion") != "SUCCESS":
                if check.get("status") != "COMPLETED":
                    pending = True
                else:
                    raise PublicationError(f"required check did not succeed: {context}")
    if pending:
        return None
    # GitHub additionally enforces source-app bindings, required reviews and
    # up-to-date rules; a rollup of green jobs alone is not that decision.
    if pr.get("mergeStateStatus") != "CLEAN" or pr.get("mergeable") != "MERGEABLE":
        return None
    return {
        "candidate_sha": candidate,
        "checks": checks,
        "required_check_policy": policy,
        "merge_state": pr["mergeStateStatus"],
    }


def wait_for_review(
    root: Path,
    number: int,
    candidate: str,
    *,
    deadline_unix: int | None = None,
    max_wait_seconds: int = MAX_REVIEW_WAIT_SECONDS,
    recovery_identity: dict[str, Any] | None = None,
    expected_pr_evidence: dict[str, str] | None = None,
    observed_heads: list[str] | None = None,
) -> dict[str, Any]:
    """Wait within CI and owning-lease bounds; pending is never approval."""
    if type(max_wait_seconds) is not int or max_wait_seconds <= 0:
        raise PublicationError("PR review wait bound is invalid")
    remaining_lease = (
        max(0.0, float(deadline_unix) - time.time())
        if type(deadline_unix) is int
        else float(max_wait_seconds)
    )
    wait_seconds = min(float(max_wait_seconds), remaining_lease)
    deadline = time.monotonic() + wait_seconds
    while True:
        fields = (
            FIELDS + OWNERSHIP_FIELDS + ",mergeStateStatus,mergeable"
            if expected_pr_evidence is not None
            else "state,headRefOid,baseRefName,mergeStateStatus,mergeable"
        )
        pr = json.loads(
            _run(
                [
                    str(GH),
                    "pr",
                    "view",
                    str(number),
                    "--repo",
                    REPOSITORY,
                    "--json",
                    fields,
                ],
                root,
            )
        )
        if expected_pr_evidence is not None:
            if "base_sha" in expected_pr_evidence:
                _validate_owned_base(pr, expected_pr_evidence["base_sha"])
            _validate_pr(
                pr,
                expected_pr_evidence["head_branch"],
                candidate,
                expected_pr_evidence["candidate_marker"],
            )
            current = _published_block(
                pr["body"], expected_pr_evidence["preview_identity"]
            )
            if (
                current is None
                or hashlib.sha256(current[0].encode()).hexdigest()
                != expected_pr_evidence["block_sha256"]
                or current[1] != expected_pr_evidence["attachment_url"]
            ):
                raise PublicationError(
                    "candidate PR attachment identity changed before publication"
                )
        pr["statusCheckRollup"] = candidate_checks(root, candidate)
        policy = required_check_policy(root)
        observations = collect_review_surfaces(
            root,
            number,
            candidate,
            observed_heads=observed_heads,
        )
        proof = review_status(pr, candidate, policy)
        disposition_sha256 = require_review_disposition(root, observations)
        if proof is not None:
            proof = {
                **proof,
                "review_surfaces_sha256": observations["observations_sha256"],
                "review_disposition_sha256": disposition_sha256,
            }
            _write(root / "pr-review.json", json.dumps(proof, indent=2) + "\n")
            (root / "pr-pending.json").unlink(missing_ok=True)
            return proof
        if time.monotonic() >= deadline:
            pending = {
                "schema_version": 1,
                "status": "pending",
                "number": number,
                "candidate_sha": candidate,
                "observed_unix": int(time.time()),
                "deadline_unix": deadline_unix,
                "max_wait_seconds": max_wait_seconds,
                "target_updated": False,
                "recovery": "reuse matching candidate PR and re-run current-head gates",
            }
            if recovery_identity is not None:
                pending["publication_identity"] = recovery_identity
            _write(root / "pr-pending.json", json.dumps(pending, indent=2) + "\n")
            raise PublicationError(
                "PR review/checks are still pending at the bounded lease-aware deadline; "
                "candidate PR was retained for recovery and target branch was not updated"
            )
        print(f"PR #{number}: waiting for current-head CI and GitHub merge policy", flush=True)
        time.sleep(min(REVIEW_POLL_SECONDS, max(0.0, deadline - time.monotonic())))


def resume_preview(
    root: Path, source: Path, manifest: dict[str, Any], *,
    number: int, deadline_unix: int,
    publication_source: Path | None = None,
    publication_sha256: str | None = None,
    repo: Path | None = None,
    node: Path | None = None,
    remote: str = "origin",
    issue_request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resume an explicitly adopted PR without pushing its head or creating a PR.

    Bound PR evidence is observation-only. Bound draft evidence re-enters the
    existing publisher to finish its interrupted attachment and ready boundary.

    PR81 predates ownership markers. Its exception is an exact, operator-reviewed
    manifest/packet/PR tuple, not permission to adopt arbitrary legacy PRs.
    """
    manifest_root = root if "publication_recovery" in manifest else source.parent
    _, digest, dimensions = preview(manifest_root, manifest)
    head, _, identity = _candidate_head(manifest)
    marker = f"<!-- maintainer-candidate:v1:{identity} -->"
    legacy = (
        number == 81
        and _hash(source) == "46b71afc40b7d1d7d734eecf6a17fb8eca68430ee7fc8d2c74993c0b048498c6"
        and _hash(source.parent / "gate-packet.json")
        == "6a11d685a3c67e6f603d89604ae9f237d6a2dbbb06afa290e1d9d1fb1357e0d0"
        and manifest["candidate_sha"] == "6f5863475a51a2e40b58402517f1bbae53e35a43"
        and manifest["base_sha"] == "957d6c6b92ce5ef1355487b0fdac13a1c5f4836d"
    )
    if legacy:
        head = "codex/opentui-maint-1cfaffead678f32bcaeccbf9"
        marker = (
            f"Automated OpenTUI maintenance candidate `{manifest['candidate_sha']}` "
            f"from `{manifest['base_sha']}`."
        )
    publication_path = publication_source or source.parent / "pr-evidence.json"
    if (
        publication_path.is_symlink()
        or not publication_path.is_file()
        or not publication_path.resolve().is_relative_to(source.parent.resolve())
        or publication_path.name not in {"pr-evidence.json", "pr-draft.json"}
        or (
            publication_sha256 is not None
            and _hash(publication_path) != publication_sha256
        )
    ):
        raise PublicationError("retained publication evidence changed")
    try:
        publication = json.loads(publication_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PublicationError("retained publication evidence is invalid") from exc
    if publication_path.name == "pr-evidence.json":
        proof = publication
    else:
        _, request_identity, candidate_identity = _candidate_head(manifest)
        expected_draft = {
            "schema_version": 1,
            "status": "draft",
            "repository": REPOSITORY,
            "base_branch": BASE,
            "base_sha": manifest["base_sha"],
            "candidate_sha": manifest["candidate_sha"],
            "head_branch": head,
            "number": number,
            "url": f"https://github.com/{REPOSITORY}/pull/{number}",
            "request_identity": request_identity,
            "candidate_identity": candidate_identity,
        }
        if (
            not isinstance(publication, dict)
            or any(publication.get(key) != value for key, value in expected_draft.items())
            or not isinstance(publication.get("passed"), list)
            or not isinstance(publication.get("pending"), list)
            or not publication["pending"]
        ):
            raise PublicationError("retained draft evidence does not match explicit adoption")
        pr = json.loads(
            _run(
                [
                    str(GH),
                    "pr",
                    "view",
                    str(number),
                    "--repo",
                    REPOSITORY,
                    "--json",
                    FIELDS + OWNERSHIP_FIELDS,
                ],
                root,
            )
        )
        _validate_pr(pr, head, manifest["candidate_sha"], marker)
        _validate_owned_base(pr, manifest["base_sha"])
        if repo is None or node is None:
            raise PublicationError(
                "missing draft recovery requires the existing publisher"
            )
        return publish_preview(
            repo,
            root,
            manifest,
            node=node,
            remote=remote,
            review_deadline_unix=deadline_unix,
            issue_request=issue_request,
            _existing_draft=publication,
            _preview_root=manifest_root,
        )
    expected = {
        "repository": REPOSITORY, "base_branch": BASE,
        "base_sha": manifest["base_sha"], "candidate_sha": manifest["candidate_sha"],
        "head_branch": head, "number": number,
        "url": f"https://github.com/{REPOSITORY}/pull/{number}",
        "preview_sha256": digest, "preview_dimensions": list(dimensions),
    }
    if any(proof.get(key) != value for key, value in expected.items()):
        raise PublicationError("retained PR evidence does not match explicit adoption")
    review = wait_for_review(
        root, number, manifest["candidate_sha"], deadline_unix=deadline_unix,
        expected_pr_evidence={
            "head_branch": head, "candidate_marker": marker,
            "preview_identity": f"<!-- maintainer-preview:{manifest['candidate_sha']}:{digest} -->",
            "block_sha256": proof["block_sha256"],
            "attachment_url": proof["attachment_url"],
            "base_sha": manifest["base_sha"],
        },
        observed_heads=[manifest["candidate_sha"]],
    )
    result = {**proof, "review": review}
    _write(root / "pr-evidence.json", json.dumps(result, indent=2) + "\n")
    return result


def _validate_owned_base(pr: dict[str, Any], base: str) -> None:
    owner, repository = REPOSITORY.split("/")
    if (
        pr.get("baseRefOid") != base
        or pr.get("isCrossRepository") is not False
        or (pr.get("headRepositoryOwner") or {}).get("login") != owner
        or (pr.get("headRepository") or {}).get("name") != repository
    ):
        raise PublicationError("PR base or repository ownership changed")


def _publication_destination(repo: Path, remote: str) -> str:
    destination = _run(
        ["git", "remote", "get-url", "--push", "--all", remote], repo
    ).strip()
    if destination not in {
        f"https://github.com/{REPOSITORY}.git",
        f"git@github.com:{REPOSITORY}.git",
        f"https://github.com/{REPOSITORY}",
    }:
        raise PublicationError("refusing candidate push to an untrusted remote")
    return destination


def _publication_metadata(
    root: Path,
    manifest: dict[str, Any],
    issue_request: dict[str, Any] | None,
    *,
    verification_complete: bool,
) -> tuple[str, str, dict[str, Any] | None, Any | None]:
    candidate, base = manifest["candidate_sha"], manifest["base_sha"]
    binding = manifest.get("run_binding")
    if isinstance(binding, dict) and binding.get("mode") == "issue":
        workflow = _issue_workflow()
        try:
            title, body_prefix, issue = workflow.issue_publication_metadata(
                root,
                manifest,
                issue_request,
                verification_complete=verification_complete,
            )
        except workflow.IssueWorkflowError as exc:
            raise PublicationError(str(exc)) from exc
        return title, body_prefix, issue, workflow
    return (
        f"chore(opentui): maintainer candidate {candidate[:12]}",
        f"Automated OpenTUI maintenance candidate `{candidate}` from `{base}`.\n\n",
        None,
        None,
    )


def _reconcile_live_issue_pr(
    workflow: Any | None,
    issue: dict[str, Any] | None,
    candidate: str,
    *,
    root: Path,
) -> dict[str, Any] | None:
    if workflow is None:
        return None
    try:
        return workflow.reconcile_issue_pr(issue, candidate, cwd=root, runner=_run)
    except workflow.IssueWorkflowError as exc:
        raise PublicationError(str(exc)) from exc


def _ensure_owned_draft(
    root: Path,
    pr: dict[str, Any],
    head: str,
    candidate: str,
    base: str,
    marker: str | None,
) -> dict[str, Any]:
    """Move a proven task PR back to draft before exposing an unverified fix."""
    if pr.get("isDraft") is True:
        return pr
    options = ["--repo", REPOSITORY]
    _run(
        [str(GH), "pr", "ready", str(pr["number"]), *options, "--undo"],
        root,
    )
    updated = json.loads(
        _run(
            [
                str(GH),
                "pr",
                "view",
                str(pr["number"]),
                *options,
                "--json",
                FIELDS + OWNERSHIP_FIELDS,
            ],
            root,
        )
    )
    _validate_pr(updated, head, candidate, marker)
    _validate_owned_base(updated, base)
    if updated.get("isDraft") is not True:
        raise PublicationError("task PR did not return to draft before fix publication")
    return updated


def _owned_head(
    root: Path,
    destination: str,
    manifest: dict[str, Any],
    expected: str,
    *,
    allow_missing: bool = False,
) -> tuple[dict[str, Any], str, str] | None:
    if not re.fullmatch(r"[0-9a-f]{40}", expected):
        raise PublicationError("expected PR head must be an exact SHA")
    head, _, identity = _candidate_head(manifest)
    marker = f"<!-- maintainer-candidate:v1:{identity} -->"
    prs = json.loads(
        _run(
            [
                str(GH),
                "pr",
                "list",
                "--repo",
                REPOSITORY,
                "--state",
                "all",
                "--head",
                head,
                "--json",
                FIELDS + OWNERSHIP_FIELDS,
            ],
            root,
        )
    )
    binding = manifest.get("run_binding")
    if prs == [] and isinstance(binding, dict) and binding.get("mode") == "issue":
        # Adopted drafts keep their contributor branch through follow-up fixes.
        _, _, issue, workflow = _publication_metadata(
            root, manifest, None, verification_complete=False
        )
        try:
            adopted = _reconcile_live_issue_pr(workflow, issue, expected, root=root)
        except PublicationError:
            # A lost push reply may already have advanced exactly this candidate.
            adopted = _reconcile_live_issue_pr(
                workflow, issue, manifest["candidate_sha"], root=root
            )
        if adopted is not None:
            head = adopted["headRefName"]
            prs = [adopted]
    if prs == [] and allow_missing:
        return None
    if not isinstance(prs, list) or len(prs) != 1:
        raise PublicationError("expected exactly one owned task PR before update")
    candidate = manifest["candidate_sha"]
    pr = prs[0]
    if not isinstance(pr, dict) or pr.get("headRefOid") not in {expected, candidate}:
        raise PublicationError("owned PR head moved unexpectedly")
    _validate_pr(pr, head, pr["headRefOid"], marker)
    _validate_owned_base(pr, manifest["base_sha"])
    ref = f"refs/heads/{head}"
    advertised = _run(["git", "ls-remote", destination, ref], root).split()
    if advertised != [pr["headRefOid"], ref]:
        raise PublicationError("owned branch and PR disagree")
    return pr, head, marker


def preflight_owned_head(
    repo: Path,
    root: Path,
    manifest: dict[str, Any],
    expected: str,
    *,
    remote: str = "origin",
    allow_missing: bool = False,
) -> dict[str, Any] | None:
    """Consume prior-head ownership, findings and failed CI before local gates."""
    root = Path(os.path.abspath(root))
    destination = _publication_destination(repo, remote)
    owned = _owned_head(
        root, destination, manifest, expected, allow_missing=allow_missing
    )
    if owned is None:
        return None
    pr, head, _ = owned
    candidate = manifest["candidate_sha"]
    _run(["git", "merge-base", "--is-ancestor", expected, candidate], repo)
    observed_heads = list(dict.fromkeys([expected, pr["headRefOid"]]))
    observations = collect_review_surfaces(
        root,
        pr["number"],
        candidate,
        observed_heads=observed_heads,
        artifact_name="pr-owner-preflight-surfaces.json",
    )
    disposition_sha256 = require_review_disposition(
        root,
        observations,
        snapshot_name="pr-owner-preflight-disposition.json",
    )
    surfaces_path = root / "pr-owner-preflight-surfaces.json"
    disposition_path = root / "pr-owner-preflight-disposition.json"
    identity = {
        "repository": REPOSITORY,
        "base_branch": BASE,
        "base_sha": manifest["base_sha"],
        "candidate_sha": candidate,
        "expected_previous_head": expected,
        "observed_pr_head": pr["headRefOid"],
        "head_branch": head,
        "number": pr["number"],
        "url": pr["url"],
        "observed_heads": observed_heads,
        "review_surfaces_sha256": observations["observations_sha256"],
        "review_surfaces_artifact_sha256": _hash(surfaces_path),
        "review_disposition_sha256": disposition_sha256,
        "review_disposition_artifact_sha256": (
            _hash(disposition_path) if disposition_sha256 is not None else None
        ),
    }
    proof = {
        "schema_version": 1,
        **identity,
        "proof_sha256": _canonical_sha(identity),
    }
    _write(root / "pr-owner-preflight.json", json.dumps(proof, indent=2) + "\n")
    return proof


def preflight_task_owner(
    repo: Path,
    root: Path,
    manifest: dict[str, Any],
    *,
    remote: str = "origin",
) -> dict[str, Any] | None:
    """Preflight an unchanged task PR, or permit a genuine first publication."""
    candidate = manifest.get("candidate_sha")
    if not isinstance(candidate, str):
        raise PublicationError("invalid candidate/base identity")
    return preflight_owned_head(
        repo,
        root,
        manifest,
        candidate,
        remote=remote,
        allow_missing=True,
    )


def advance_owned_head(
    repo: Path,
    root: Path,
    destination: str,
    manifest: dict[str, Any],
    expected: str,
    *,
    as_draft: bool = False,
) -> None:
    """CAS only a proven fast-forward on this task's already-owned open PR."""
    pr, head, marker = _owned_head(root, destination, manifest, expected)
    candidate = manifest["candidate_sha"]
    observations = collect_review_surfaces(
        root,
        pr["number"],
        candidate,
        observed_heads=[expected],
    )
    require_review_disposition(root, observations)
    # Refused updates must not even change the PR's draft state.
    _run(["git", "merge-base", "--is-ancestor", expected, candidate], repo)
    ref = f"refs/heads/{head}"
    advertised = _run(["git", "ls-remote", destination, ref], repo).split()
    if advertised != [pr["headRefOid"], ref]:
        raise PublicationError("owned branch and PR disagree")
    if as_draft:
        pr = _ensure_owned_draft(
            root,
            pr,
            head,
            pr["headRefOid"],
            manifest["base_sha"],
            marker,
        )

    if pr["headRefOid"] == expected and expected != candidate:
        _run(["git", "push", "--porcelain", f"--force-with-lease={ref}:{expected}",
              destination, f"{candidate}:{ref}"], repo)
    if _run(["git", "ls-remote", destination, ref], repo).split() != [candidate, ref]:
        raise PublicationError("owned branch update was not acknowledged")


def publish_draft(
    repo: Path,
    root: Path,
    manifest: dict[str, Any],
    *,
    pending_gates: list[str],
    remote: str = "origin",
    issue_request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create or reconcile the task's one honest pre-verification draft PR."""
    root = root.resolve()
    if manifest.get("branch") != BASE:
        raise PublicationError("draft publication only supports the OpenTUI fork branch")
    candidate, base = manifest["candidate_sha"], manifest["base_sha"]
    head, request_identity, candidate_identity = _candidate_head(manifest)
    candidate_marker = f"<!-- maintainer-candidate:v1:{candidate_identity} -->"
    destination = _publication_destination(repo, remote)
    title, body_prefix, issue, workflow = _publication_metadata(
        root,
        manifest,
        issue_request,
        verification_complete=False,
    )
    status = _status_block(
        candidate,
        passed=["Task/base identity and publication ownership checks passed."],
        pending=pending_gates,
    )
    gh = [str(GH), "pr"]
    options = ["--repo", REPOSITORY]
    if manifest.get("expected_pr_head") is not None:
        advance_owned_head(
            repo,
            root,
            destination,
            manifest,
            manifest["expected_pr_head"],
            as_draft=True,
        )

    reconciled = _reconcile_live_issue_pr(workflow, issue, candidate, root=root)
    if reconciled is not None:
        head = reconciled["headRefName"]
        prs = [reconciled]
    else:
        ref = f"refs/heads/{head}"
        existing = _run(["git", "ls-remote", destination, ref], repo).strip()
        if existing and existing.split() != [candidate, ref]:
            raise PublicationError("run branch already points at a different candidate")
        if not existing:
            _run(
                [
                    "git",
                    "push",
                    "--porcelain",
                    f"--force-with-lease={ref}:",
                    destination,
                    f"{candidate}:{ref}",
                ],
                repo,
            )
        prs = json.loads(
            _run(
                gh
                + [
                    "list",
                    *options,
                    "--state",
                    "all",
                    "--head",
                    head,
                    "--base",
                    BASE,
                    "--json",
                    FIELDS + OWNERSHIP_FIELDS,
                ],
                root,
            )
        )
    if not prs and reconciled is None:
        reconciled = _reconcile_live_issue_pr(workflow, issue, candidate, root=root)
        if reconciled is not None:
            head = reconciled["headRefName"]
            prs = [reconciled]
    if not prs and reconciled is None:
        body = candidate_marker + "\n" + body_prefix + status + "\n"
        _write(root / "pr-body.md", body)
        _run(
            gh
            + [
                "create",
                *options,
                "--draft",
                "--base",
                BASE,
                "--head",
                head,
                "--title",
                title,
                "--body-file",
                str(root / "pr-body.md"),
            ],
            root,
        )
        prs = json.loads(
            _run(
                gh
                + [
                    "list",
                    *options,
                    "--state",
                    "all",
                    "--head",
                    head,
                    "--base",
                    BASE,
                    "--json",
                    FIELDS + OWNERSHIP_FIELDS,
                ],
                root,
            )
        )
    if len(prs) != 1:
        raise PublicationError("expected exactly one task-owned draft PR")
    pr = prs[0]
    _validate_pr(pr, head, candidate)
    _validate_owned_base(pr, base)
    if pr.get("isDraft") is not True:
        observations = collect_review_surfaces(root, pr["number"], candidate)
        require_review_disposition(root, observations)
        marker = candidate_marker if candidate_marker in str(pr.get("body", "")) else None
        pr = _ensure_owned_draft(root, pr, head, candidate, base, marker)
    body = pr["body"]
    if candidate_marker not in body:
        body = candidate_marker + "\n" + (body_prefix if reconciled is not None else "") + body
    body = _replace_status(body, status)
    if body != pr["body"]:
        _write(root / "pr-body.md", body)
        _run(
            gh
            + [
                "edit",
                str(pr["number"]),
                *options,
                "--body-file",
                str(root / "pr-body.md"),
            ],
            root,
        )
    pr = json.loads(
        _run(
            gh
            + [
                "view",
                str(pr["number"]),
                *options,
                "--json",
                FIELDS + OWNERSHIP_FIELDS,
            ],
            root,
        )
    )
    _validate_pr(pr, head, candidate, candidate_marker)
    _validate_owned_base(pr, base)
    if pr.get("isDraft") is not True or _replace_status(pr["body"], status) != pr["body"]:
        raise PublicationError("task draft state was not acknowledged")
    proof = {
        "schema_version": 1,
        "status": "draft",
        "repository": REPOSITORY,
        "base_branch": BASE,
        "base_sha": base,
        "candidate_sha": candidate,
        "head_branch": head,
        "number": pr["number"],
        "url": pr["url"],
        "request_identity": request_identity,
        "candidate_identity": candidate_identity,
        "passed": ["Task/base identity and publication ownership checks passed"],
        "pending": pending_gates,
        "issue": issue,
    }
    _write(root / "pr-draft.json", json.dumps(proof, indent=2) + "\n")
    return proof


def publish_preview(
    repo: Path,
    root: Path,
    manifest: dict[str, Any],
    *,
    node: Path,
    remote: str = "origin",
    review_deadline_unix: int | None = None,
    issue_request: dict[str, Any] | None = None,
    _existing_draft: dict[str, Any] | None = None,
    _preview_root: Path | None = None,
) -> dict[str, Any]:
    """Idempotently create the candidate PR and attach one proven synthetic PNG.

    The create-only head branch is separate from sid/opentui. The caller alone
    owns the target-ref CAS, after this function returns verified evidence.
    """
    root = root.resolve()
    png, digest, dimensions = preview(_preview_root or root, manifest)
    if manifest.get("branch") != BASE:
        raise PublicationError("PR publication only supports the OpenTUI fork branch")
    version = _run([str(GH), "--version"], root)
    if not version.startswith("gh version 2.100.0 "):
        raise PublicationError(
            "publication requires the verified gh 2.100.0 attachment CLI"
        )
    if not FORMATTER.is_file() or _hash(FORMATTER) != FORMATTER_SHA256:
        raise PublicationError(
            "installed before-and-after formatter changed; revalidate it"
        )
    destination = (
        None if _existing_draft is not None else _publication_destination(repo, remote)
    )
    candidate, base = manifest["candidate_sha"], manifest["base_sha"]
    head, request_identity, candidate_identity = _candidate_head(manifest)
    candidate_marker = f"<!-- maintainer-candidate:v1:{candidate_identity} -->"
    title, body_prefix, issue, workflow = _publication_metadata(
        root,
        manifest,
        issue_request,
        verification_complete=True,
    )
    verified_status = _status_block(
        candidate,
        passed=[
            "All candidate-bound local gates passed, including independent review and native evidence."
        ],
        pending=[
            "Current-head CI and GitHub publication policy must pass before the guarded target update."
        ],
    )
    gh = [str(GH), "pr"]
    options = ["--repo", REPOSITORY]
    if _existing_draft is not None and manifest.get("expected_pr_head") is not None:
        raise PublicationError("existing-draft recovery cannot advance a PR head")
    if manifest.get("expected_pr_head") is not None:
        assert destination is not None
        advance_owned_head(repo, root, destination, manifest, manifest["expected_pr_head"])

    # Reuse or refuse a competing implementing PR before pushing our own branch,
    # so a PR that appeared after the caller's snapshot leaves no dangling ref.
    reconciled = None
    if _existing_draft is not None:
        head = _existing_draft["head_branch"]
        prs = [
            json.loads(
                _run(
                    gh
                    + [
                        "view",
                        str(_existing_draft["number"]),
                        *options,
                        "--json",
                        FIELDS + OWNERSHIP_FIELDS,
                    ],
                    root,
                )
            )
        ]
        reconciled = prs[0]
    else:
        reconciled = _reconcile_live_issue_pr(
            workflow, issue, candidate, root=root
        )
    if _existing_draft is None and reconciled is not None:
        head = reconciled["headRefName"]
        prs = [reconciled]
    elif _existing_draft is None:
        assert destination is not None
        ref = f"refs/heads/{head}"
        existing = _run(["git", "ls-remote", destination, ref], repo).strip()
        if existing and existing.split() != [candidate, ref]:
            raise PublicationError("run branch already points at a different candidate")
        if not existing:
            _run(
                [
                    "git",
                    "push",
                    "--porcelain",
                    f"--force-with-lease={ref}:",
                    destination,
                    f"{candidate}:{ref}",
                ],
                repo,
            )
        prs = json.loads(
            _run(
                gh
                + [
                    "list",
                    *options,
                    "--state",
                    "all",
                    "--head",
                    head,
                    "--base",
                    BASE,
                    "--json",
                    FIELDS + OWNERSHIP_FIELDS,
                ],
                root,
            )
        )
    if not prs and reconciled is None:
        # Narrow the final edge: re-read the live issue-scoped PR set once more
        # immediately before creation, since our own push/list may have raced a
        # competitor. GitHub offers no atomic CAS for PR creation.
        reconciled = _reconcile_live_issue_pr(workflow, issue, candidate, root=root)
        if reconciled is not None:
            head = reconciled["headRefName"]
            prs = [reconciled]
    if not prs and reconciled is None:
        body = (
            candidate_marker
            + "\n"
            + body_prefix
            + verified_status
            + "\n\nPreview is startup/help regression proof from the isolated synthetic profile, "
            "not a before/after claim about changed UI behavior.\n"
        )
        _write(root / "pr-body.md", body)
        _run(
            gh
            + [
                "create",
                *options,
                "--draft",
                "--base",
                BASE,
                "--head",
                head,
                "--title",
                title,
                "--body-file",
                str(root / "pr-body.md"),
            ],
            root,
        )
        prs = json.loads(
            _run(
                gh
                + [
                    "list",
                    *options,
                    "--state",
                    "all",
                    "--head",
                    head,
                    "--base",
                    BASE,
                    "--json",
                    FIELDS + OWNERSHIP_FIELDS,
                ],
                root,
            )
        )
    if len(prs) != 1:
        raise PublicationError("expected exactly one run-scoped PR")
    pr = prs[0]
    # Recovery already proved ownership; a removed marker is not a new adoption.
    _validate_pr(
        pr, head, candidate, candidate_marker if _existing_draft is not None else None
    )
    _validate_owned_base(pr, base)
    marker_missing = candidate_marker not in pr["body"]
    if marker_missing:
        reconciled_prefix = body_prefix if reconciled is not None else ""
        pr = {
            **pr,
            "body": candidate_marker + "\n" + reconciled_prefix + pr["body"],
        }
    pr = {**pr, "body": _replace_status(pr["body"], verified_status)}
    identity = f"<!-- maintainer-preview:{candidate}:{digest} -->"
    # A draft receipt does not authenticate any attachment URL already in the
    # live body. Republish the hash-bound source through the verified formatter.
    published = (
        None
        if _existing_draft is not None
        else _published_block(pr["body"], identity)
    )
    if published is None:
        upload_png = png
        if not png.is_relative_to(root):
            folder = root / "termctrl-verified"
            if folder.is_symlink():
                raise PublicationError("publication state must not be a symlink")
            folder.mkdir(exist_ok=True)
            upload_png = folder / "accepted.png"
            if upload_png.is_symlink():
                raise PublicationError("publication state must not be a symlink")
            if upload_png.exists() and _hash(upload_png) != digest:
                raise PublicationError("staged Preview evidence changed")
            if not upload_png.exists():
                fd, name = tempfile.mkstemp(dir=folder, prefix=".preview-")
                try:
                    with os.fdopen(fd, "wb") as handle:
                        handle.write(png.read_bytes())
                        handle.flush()
                        os.fsync(handle.fileno())
                    os.replace(name, upload_png)
                finally:
                    Path(name).unlink(missing_ok=True)
        formatter = [
            str(node),
            str(FORMATTER),
            "--after",
            str(upload_png),
            "--label",
            "Synthetic startup/help regression proof",
        ]
        attachments = _run([*formatter, "--attach-list"], root).splitlines()
        if attachments != ["./termctrl-verified/accepted.png"]:
            raise PublicationError(
                "formatter attachment list does not match proven media"
            )
        block = _run(formatter, root).strip()
        if (
            _block(block) != block
            or "![Preview](./termctrl-verified/accepted.png)" not in block
        ):
            raise PublicationError("formatter violated the verified Preview contract")
        block = block.replace(START, START + "\n" + identity, 1)
        _write(root / "pr-body.md", _replace(pr["body"], block))
        # Revalidate bytes immediately before the upload boundary.
        preview(_preview_root or root, manifest)
        _run(
            gh
            + [
                "edit",
                str(pr["number"]),
                *options,
                "--body-file",
                str(root / "pr-body.md"),
                "--attach",
                attachments[0],
            ],
            root,
        )
    elif marker_missing or pr["body"] != prs[0]["body"]:
        _write(root / "pr-body.md", pr["body"])
        _run(
            gh
            + [
                "edit",
                str(pr["number"]),
                *options,
                "--body-file",
                str(root / "pr-body.md"),
            ],
            root,
        )
    pr = json.loads(
        _run(
            gh
            + [
                "view",
                str(pr["number"]),
                *options,
                "--json",
                FIELDS + OWNERSHIP_FIELDS,
            ],
            root,
        )
    )
    _validate_pr(pr, head, candidate, candidate_marker)
    _validate_owned_base(pr, base)
    published = _published_block(pr["body"], identity)
    if published is None:
        raise PublicationError(
            "PR attachment was not acknowledged; refusing target publication"
        )
    block, url = published
    if pr.get("isDraft") is True:
        _run(gh + ["ready", str(pr["number"]), *options], root)
        pr = json.loads(
            _run(
                gh
                + [
                    "view",
                    str(pr["number"]),
                    *options,
                    "--json",
                    FIELDS + OWNERSHIP_FIELDS,
                ],
                root,
            )
        )
        _validate_pr(pr, head, candidate, candidate_marker)
        _validate_owned_base(pr, base)
        if pr.get("isDraft") is not False:
            raise PublicationError("candidate PR did not leave draft state after local gates")
    proof = {
        "schema_version": 1,
        "repository": REPOSITORY,
        "base_branch": BASE,
        "base_sha": base,
        "candidate_sha": candidate,
        "head_branch": head,
        "number": pr["number"],
        "url": pr["url"],
        "preview_sha256": digest,
        "preview_dimensions": list(dimensions),
        "attachment_url": url,
        "block_sha256": hashlib.sha256(block.encode()).hexdigest(),
        "formatter_sha256": FORMATTER_SHA256,
        "gh_version": "2.100.0",
        "scope": "synthetic-startup-help",
        "request_identity": request_identity,
        "candidate_identity": candidate_identity,
        "issue": issue,
    }
    _write(root / "pr-evidence.json", json.dumps(proof, indent=2) + "\n")
    proof["review"] = wait_for_review(
        root,
        pr["number"],
        candidate,
        deadline_unix=review_deadline_unix,
        recovery_identity={
            "repository": REPOSITORY,
            "base_branch": BASE,
            "base_sha": base,
            "head_branch": head,
            "request_identity": request_identity,
            "candidate_identity": candidate_identity,
        },
        expected_pr_evidence={
            "head_branch": head,
            "candidate_marker": candidate_marker,
            "preview_identity": identity,
            "block_sha256": hashlib.sha256(block.encode()).hexdigest(),
            "attachment_url": url,
            "base_sha": base,
        },
        observed_heads=list(
            dict.fromkeys(
                [
                    *(
                        [manifest["expected_pr_head"]]
                        if manifest.get("expected_pr_head") is not None
                        else []
                    ),
                    candidate,
                ]
            )
        ),
    )
    _write(root / "pr-evidence.json", json.dumps(proof, indent=2) + "\n")
    return proof
