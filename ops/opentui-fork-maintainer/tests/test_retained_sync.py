"""Retained scheduled-sync repair contracts with real temporary Git state."""
from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

from test_pr_publication import Github, green_checks
from test_runtime import (
    claim_backport,
    file_hash,
    git,
    install_success_mocks,
    make_gate_packet,
    remote_sha,
    runtime,
    write_live_lease,
)


PUBLICATION_SCRIPT = Path(__file__).parents[1] / "scripts" / "pr_publication.py"
PUBLICATION_SPEC = importlib.util.spec_from_file_location(
    "retained_sync_test_pr_publication", PUBLICATION_SCRIPT
)
assert PUBLICATION_SPEC and PUBLICATION_SPEC.loader
publication = importlib.util.module_from_spec(PUBLICATION_SPEC)
PUBLICATION_SPEC.loader.exec_module(publication)


def install_publication_transport(f, monkeypatch, *, ci: str = "green"):
    """Run Git against the bare fixture while simulating only GitHub's API/CLI."""
    github = Github()
    github.pr = {
        "number": 95,
        "url": "https://github.com/alt-glitch/hermes-agent/pull/95",
        "body": "retained scheduled candidate",
        "headRefName": f["head_branch"],
        "headRefOid": f["source"],
        "baseRefName": runtime.BRANCH,
        "baseRefOid": f["base"],
        "state": "OPEN",
        "isDraft": True,
        "isCrossRepository": False,
        "headRepositoryOwner": {"login": "alt-glitch"},
        "headRepository": {"name": "hermes-agent"},
        "mergeStateStatus": "CLEAN",
        "mergeable": "MERGEABLE",
        "statusCheckRollup": green_checks(),
    }
    if ci == "missing":
        github.pr["statusCheckRollup"] = [
            check
            for check in green_checks()
            if check["name"] != "All required checks pass"
        ]
    elif ci == "failed":
        required = next(
            check
            for check in github.pr["statusCheckRollup"]
            if check["name"] == "All required checks pass"
        )
        required["conclusion"] = "FAILURE"

    real_run = publication._run
    trusted = github.destination

    def transport(argv, cwd):
        if argv[0] != "git":
            return github.run(argv, cwd)
        github.calls.append(argv)
        if argv[:3] == ["git", "remote", "get-url"]:
            return trusted + "\n"
        local_argv = [str(f["remote"]) if arg == trusted else arg for arg in argv]
        result = real_run(local_argv, cwd)
        if argv[1] == "push":
            github.pr["headRefOid"] = argv[-1].split(":", 1)[0]
        return result

    monkeypatch.setattr(publication, "_run", transport)
    return github


