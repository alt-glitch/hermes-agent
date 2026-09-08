"""Continuation contracts: real temporary Git/state, simulated GitHub only.

Gate artifacts below are explicit test fixtures, not claimed product QA.
"""
from __future__ import annotations

import hashlib
import json
import struct
import subprocess
from pathlib import Path

import pytest

from test_pr_publication import (
    bind_issue,
    capture,
    github,
    green_checks,
    pub,
    review_pr,
)
from test_runtime import git, make_gate_packet, make_repo, manifest, remote_sha, runtime


def write_json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


def retained_artifacts(root):
    worktree = root / "integration"
    return {
        str(path): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file() and not path.is_relative_to(worktree)
    }


@pytest.fixture
def retained(tmp_path, monkeypatch):
    state = tmp_path / "state"
    old, fresh = state / "runs/old", state / "runs/fresh"
    repo, remote, base, candidate, cwd = make_repo(
        tmp_path, worktree_name="state/runs/old/integration"
    )
    old.mkdir(parents=True, exist_ok=True)
    fresh.mkdir()
    source, output = old / "gate.json", fresh / "gate.json"
    manifest(source, cwd, base, candidate)
    packet, _ = make_gate_packet(old, cwd, base, candidate)
    packet.rename(old / "gate-packet.json")
    request = {"mode": "backport", "commits": [candidate]}
    for path in (old / "request.claimed.json", fresh / "request.claimed.json", state / "run-request.inflight.json"):
        write_json(path, request)
    binding = {"mode": "backport", "request_sha256": runtime._canonical_json_sha256(request),
               "last_synced_upstream": None, "captured_upstream": base, "captured_base": base}
    value = runtime._load_gate(source)
    value["run_binding"] = binding
    value["packet_sha256"] = runtime._file_sha256(old / "gate-packet.json")
    review = {**value["review_proof"], "candidate_sha": candidate, "verdict": "approved",
              "review_ranges": [{"before": base, "after": candidate,
                                 "diff_sha256": hashlib.sha256(runtime._canonical_range_diff(repo, base, candidate)).hexdigest()}]}
    review["verified_gate_evidence"] = [
        {
            "id": gate_id,
            "exit_code": 0,
            "status": "passed",
            "output_sha256": next(
                check["output_sha256"]
                for check in value["checks"]
                if check["id"] == gate_id
            ),
            "command_sha256": hashlib.sha256(
                json.dumps(
                    next(
                        check["argv"]
                        for check in value["checks"]
                        if check["id"] == gate_id
                    ),
                    separators=(",", ":"),
                ).encode()
            ).hexdigest(),
        }
        for gate_id in runtime.REVIEW_PREREQUISITE_GATES
    ]
    value["review_proof"] = review
    folder = old / "termctrl-verified"
    folder.mkdir()
    png, text = folder / "accepted.png", folder / "accepted.txt"
    png.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + struct.pack(">II", 1200, 800))
    text.write_text("Hermes Agent\nAvailable Commands\n", encoding="utf-8")
    media = {"publication_scope": runtime._synthetic_scope(),
             "png_path": str(png), "png_sha256": runtime._file_sha256(png),
             "text_path": str(text), "text_sha256": runtime._file_sha256(text)}
    for check in value["checks"]:
        proof = {"adversarial-review": review, "termctrl-smoke": media, "video-analysis": media}.get(check["id"])
        if proof is not None:
            write_json(Path(check["output_path"]), proof)
            check["output_sha256"] = runtime._file_sha256(Path(check["output_path"]))
    write_json(source, value)
    for root, token in ((old, "test-token"), (fresh, "fresh-token")):
        write_json(root / "run-context.json", {
            "schema_version": 1, "run_id": root.name, "execution_id": root.name + "-execution",
            "lease_token_sha256": hashlib.sha256(token.encode()).hexdigest(),
            "base_sha": base, "upstream_sha": base,
        })
    write_json(state / "run.lease.json", {
        "token": "fresh-token", "expires_unix": 4_000_000_000, "max_expires_unix": 4_000_000_000,
        "run_id": fresh.name, "evidence_dir": str(fresh), "captured_base": base, "captured_upstream": base,
        "run_context_sha256": runtime._file_sha256(fresh / "run-context.json"),
    })
    write_json(old / "run-outcome.json", {
        "status": "failed", "stage": "publish", "reason_code": "publish-refused",
        "published": False, "needs_finalization": False,
    })
    head, _, identity = pub._candidate_head(value)
    block = f"{pub.START}\n<!-- maintainer-preview:{candidate}:{media['png_sha256']} -->\n![Preview](https://github.com/user-attachments/assets/test-fixture)\n{pub.END}"
    proof = {"repository": pub.REPOSITORY, "base_branch": pub.BASE, "base_sha": base,
             "candidate_sha": candidate, "head_branch": head, "number": 42,
             "url": f"https://github.com/{pub.REPOSITORY}/pull/42", "preview_sha256": media["png_sha256"],
             "preview_dimensions": [1200, 800], "block_sha256": hashlib.sha256(block.encode()).hexdigest(),
             "attachment_url": "https://github.com/user-attachments/assets/test-fixture"}
    write_json(old / "pr-evidence.json", proof)
    pr = {"number": 42, "url": proof["url"], "body": f"<!-- maintainer-candidate:v1:{identity} -->\n" + block,
          "headRefName": head, "headRefOid": candidate, "baseRefName": pub.BASE, "baseRefOid": base,
          "state": "OPEN", "isDraft": False, "isCrossRepository": False,
          "headRepositoryOwner": {"login": "alt-glitch"},
          "headRepository": {"name": "hermes-agent"}, "mergeStateStatus": "CLEAN", "mergeable": "MERGEABLE"}
    calls = []
    def github(argv, _cwd):
        calls.append(argv)
        if argv[:3] == [str(pub.GH), "pr", "view"]:
            return json.dumps(pr)
        if argv[:2] == [str(pub.GH), "api"]:
            endpoint = argv[-1]
            if "/check-runs?" in endpoint:
                return json.dumps([{"total_count": 0, "check_runs": []}])
            return json.dumps([[]])
        pytest.fail(f"unexpected external write or call: {argv}")
    monkeypatch.setattr(pub, "_run", github)
    monkeypatch.setattr(pub, "candidate_checks", lambda *_: green_checks())
    monkeypatch.setattr(pub, "required_check_policy", lambda *_: {"base": pub.BASE, "contexts": list(pub.REQUIRED_CONTEXTS)})
    real_load = runtime.runpy.run_path
    monkeypatch.setattr(runtime.runpy, "run_path", lambda path: {"resume_preview": pub.resume_preview} if path.endswith("pr_publication.py") else real_load(path))
    monkeypatch.setattr(runtime, "run_gate", lambda *a, **kw: pytest.fail("continuation reran expensive gates"))
    args = ["resume-publication", "--repo", str(repo), "--state", str(state), "--token", "fresh-token",
            "--source-manifest", str(source), "--source-sha256", runtime._file_sha256(source),
            "--packet-sha256", value["packet_sha256"], "--adopt-pr", "42", "--manifest", str(output)]
    return {"repo": repo, "remote": remote, "base": base, "candidate": candidate, "cwd": cwd,
            "state": state, "old": old, "fresh": fresh, "source": source, "output": output,
            "args": args, "pr": pr, "calls": calls}


