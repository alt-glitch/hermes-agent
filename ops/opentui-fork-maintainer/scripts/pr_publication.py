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
FIELDS = "number,url,body,headRefName,headRefOid,baseRefName,state"
# Immutable GitHub App IDs, verified against this fork's live check suites.
REQUIRED_CHECK_APPS = {"Greptile Review": 867647, "All required checks pass": 15368}
REQUIRED_CONTEXTS = set(REQUIRED_CHECK_APPS)
# These rules add no check contexts; GitHub still enforces them at merge/push.
NON_CHECK_RULES = frozenset({
    "creation", "update", "deletion", "required_linear_history",
    "required_signatures", "pull_request", "non_fast_forward",
})
MAX_REVIEW_WAIT_SECONDS = 140 * 60
REVIEW_POLL_SECONDS = 30


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


def _canonical_sha(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _candidate_head(manifest: dict[str, Any]) -> tuple[str, str, str]:
    """Derive retry-stable PR identity from request/base/candidate."""
    candidate, base = manifest.get("candidate_sha"), manifest.get("base_sha")
    if not all(
        isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha)
        for sha in (candidate, base)
    ):
        raise PublicationError("invalid candidate/base identity")
    binding = manifest.get("run_binding")
    request_identity: str | None = None
    if isinstance(binding, dict):
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
            "schema_version": 1,
            "repository": REPOSITORY,
            "base_branch": BASE,
            "request_identity": request_identity,
            "base_sha": base,
            "candidate_sha": candidate,
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


