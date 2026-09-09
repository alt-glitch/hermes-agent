"""Retained scheduled-sync repair contracts with real temporary Git state."""
from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

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

    git(repo, "checkout", "-b", runtime.BRANCH, common)
    (repo / "fork").write_text("fork base\n", encoding="utf-8")
    git(repo, "add", "fork")
    git(repo, "commit", "-m", "fork base")
    base = git(repo, "rev-parse", "HEAD")
    git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "origin", runtime.BRANCH)

    head_branch = "codex/opentui-maint-retained-fixture"
    git(repo, "checkout", "-b", head_branch)
    git(repo, "merge", "--no-ff", "upstream", "-m", "scheduled merge")
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
    claim_backport(state, evidence, base, candidate)
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
    assert binding["retained_sync"]["source_sha"] == f["source"]
    assert binding["retained_sync"]["repair_sha"] == f["candidate"]
    assert publication._candidate_head(
        {
            "base_sha": f["base"],
            "candidate_sha": f["candidate"],
            "run_binding": binding,
        }
    )[0] == f["head_branch"]
    scope = runtime._review_scope(
        f["repo"],
        f["base"],
        f["candidate"],
        expected_mode="repair",
        retained_sync_binding=binding["retained_sync"],
    )
    assert scope == {
        "mode": "retained-sync-repair",
        "ranges": [("candidate", f["base"], f["candidate"])],
        "upstream_sha": f["upstream"],
        "merge_commit": f["merge"],
        "synthetic_merge_tree": None,
    }
    owner_manifest = {
        "base_sha": f["base"],
        "candidate_sha": f["candidate"],
        "run_binding": binding,
    }
    live_pr = {
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
    }
    publication_run = publication._run

    def retained_pr_transport(argv, cwd):
        if argv[:3] == [str(publication.GH), "pr", "list"]:
            return json.dumps([live_pr])
        return publication_run(argv, cwd)

    monkeypatch.setattr(publication, "_run", retained_pr_transport)
    owned = publication._owned_head(
        f["repo"],
        f["evidence"],
        str(f["remote"]),
        owner_manifest,
        f["source"],
    )
    assert owned is not None
    assert owned[0]["number"] == 95
    assert owned[1] == f["head_branch"]
    monkeypatch.setattr(publication, "_run", publication_run)

    packet, _ = make_gate_packet(
        f["evidence"], f["worktree"], f["base"], f["candidate"]
    )
    install_success_mocks(monkeypatch)
    loaded_path = runtime.runpy.run_path
    preflight_calls = []

    def load_owner(path, *args, **kwargs):
        loaded = loaded_path(path, *args, **kwargs)
        if Path(path).name == "pr_publication.py":
            def preflight(repo, root, manifest_value, expected, **_options):
                preflight_calls.append((repo, root, expected))
                assert expected == f["source"]
                assert publication._retained_pr_reconciliation(manifest_value) == {
                    "number": 95,
                    "url": "https://github.com/alt-glitch/hermes-agent/pull/95",
                    "base_branch": runtime.BRANCH,
                    "head_branch": f["head_branch"],
                    "head_sha": f["source"],
                    "head_repository": "alt-glitch/hermes-agent",
                }
                return {"number": 95, "candidate_sha": f["candidate"]}

            loaded["preflight_owned_head"] = preflight
        return loaded

    monkeypatch.setattr(runtime.runpy, "run_path", load_owner)
    monkeypatch.setattr(
        runtime,
        "_publish_pr_evidence",
        lambda *_args, **_kwargs: {
            "number": 95,
            "url": "https://github.com/alt-glitch/hermes-agent/pull/95",
            "candidate_sha": f["candidate"],
            "head_branch": f["head_branch"],
        },
    )
    assert runtime.main(
        [
            "gate-and-ship",
            "--state",
            str(f["state"]),
            "--token",
            "test-token",
            "--packet",
            str(packet),
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
    ) == 0
    gate = runtime._load_gate(f["evidence"] / "gate.json")
    assert len(gate["checks"]) == len(runtime.REQUIRED_GATES)
    assert all(check["status"] == "passed" for check in gate["checks"])
    assert gate["review_proof"]["review_mode"] == "retained-sync-repair"
    assert preflight_calls == [(f["repo"], f["evidence"], f["source"])]
    assert remote_sha(f["repo"]) == f["candidate"]
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