def test_continuation_delivers_once_without_rewriting_original(retained):
    f = retained
    before = retained_artifacts(f["old"])
    assert runtime.main(f["args"]) == 0
    assert remote_sha(f["repo"]) == f["candidate"]
    assert runtime._load_gate(f["fresh"] / "run-outcome.json")["published"] is True
    recovered = runtime._load_gate(f["output"])
    journal = runtime._load_gate(f["state"] / "publish-journal.json")
    cleanup = {
        "evidence_dir": str(f["old"]),
        "worktree": str(f["cwd"]),
    }
    assert recovered["cleanup_ownership"] == cleanup
    assert journal["cleanup_ownership"] == cleanup
    assert journal["cleanup_ownership_sha256"] == runtime._canonical_json_sha256(
        cleanup
    )
    assert journal["phase"] == "finalized"
    assert not f["cwd"].exists()
    assert not (f["state"] / "run.lease.json").exists()
    assert retained_artifacts(f["old"]) == before
    with pytest.raises(runtime.ControlError, match="lease"):
        runtime.main(f["args"])
    assert sum(call[:3] == [str(pub.GH), "pr", "view"] for call in f["calls"]) == 1
    assert all(call[1] in {"pr", "api"} for call in f["calls"])


@pytest.mark.parametrize("damage", ["changed", "missing"])
def test_continuation_regenerates_only_unusable_local_checks(
    retained, monkeypatch, damage
):
    f = retained
    changed = {"focused-contracts", "opentui-check", "opentui-build"}
    for gate_id in changed:
        path = f["old"] / "gate-logs" / f"{gate_id}.log"
        if damage == "missing":
            path.unlink()
        else:
            path.write_text(
                f"interrupted duplicate {gate_id}\n", encoding="utf-8"
            )
    before = retained_artifacts(f["old"])
    real_run = runtime.subprocess.run
    executed = []

    def local_checks(argv, *args, **kwargs):
        if argv and (argv[0] == "uv" or argv[0] == str(runtime.NPM26)):
            executed.append(argv)
            output = kwargs.get("stdout")
            if hasattr(output, "write"):
                output.write(
                    b"1 passed in 0.01s\n" if argv[0] == "uv" else b"completed\n"
                )
            return subprocess.CompletedProcess(argv, 0)
        return real_run(argv, *args, **kwargs)

    monkeypatch.setattr(runtime.subprocess, "run", local_checks)
    monkeypatch.setattr(
        runtime,
        "run_adversarial_review",
        lambda *args, **kwargs: pytest.fail("valid independent review ran twice"),
    )
    args = [
        *f["args"],
        "--source-packet",
        str(f["old"] / "gate-packet.json"),
    ]

    assert runtime.main(args) == 0

    recovered = runtime._load_gate(f["output"])
    assert set(recovered["publication_recovery"]["regenerated_gates"]) == changed
    assert "adversarial-review" in recovered["publication_recovery"]["reused_gates"]
    assert len(executed) == 3
    assert retained_artifacts(f["old"]) == before


