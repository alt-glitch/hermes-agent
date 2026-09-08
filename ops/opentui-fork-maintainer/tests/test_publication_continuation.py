"""Continuation contracts: real temporary Git/state, simulated GitHub only.

Gate artifacts below are explicit test fixtures, not claimed product QA.
"""
from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

import pytest

from test_pr_publication import green_checks, pub
from test_runtime import git, make_gate_packet, make_repo, manifest, remote_sha, runtime


def write_json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


@pytest.fixture
def retained(tmp_path, monkeypatch):
    repo, remote, base, candidate, cwd = make_repo(tmp_path)
    state = tmp_path / "state"
    old, fresh = state / "runs/old", state / "runs/fresh"
    old.mkdir(parents=True)
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
    before = {str(p): p.read_bytes() for p in f["old"].rglob("*") if p.is_file()}
    assert runtime.main(f["args"]) == 0
    assert remote_sha(f["repo"]) == f["candidate"]
    assert runtime._load_gate(f["fresh"] / "run-outcome.json")["published"] is True
    assert runtime._load_gate(f["state"] / "publish-journal.json")["phase"] == "finalized"
    assert not f["cwd"].exists()
    assert not (f["state"] / "run.lease.json").exists()
    assert {str(p): p.read_bytes() for p in f["old"].rglob("*") if p.is_file()} == before
    with pytest.raises(runtime.ControlError, match="lease"):
        runtime.main(f["args"])
    assert sum(call[:3] == [str(pub.GH), "pr", "view"] for call in f["calls"]) == 1
    assert all(call[1] in {"pr", "api"} for call in f["calls"])


@pytest.mark.parametrize("fault", ["foreign-owner", "live-lock", "candidate", "base", "packet", "gate-log", "missing-log", "media", "context", "authorization", "already-delivered"])
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
    elif fault in {"base", "already-delivered"}:
        git(f["repo"], "push", "origin", f"{f['candidate']}:refs/heads/sid/opentui")
    elif fault == "packet":
        (f["old"] / "gate-packet.json").write_text("{}", encoding="utf-8")
    elif fault in {"gate-log", "missing-log"}:
        log = f["old"] / "gate-logs/opentui-check.log"
        if fault == "missing-log":
            log.unlink()
        else:
            log.write_text("tampered", encoding="utf-8")
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
    before = {str(p): p.read_bytes() for p in f["old"].rglob("*") if p.is_file()}
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
    assert {str(p): p.read_bytes() for p in f["old"].rglob("*") if p.is_file()} == before


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