def retained_sync_repair_fixture(tmp_path, monkeypatch):
    remote = tmp_path / "remote.git"
    repo = tmp_path / "repo"
    git(tmp_path, "init", "--bare", str(remote))
    git(tmp_path, "init", str(repo))
    git(repo, "config", "user.email", "test@example.invalid")
    git(repo, "config", "user.name", "Test")
    (repo / "common").write_text("common\n", encoding="utf-8")
    (repo / "ui-opentui").mkdir()
    (repo / "ui-opentui/package-lock.json").write_text("{}\n", encoding="utf-8")
    git(repo, "add", "common", "ui-opentui/package-lock.json")
    git(repo, "commit", "-m", "common")
    common = git(repo, "rev-parse", "HEAD")

    git(repo, "checkout", "-b", "upstream")
    (repo / "upstream").write_text("trusted upstream\n", encoding="utf-8")
    git(repo, "add", "upstream")
    git(repo, "commit", "-m", "upstream")
    upstream = git(repo, "rev-parse", "HEAD")
    (repo / "later-upstream").write_text("later trusted upstream\n", encoding="utf-8")
    git(repo, "add", "later-upstream")
    git(repo, "commit", "-m", "later upstream")
    wrapper_upstream = git(repo, "rev-parse", "HEAD")

    git(repo, "checkout", "-b", runtime.BRANCH, common)
    (repo / "fork").write_text("fork base\n", encoding="utf-8")
    git(repo, "add", "fork")
    git(repo, "commit", "-m", "fork base")
    base = git(repo, "rev-parse", "HEAD")
    git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "origin", runtime.BRANCH)

    head_branch = "codex/opentui-maint-retained-fixture"
    git(repo, "checkout", "-b", head_branch)
    git(repo, "merge", "--no-ff", upstream, "-m", "scheduled merge")
    merge_commit = git(repo, "rev-parse", "HEAD")
    (repo / "source").write_text("published PR source\n", encoding="utf-8")
    git(repo, "add", "source")
    git(repo, "commit", "-m", "scheduled adaptation")
    source = git(repo, "rev-parse", "HEAD")
    git(repo, "push", "origin", head_branch)
    (repo / "repair").write_text("retained linear repair\n", encoding="utf-8")
    git(repo, "add", "repair")
    git(repo, "commit", "-m", "linear repair")
    candidate = git(repo, "rev-parse", "HEAD")
    worktree = tmp_path / "opentui-maint-retained-sync"
    git(repo, "worktree", "add", "--detach", str(worktree), candidate)

    state = tmp_path / "state"
    evidence = state / "runs/fresh-owner"
    source_root = state / "runs/terminal-owner"
    write_live_lease(state)
    claim_backport(state, evidence, base, wrapper_upstream)
    fresh_context_path = evidence / "run-context.json"
    fresh_context = json.loads(fresh_context_path.read_text(encoding="utf-8"))
    fresh_context.update(
        run_id=evidence.name,
        execution_id="fresh-owner-execution",
    )
    fresh_context_path.write_text(json.dumps(fresh_context), encoding="utf-8")
    fresh_lease_path = state / "run.lease.json"
    fresh_lease = json.loads(fresh_lease_path.read_text(encoding="utf-8"))
    fresh_lease.update(
        run_id=evidence.name,
        evidence_dir=str(evidence.resolve()),
        run_context_sha256=file_hash(fresh_context_path),
    )
    fresh_lease_path.write_text(json.dumps(fresh_lease), encoding="utf-8")
    (state / "last_synced_upstream.sha").write_text(common + "\n", encoding="utf-8")

    source_root.mkdir(parents=True)
    source_context = {
        "schema_version": 1,
        "run_id": source_root.name,
        "execution_id": "terminal-execution",
        "lease_token_sha256": "1" * 64,
        "base_sha": base,
        "upstream_sha": upstream,
    }
    source_outcome = {
        "schema_version": 1,
        "status": "failed",
        "stage": "external",
        "reason_code": "external-blocker",
        "published": False,
        "needs_finalization": False,
    }
    source_pr = {
        "schema_version": 1,
        "repository": "alt-glitch/hermes-agent",
        "base_branch": runtime.BRANCH,
        "base_sha": base,
        "candidate_sha": source,
        "head_branch": head_branch,
        "number": 95,
        "url": "https://github.com/alt-glitch/hermes-agent/pull/95",
        "issue": None,
    }
    for path, value in (
        (source_root / "run-context.json", source_context),
        (source_root / "run-outcome.json", source_outcome),
        (source_root / "pr-evidence.json", source_pr),
    ):
        path.write_text(json.dumps(value), encoding="utf-8")
    context_hash = file_hash(source_root / "run-context.json")
    source_manifest = {
        "base_sha": base,
        "candidate_sha": source,
        "run_binding": {
            "mode": "scheduled",
            "request_sha256": None,
            "last_synced_upstream": common,
            "captured_upstream": upstream,
            "captured_base": base,
        },
        "review_proof": {
            "review_mode": "upstream-merge",
            "base_sha": base,
            "candidate_sha": source,
            "upstream_sha": upstream,
            "merge_commit": merge_commit,
        },
        "publication_recovery": {
            "source_owner": "live-owner",
            "source_evidence_dir": str(source_root),
            "context_path": str(source_root / "run-context.json"),
            "context_sha256": context_hash,
            "number": 95,
        },
        "owner_preflight": {
            "repository": "alt-glitch/hermes-agent",
            "base_sha": base,
            "candidate_sha": source,
            "number": 95,
            "head_branch": head_branch,
        },
    }
    (source_root / "gate.json").write_text(
        json.dumps(source_manifest), encoding="utf-8"
    )
    provenance = {
        "source_run": source_root.name,
        "manifest_sha256": file_hash(source_root / "gate.json"),
        "context_sha256": context_hash,
        "outcome_sha256": file_hash(source_root / "run-outcome.json"),
        "pr_sha256": file_hash(source_root / "pr-evidence.json"),
    }
    grant = {
        **provenance,
        "base_sha": base,
        "source_sha": source,
        "repair_sha": candidate,
        "upstream_sha": upstream,
        "merge_commit": merge_commit,
        "last_synced_upstream": common,
        "head_branch": head_branch,
    }
    owner = runtime._retained_sync()
    owner.RETAINED_SYNC_REPAIRS = {95: grant}
    monkeypatch.setattr(runtime, "_retained_sync", lambda: owner)
    monkeypatch.setattr(publication, "_retained_sync", lambda: owner)
    request = {
        "mode": "repair",
        "pr": 95,
        "base_sha": base,
        "source_sha": source,
        "instruction": "Finish the retained scheduled sync on the same PR.",
        "retained_sync": provenance,
    }
    for path in (
        state / "run-request.inflight.json",
        evidence / "request.claimed.json",
    ):
        path.write_text(json.dumps(request), encoding="utf-8")
    return {
        "repo": repo,
        "remote": remote,
        "state": state,
        "evidence": evidence,
        "source_root": source_root,
        "base": base,
        "upstream": upstream,
        "wrapper_upstream": wrapper_upstream,
        "merge": merge_commit,
        "source": source,
        "candidate": candidate,
        "worktree": worktree,
        "head_branch": head_branch,
        "request": request,
        "owner": owner,
    }