def test_live_owner_continuation_archives_source_before_fresh_attempt(
    retained, monkeypatch
):
    f = retained
    context = runtime._load_gate(f["old"] / "run-context.json")
    write_json(
        f["state"] / "run.lease.json",
        {
            "token": "test-token",
            "expires_unix": 4_000_000_000,
            "max_expires_unix": 4_000_000_000,
            "run_id": f["old"].name,
            "evidence_dir": str(f["old"]),
            "captured_base": f["base"],
            "captured_upstream": f["base"],
            "run_context_sha256": runtime._file_sha256(
                f["old"] / "run-context.json"
            ),
        },
    )
    source_bytes = f["source"].read_bytes()
    args = [
        "resume-publication",
        "--repo",
        str(f["repo"]),
        "--state",
        str(f["state"]),
        "--token",
        "test-token",
        "--source-manifest",
        str(f["source"]),
        "--source-sha256",
        runtime._file_sha256(f["source"]),
        "--packet-sha256",
        runtime._file_sha256(f["old"] / "gate-packet.json"),
        "--source-packet",
        str(f["old"] / "gate-packet.json"),
        "--adopt-pr",
        "42",
        "--manifest",
        str(f["source"]),
    ]

    observe = pub.wait_for_review
    monkeypatch.setattr(
        pub,
        "wait_for_review",
        lambda *a, **kw: (_ for _ in ()).throw(
            pub.PublicationError("API observation interrupted")
        ),
    )
    with pytest.raises(runtime.ControlError, match="API observation interrupted"):
        runtime.main(args)

    recovered = runtime._load_gate(f["source"])
    archived = Path(recovered["publication_recovery"]["manifest_path"])
    assert archived != f["source"]
    assert archived.read_bytes() == source_bytes
    assert recovered["publication_recovery"]["source_owner"] == "live-owner"
    monkeypatch.setattr(pub, "wait_for_review", observe)
    assert runtime.main(args) == 0


def test_recovery_rechecks_authorization_inside_ship_lock(retained, monkeypatch):
    f = retained
    damaged = f["old"] / "gate-logs/focused-contracts.log"
    damaged.write_text("interrupted duplicate\n", encoding="utf-8")
    real_run = runtime.subprocess.run

    def local_check(argv, *args, **kwargs):
        if argv and argv[0] == "uv":
            output = kwargs.get("stdout")
            if hasattr(output, "write"):
                output.write(b"1 passed in 0.01s\n")
            return subprocess.CompletedProcess(argv, 0)
        return real_run(argv, *args, **kwargs)

    real_ship = runtime.ship_candidate

    def revoke_before_ship(*args, **kwargs):
        revoked = {"mode": "backport", "commits": [f["base"]]}
        write_json(f["state"] / "run-request.inflight.json", revoked)
        write_json(f["fresh"] / "request.claimed.json", revoked)
        return real_ship(*args, **kwargs)

    monkeypatch.setattr(runtime.subprocess, "run", local_check)
    monkeypatch.setattr(runtime, "ship_candidate", revoke_before_ship)

    with pytest.raises(
        runtime.ControlError, match="publication request authorization changed"
    ):
        runtime.main(f["args"])

    assert remote_sha(f["repo"]) == f["base"]
    assert not (f["state"] / "publish-journal.json").exists()