def review_status(pr: dict[str, Any], comments: list[dict[str, Any]], candidate: str, policy: dict[str, Any]) -> dict[str, Any] | None:
    """Accept only the current candidate's bot score and completed green checks."""
    if pr.get("headRefOid") != candidate or pr.get("state") != "OPEN" or pr.get("baseRefName") != BASE:
        raise PublicationError("review target changed or closed before publication")
    if policy.get("base") != BASE or not isinstance(policy.get("contexts"), list):
        raise PublicationError("verified base branch check policy is required")
    summaries = [
        comment for comment in comments
        if (comment.get("user") or {}).get("login") == "greptile-apps[bot]"
        and "Confidence Score:" in comment.get("body", "")
    ]
    latest = max(summaries, key=lambda item: (item["updated_at"], item["id"]), default=None)
    if latest is None:
        return None
    body = latest["body"]
    reviewed = re.search(r"Last reviewed commit:.*?/commit/([0-9a-f]{40})", body)
    if not reviewed or reviewed[1] != candidate:
        return None
    scores = re.findall(r"Confidence Score:\s*([0-5])/5", body)
    if scores != ["5"]:
        raise PublicationError("current Greptile review is not 5/5; fix findings before publication")
    checks = pr.get("statusCheckRollup") or []
    if not checks:
        return None
    for check in checks:
        if check.get("__typename") == "CheckRun":
            if check.get("status") != "COMPLETED":
                return None
            if check.get("conclusion") not in {"SUCCESS", "SKIPPED", "NEUTRAL"}:
                raise PublicationError(f"PR check failed: {check.get('name', 'unknown')}")
        elif check.get("__typename") == "StatusContext":
            if check.get("state") in {"PENDING", "EXPECTED"}:
                return None
            if check.get("state") != "SUCCESS":
                raise PublicationError(f"PR status failed: {check.get('context', 'unknown')}")
        else:
            raise PublicationError("unknown PR check shape; refusing publication")
    app_ids = {**policy.get("app_ids", {}), **REQUIRED_CHECK_APPS}
    for context in set(policy["contexts"]) | REQUIRED_CONTEXTS:
        matches = [check for check in checks if (check.get("name") or check.get("context")) == context]
        if not matches:
            return None
        for check in matches:
            if context in app_ids:
                app_id = ((check.get("checkSuite") or {}).get("app") or {}).get("databaseId")
                if check.get("__typename") != "CheckRun" or app_id != app_ids[context]:
                    raise PublicationError(f"untrusted producer for required check: {context}")
            if check.get("__typename") == "CheckRun" and check.get("conclusion") != "SUCCESS":
                raise PublicationError(f"required check did not succeed: {context}")
    # GitHub additionally enforces source-app bindings, required reviews and
    # up-to-date rules; a rollup of green jobs alone is not that decision.
    if pr.get("mergeStateStatus") != "CLEAN" or pr.get("mergeable") != "MERGEABLE":
        return None
    return {
        "candidate_sha": candidate,
        "score": "5/5",
        "comment_url": latest["html_url"],
        "comment_updated_at": latest["updated_at"],
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
            FIELDS + ",mergeStateStatus,mergeable"
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
        pages = json.loads(_run([
            str(GH), "api", "--paginate", "--slurp",
            f"repos/{REPOSITORY}/issues/{number}/comments?per_page=100",
        ], root))
        policy = required_check_policy(root)
        proof = review_status(pr, [item for page in pages for item in page], candidate, policy)
        if proof is not None:
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
        print(f"PR #{number}: waiting for current-head Greptile 5/5 and green checks", flush=True)
        time.sleep(min(REVIEW_POLL_SECONDS, max(0.0, deadline - time.monotonic())))


def publish_preview(
    repo: Path,
    root: Path,
    manifest: dict[str, Any],
    *,
    node: Path,
    remote: str = "origin",
    review_deadline_unix: int | None = None,
    issue_request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Idempotently create the candidate PR and attach one proven synthetic PNG.

    The create-only head branch is separate from sid/opentui. The caller alone
    owns the target-ref CAS, after this function returns verified evidence.
    """
    root = root.resolve()
    png, digest, dimensions = preview(root, manifest)
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
    destination = _run(
        ["git", "remote", "get-url", "--push", "--all", remote], repo
    ).strip()
    if destination not in {
        f"https://github.com/{REPOSITORY}.git",
        f"git@github.com:{REPOSITORY}.git",
        f"https://github.com/{REPOSITORY}",
    }:
        raise PublicationError("refusing candidate push to an untrusted remote")
    candidate, base = manifest["candidate_sha"], manifest["base_sha"]
    head, request_identity, candidate_identity = _candidate_head(manifest)
    candidate_marker = f"<!-- maintainer-candidate:v1:{candidate_identity} -->"
    binding = manifest.get("run_binding")
    is_issue = isinstance(binding, dict) and binding.get("mode") == "issue"
    if is_issue:
        # Issue metadata, body construction and implementing-PR reconciliation
        # are issue policy; this transport module delegates them to the owner.
        workflow = _issue_workflow()
        try:
            title, body_prefix, issue = workflow.issue_publication_metadata(
                root, manifest, issue_request
            )
        except workflow.IssueWorkflowError as exc:
            raise PublicationError(str(exc)) from exc
    else:
        workflow = None
        issue = None
        title = f"chore(opentui): maintainer candidate {candidate[:12]}"
        body_prefix = (
            f"Automated OpenTUI maintenance candidate `{candidate}` from `{base}`.\n\n"
        )
    gh = [str(GH), "pr"]
    options = ["--repo", REPOSITORY]

    def reconcile_live_issue_pr() -> dict[str, Any] | None:
        """Re-read the live issue-scoped PR set at the publication edge."""
        if not is_issue:
            return None
        try:
            return workflow.reconcile_issue_pr(
                issue, candidate, cwd=root, runner=_run
            )
        except workflow.IssueWorkflowError as exc:
            raise PublicationError(str(exc)) from exc

    # Reuse or refuse a competing implementing PR before pushing our own branch,
    # so a PR that appeared after the caller's snapshot leaves no dangling ref.
    reconciled = reconcile_live_issue_pr()
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
                    FIELDS,
                ],
                root,
            )
        )
    if not prs and reconciled is None:
        # Narrow the final edge: re-read the live issue-scoped PR set once more
        # immediately before creation, since our own push/list may have raced a
        # competitor. GitHub offers no atomic CAS for PR creation.
        reconciled = reconcile_live_issue_pr()
        if reconciled is not None:
            head = reconciled["headRefName"]
            prs = [reconciled]
    if not prs and reconciled is None:
        body = (
            candidate_marker
            + "\n"
            + body_prefix
            + "Preview is startup/help regression proof from the isolated synthetic profile, "
            "not a before/after claim about changed UI behavior.\n\n"
            "All required code, independent review, terminal, and video gates passed. "
            "The maintainer publishes only through its guarded target-branch CAS.\n"
        )
        _write(root / "pr-body.md", body)
        _run(
            gh
            + [
                "create",
                *options,
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
                    FIELDS,
                ],
                root,
            )
        )
    if len(prs) != 1:
        raise PublicationError("expected exactly one run-scoped PR")
    pr = prs[0]
    _validate_pr(pr, head, candidate)
    marker_missing = candidate_marker not in pr["body"]
    if marker_missing:
        reconciled_prefix = body_prefix if reconciled is not None else ""
        pr = {
            **pr,
            "body": candidate_marker + "\n" + reconciled_prefix + pr["body"],
        }
    identity = f"<!-- maintainer-preview:{candidate}:{digest} -->"
    published = _published_block(pr["body"], identity)
    if published is None:
        formatter = [
            str(node),
            str(FORMATTER),
            "--after",
            str(png),
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
        preview(root, manifest)
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
    elif marker_missing:
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
        _run(gh + ["view", str(pr["number"]), *options, "--json", FIELDS], root)
    )
    _validate_pr(pr, head, candidate, candidate_marker)
    published = _published_block(pr["body"], identity)
    if published is None:
        raise PublicationError(
            "PR attachment was not acknowledged; refusing target publication"
        )
    block, url = published
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
        },
    )
    _write(root / "pr-evidence.json", json.dumps(proof, indent=2) + "\n")
    return proof