def test_retained_sync_repair_runs_fresh_gate_ship_and_finalization(
    tmp_path, monkeypatch
):
    f = retained_sync_repair_fixture(tmp_path, monkeypatch)
    source_before = {
        path.relative_to(f["source_root"]): path.read_bytes()
        for path in f["source_root"].iterdir()
        if path.is_file()
    }
    binding = runtime._derive_run_binding(
        f["state"], f["evidence"], "test-token"
    )
    assert binding["captured_upstream"] == f["upstream"]
    assert runtime._load_gate(f["evidence"] / "run-context.json")[
        "upstream_sha"
    ] == f["wrapper_upstream"]
    assert binding["retained_sync"]["source_sha"] == f["source"]
    assert binding["retained_sync"]["repair_sha"] == f["candidate"]
    assert publication._candidate_head(
        {
            "base_sha": f["base"],
            "candidate_sha": f["candidate"],
            "run_binding": binding,
        }
    )[0] == f["head_branch"]
    trusted_checks = []
    monkeypatch.setattr(
        runtime,
        "_trusted_upstream_tip",
        lambda repo: trusted_checks.append(repo) or f["wrapper_upstream"],
    )
    scope = runtime._review_scope(
        f["repo"],
        f["base"],
        f["candidate"],
        expected_mode="repair",
        last_synced_upstream=binding["last_synced_upstream"],
        retained_sync_binding=binding["retained_sync"],
    )
    assert scope["mode"] == "retained-sync-repair"
    assert scope["upstream_sha"] == f["upstream"]
    assert scope["merge_commit"] == f["merge"]
    assert scope["synthetic_merge_tree"] is not None
    assert [item[0] for item in scope["ranges"]] == [
        "conflict-resolution",
        "post-merge-adaptation",
    ]
    reviewed_names = {
        name
        for _, before, after in scope["ranges"]
        for name in git(f["repo"], "diff", "--name-only", before, after).splitlines()
    }
    assert {"source", "repair"}.issubset(reviewed_names)
    assert "upstream" not in reviewed_names
    assert trusted_checks == [f["repo"]]

    real_publish = runtime._publish_pr_evidence
    real_run_path = runtime.runpy.run_path
    install_success_mocks(monkeypatch)
    github = install_publication_transport(f, monkeypatch)

    def load_publisher(path, *args, **kwargs):
        if Path(path).name == "pr_publication.py":
            return publication.__dict__
        return real_run_path(path, *args, **kwargs)

    monkeypatch.setattr(runtime.runpy, "run_path", load_publisher)
    monkeypatch.setattr(runtime, "_publish_pr_evidence", real_publish)

    owner_manifest = {
        "branch": runtime.BRANCH,
        "base_sha": f["base"],
        "candidate_sha": f["candidate"],
        "run_binding": binding,
    }
    branch_ref = f"refs/heads/{f['head_branch']}"
    original_branch = git(f["repo"], "ls-remote", str(f["remote"]), branch_ref)
    with pytest.raises(publication.PublicationError):
        publication.preflight_owned_head(
            f["repo"],
            f["evidence"],
            owner_manifest,
            f["base"],
            remote="origin",
        )
    github.pr["number"] = 94
    github.pr["url"] = "https://github.com/alt-glitch/hermes-agent/pull/94"
    with pytest.raises(publication.PublicationError, match="approved retained"):
        publication.preflight_owned_head(
            f["repo"],
            f["evidence"],
            owner_manifest,
            f["source"],
            remote="origin",
        )
    github.pr["number"] = 95
    github.pr["url"] = "https://github.com/alt-glitch/hermes-agent/pull/95"
    assert git(f["repo"], "ls-remote", str(f["remote"]), branch_ref) == original_branch

    preflight = publication.preflight_owned_head(
        f["repo"],
        f["evidence"],
        owner_manifest,
        f["source"],
        remote="origin",
    )
    assert preflight["number"] == 95

    packet, _ = make_gate_packet(
        f["evidence"], f["worktree"], f["base"], f["candidate"]
    )
    packet.replace(f["evidence"] / "gate-packet.json")
    first = runtime.run_gate(
        f["evidence"] / "gate-packet.json",
        f["evidence"] / "gate.json",
        cwd=f["worktree"],
        branch=runtime.BRANCH,
        base_sha=f["base"],
        candidate_sha=f["candidate"],
        token="test-token",
        run_binding=binding,
    )
    first["owner_preflight"] = preflight
    first["expected_pr_head"] = f["source"]
    runtime._atomic_json(f["evidence"] / "gate.json", first)
    first_proof = real_publish(
        f["repo"],
        f["evidence"],
        first,
        "origin",
        state_dir=f["state"],
        token="test-token",
    )
    first["pr_evidence"] = first_proof
    runtime._atomic_json(f["evidence"] / "gate.json", first)
    assert github.pr["headRefOid"] == f["candidate"]
    assert git(f["repo"], "ls-remote", str(f["remote"]), branch_ref).split()[0] == f[
        "candidate"
    ]
    marker = publication._candidate_head(first)[2]
    assert marker in github.pr["body"]

    (f["worktree"] / "second-repair").write_text(
        "second reviewed linear repair\n", encoding="utf-8"
    )
    git(f["worktree"], "add", "second-repair")
    git(f["worktree"], "commit", "-m", "second linear repair")
    second = git(f["worktree"], "rev-parse", "HEAD")
    second_packet, _ = make_gate_packet(
        f["evidence"], f["worktree"], f["base"], second
    )
    second_packet.replace(f["evidence"] / "gate-packet.json")
    install_success_mocks(monkeypatch)
    monkeypatch.setattr(runtime.runpy, "run_path", load_publisher)
    monkeypatch.setattr(runtime, "_publish_pr_evidence", real_publish)
    github.interrupt_candidate_check = True
    transport = publication._run

    def interrupt_observation(argv, cwd):
        if (
            github.interrupt_candidate_check
            and argv[:3] == [str(publication.GH), "api", "graphql"]
            and "--paginate" in argv
        ):
            github.interrupt_candidate_check = False
            raise publication.PublicationError("simulated CI observation interruption")
        return transport(argv, cwd)

    monkeypatch.setattr(publication, "_run", interrupt_observation)
    with pytest.raises(runtime.ControlError, match="CI observation interruption"):
        runtime.main([
            "gate-and-ship",
            "--state",
            str(f["state"]),
            "--token",
            "test-token",
            "--packet",
            str(f["evidence"] / "gate-packet.json"),
            "--manifest",
            str(f["evidence"] / "gate.json"),
            "--cwd",
            str(f["worktree"]),
            "--repo",
            str(f["repo"]),
            "--base",
            f["base"],
            "--candidate",
            second,
            "--expected-pr-head",
            f["candidate"],
        ])
    assert github.pr["headRefOid"] == second
    assert remote_sha(f["repo"]) == f["base"]
    interrupted_gate = runtime._load_gate(f["evidence"] / "gate.json")
    assert interrupted_gate["review_proof"]["candidate_sha"] == second
    assert interrupted_gate["review_proof"]["candidate_sha"] != first["review_proof"][
        "candidate_sha"
    ]

    def resume_args():
        return [
            "resume-publication",
            "--repo",
            str(f["repo"]),
            "--state",
            str(f["state"]),
            "--token",
            "test-token",
            "--source-manifest",
            str(f["evidence"] / "gate.json"),
            "--source-sha256",
            file_hash(f["evidence"] / "gate.json"),
            "--packet-sha256",
            file_hash(f["evidence"] / "gate-packet.json"),
            "--adopt-pr",
            "95",
            "--manifest",
            str(f["evidence"] / "gate.json"),
        ]

    request_bytes = {
        path: path.read_bytes()
        for path in (
            f["evidence"] / "request.claimed.json",
            f["state"] / "run-request.inflight.json",
        )
    }
    changed_request = {**f["request"], "instruction": "altered after the gate"}
    for path in request_bytes:
        path.write_text(json.dumps(changed_request), encoding="utf-8")
    with pytest.raises(runtime.ControlError, match="authorization|stale|changed"):
        runtime.main(resume_args())
    for path, contents in request_bytes.items():
        path.write_bytes(contents)

    pr_path = f["evidence"] / "pr-evidence.json"
    pr_bytes = pr_path.read_bytes()
    pr_path.write_text("{}\n", encoding="utf-8")
    with pytest.raises(runtime.ControlError, match="evidence|publication|archive changed"):
        runtime.main(resume_args())
    pr_path.write_bytes(pr_bytes)

    assert runtime.main(resume_args()) == 0
    gate = runtime._load_gate(f["evidence"] / "gate.json")
    assert len(gate["checks"]) == len(runtime.REQUIRED_GATES)
    assert all(check["status"] == "passed" for check in gate["checks"])
    assert gate["review_proof"]["review_mode"] == "retained-sync-repair"
    assert gate["review_proof"]["candidate_sha"] == second
    assert remote_sha(f["repo"]) == second
    assert (f["state"] / "last_synced_upstream.sha").read_text().strip() == f[
        "upstream"
    ]
    assert runtime._load_gate(f["state"] / "publish-journal.json")["phase"] == "finalized"
    assert runtime._load_gate(f["evidence"] / "run-outcome.json")["status"] == "success"
    assert not f["worktree"].exists()
    assert not (f["state"] / "run.lease.json").exists()
    assert {
        path.relative_to(f["source_root"]): path.read_bytes()
        for path in f["source_root"].iterdir()
        if path.is_file()
    } == source_before
    assert not any(
        call[:3] == [str(publication.GH), "pr", "create"]
        for call in github.calls
    )