@pytest.mark.parametrize(
    "fault",
    [
        "foreign-owner",
        "live-lock",
        "candidate",
        "dirty",
        "branch-attached",
        "arbitrary-sibling",
        "base",
        "packet",
        "media",
        "context",
        "authorization",
        "already-delivered",
    ],
)
def test_continuation_refuses_real_state_and_artifact_changes(retained, fault):
    f = retained
    if fault == "foreign-owner":
        lease = runtime._load_gate(f["state"] / "run.lease.json")
        lease["token"] = "foreign"
        write_json(f["state"] / "run.lease.json", lease)
    elif fault == "live-lock":
        with runtime.run_lock(f["state"]), pytest.raises(runtime.RunBusyError):
            runtime.main(f["args"])
        return
    elif fault == "candidate":
        (f["cwd"] / "file").write_text("changed\n", encoding="utf-8")
        git(f["cwd"], "commit", "-am", "unreviewed fix")
    elif fault == "dirty":
        (f["cwd"] / "untracked").write_text("dirty\n", encoding="utf-8")
    elif fault == "branch-attached":
        git(f["cwd"], "switch", "-c", "unexpected-owner")
    elif fault == "arbitrary-sibling":
        sibling = f["old"] / "integration-sibling"
        git(f["repo"], "worktree", "add", "--detach", str(sibling), f["candidate"])
        value = runtime._load_gate(f["source"])
        value["worktree_proof"]["worktree"] = str(sibling)
        write_json(f["source"], value)
        f["args"][f["args"].index("--source-sha256") + 1] = runtime._file_sha256(
            f["source"]
        )
    elif fault in {"base", "already-delivered"}:
        git(f["repo"], "push", "origin", f"{f['candidate']}:refs/heads/sid/opentui")
    elif fault == "packet":
        (f["old"] / "gate-packet.json").write_text("{}", encoding="utf-8")
    elif fault == "media":
        (f["old"] / "termctrl-verified/accepted.png").write_bytes(b"changed")
    elif fault == "context":
        context = runtime._load_gate(f["old"] / "run-context.json")
        context["lease_token_sha256"] = "0" * 64
        write_json(f["old"] / "run-context.json", context)
    elif fault == "authorization":
        write_json(f["state"] / "run-request.inflight.json", {"mode": "backport", "commits": [f["base"]]})
    with pytest.raises(runtime.ControlError):
        runtime.main(f["args"])
    assert not (f["fresh"] / "run-outcome.json").exists()
    assert not (f["state"] / "publish-journal.json").exists()
    assert f["calls"] == []


def test_post_push_recovery_uses_authenticated_original_cleanup_owner(
    retained, monkeypatch
):
    f = retained
    finalize = runtime.finalize_success
    monkeypatch.setattr(
        runtime,
        "finalize_success",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            OSError("simulated crash after publication")
        ),
    )

    with pytest.raises(OSError, match="simulated crash after publication"):
        runtime.main(f["args"])

    journal = runtime._load_gate(f["state"] / "publish-journal.json")
    assert journal["phase"] == "published"
    assert journal["cleanup_ownership"] == {
        "evidence_dir": str(f["old"]),
        "worktree": str(f["cwd"]),
    }
    assert remote_sha(f["repo"]) == f["candidate"]
    assert f["cwd"].exists()

    monkeypatch.setattr(runtime, "finalize_success", finalize)
    result = runtime.reconcile_run(
        f["state"], f["fresh"], token="fresh-token"
    )
    assert result["status"] == "success"
    assert not f["cwd"].exists()


@pytest.mark.parametrize("tamper", ["manifest", "journal", "journal-and-digest"])
def test_cleanup_ownership_metadata_cannot_be_changed(
    retained, monkeypatch, tamper
):
    f = retained
    finalize = runtime.finalize_success
    monkeypatch.setattr(
        runtime,
        "finalize_success",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            OSError("simulated crash after publication")
        ),
    )
    with pytest.raises(OSError, match="simulated crash after publication"):
        runtime.main(f["args"])

    replacement = {
        "evidence_dir": str(f["fresh"]),
        "worktree": str(f["cwd"]),
    }
    if tamper == "manifest":
        recovered = runtime._load_gate(f["output"])
        recovered["cleanup_ownership"] = replacement
        write_json(f["output"], recovered)
    else:
        journal_path = f["state"] / "publish-journal.json"
        journal = runtime._load_gate(journal_path)
        journal["cleanup_ownership"] = replacement
        if tamper == "journal-and-digest":
            journal["cleanup_ownership_sha256"] = runtime._canonical_json_sha256(
                replacement
            )
        write_json(journal_path, journal)

    monkeypatch.setattr(runtime, "finalize_success", finalize)
    with pytest.raises(runtime.ControlError, match="manifest evidence|cleanup ownership"):
        runtime.reconcile_run(f["state"], f["fresh"], token="fresh-token")
    assert f["cwd"].exists()


@pytest.mark.parametrize("field,value", [("state", "CLOSED"), ("baseRefName", "main"), ("baseRefOid", "0" * 40), ("headRefOid", "0" * 40), ("headRefName", "foreign"), ("number", 81), ("isCrossRepository", True), ("body", "foreign ownership")])
def test_continuation_refuses_changed_pr_without_remote_writes(retained, field, value):
    f = retained
    f["pr"][field] = value
    with pytest.raises(runtime.ControlError, match="PR continuation refused"):
        runtime.main(f["args"])
    assert remote_sha(f["repo"]) == f["base"]
    assert not (f["state"] / "publish-journal.json").exists()


