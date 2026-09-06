from __future__ import annotations

import hashlib
import importlib.util
import json
import struct
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[1] / "scripts/pr_publication.py"
SPEC = importlib.util.spec_from_file_location("pr_publication", SCRIPT)
assert SPEC and SPEC.loader
pub = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pub)
NODE = Path("/home/daimon/.local/share/fnm/node-versions/v26.3.0/installation/bin/node")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def capture(tmp_path: Path):
    root = tmp_path / "evidence"
    folder = root / "termctrl-verified"
    folder.mkdir(parents=True)
    png = folder / "accepted.png"
    png.write_bytes(
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + struct.pack(">II", 1200, 800)
    )
    text = folder / "accepted.txt"
    text.write_text("Hermes Agent\nAvailable Commands\n/help /quit\n")
    proof = {
        "publication_scope": {
            "profile": pub.PROFILE,
            "flow": "synthetic-startup-help",
            "personal_history": False,
            "environment": "allowlist-v1",
        },
        "png_path": str(png),
        "png_sha256": digest(png),
        "text_path": str(text),
        "text_sha256": digest(text),
    }
    log = root / "termctrl.log"
    log.write_text(json.dumps(proof))
    manifest = {
        "branch": pub.BASE,
        "candidate_sha": "a" * 40,
        "base_sha": "b" * 40,
        "lease_token_sha256": "c" * 64,
        "checks": [
            {
                "id": "termctrl-smoke",
                "status": "passed",
                "output_path": str(log),
                "output_sha256": digest(log),
            }
        ],
    }
    return root, manifest, proof


class Github:
    """Stateful remote seam; the installed media formatter still runs for real."""

    def __init__(self):
        self.calls = []
        self.ref = None
        self.pr = None
        self.fail_after = None
        self.destination = f"https://github.com/{pub.REPOSITORY}.git"
        self.upload = "https://github.com/user-attachments/assets/1234-abcd"

    def run(self, argv, cwd):
        self.calls.append(argv)
        if argv[0] == str(NODE):
            return subprocess.run(
                argv, cwd=cwd, capture_output=True, text=True, check=True
            ).stdout
        if argv == [str(pub.GH), "--version"]:
            return "gh version 2.100.0 (2026-09-03)\n"
        if argv[:3] == ["git", "remote", "get-url"]:
            return self.destination + "\n"
        if argv[:2] == ["git", "ls-remote"]:
            return self.ref or ""
        if argv[:2] == ["git", "push"]:
            candidate, ref = argv[-1].split(":")
            self.ref = candidate + "\t" + ref
            result = "ok"
            phase = "push"
        elif argv[:2] == [str(pub.GH), "api"]:
            if argv[2] == "graphql":
                if "--paginate" in argv:
                    return json.dumps([{"data": {"repository": {"object": {
                        "oid": "a" * 40, "statusCheckRollup": {"contexts": {
                            "nodes": self.pr["statusCheckRollup"],
                        }},
                    }}}}])
                return json.dumps({"data": {"repository": {"ref": {"name": pub.BASE, "branchProtectionRule": None}}}})
            if "/rules/branches/" in argv[-1]:
                return "[[]]"
            return json.dumps([[review_comment()]])
        else:
            phase = argv[2]
            if phase == "list":
                return json.dumps([self.pr] if self.pr else [])
            if phase == "create":
                self.pr = {
                    "number": 42,
                    "url": f"https://github.com/{pub.REPOSITORY}/pull/42",
                    "body": Path(argv[argv.index("--body-file") + 1]).read_text(
                        encoding="utf-8"
                    ),
                    "headRefName": argv[argv.index("--head") + 1],
                    "headRefOid": "a" * 40,
                    "baseRefName": pub.BASE,
                    "state": "OPEN",
                    "statusCheckRollup": green_checks(),
                    "mergeStateStatus": "CLEAN", "mergeable": "MERGEABLE",
                }
                result = self.pr["url"]
            elif phase == "edit":
                self.pr["body"] = (
                    Path(argv[argv.index("--body-file") + 1])
                    .read_text(encoding="utf-8")
                    .replace("./termctrl-verified/accepted.png", self.upload)
                )
                result = "ok"
            elif phase == "view":
                result = json.dumps(self.pr)
            else:
                pytest.fail(f"unexpected command: {argv}")
        if phase == self.fail_after:
            self.fail_after = None
            raise pub.PublicationError("simulated lost acknowledgement")
        return result