@pytest.mark.parametrize("ci", ["missing", "failed"])
def test_retained_sync_required_ci_cannot_ship(tmp_path, monkeypatch, ci):
    f = retained_sync_repair_fixture(tmp_path, monkeypatch)
    binding = runtime._derive_run_binding(f["state"], f["evidence"], "test-token")
    monkeypatch.setattr(runtime, "_trusted_upstream_tip", lambda _repo: f["upstream"])
    real_publish = runtime._publish_pr_evidence
    real_run_path = runtime.runpy.run_path
    install_success_mocks(monkeypatch)
    github = install_publication_transport(f, monkeypatch, ci=ci)

    def load_publisher(path, *args, **kwargs):
        if Path(path).name == "pr_publication.py":
            return publication.__dict__
        return real_run_path(path, *args, **kwargs)

    monkeypatch.setattr(runtime.runpy, "run_path", load_publisher)
    monkeypatch.setattr(runtime, "_publish_pr_evidence", real_publish)
    packet, _ = make_gate_packet(
        f["evidence"], f["worktree"], f["base"], f["candidate"]
    )
    packet.replace(f["evidence"] / "gate-packet.json")

    if ci == "missing":
        lease_path = f["state"] / "run.lease.json"
        lease = runtime._load_gate(lease_path)
        lease.update(expires_unix=1_601, max_expires_unix=1_601)
        runtime._atomic_json(lease_path, lease)
        monotonic = [0.0]
        monkeypatch.setattr(publication.time, "time", lambda: 1_000.0)

        def tick():
            monotonic[0] += 1.0
            return monotonic[0]

        monkeypatch.setattr(publication.time, "monotonic", tick)

    with pytest.raises(
        runtime.ControlError,
        match="still pending|required PR check|PR check failed|PR review/checks",
    ):
        runtime.main(
            [
                "gate-and-ship",
                "--state",
                str(f["state"]),
                "--token",
                "test-token",
                "--packet",
                str(f["evidence"] / "gate-packet.json"),
                "--manifest",
                str(f["evidence"] / "gate.json"),
                "--cwd",
                str(f["worktree"]),
                "--repo",
                str(f["repo"]),
                "--base",
                f["base"],
                "--candidate",
                f["candidate"],
                "--expected-pr-head",
                f["source"],
            ]
        )

    assert github.pr["headRefOid"] == f["candidate"]
    assert remote_sha(f["repo"]) == f["base"]
    assert not (f["state"] / "publish-journal.json").exists()
    assert binding == runtime._load_gate(f["evidence"] / "gate.json")["run_binding"]