def test_interrupted_observation_reuses_evidence_and_keeps_deadline(retained, monkeypatch):
    f = retained
    lease = (f["state"] / "run.lease.json").read_bytes()
    observe = pub.wait_for_review
    monkeypatch.setattr(pub, "wait_for_review", lambda *a, **kw: (_ for _ in ()).throw(pub.PublicationError("API observation interrupted")))
    with pytest.raises(runtime.ControlError, match="API observation interrupted"):
        runtime.main(f["args"])
    assert remote_sha(f["repo"]) == f["base"]
    assert (f["state"] / "run.lease.json").read_bytes() == lease
    assert "continuation" in runtime._load_gate(f["output"])
    monkeypatch.setattr(pub, "wait_for_review", observe)
    assert runtime.main(f["args"]) == 0
    assert remote_sha(f["repo"]) == f["candidate"]


@pytest.mark.parametrize("regenerated", [False, True])
@pytest.mark.parametrize("mutation", ["changed", "removed"])
@pytest.mark.parametrize("window", ["observation", "ship-lock"])
@pytest.mark.parametrize("owner", ["live-owner", "terminal-prior-owner"])
def test_scheduled_resume_request_identity_is_bound_across_recovery(
    scheduled_request, monkeypatch, regenerated, mutation, window, owner
):
    f, request = scheduled_request
    owner_root = f["fresh"]
    if owner == "live-owner":
        owner_root = f["old"]
        (f["fresh"] / "request.claimed.json").replace(
            owner_root / "request.claimed.json"
        )
        write_json(
            f["state"] / "run.lease.json",
            {
                "token": "test-token",
                "expires_unix": 4_000_000_000,
                "max_expires_unix": 4_000_000_000,
                "run_id": owner_root.name,
                "evidence_dir": str(owner_root),
                "captured_base": f["base"],
                "captured_upstream": f["base"],
                "run_context_sha256": runtime._file_sha256(
                    owner_root / "run-context.json"
                ),
            },
        )
        f["args"][f["args"].index("--token") + 1] = "test-token"
        f["args"][f["args"].index("--manifest") + 1] = str(f["source"])
    if regenerated:
        (f["old"] / "gate-logs/focused-contracts.log").write_text(
            "interrupted local evidence\n", encoding="utf-8"
        )
        monkeypatch.setattr(
            runtime,
            "_execute_recovery_gate",
            lambda _gate_id, _argv, output, _cwd: output.write_text(
                "1 passed in 0.01s\n", encoding="utf-8"
            ),
        )

    def mutate_request():
        paths = (
            owner_root / "request.claimed.json",
            f["state"] / "run-request.inflight.json",
        )
        if mutation == "removed":
            for path in paths:
                path.unlink()
        else:
            for path in paths:
                write_json(path, {**request, "pr": 81})

    if window == "observation":
        monkeypatch.setattr(
            pub,
            "candidate_checks",
            lambda *_args: mutate_request() or green_checks(),
        )
        monkeypatch.setattr(
            runtime,
            "ship_candidate",
            lambda *_args, **_kwargs: pytest.fail(
                "changed request reached the final ship boundary"
            ),
        )
    else:
        real_ship = runtime.ship_candidate

        def mutate_inside_ship(*args, **kwargs):
            mutate_request()
            return real_ship(*args, **kwargs)

        monkeypatch.setattr(runtime, "ship_candidate", mutate_inside_ship)

    with pytest.raises(runtime.ControlError, match="authorization|request"):
        runtime.main(f["args"])

    assert remote_sha(f["repo"]) == f["base"]
    assert not (owner_root / "request.consumed.json").exists()