@pytest.fixture
def github(monkeypatch):
    github = Github()
    monkeypatch.setattr(pub, "_run", github.run)
    return github


def publish(capture, *, issue_request=None):
    root, manifest, _ = capture
    return pub.publish_preview(
        root.parent, root, manifest, node=NODE, issue_request=issue_request
    )


def bind_issue(
    capture,
    *,
    revision: str | None = None,
    existing_prs: list[dict] | None = None,
):
    root, manifest, _ = capture
    request = {
        "mode": "issue",
        "repository": pub.REPOSITORY,
        "issue": 41,
        "issue_url": f"https://github.com/{pub.REPOSITORY}/issues/41",
        "title": "Readable approved feature",
        "body": "Implement the requested feature.",
        "created_at": "2026-09-06T01:00:00Z",
        "last_edited_at": None,
        "revision_sha256": revision or "d" * 64,
        "approval": {
            "actor": "alt-glitch",
            "event_id": "99",
            "created_at": "2026-09-06T02:00:00Z",
            "revision_sha256": revision or "d" * 64,
        },
        "existing_prs": existing_prs or [],
    }
    (root / "request.claimed.json").write_text(json.dumps(request))
    manifest["run_binding"] = {
        "mode": "issue",
        "request_sha256": pub._canonical_sha(request),
        "last_synced_upstream": "e" * 40,
        "captured_upstream": "f" * 40,
        "captured_base": manifest["base_sha"],
        "issue": {
            "repository": pub.REPOSITORY,
            "number": 41,
            "revision_sha256": request["revision_sha256"],
            "approval_event_id": "99",
        },
    }
    return request


def green_checks():
    return [{
        "__typename": "CheckRun", "name": name,
        "status": "COMPLETED", "conclusion": "SUCCESS",
        "checkSuite": {"app": {"databaseId": 867647 if name == "Greptile Review" else 15368}},
    } for name in ("Greptile Review", "Python tests", "All required checks pass")]


def review_comment(score="5", candidate="a" * 40, login="greptile-apps[bot]"):
    return {
        "id": 1, "user": {"login": login}, "updated_at": "2026-09-05T16:00:00Z",
        "html_url": "https://github.com/alt-glitch/hermes-agent/pull/42#issuecomment-1",
        "body": f"Confidence Score: {score}/5\nLast reviewed commit: [title](https://github.com/alt-glitch/hermes-agent/commit/{candidate})",
    }


def review_pr():
    return {"headRefOid": "a" * 40, "state": "OPEN", "baseRefName": pub.BASE,
            "mergeStateStatus": "CLEAN", "mergeable": "MERGEABLE",
            "statusCheckRollup": green_checks()}


POLICY = {"base": pub.BASE, "contexts": ["Python tests"], "classic": None, "rules": []}


@pytest.mark.parametrize("name", ["Greptile Review", "All required checks pass"])
@pytest.mark.parametrize("replacement", [
    {"checkSuite": {"app": {"databaseId": 999999, "slug": "unrelated-forged-app"}}},
    {"checkSuite": None},
    {"__typename": "StatusContext", "state": "SUCCESS", "creator": {"login": "unrelated-user"}},
    {"conclusion": "SKIPPED"},
    {"conclusion": "NEUTRAL"},
])
def test_required_checks_cannot_be_impersonated_or_skipped(name, replacement):
    pr = review_pr()
    check = next(check for check in pr["statusCheckRollup"] if check["name"] == name)
    check.update(replacement)
    if check["__typename"] == "StatusContext":
        check["context"] = check.pop("name")
    with pytest.raises(pub.PublicationError, match="required check"):
        pub.review_status(pr, [review_comment()], "a" * 40, POLICY)