@pytest.mark.parametrize(
    ("fault", "message"),
    [
        ("live-owner", "source owner is not terminal"),
        ("moved-source", "source identity changed"),
        ("changed-evidence", "outcome evidence is missing or changed"),
        ("foreign-pr", "PR provenance changed"),
        ("foreign-live-pr", "not the approved retained"),
        ("changed-watermark", "watermark provenance changed"),
        ("moved-target", "publication target moved"),
        ("dropped-repair", "does not preserve its authenticated source and repair history"),
        ("extra-merge", "history must be linear"),
        ("noncanonical-upstream", "not in canonical upstream"),
        ("regressed-watermark", "regress canonical upstream"),
    ],
)
def test_retained_sync_repair_refuses_unproven_provenance_or_topology(
    tmp_path, monkeypatch, fault, message
):
    f = retained_sync_repair_fixture(tmp_path, monkeypatch)
    if fault == "live-owner":
        with pytest.raises(f["owner"].RetainedSyncError, match=message):
            f["owner"].authenticate(
                f["state"], f["request"], current_run_id=f["source_root"].name
            )
        return
    if fault == "moved-source":
        request = {**f["request"], "source_sha": "f" * 40}
        with pytest.raises(runtime.ControlError, match=message):
            runtime._validate_request(request)
        return
    if fault == "changed-evidence":
        (f["source_root"] / "run-outcome.json").write_text(
            "{}\n", encoding="utf-8"
        )
        with pytest.raises(runtime.ControlError, match=message):
            runtime._derive_run_binding(
                f["state"], f["evidence"], "test-token"
            )
        return
    if fault == "foreign-pr":
        pr_path = f["source_root"] / "pr-evidence.json"
        pr_value = runtime._load_gate(pr_path)
        pr_value["repository"] = "someone-else/hermes-agent"
        pr_path.write_text(json.dumps(pr_value), encoding="utf-8")
        changed_hash = file_hash(pr_path)
        f["request"]["retained_sync"]["pr_sha256"] = changed_hash
        f["owner"].RETAINED_SYNC_REPAIRS[95]["pr_sha256"] = changed_hash
        for path in (
            f["state"] / "run-request.inflight.json",
            f["evidence"] / "request.claimed.json",
        ):
            path.write_text(json.dumps(f["request"]), encoding="utf-8")
        with pytest.raises(runtime.ControlError, match=message):
            runtime._derive_run_binding(
                f["state"], f["evidence"], "test-token"
            )
        return
    if fault == "foreign-live-pr":
        binding = runtime._derive_run_binding(
            f["state"], f["evidence"], "test-token"
        )
        with pytest.raises(publication.PublicationError, match=message):
            publication._validate_retained_pr_owner(
                {
                    "number": 94,
                    "url": "https://github.com/alt-glitch/hermes-agent/pull/94",
                    "baseRefName": runtime.BRANCH,
                    "headRefName": "foreign",
                },
                {
                    "base_sha": f["base"],
                    "candidate_sha": f["candidate"],
                    "run_binding": binding,
                },
            )
        return
    if fault == "changed-watermark":
        (f["state"] / "last_synced_upstream.sha").write_text(
            f["upstream"] + "\n", encoding="utf-8"
        )
        with pytest.raises(runtime.ControlError, match=message):
            runtime._derive_run_binding(
                f["state"], f["evidence"], "test-token"
            )
        return
    if fault == "moved-target":
        binding = runtime._derive_run_binding(
            f["state"], f["evidence"], "test-token"
        )
        git(
            f["repo"],
            "push",
            "origin",
            f"{f['candidate']}:refs/heads/{runtime.BRANCH}",
        )
        live_pr = {
            "baseRefOid": f["base"],
            "baseRefName": runtime.BRANCH,
            "isCrossRepository": False,
            "headRepositoryOwner": {"login": "alt-glitch"},
            "headRepository": {"name": "hermes-agent"},
        }
        with pytest.raises(publication.PublicationError, match=message):
            publication._validate_publication_base(
                f["repo"],
                f["evidence"],
                str(f["remote"]),
                live_pr,
                {
                    "base_sha": f["base"],
                    "candidate_sha": f["candidate"],
                    "run_binding": binding,
                },
            )
        return
    if fault == "dropped-repair":
        with pytest.raises(runtime.ControlError, match=message):
            runtime._review_scope(
                f["repo"],
                f["base"],
                f["source"],
                expected_mode="repair",
                retained_sync_binding=runtime._derive_run_binding(
                    f["state"], f["evidence"], "test-token"
                )["retained_sync"],
            )
        return
    if fault in {"noncanonical-upstream", "regressed-watermark"}:
        monkeypatch.setattr(
            runtime,
            "_trusted_upstream_tip",
            lambda _repo: f["base"] if fault == "noncanonical-upstream" else f["upstream"],
        )
        with pytest.raises(runtime.ControlError, match=message):
            runtime._review_scope(
                f["repo"],
                f["base"],
                f["candidate"],
                expected_mode="repair",
                last_synced_upstream=(
                    f["candidate"]
                    if fault == "regressed-watermark"
                    else f["owner"].RETAINED_SYNC_REPAIRS[95][
                        "last_synced_upstream"
                    ]
                ),
                retained_sync_binding=runtime._derive_run_binding(
                    f["state"], f["evidence"], "test-token"
                )["retained_sync"],
            )
        return

    tree = git(f["repo"], "rev-parse", f"{f['candidate']}^{{tree}}")
    extra_merge = subprocess.run(
        [
            "git",
            "-C",
            str(f["repo"]),
            "commit-tree",
            tree,
            "-p",
            f["candidate"],
            "-p",
            f["base"],
        ],
        input="unexpected merge\n",
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    with pytest.raises(runtime.ControlError, match=message):
        runtime._review_scope(
            f["repo"],
            f["base"],
            extra_merge,
            expected_mode="repair",
            retained_sync_binding=runtime._derive_run_binding(
                f["state"], f["evidence"], "test-token"
            )["retained_sync"],
        )