@pytest.mark.parametrize(
    "fresh_fault",
    [
        "none",
        "local-changed",
        "local-missing",
        "copied-local-changed",
        "review-changed",
        "visual-missing",
        "source-changed",
        "cleanup-changed",
    ],
)
def test_terminal_recovery_retry_reuses_only_authenticated_fresh_evidence(
    retained, monkeypatch, fresh_fault
):
    f = retained
    (f["old"] / "gate-logs/focused-contracts.log").write_text(
        "interrupted local evidence\n", encoding="utf-8"
    )
    (f["old"] / "gate-logs/opentui-check.log").write_text(
        "interrupted second local evidence\n", encoding="utf-8"
    )
    original_bytes = retained_artifacts(f["old"])
    executions = []

    def execute(gate_id, _argv, output, _cwd):
        executions.append(gate_id)
        output.write_text("1 passed in 0.01s\n", encoding="utf-8")

    monkeypatch.setattr(runtime, "_execute_recovery_gate", execute)
    original_wait = pub.wait_for_review
    monkeypatch.setattr(
        pub,
        "wait_for_review",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            pub.PublicationError("observation interrupted")
        ),
    )
    with pytest.raises(runtime.ControlError, match="observation interrupted"):
        runtime.main(f["args"])

    first = runtime._load_gate(f["output"])
    first_attempt = Path(first["publication_recovery"]["attempt_dir"])
    targets = {
        "local-changed": first_attempt / "focused-contracts.log",
        "local-missing": first_attempt / "focused-contracts.log",
        "copied-local-changed": first_attempt / "opentui-install.log",
        "review-changed": first_attempt / "adversarial-review.log",
        "visual-missing": first_attempt / "termctrl-smoke.log",
        "source-changed": f["source"],
    }
    if fresh_fault == "cleanup-changed":
        first["cleanup_ownership"]["evidence_dir"] = str(f["fresh"])
        write_json(f["output"], first)
    elif fresh_fault.endswith("changed"):
        targets[fresh_fault].write_text("changed fresh evidence\n", encoding="utf-8")
    elif fresh_fault.endswith("missing"):
        targets[fresh_fault].unlink()

    monkeypatch.setattr(pub, "wait_for_review", original_wait)
    if fresh_fault.startswith(("review", "visual", "source", "cleanup")):
        with pytest.raises(
            runtime.ControlError,
            match="evidence|recovery|review|manifest|cleanup ownership",
        ):
            runtime.main(f["args"])
        assert executions == ["focused-contracts", "opentui-check"]
        assert len(list(first_attempt.parent.glob("attempt-*"))) == 1
        if fresh_fault == "source-changed":
            assert f["source"].read_text(encoding="utf-8") == "changed fresh evidence\n"
            f["source"].write_bytes(original_bytes[str(f["source"])])
    else:
        assert runtime.main(f["args"]) == 0
        expected = 2 if "local" in fresh_fault else 1
        assert executions == ["focused-contracts", "opentui-check"] + (
            ["focused-contracts"] if fresh_fault.startswith("local") else []
        )
        attempts = list(first_attempt.parent.glob("attempt-*"))
        assert len(attempts) == expected
        assert first_attempt in attempts
        assert "continuation" not in runtime._load_gate(f["output"])

    assert retained_artifacts(f["old"]) == original_bytes


def test_owned_task_fix_is_fast_forward_and_retry_stable(retained, monkeypatch):
    f = retained
    original = runtime._load_gate(f["source"])
    head = f["pr"]["headRefName"]
    git(f["repo"], "push", "origin", f"{f['candidate']}:refs/heads/{head}")
    (f["cwd"] / "file").write_text("reviewed follow-up\n", encoding="utf-8")
    git(f["cwd"], "commit", "-am", "fix task")
    fixed = git(f["cwd"], "rev-parse", "HEAD")
    updated = {**original, "candidate_sha": fixed, "lease_token_sha256": "9" * 64}
    assert pub._candidate_head(updated) == pub._candidate_head(original)
    real_run = pub._run
    writes = []
    def transport(argv, cwd):
        if argv[0] == "git":
            if argv[1] == "push":
                writes.append("push")
            result = runtime._git(cwd, argv[1:])
            if argv[1] == "push":
                f["pr"]["headRefOid"] = fixed
            return result
        if argv[:3] == [str(pub.GH), "pr", "list"]:
            return json.dumps([f["pr"]])
        if argv[:3] == [str(pub.GH), "pr", "ready"]:
            assert "--undo" in argv
            writes.append("draft")
            f["pr"]["isDraft"] = True
            return ""
        return real_run(argv, cwd)
    monkeypatch.setattr(pub, "_run", transport)
    pub.advance_owned_head(
        f["repo"],
        f["fresh"],
        str(f["remote"]),
        updated,
        f["candidate"],
        as_draft=True,
    )
    pub.advance_owned_head(
        f["repo"],
        f["fresh"],
        str(f["remote"]),
        updated,
        f["candidate"],
        as_draft=True,
    )
    assert writes == ["draft", "push"]
    assert f["pr"]["isDraft"] is True
    assert git(f["repo"], "ls-remote", "origin", f"refs/heads/{head}").split()[0] == fixed
    with pytest.raises(runtime.ControlError):
        runtime.main(f["args"])
    assert remote_sha(f["repo"]) == f["base"]