@pytest.mark.parametrize("comment", [
    review_comment(candidate="b" * 40),
    review_comment(login="not-the-review-bot"),
    {**review_comment(), "user": None},
])
def test_review_requires_authenticated_current_candidate(comment):
    assert pub.review_status(review_pr(), [comment], "a" * 40, POLICY) is None


def test_review_rejects_lower_score_and_later_downgrade():
    earlier = review_comment()
    later = {**review_comment(score="3"), "id": 2}
    with pytest.raises(pub.PublicationError, match="not 5/5"):
        pub.review_status(review_pr(), [earlier, later], "a" * 40, POLICY)


@pytest.mark.parametrize("change", [{"headRefOid": "b" * 40}, {"state": "MERGED"}, {"baseRefName": "main"}])
def test_review_refuses_changed_pr(change):
    with pytest.raises(pub.PublicationError, match="changed or closed"):
        pub.review_status({**review_pr(), **change}, [review_comment()], "a" * 40, POLICY)


def test_review_requires_finished_green_checks():
    pr = review_pr()
    pr["statusCheckRollup"][1]["status"] = "IN_PROGRESS"
    assert pub.review_status(pr, [review_comment()], "a" * 40, POLICY) is None
    pr["statusCheckRollup"][1].update(status="COMPLETED", conclusion="FAILURE")
    with pytest.raises(pub.PublicationError, match="PR check failed"):
        pub.review_status(pr, [review_comment()], "a" * 40, POLICY)


def test_missing_required_check_cannot_be_approved_even_with_green_greptile():
    pr = review_pr()
    pr["statusCheckRollup"] = green_checks()[:1]
    assert pub.review_status(pr, [review_comment()], "a" * 40, POLICY) is None
    pr["statusCheckRollup"] = green_checks()
    assert pub.review_status(pr, [review_comment()], "a" * 40, POLICY)["score"] == "5/5"


@pytest.mark.parametrize("state", ["BLOCKED", "BEHIND", "UNKNOWN", "UNSTABLE", "DRAFT"])
def test_green_rollup_does_not_override_github_merge_policy(state):
    assert pub.review_status({**review_pr(), "mergeStateStatus": state}, [review_comment()], "a" * 40, POLICY) is None


def test_policy_combines_classic_and_active_branch_rules(tmp_path, monkeypatch):
    responses = iter([
        {"data": {"repository": {"ref": {"name": pub.BASE, "branchProtectionRule": {
            "requiresStatusChecks": True, "requiredStatusCheckContexts": ["unit"],
            "requiredStatusChecks": [{"context": "unit", "app": {"databaseId": 123}}],
        }}}}},
        [[{"type": "required_status_checks", "parameters": {"required_status_checks": [
            {"context": "integration", "integration_id": 456},
        ]}}]],
    ])
    monkeypatch.setattr(pub, "_run", lambda argv, cwd: json.dumps(next(responses)))
    policy = pub.required_check_policy(tmp_path)
    assert set(policy["contexts"]) == {"integration", "unit", *pub.REQUIRED_CONTEXTS}
    assert policy["classic"]["requiredStatusChecks"][0]["app"]["databaseId"] == 123
    assert policy["app_ids"] == {**pub.REQUIRED_CHECK_APPS, "unit": 123, "integration": 456}
    pr = review_pr()
    for context, app_id in (("unit", 123), ("integration", 456)):
        pr["statusCheckRollup"].append({
            "__typename": "CheckRun", "name": context, "status": "COMPLETED",
            "conclusion": "SUCCESS", "checkSuite": {"app": {"databaseId": app_id}},
        })
    assert pub.review_status(pr, [review_comment()], "a" * 40, policy)
    pr["statusCheckRollup"][-1]["checkSuite"]["app"]["databaseId"] = 999
    with pytest.raises(pub.PublicationError, match="untrusted producer"):
        pub.review_status(pr, [review_comment()], "a" * 40, policy)


def test_candidate_check_query_preserves_all_pages_and_producers(tmp_path, monkeypatch):
    checks = green_checks()
    pages = [{"data": {"repository": {"object": {
        "oid": "a" * 40, "statusCheckRollup": {"contexts": {"nodes": [check]}},
    }}}} for check in checks]
    monkeypatch.setattr(pub, "_run", lambda argv, cwd: json.dumps(pages))
    assert pub.candidate_checks(tmp_path, "a" * 40) == checks
    pages[-1]["data"]["repository"]["object"]["oid"] = "b" * 40
    with pytest.raises(pub.PublicationError, match="could not be determined"):
        pub.candidate_checks(tmp_path, "a" * 40)


@pytest.mark.parametrize("response", [{"errors": [{"message": "denied"}]}, {"data": {"repository": {"ref": None}}}])
def test_unknown_base_policy_fails_closed(tmp_path, monkeypatch, response):
    monkeypatch.setattr(pub, "_run", lambda argv, cwd: json.dumps(response))
    with pytest.raises(pub.PublicationError, match="could not be determined"):
        pub.required_check_policy(tmp_path)


@pytest.mark.parametrize("rule_type", [
    "creation", "update", "deletion", "required_linear_history",
    "required_signatures", "pull_request", "non_fast_forward",
])
def test_non_check_rules_preserve_required_checks_and_merge_policy(tmp_path, monkeypatch, rule_type):
    rule = {"type": rule_type}
    checks_rule = {"type": "required_status_checks", "parameters": {
        "required_status_checks": [{"context": "integration", "integration_id": 456}],
    }}
    responses = iter([
        {"data": {"repository": {"ref": {"name": pub.BASE, "branchProtectionRule": None}}}},
        [[rule], [checks_rule]],
    ])
    monkeypatch.setattr(pub, "_run", lambda argv, cwd: json.dumps(next(responses)))
    policy = pub.required_check_policy(tmp_path)
    assert policy["rules"] == [rule, checks_rule]
    pr = review_pr()
    assert pub.review_status(pr, [review_comment()], "a" * 40, policy) is None
    pr["statusCheckRollup"].append({
        "__typename": "CheckRun", "name": "integration", "status": "COMPLETED",
        "conclusion": "SUCCESS", "checkSuite": {"app": {"databaseId": 456}},
    })
    assert pub.review_status(pr, [review_comment()], "a" * 40, policy)["score"] == "5/5"
    pr["mergeStateStatus"] = "BLOCKED"
    assert pub.review_status(pr, [review_comment()], "a" * 40, policy) is None


@pytest.mark.parametrize("rule_type", ["workflows", "merge_queue", "required_deployments", "unknown_future_rule"])
def test_unsupported_check_policy_fails_closed_instead_of_matching_display_names(tmp_path, monkeypatch, rule_type):
    responses = iter([
        {"data": {"repository": {"ref": {"name": pub.BASE, "branchProtectionRule": None}}}},
        [[{"type": rule_type, "parameters": {"workflows": [{"path": ".github/workflows/security.yml"}]}}]],
    ])
    monkeypatch.setattr(pub, "_run", lambda argv, cwd: json.dumps(next(responses)))
    with pytest.raises(pub.PublicationError, match="unsupported branch rule"):
        pub.required_check_policy(tmp_path)


def test_unprotected_fork_still_requires_ci_aggregate(capture, github):
    policy = pub.required_check_policy(capture[0])
    assert set(policy["contexts"]) == pub.REQUIRED_CONTEXTS
    pr = review_pr()
    pr["statusCheckRollup"] = green_checks()[:1]
    assert pub.review_status(pr, [review_comment()], "a" * 40, policy) is None
    pr["statusCheckRollup"] = green_checks()
    assert pub.review_status(pr, [review_comment()], "a" * 40, policy)["score"] == "5/5"