def test_stacked_issue_draft_is_adopted_after_exact_prerequisite_base_advance(
    capture, github, monkeypatch
):
    root, draft_manifest, _ = capture
    repo, _, base, prerequisite, worktree = make_repo(root.parent)
    (worktree / "file").write_text("issue 41\n", encoding="utf-8")
    git(worktree, "commit", "-am", "issue 41")
    candidate = git(worktree, "rev-parse", "HEAD")
    assert git(repo, "merge-base", "--is-ancestor", prerequisite, candidate) == ""

    draft_manifest.update(base_sha=base, candidate_sha=candidate)
    existing = {
        "number": 42,
        "url": f"https://github.com/{pub.REPOSITORY}/pull/42",
        "base_branch": pub.BASE,
        "head_branch": "feature/approved-41",
        "head_sha": candidate,
        "head_repository": pub.REPOSITORY,
    }
    bind_issue(capture, existing_prs=[existing])
    github.pr = {
        **review_pr(),
        "number": 42,
        "url": existing["url"],
        "body": "Contributor context.\n\nFixes #41",
        "headRefName": existing["head_branch"],
        "headRefOid": candidate,
        "baseRefOid": base,
        "isDraft": True,
    }
    transport = github.run

    def real_ancestry(argv, cwd):
        if argv[:2] == ["git", "merge-base"]:
            return runtime._git(repo, argv[1:])
        return transport(argv, cwd)

    monkeypatch.setattr(pub, "_run", real_ancestry)
    first = pub.publish_draft(
        repo, root, draft_manifest, pending_gates=["candidate verification"]
    )
    first_marker = pub._candidate_head(draft_manifest)[2]

    draft_manifest["base_sha"] = prerequisite
    draft_manifest["run_binding"]["captured_base"] = prerequisite
    github.pr["baseRefOid"] = prerequisite
    second = pub.publish_draft(
        repo, root, draft_manifest, pending_gates=["new-base candidate review"]
    )
    second_marker = pub._candidate_head(draft_manifest)[2]

    assert first["number"] == second["number"] == 42
    assert first["head_branch"] == second["head_branch"] == existing["head_branch"]
    assert github.pr["headRefOid"] == candidate
    assert first_marker != second_marker
    assert second_marker in github.pr["body"]
    assert not any(call[:2] == ["git", "push"] for call in github.calls)
    assert not any(
        len(call) > 2 and call[1:3] == ["pr", "create"] for call in github.calls
    )


@pytest.mark.parametrize("as_draft", [False, True])
@pytest.mark.parametrize("fault", ["foreign", "closed", "retargeted", "base", "remote", "revision", "rewind"])
def test_owned_task_update_refuses_lost_ownership(retained, monkeypatch, fault, as_draft):
    f = retained
    original = runtime._load_gate(f["source"])
    head = f["pr"]["headRefName"]
    git(f["repo"], "push", "origin", f"{f['candidate']}:refs/heads/{head}")
    updated = {**original, "candidate_sha": f["candidate"]}
    if fault == "foreign":
        f["pr"]["body"] = "human branch"
    elif fault == "closed":
        f["pr"]["state"] = "CLOSED"
    elif fault == "retargeted":
        f["pr"]["baseRefName"] = "main"
    elif fault == "base":
        f["pr"]["baseRefOid"] = "0" * 40
    elif fault == "remote":
        git(f["repo"], "push", "--force", "origin", f"{f['base']}:refs/heads/{head}")
    elif fault == "revision":
        updated["run_binding"] = {**updated["run_binding"], "request_sha256": "0" * 64}
    elif fault == "rewind":
        updated["candidate_sha"] = f["base"]
    def transport(argv, cwd):
        if argv[0] == "git":
            assert argv[1] != "push", "rejected task must not write the remote"
            return runtime._git(cwd, argv[1:])
        if argv[:2] == [str(pub.GH), "api"]:
            if "/check-runs?" in argv[-1]:
                return json.dumps([{"total_count": 0, "check_runs": []}])
            return json.dumps([[]])
        assert argv[:3] == [str(pub.GH), "pr", "list"]
        return json.dumps([f["pr"]])
    monkeypatch.setattr(pub, "_run", transport)
    with pytest.raises((pub.PublicationError, runtime.ControlError)):
        pub.advance_owned_head(f["repo"], f["fresh"], str(f["remote"]), updated, f["candidate"], as_draft=as_draft)


def test_scheduled_identity_survives_owner_and_fix_changes():
    original = {"base_sha": "1" * 40, "candidate_sha": "2" * 40,
                "lease_token_sha256": "3" * 64,
                "run_binding": {"mode": "scheduled", "captured_upstream": "4" * 40}}
    changed = {**original, "candidate_sha": "5" * 40, "lease_token_sha256": "6" * 64}
    assert pub._candidate_head(original) == pub._candidate_head(changed)


def test_task_revocation_during_observation_cannot_ship(retained, monkeypatch):
    f = retained
    def checks(*_):
        write_json(f["state"] / "run-request.inflight.json", {"mode": "backport", "commits": [f["base"]]})
        return green_checks()
    monkeypatch.setattr(pub, "candidate_checks", checks)
    with pytest.raises(runtime.ControlError, match="in-flight"):
        runtime.main(f["args"])
    assert remote_sha(f["repo"]) == f["base"]