def test_review_timeout_keeps_target_untouched(capture, github, monkeypatch):
    root, _, _ = capture
    github.pr = review_pr()
    github.pr["statusCheckRollup"] = []
    clock = iter([0, 1801])
    monkeypatch.setattr(pub.time, "monotonic", lambda: next(clock))
    with pytest.raises(pub.PublicationError, match="still pending"):
        pub.wait_for_review(root, 42, "a" * 40, max_wait_seconds=1800)
    assert all(argv[0] == str(pub.GH) for argv in github.calls)
    assert not (root / "pr-review.json").exists()
    assert json.loads((root / "pr-pending.json").read_text())["status"] == "pending"


def test_review_wait_can_outlive_old_thirty_minute_limit(
    capture, github, monkeypatch
) -> None:
    root, _, _ = capture
    github.pr = review_pr()
    github.pr["statusCheckRollup"] = []
    clock = [0.0]
    monkeypatch.setattr(pub.time, "monotonic", lambda: clock[0])

    def complete_after_old_limit(_seconds: float) -> None:
        clock[0] = 1_901.0
        github.pr["statusCheckRollup"] = green_checks()

    monkeypatch.setattr(pub.time, "sleep", complete_after_old_limit)
    proof = pub.wait_for_review(
        root, 42, "a" * 40, max_wait_seconds=4_000
    )
    assert proof["score"] == "5/5"
    assert clock[0] > 1_800
    assert not (root / "pr-pending.json").exists()


def test_real_formatter_preview_seals_head_media_and_preserves_only_cas_publisher(
    capture, github
):
    proof = publish(capture)
    assert proof["preview_dimensions"] == [1200, 800]
    assert proof["candidate_sha"] == capture[1]["candidate_sha"]
    assert proof["preview_sha256"] == capture[2]["png_sha256"]
    assert "Preview (Synthetic startup/help regression proof)" in github.pr["body"]
    assert "not a before/after claim" in github.pr["body"]
    assert "./termctrl-verified" not in github.pr["body"]
    assert all("merge" not in argv for argv in github.calls)
    pushes = [argv for argv in github.calls if argv[:2] == ["git", "push"]]
    assert len(pushes) == 1
    assert pushes[0][-1].split(":")[1].startswith("refs/heads/codex/opentui-maint-")
    assert any(
        arg.startswith("--force-with-lease=refs/heads/codex/") and arg.endswith(":")
        for arg in pushes[0]
    )
    state = capture[0] / "pr-evidence.json"
    assert json.loads(state.read_text()) == proof
    assert state.stat().st_mode & 0o777 == 0o600


def test_recovered_issue_reuses_candidate_pr_across_distinct_leases(
    capture, github
) -> None:
    bind_issue(capture)
    first = publish(capture)
    first_head = first["head_branch"]
    capture[1]["lease_token_sha256"] = "9" * 64
    second = publish(capture)

    assert second["number"] == first["number"]
    assert second["head_branch"] == first_head
    assert second["request_identity"] == pub._canonical_sha(
        capture[1]["run_binding"]["issue"]
    )
    assert sum(call[:2] == ["git", "push"] for call in github.calls) == 1
    assert sum(
        len(call) > 2 and call[1:3] == ["pr", "create"] for call in github.calls
    ) == 1
    assert github.pr["body"].startswith("<!-- maintainer-candidate:v1:")
    assert "Approved issue: #41" in github.pr["body"]
    assert github.pr["body"].count("https://github.com/user-attachments/assets/") == 1


@pytest.mark.parametrize("appeared_after_capture", [False, True])
def test_exact_existing_implementing_pr_is_reused_without_candidate_branch(
    capture, github, appeared_after_capture
) -> None:
    existing = {
        "number": 42,
        "url": f"https://github.com/{pub.REPOSITORY}/pull/42",
        "base_branch": pub.BASE,
        "head_branch": "feature/approved-41",
        "head_sha": "a" * 40,
        "head_repository": pub.REPOSITORY,
    }
    request = bind_issue(
        capture, existing_prs=[] if appeared_after_capture else [existing]
    )
    current = (
        {**request, "existing_prs": [existing]} if appeared_after_capture else None
    )
    github.pr = {
        **review_pr(),
        "number": 42,
        "url": existing["url"],
        "body": "Contributor context.\n\nFixes #41",
        "headRefName": existing["head_branch"],
    }

    proof = publish(capture, issue_request=current)

    assert proof["number"] == 42
    assert proof["head_branch"] == existing["head_branch"]
    assert "Implements approved issue #41" in github.pr["body"]
    assert "Contributor context." in github.pr["body"]
    assert github.pr["body"].startswith("<!-- maintainer-candidate:v1:")
    assert not any(call[:2] == ["git", "push"] for call in github.calls)
    assert not any(
        len(call) > 2 and call[1:3] == ["pr", "create"] for call in github.calls
    )


@pytest.mark.parametrize(
    ("captured_head", "live_head"),
    [("b" * 40, "b" * 40), ("a" * 40, "b" * 40)],
)
def test_existing_implementing_pr_must_still_exactly_match_candidate(
    capture, github, captured_head, live_head
) -> None:
    existing = {
        "number": 42,
        "url": f"https://github.com/{pub.REPOSITORY}/pull/42",
        "base_branch": pub.BASE,
        "head_branch": "feature/approved-41",
        "head_sha": captured_head,
        "head_repository": pub.REPOSITORY,
    }
    bind_issue(capture, existing_prs=[existing])
    github.pr = {
        **review_pr(),
        "number": 42,
        "url": existing["url"],
        "body": "Fixes #41",
        "headRefName": existing["head_branch"],
        "headRefOid": live_head,
    }

    with pytest.raises(pub.PublicationError, match="implementing PR|duplicate PR"):
        publish(capture)
    assert not any(call[:2] == ["git", "push"] for call in github.calls)
    assert not any(
        len(call) > 2 and call[1:3] == ["pr", "create"] for call in github.calls
    )


def test_candidate_pr_identity_changes_with_request_base_or_candidate(capture) -> None:
    bind_issue(capture)
    original = pub._candidate_head(capture[1])[0]
    changed_request = json.loads(json.dumps(capture[1]))
    changed_request["run_binding"]["issue"]["revision_sha256"] = "8" * 64
    changed_base = json.loads(json.dumps(capture[1]))
    changed_base["base_sha"] = "7" * 40
    changed_candidate = json.loads(json.dumps(capture[1]))
    changed_candidate["candidate_sha"] = "6" * 40
    assert {
        pub._candidate_head(changed_request)[0],
        pub._candidate_head(changed_base)[0],
        pub._candidate_head(changed_candidate)[0],
    }.isdisjoint({original})


def test_issue_metadata_is_bounded_plain_data_and_preserves_preview_semantics(
    capture, github
) -> None:
    request = bind_issue(capture)
    metadata = {
        "schema_version": 1,
        "issue": 41,
        "revision_sha256": request["revision_sha256"],
        "title": "Show retry state clearly",
        "outcome": "Makes publication recovery visible without weakening any gate.",
        "implementation": ["Reuses the bound candidate PR."],
        "verification": ["Exercised the pending and eventual-success paths."],
        "limitations": ["No live deployment was performed."],
    }
    (capture[0] / "pr-metadata.json").write_text(json.dumps(metadata))
    proof = publish(capture)
    assert "feat(opentui): Show retry state clearly" in next(
        call[call.index("--title") + 1]
        for call in github.calls
        if len(call) > 2 and call[1:3] == ["pr", "create"]
    )
    assert "Makes publication recovery visible" in github.pr["body"]
    assert "Preview (Synthetic startup/help regression proof)" in github.pr["body"]
    assert proof["issue"]["metadata_sha256"] == digest(capture[0] / "pr-metadata.json")


def test_issue_metadata_cannot_inject_evidence_markers_or_secrets(capture, github) -> None:
    request = bind_issue(capture)
    metadata = {
        "schema_version": 1,
        "issue": 41,
        "revision_sha256": request["revision_sha256"],
        "title": "Feature",
        "outcome": "<!-- before-and-after:start --> sk-private1234567890",
        "implementation": [],
        "verification": [],
        "limitations": [],
    }
    (capture[0] / "pr-metadata.json").write_text(json.dumps(metadata))
    with pytest.raises(pub.PublicationError, match="unsafe text"):
        publish(capture)
    assert not any(call[:2] == ["git", "push"] for call in github.calls)