@pytest.fixture
def scheduled_request(retained):
    f = retained
    value = runtime._load_gate(f["source"])
    value["run_binding"].update(mode="scheduled", request_sha256=None)
    value["review_proof"].update(review_mode="upstream-merge", upstream_sha=f["base"])
    review = f["old"] / "gate-logs/adversarial-review.log"
    write_json(review, value["review_proof"])
    for check in value["checks"]:
        if check["id"] == "adversarial-review":
            check["output_sha256"] = runtime._file_sha256(review)
    write_json(f["source"], value)
    f["args"][f["args"].index("--source-sha256") + 1] = runtime._file_sha256(f["source"])
    head, _, identity = pub._candidate_head(value)
    f["pr"]["headRefName"] = head
    f["pr"]["body"] = f"<!-- maintainer-candidate:v1:{identity} -->\n" + f["pr"]["body"].split("\n", 1)[1]
    proof_path = f["old"] / "pr-evidence.json"
    proof = runtime._load_gate(proof_path)
    proof["head_branch"] = head
    write_json(proof_path, proof)
    for path in (f["old"] / "request.claimed.json", f["fresh"] / "request.claimed.json", f["state"] / "run-request.inflight.json"):
        path.unlink()
    request = {"mode": "resume", "source_run": "old", "pr": 42, "base_sha": f["base"],
               "candidate_sha": f["candidate"], "manifest_sha256": runtime._file_sha256(f["source"]),
               "packet_sha256": value["packet_sha256"]}
    submitted = runtime.submit_request(f["state"], request)
    assert submitted["created"] is True
    assert runtime.submit_request(f["state"], request)["created"] is False
    assert runtime.claim_request(f["state"], f["fresh"]) == request
    return f, request


def test_queued_resume_uses_existing_claim_and_finalization(scheduled_request):
    f, request = scheduled_request
    with pytest.raises(runtime.ControlError, match="observation only"):
        runtime.gate_and_ship(f["repo"], f["old"] / "gate-packet.json", f["output"],
                              state_dir=f["state"], cwd=f["cwd"], base_sha=f["base"],
                              candidate_sha=f["candidate"], token="fresh-token")
    assert runtime.main(f["args"]) == 0
    assert runtime._load_gate(f["fresh"] / "request.consumed.json") == request
    assert not (f["state"] / "run-request.inflight.json").exists()
    assert remote_sha(f["repo"]) == f["candidate"]


@pytest.mark.parametrize("relative_flags", [("--state", "--source-manifest"), ("--manifest",)])
@pytest.mark.parametrize("fault", [None, "foreign-owner", "media", "foreign-output"])
def test_mixed_command_paths_preserve_continuation_fences(scheduled_request, monkeypatch, relative_flags, fault):
    f, request = scheduled_request
    monkeypatch.chdir(f["state"].parent)
    args = list(f["args"])
    for flag in relative_flags:
        index = args.index(flag) + 1
        args[index] = str(Path(args[index]).relative_to(Path.cwd()))
    if fault == "foreign-owner":
        lease = runtime._load_gate(f["state"] / "run.lease.json")
        lease["token"] = "foreign"
        write_json(f["state"] / "run.lease.json", lease)
    elif fault == "media":
        (f["old"] / "termctrl-verified/accepted.png").write_bytes(b"tampered")
    elif fault == "foreign-output":
        args[args.index("--manifest") + 1] = "state/runs/foreign/gate.json"
    before = retained_artifacts(f["old"])
    if fault is None:
        assert runtime.main(args) == 0
        assert remote_sha(f["repo"]) == f["candidate"]
        assert runtime._load_gate(f["fresh"] / "request.consumed.json") == request
    else:
        with pytest.raises(runtime.ControlError):
            runtime.main(args)
        assert remote_sha(f["repo"]) == f["base"]
        assert f["calls"] == []
        assert not (f["state"] / "publish-journal.json").exists()
        assert not f["output"].exists()
    assert retained_artifacts(f["old"]) == before


@pytest.mark.parametrize("when", ["before", "during"])
def test_queued_resume_pins_cannot_be_changed(scheduled_request, monkeypatch, when):
    f, request = scheduled_request
    def change():
        for path in (f["fresh"] / "request.claimed.json", f["state"] / "run-request.inflight.json"):
            write_json(path, {**request, "pr": 81})
        return green_checks()
    if when == "before":
        change()
    else:
        monkeypatch.setattr(pub, "candidate_checks", lambda *_: change())
    with pytest.raises(runtime.ControlError, match="resume request|authorization changed"):
        runtime.main(f["args"])
    assert remote_sha(f["repo"]) == f["base"]