@pytest.mark.parametrize("phase", ["push", "create", "edit", "view"])
def test_lost_ack_retry_is_idempotent(capture, github, phase):
    github.fail_after = phase
    with pytest.raises(pub.PublicationError, match="lost acknowledgement"):
        publish(capture)
    proof = publish(capture)
    assert proof["number"] == 42
    assert sum(a[:2] == ["git", "push"] for a in github.calls) == 1
    assert sum(len(a) > 2 and a[1:3] == ["pr", "create"] for a in github.calls) == 1
    assert sum(len(a) > 2 and a[1:3] == ["pr", "edit"] for a in github.calls) == 1


def update_proof(capture):
    root, manifest, proof = capture
    log = Path(manifest["checks"][0]["output_path"])
    log.write_text(json.dumps(proof), encoding="utf-8")
    manifest["checks"][0]["output_sha256"] = digest(log)


@pytest.mark.parametrize(
    "scope",
    [
        None,
        {},
        {
            "profile": "/home/daimon/.hermes",
            "flow": "synthetic-startup-help",
            "personal_history": False,
        },
    ],
)
def test_personal_or_unproven_capture_never_reaches_network(capture, github, scope):
    capture[2]["publication_scope"] = scope
    update_proof(capture)
    with pytest.raises(pub.PublicationError, match="isolated synthetic"):
        publish(capture)
    assert github.calls == []


def test_changed_image_is_rejected_before_network(capture, github):
    Path(capture[2]["png_path"]).write_bytes(b"tampered")
    with pytest.raises(pub.PublicationError, match="escaped or changed"):
        publish(capture)
    assert github.calls == []


def test_token_like_visible_text_is_never_uploaded(capture, github):
    text = Path(capture[2]["text_path"])
    text.write_text("Available Commands\nsk-private1234567890", encoding="utf-8")
    capture[2]["text_sha256"] = digest(text)
    update_proof(capture)
    with pytest.raises(pub.PublicationError, match="safety check"):
        publish(capture)
    assert github.calls == []


def test_remote_destination_is_pinned(capture, github):
    github.destination = "git@github.com:someone-else/hermes-agent.git"
    with pytest.raises(pub.PublicationError, match="untrusted remote"):
        publish(capture)
    assert not any(a[:2] == ["git", "push"] for a in github.calls)


def test_moved_run_head_refuses_overwrite(capture, github):
    publish(capture)
    github.ref = github.ref.replace("a" * 40, "d" * 40)
    with pytest.raises(pub.PublicationError, match="different candidate"):
        publish(capture)


def test_mutated_pr_head_refuses_acceptance(capture, github):
    publish(capture)
    github.pr["headRefOid"] = "d" * 40
    with pytest.raises(pub.PublicationError, match="expected base/head"):
        publish(capture)


def test_unacknowledged_local_media_refuses_publication(capture, github):
    github.upload = "./termctrl-verified/accepted.png"
    with pytest.raises(pub.PublicationError, match="not acknowledged"):
        publish(capture)
    assert not (capture[0] / "pr-evidence.json").exists()


def test_replacing_preview_preserves_unrelated_prose_byte_for_byte(capture, github):
    publish(capture)
    marker = github.pr["body"].splitlines()[0]
    prefix = marker + "\nhuman intro  \n\n"
    suffix = "\n\n## Testing\n  keep trailing spaces  \n"
    github.pr["body"] = prefix + pub.START + "\nold\n" + pub.END + suffix
    publish(capture)
    assert github.pr["body"].startswith(prefix)
    assert github.pr["body"].endswith(suffix)


def test_changed_formatter_requires_revalidation(capture, github, monkeypatch):
    monkeypatch.setattr(pub, "FORMATTER_SHA256", "0" * 64)
    with pytest.raises(pub.PublicationError, match="formatter changed"):
        publish(capture)
    assert not any(a[:2] == ["git", "push"] for a in github.calls)
