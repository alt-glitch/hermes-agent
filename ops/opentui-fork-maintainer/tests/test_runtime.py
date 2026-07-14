from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import subprocess
import sys
import threading
from collections.abc import Callable
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts" / "maintainer_runtime.py"
SPEC = importlib.util.spec_from_file_location("maintainer_runtime", SCRIPT)
assert SPEC and SPEC.loader
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


def make_repo(tmp_path: Path) -> tuple[Path, Path, str, str, Path]:
    remote = tmp_path / "remote.git"
    repo = tmp_path / "repo"
    git(tmp_path, "init", "--bare", str(remote))
    git(tmp_path, "init", str(repo))
    git(repo, "config", "user.email", "test@example.invalid")
    git(repo, "config", "user.name", "Test")
    (repo / "file").write_text("base\n")
    (repo / "ui-opentui").mkdir()
    (repo / "ui-opentui" / "package-lock.json").write_text("{}\n")
    git(repo, "add", "file", "ui-opentui/package-lock.json")
    git(repo, "commit", "-m", "base")
    base = git(repo, "rev-parse", "HEAD")
    git(repo, "branch", "sid/opentui")
    git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "origin", "sid/opentui")
    git(repo, "checkout", "-b", "integration")
    (repo / "file").write_text("candidate\n")
    git(repo, "commit", "-am", "candidate")
    candidate = git(repo, "rev-parse", "HEAD")
    gate_worktree = tmp_path / "gate-worktree"
    git(repo, "worktree", "add", "--detach", str(gate_worktree), candidate)
    return repo, remote, base, candidate, gate_worktree


def gate_argv(gate_id: str) -> list[str]:
    if gate_id == "focused-contracts":
        return ["uv", "run", "pytest", "tests/test_example.py"]
    if gate_id in runtime.CANONICAL_CODE_GATES:
        return runtime.CANONICAL_CODE_GATES[gate_id]
    return ["verify-artifact", gate_id, "artifact"]


def manifest(
    path: Path,
    gate_worktree: Path,
    base: str,
    candidate: str,
    *,
    failed: str | None = None,
) -> None:
    checks = []
    (path.parent / "gate-logs").mkdir(exist_ok=True)
    for gate_id in sorted(runtime.REQUIRED_GATES):
        did_fail = gate_id == failed
        output_path = path.parent / "gate-logs" / f"{gate_id}.log"
        output_path.write_text(gate_id)
        checks.append({
            "id": gate_id,
            "argv": gate_argv(gate_id),
            "exit_code": 1 if did_fail else 0,
            "status": "failed" if did_fail else "passed",
            "output_path": str(output_path),
            "output_sha256": hashlib.sha256(gate_id.encode()).hexdigest(),
        })
    path.write_text(
        json.dumps({
            "schema_version": runtime.GATE_SCHEMA_VERSION,
            "branch": "sid/opentui",
            "base_sha": base,
            "candidate_sha": candidate,
            "lease_token_sha256": hashlib.sha256(b"test-token").hexdigest(),
            "checks": checks,
            "worktree_proof": {
                "worktree": str(gate_worktree.resolve()),
                "before": {
                    "head_sha": candidate,
                    "tree_sha": git(gate_worktree, "rev-parse", "HEAD^{tree}"),
                    "status_porcelain": "",
                },
                "after": {
                    "head_sha": candidate,
                    "tree_sha": git(gate_worktree, "rev-parse", "HEAD^{tree}"),
                    "status_porcelain": "",
                },
            },
        }),
        encoding="utf-8",
    )


def remote_sha(repo: Path) -> str:
    return git(
        repo, "ls-remote", "--heads", "origin", "refs/heads/sid/opentui"
    ).split()[0]


def write_live_lease(
    state_dir: Path, *, token: str = "test-token", expires_unix: int = 4_000_000_000
) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "run.lease.json").write_text(
        json.dumps({"token": token, "expires_unix": expires_unix})
    )


def test_worker_and_gate_renewals_bypass_nonblocking_run_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    renewals: list[tuple[Path, str]] = []

    def forbidden_run_lock(_state: Path):
        pytest.fail("lease renewal must not use the nonblocking run lock")

    monkeypatch.setattr(runtime, "run_lock", forbidden_run_lock)
    monkeypatch.setattr(
        runtime,
        "renew_lease",
        lambda state, token: renewals.append((state, token)),
    )
    monkeypatch.setattr(runtime, "run_packet", lambda *args, **kwargs: 0)
    monkeypatch.setattr(runtime, "gate_and_ship", lambda *args, **kwargs: {})

    state = tmp_path / "state"
    assert (
        runtime.main([
            "run-packet",
            "--state",
            str(state),
            "--token",
            "token",
            "--packet",
            str(tmp_path / "packet.json"),
            "--cwd",
            str(tmp_path),
        ])
        == 0
    )
    assert (
        runtime.main([
            "gate-and-ship",
            "--state",
            str(state),
            "--token",
            "token",
            "--packet",
            str(tmp_path / "gate-packet.json"),
            "--manifest",
            str(tmp_path / "gate.json"),
            "--cwd",
            str(tmp_path),
            "--repo",
            str(tmp_path),
            "--base",
            "a" * 40,
            "--candidate",
            "b" * 40,
        ])
        == 0
    )
    assert (
        runtime.main([
            "renew-lease",
            "--state",
            str(state),
            "--token",
            "token",
        ])
        == 0
    )
    assert renewals == [(state, "token")] * 5


def test_run_packet_is_fixed_argv_and_lease_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    stdin = tmp_path / "task.txt"
    stdout = tmp_path / "stdout.log"
    stderr = tmp_path / "stderr.log"
    packet = tmp_path / "packet.json"
    state = tmp_path / "state"
    stdin.write_text("task\n")
    packet.write_text(
        json.dumps({
            "argv": ["worker", "--fixed"],
            "stdin": str(stdin),
            "stdout": str(stdout),
            "stderr": str(stderr),
        })
    )
    observed: dict[str, object] = {}

    class Process:
        pid = 4242

        def __init__(self, argv: list[str], **kwargs: object) -> None:
            observed.update({"argv": argv, **kwargs})

        def wait(self, timeout: int) -> int:
            observed["timeout"] = timeout
            raise subprocess.TimeoutExpired(observed["argv"], timeout)

    monkeypatch.setattr(runtime.subprocess, "Popen", Process)
    monkeypatch.setattr(
        runtime,
        "_terminate_process_group",
        lambda process: observed.update({"killed": process.pid}),
    )
    with pytest.raises(runtime.ControlError, match="four-hour"):
        runtime.run_packet(packet, cwd=tmp_path, state_dir=state, token="token")
    assert observed["argv"] == ["worker", "--fixed"]
    assert observed["shell"] is False
    assert observed["start_new_session"] is True
    assert observed["timeout"] == runtime.PACKET_TIMEOUT_SECONDS
    assert observed["killed"] == 4242
    assert not list(state.glob("worker-slot-*.json"))


def test_nonblocking_lock_denies_second_holder(tmp_path: Path) -> None:
    with runtime.run_lock(tmp_path):
        with pytest.raises(runtime.ControlError, match="holds"):
            with runtime.run_lock(tmp_path):
                pass


def test_request_claim_is_recoverable_and_one_shot(tmp_path: Path) -> None:
    state, evidence = tmp_path / "state", tmp_path / "evidence"
    state.mkdir()
    (state / "run-request.json").write_text(
        json.dumps({"mode": "backport", "commits": ["abcdef1"]})
    )
    assert runtime.claim_request(state, evidence)["commits"] == ["abcdef1"]
    assert not (state / "run-request.json").exists()
    assert runtime.claim_request(state, evidence)["commits"] == ["abcdef1"]
    runtime.recover_request(state)
    assert (state / "run-request.json").exists()
    runtime.claim_request(state, evidence)
    runtime.consume_request(state, evidence)
    assert not (state / "run-request.inflight.json").exists()
    assert (evidence / "request.consumed.json").exists()


def test_recovered_request_records_hashed_prior_gate_context(tmp_path: Path) -> None:
    state = tmp_path / "state"
    previous = state / "runs" / "run-old"
    current = state / "runs" / "run-new"
    previous.mkdir(parents=True)
    current.mkdir(parents=True)
    request = {"mode": "backport", "commits": ["abcdef1"]}
    (state / "run-request.json").write_text(json.dumps(request))
    (previous / "request.claimed.json").write_text(json.dumps(request))
    (previous / "handoff.md").write_text("fix the rejected race\n")
    (previous / "gate.json").write_text('{"failed": true}\n')
    review = previous / "review-verified" / "stdout.txt"
    review.parent.mkdir()
    review.write_text("BLOCKER: stale runner\nVERDICT: REJECTED\n")

    assert runtime.claim_request(state, current) == request
    context = json.loads((current / "retry-context.json").read_text())
    assert context["schema_version"] == 1
    assert context["previous_run"] == "run-old"
    assert [item["kind"] for item in context["artifacts"]] == [
        "handoff",
        "gate",
        "review",
    ]
    for item in context["artifacts"]:
        path = Path(item["path"])
        assert path.is_relative_to(previous)
        assert item["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()


def test_missing_invalid_and_failed_gates_never_move_remote(tmp_path: Path) -> None:
    repo, _, base, candidate, gate_worktree = make_repo(tmp_path)
    state = tmp_path / "state"
    write_live_lease(state)
    gate = tmp_path / "gate.json"
    for setup in ("missing", "invalid", "failed"):
        if setup == "invalid":
            gate.write_text("{}")
        elif setup == "failed":
            manifest(gate, gate_worktree, base, candidate, failed="opentui-check")
        else:
            gate.unlink(missing_ok=True)
        with pytest.raises(runtime.ControlError):
            runtime.ship_candidate(
                repo,
                gate,
                state_dir=state,
                base_sha=base,
                candidate_sha=candidate,
                token="test-token",
            )
        assert remote_sha(repo) == base


def test_stale_base_denied_and_safe_fast_forward_succeeds(tmp_path: Path) -> None:
    repo, _, base, candidate, gate_worktree = make_repo(tmp_path)
    state = tmp_path / "state"
    write_live_lease(state)
    gate = tmp_path / "gate.json"
    manifest(gate, gate_worktree, base, candidate)
    stale = "0" * 40
    with pytest.raises(runtime.ControlError):
        runtime.ship_candidate(
            repo,
            gate,
            state_dir=state,
            base_sha=stale,
            candidate_sha=candidate,
            token="test-token",
        )
    assert remote_sha(repo) == base
    runtime.ship_candidate(
        repo,
        gate,
        state_dir=state,
        base_sha=base,
        candidate_sha=candidate,
        token="test-token",
    )
    assert remote_sha(repo) == candidate
    # Publishing does not move or dirty the local daily-driver ref/checkout.
    assert git(repo, "rev-parse", "refs/heads/sid/opentui") == base


def test_replaced_or_expired_lease_never_publishes(tmp_path: Path) -> None:
    repo, _, base, candidate, gate_worktree = make_repo(tmp_path)
    state = tmp_path / "state"
    gate = tmp_path / "gate.json"
    manifest(gate, gate_worktree, base, candidate)

    for token, expires_unix in (("replacement", 4_000_000_000), ("test-token", 1)):
        write_live_lease(state, token=token, expires_unix=expires_unix)
        with pytest.raises(runtime.ControlError, match="invalid or expired"):
            runtime.ship_candidate(
                repo,
                gate,
                state_dir=state,
                base_sha=base,
                candidate_sha=candidate,
                token="test-token",
            )
        assert remote_sha(repo) == base


def test_lease_takeover_cannot_interleave_with_publish(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, _, base, candidate, gate_worktree = make_repo(tmp_path)
    state = tmp_path / "state"
    write_live_lease(state)
    gate = tmp_path / "gate.json"
    manifest(gate, gate_worktree, base, candidate)
    real_run = subprocess.run
    takeover_attempted = threading.Event()
    takeover_acquired = threading.Event()
    takeover_thread: list[threading.Thread] = []

    def replace_lease() -> None:
        takeover_attempted.set()
        with runtime._lease_lock(state):
            takeover_acquired.set()
            write_live_lease(state, token="replacement")

    def run_with_takeover(argv: list[str], *args: object, **kwargs: object):
        if "push" in argv:
            thread = threading.Thread(target=replace_lease)
            takeover_thread.append(thread)
            thread.start()
            assert takeover_attempted.wait(timeout=1)
            assert not takeover_acquired.wait(timeout=0.1)
        return real_run(argv, *args, **kwargs)

    monkeypatch.setattr(runtime.subprocess, "run", run_with_takeover)
    runtime.ship_candidate(
        repo,
        gate,
        state_dir=state,
        base_sha=base,
        candidate_sha=candidate,
        token="test-token",
    )
    takeover_thread[0].join(timeout=1)
    assert takeover_acquired.is_set()
    assert json.loads((state / "run.lease.json").read_text())["token"] == "replacement"
    assert remote_sha(repo) == candidate


def test_dirty_checked_out_daily_driver_is_not_mutated(tmp_path: Path) -> None:
    repo, _, base, candidate, gate_worktree = make_repo(tmp_path)
    state = tmp_path / "state"
    write_live_lease(state)
    git(repo, "checkout", "sid/opentui")
    (repo / "file").write_text("user work\n")
    gate = tmp_path / "gate.json"
    manifest(gate, gate_worktree, base, candidate)
    runtime.ship_candidate(
        repo,
        gate,
        state_dir=state,
        base_sha=base,
        candidate_sha=candidate,
        token="test-token",
    )
    assert (repo / "file").read_text() == "user work\n"
    assert git(repo, "rev-parse", "refs/heads/sid/opentui") == base
    assert remote_sha(repo) == candidate


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_gate_packet(
    evidence: Path, gate_worktree: Path, base: str, candidate: str
) -> tuple[Path, list[dict[str, object]]]:
    evidence.mkdir(exist_ok=True)
    drive = {
        "cols": 132,
        "rows": 40,
        "actions": [
            {
                "send": ["text:/help", "enter"],
                "wait": "Available Commands",
                "timeout_ms": 5000,
            }
        ],
        "required_text": ["Hermes Agent", "Available Commands"],
    }
    checks: list[dict[str, object]] = [
        {"id": "opentui-install", "argv": gate_argv("opentui-install")},
        {"id": "focused-contracts", "argv": gate_argv("focused-contracts")},
        {"id": "opentui-check", "argv": gate_argv("opentui-check")},
        {"id": "opentui-build", "argv": gate_argv("opentui-build")},
        {
            "id": "adversarial-review",
            "reviewer": {"tool": "claude", "model": "fable-5"},
        },
        {"id": "termctrl-smoke", "drive": drive},
        {
            "id": "video-analysis",
            "request": {"provider": "openrouter", "model": runtime.VIDEO_MODEL},
        },
    ]
    packet = evidence / "packet.json"
    packet.write_text(json.dumps({"checks": checks}))
    return packet, checks


def install_success_mocks(
    monkeypatch: pytest.MonkeyPatch,
    *,
    markers: tuple[str, ...] = ("ready", "accepted"),
    mutate: Callable[[], None] | None = None,
    focused_output: bytes = b"1 passed in 0.01s\n",
    marker_step_ms: int = 1_500,
    stable_after_send: bool = True,
) -> None:
    real_run = subprocess.run
    mutated = False
    sent = False

    def fake_run(argv: list[str], *args: object, **kwargs: object):
        nonlocal mutated
        if argv and (argv[0] == "uv" or argv[0] == str(runtime.NPM26)):
            if mutate is not None and not mutated:
                mutate()
                mutated = True
            output = kwargs.get("stdout")
            if hasattr(output, "write"):
                output.write(focused_output if argv[0] == "uv" else b"completed\n")
            return subprocess.CompletedProcess(argv, 0)
        return real_run(argv, *args, **kwargs)

    def fake_termctrl(
        argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess[bytes]:
        nonlocal sent
        if argv[0] == "start":
            Path(argv[argv.index("--record") + 1]).write_bytes(b"recording")
        if argv[0] == "send":
            sent = True
        if argv[0] == "markers":
            payload = [
                {"name": name, "at_ms": index * marker_step_ms}
                for index, name in enumerate(markers)
            ]
            return subprocess.CompletedProcess(
                argv, 0, json.dumps(payload).encode(), b""
            )
        if argv[0] == "show":
            visible = b"Hermes Agent - ready\n"
            if sent and stable_after_send:
                visible += b"Available Commands\n"
            return subprocess.CompletedProcess(argv, 0, visible, b"")
        if "--out" in argv:
            Path(argv[argv.index("--out") + 1]).write_bytes(argv[0].encode())
        return subprocess.CompletedProcess(argv, 0, b"", b"")

    def fake_reviewer(
        argv: list[str], prompt: bytes, cwd: Path
    ) -> subprocess.CompletedProcess[bytes]:
        assert b"DIFF_SHA256:" in prompt
        assert b"BEGIN EXACT DIFF" in prompt
        return subprocess.CompletedProcess(
            argv, 0, b"No blockers.\nVERDICT: APPROVED\n", b""
        )

    monkeypatch.setattr(runtime.subprocess, "run", fake_run)
    monkeypatch.setattr(runtime.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(runtime, "_run_termctrl", fake_termctrl)
    monkeypatch.setattr(runtime, "_run_reviewer", fake_reviewer)
    monkeypatch.setattr(
        runtime,
        "_invoke_video_analyze",
        lambda _path: json.dumps({
            "success": True,
            "analysis": "The flow is complete.\nVERDICT: PASS",
        }),
    )


def run_success_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[Path, Path, str, str, Path, Path, list[dict[str, object]]]:
    repo, _, base, candidate, gate_worktree = make_repo(tmp_path)
    evidence = tmp_path / "evidence"
    packet, checks = make_gate_packet(evidence, gate_worktree, base, candidate)
    install_success_mocks(monkeypatch)
    gate = evidence / "gate.json"
    runtime.run_gate(
        packet,
        gate,
        cwd=gate_worktree,
        branch="sid/opentui",
        base_sha=base,
        candidate_sha=candidate,
        token="test-token",
    )
    return repo, gate_worktree, base, candidate, packet, gate, checks


def test_run_gate_records_candidate_bound_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, gate_worktree, base, candidate, _, gate, _ = run_success_gate(
        tmp_path, monkeypatch
    )
    value = runtime.validate_gate_manifest(
        repo, gate, base_sha=base, candidate_sha=candidate, token="test-token"
    )
    assert value["worktree_proof"]["before"]["tree_sha"] == git(
        gate_worktree, "rev-parse", "HEAD^{tree}"
    )
    assert (gate.parent / "termctrl-verified" / "accepted.png").is_file()
    assert (gate.parent / "video-analysis.raw.json").is_file()


def test_termctrl_uses_dependency_complete_fork_python_and_exact_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    candidate = tmp_path / "candidate"
    candidate.mkdir()
    evidence = tmp_path / "evidence"
    evidence.mkdir()
    python = tmp_path / "fork-venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("")
    calls: list[tuple[list[str], dict[str, str]]] = []
    sent = False

    def fake_termctrl(
        argv: list[str], **kwargs: object
    ) -> subprocess.CompletedProcess[bytes]:
        nonlocal sent
        env = kwargs.get("env")
        assert isinstance(env, dict)
        calls.append((argv, env))
        if argv[0] == "start":
            Path(argv[argv.index("--record") + 1]).write_bytes(b"recording")
        if argv[0] == "send":
            sent = True
        if argv[0] == "markers":
            return subprocess.CompletedProcess(
                argv,
                0,
                json.dumps([
                    {"name": "ready", "at_ms": 1},
                    {"name": "accepted", "at_ms": 1_501},
                ]).encode(),
                b"",
            )
        if argv[0] == "show":
            visible = b"Hermes Agent\n"
            if sent:
                visible += b"Available Commands\n"
            return subprocess.CompletedProcess(argv, 0, visible, b"")
        if "--out" in argv:
            Path(argv[argv.index("--out") + 1]).write_bytes(argv[0].encode())
        return subprocess.CompletedProcess(argv, 0, b"", b"")

    monkeypatch.setattr(runtime, "FORK_VENV_PYTHON", python)
    monkeypatch.setattr(runtime, "_run_termctrl", fake_termctrl)
    monkeypatch.setattr(runtime.time, "sleep", lambda _seconds: None)
    runtime.verify_termctrl_drive(
        {
            "cols": 132,
            "rows": 40,
            "actions": [
                {
                    "send": ["text:/help", "enter"],
                    "wait": "Available Commands",
                    "timeout_ms": 5_000,
                }
            ],
            "required_text": ["Hermes Agent", "Available Commands"],
        },
        evidence,
        candidate,
    )

    launch, env = calls[0]
    command = launch[launch.index("--") + 1 :]
    assert command == [str(python), "-m", "hermes_cli.main", "--tui", "--yolo"]
    assert env["PYTHONPATH"] == str(candidate)
    assert env["HERMES_PYTHON"] == str(python)
    assert env["HERMES_PYTHON_SRC_ROOT"] == str(candidate)
    assert env["HERMES_CWD"] == str(candidate)
    video_call = next(argv for argv, _env in calls if argv[0] == "video")
    edit_path = Path(video_call[video_call.index("--edit") + 1])
    assert json.loads(edit_path.read_text(encoding="utf-8")) == {
        "clips": [{"from": "ready", "to": "accepted"}]
    }
    assert "PYTHONHOME" not in env
    video_call = next(argv for argv, _env in calls if argv[0] == "video")
    assert video_call[video_call.index("--tail-ms") + 1] == str(runtime.VIDEO_TAIL_MS)


def test_run_gate_denies_wrong_or_dirty_worktree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, base, candidate, gate_worktree = make_repo(tmp_path)
    evidence = tmp_path / "evidence"
    packet, _ = make_gate_packet(evidence, gate_worktree, base, candidate)
    install_success_mocks(monkeypatch)
    with pytest.raises(runtime.ControlError, match="HEAD is not the candidate"):
        runtime.run_gate(
            packet,
            evidence / "wrong.json",
            cwd=gate_worktree,
            branch="sid/opentui",
            base_sha=base,
            candidate_sha=base,
            token="test-token",
        )
    dirty = gate_worktree / "untracked"
    dirty.write_text("dirty")
    with pytest.raises(runtime.ControlError, match="dirty"):
        runtime.run_gate(
            packet,
            evidence / "dirty.json",
            cwd=gate_worktree,
            branch="sid/opentui",
            base_sha=base,
            candidate_sha=candidate,
            token="test-token",
        )


def test_run_gate_denies_true_code_and_unstructured_review(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, base, candidate, gate_worktree = make_repo(tmp_path)
    evidence = tmp_path / "evidence"
    packet, checks = make_gate_packet(evidence, gate_worktree, base, candidate)
    next(item for item in checks if item["id"] == "focused-contracts")["argv"] = [
        "/usr/bin/true"
    ]
    packet.write_text(json.dumps({"checks": checks}))
    install_success_mocks(monkeypatch)
    with pytest.raises(runtime.ControlError, match="targeted pytest or vitest"):
        runtime.run_gate(
            packet,
            evidence / "true.json",
            cwd=gate_worktree,
            branch="sid/opentui",
            base_sha=base,
            candidate_sha=candidate,
            token="test-token",
        )
    next(item for item in checks if item["id"] == "focused-contracts")["argv"] = (
        gate_argv("focused-contracts")
    )
    review = next(item for item in checks if item["id"] == "adversarial-review")
    review["reviewer"] = {"tool": "claude", "model": "untrusted"}
    packet.write_text(json.dumps({"checks": checks}))
    result = runtime.run_gate(
        packet,
        evidence / "review-bad.json",
        cwd=gate_worktree,
        branch="sid/opentui",
        base_sha=base,
        candidate_sha=candidate,
        token="test-token",
    )
    assert (
        next(item for item in result["checks"] if item["id"] == "adversarial-review")[
            "status"
        ]
        == "failed"
    )


def test_run_gate_rejects_transient_wait_text_that_is_not_still_visible(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, base, candidate, gate_worktree = make_repo(tmp_path)
    evidence = tmp_path / "evidence"
    packet, _ = make_gate_packet(evidence, gate_worktree, base, candidate)
    install_success_mocks(monkeypatch, stable_after_send=False)
    result = runtime.run_gate(
        packet,
        evidence / "gate.json",
        cwd=gate_worktree,
        branch="sid/opentui",
        base_sha=base,
        candidate_sha=candidate,
        token="test-token",
    )
    termctrl = next(item for item in result["checks"] if item["id"] == "termctrl-smoke")
    assert termctrl["status"] == "failed"
    assert "not visible after action" in Path(termctrl["output_path"]).read_text(
        encoding="utf-8"
    )


def test_run_gate_rejects_timeline_too_short_for_visible_interaction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, base, candidate, gate_worktree = make_repo(tmp_path)
    evidence = tmp_path / "evidence"
    packet, _ = make_gate_packet(evidence, gate_worktree, base, candidate)
    install_success_mocks(monkeypatch, marker_step_ms=999)
    result = runtime.run_gate(
        packet,
        evidence / "gate.json",
        cwd=gate_worktree,
        branch="sid/opentui",
        base_sha=base,
        candidate_sha=candidate,
        token="test-token",
    )
    termctrl = next(item for item in result["checks"] if item["id"] == "termctrl-smoke")
    assert termctrl["status"] == "failed"
    assert "too short" in Path(termctrl["output_path"]).read_text(encoding="utf-8")


def test_run_gate_denies_fabricated_markers_and_symlink_outputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, _, base, candidate, gate_worktree = make_repo(tmp_path)
    evidence = tmp_path / "evidence"
    packet, _ = make_gate_packet(evidence, gate_worktree, base, candidate)
    install_success_mocks(monkeypatch, markers=("ready",))
    gate = evidence / "markers.json"
    result = runtime.run_gate(
        packet,
        gate,
        cwd=gate_worktree,
        branch="sid/opentui",
        base_sha=base,
        candidate_sha=candidate,
        token="test-token",
    )
    assert (
        next(item for item in result["checks"] if item["id"] == "termctrl-smoke")[
            "status"
        ]
        == "failed"
    )
    with pytest.raises(runtime.ControlError, match="did not pass"):
        runtime.validate_gate_manifest(
            repo, gate, base_sha=base, candidate_sha=candidate, token="test-token"
        )

    evidence2 = tmp_path / "evidence2"
    packet2, _ = make_gate_packet(evidence2, gate_worktree, base, candidate)
    outside = tmp_path / "outside"
    outside.mkdir()
    (evidence2 / "termctrl-verified").symlink_to(outside, target_is_directory=True)
    result = runtime.run_gate(
        packet2,
        evidence2 / "symlink.json",
        cwd=gate_worktree,
        branch="sid/opentui",
        base_sha=base,
        candidate_sha=candidate,
        token="test-token",
    )
    assert (
        next(item for item in result["checks"] if item["id"] == "termctrl-smoke")[
            "status"
        ]
        == "failed"
    )
    assert not list(outside.iterdir())


def test_run_gate_denies_head_change_during_gates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, base, candidate, gate_worktree = make_repo(tmp_path)
    evidence = tmp_path / "evidence"
    packet, _ = make_gate_packet(evidence, gate_worktree, base, candidate)
    install_success_mocks(
        monkeypatch, mutate=lambda: git(gate_worktree, "checkout", "--detach", base)
    )
    with pytest.raises(runtime.ControlError, match="HEAD is not the candidate"):
        runtime.run_gate(
            packet,
            evidence / "head-change.json",
            cwd=gate_worktree,
            branch="sid/opentui",
            base_sha=base,
            candidate_sha=candidate,
            token="test-token",
        )


def test_focused_contract_commands_reject_nonexecuting_modes_and_empty_proof() -> None:
    for flag in (
        "--collect-only",
        "--co",
        "--list",
        "--help",
        "--version",
        "--dry-run",
    ):
        assert not runtime._is_focused_contract_command([
            "uv",
            "run",
            "pytest",
            "tests/test_x.py",
            flag,
        ])
    assert not runtime._is_focused_contract_command([
        "uv",
        "run",
        "pytest",
        "-k",
        "name",
    ])
    assert runtime._is_focused_contract_command([
        "uv",
        "run",
        "pytest",
        "tests/test_x.py",
    ])
    assert not runtime._focused_output_proves_execution(
        ["uv", "run", "pytest", "tests/test_x.py"], "collected 4 items\n"
    )
    assert runtime._focused_output_proves_execution(
        ["uv", "run", "pytest", "tests/test_x.py"], "1 passed in 0.01s\n"
    )


def test_worker_slots_cap_two_and_recover_stale_pid(tmp_path: Path) -> None:
    state = tmp_path / "state"
    state.mkdir()
    stale = state / "worker-slot-0.json"
    stale.write_text(json.dumps({"token": "old", "pid": 99999999, "start_unix": 1}))
    with runtime._worker_slot(state, "one"):
        with runtime._worker_slot(state, "two"):
            with pytest.raises(runtime.ControlError, match="two worker"):
                with runtime._worker_slot(state, "three"):
                    pass
    assert not list(state.glob("worker-slot-*.json"))


def test_timeout_cleanup_escalates_process_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    signals: list[int] = []

    class Process:
        pid = 1234
        waits = 0

        def wait(self, timeout: int) -> int:
            self.waits += 1
            if self.waits == 1:
                raise subprocess.TimeoutExpired("worker", timeout)
            return 0

    monkeypatch.setattr(runtime.os, "killpg", lambda pid, sig: signals.append(sig))
    runtime._terminate_process_group(Process())
    assert signals == [runtime.signal.SIGTERM, runtime.signal.SIGKILL]


def test_worktree_proof_rejects_assume_unchanged(tmp_path: Path) -> None:
    _, _, _, candidate, gate_worktree = make_repo(tmp_path)
    git(gate_worktree, "update-index", "--assume-unchanged", "file")
    with pytest.raises(runtime.ControlError, match="assume-unchanged"):
        runtime._worktree_proof(gate_worktree, candidate)


def test_codex_reviewer_uses_the_vm_compatible_local_worker_mode() -> None:
    command = runtime.REVIEWER_COMMANDS[("codex", "gpt-5.6-sol")]
    assert "--dangerously-bypass-approvals-and-sandbox" in command
    assert "--skip-git-repo-check" in command
    assert "-s" not in command
    assert "read-only" not in command


def test_reviewer_commands_use_host_verified_claude_model_ids() -> None:
    fable = runtime.REVIEWER_COMMANDS[("claude", "fable-5")]
    opus = runtime.REVIEWER_COMMANDS[("claude", "opus-4.8")]
    assert fable[fable.index("--model") + 1] == "claude-fable-5"
    assert opus[opus.index("--model") + 1] == "opus"
    for command in (fable, opus):
        assert "--safe-mode" in command
        assert command[command.index("--tools") + 1] == ""
        assert "--no-session-persistence" in command
        assert "--permission-mode" not in command


def test_review_runtime_rejects_blocker_even_with_approved_tail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, base, candidate, gate_worktree = make_repo(tmp_path)
    evidence = tmp_path / "evidence"
    evidence.mkdir()
    monkeypatch.setattr(
        runtime,
        "_run_reviewer",
        lambda argv, prompt, cwd: subprocess.CompletedProcess(
            argv, 0, b"Inline BLOCKER: race remains\nVERDICT: APPROVED\n", b""
        ),
    )
    with pytest.raises(runtime.ControlError, match="did not approve"):
        runtime.run_adversarial_review(
            {"tool": "claude", "model": "fable-5"},
            evidence,
            gate_worktree,
            base,
            candidate,
        )


def test_atomic_gate_and_ship_is_only_publish_cli(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, _, base, candidate, gate_worktree = make_repo(tmp_path)
    state = tmp_path / "state"
    write_live_lease(state)
    evidence = tmp_path / "evidence"
    packet, _ = make_gate_packet(evidence, gate_worktree, base, candidate)
    install_success_mocks(monkeypatch)
    runtime.gate_and_ship(
        repo,
        packet,
        evidence / "gate.json",
        state_dir=state,
        cwd=gate_worktree,
        base_sha=base,
        candidate_sha=candidate,
        token="test-token",
    )
    assert remote_sha(repo) == candidate
    for removed in ("ship", "run-gate"):
        with pytest.raises(SystemExit):
            runtime._parser().parse_args([removed])


def test_failed_atomic_gate_never_moves_remote(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, _, base, candidate, gate_worktree = make_repo(tmp_path)
    state = tmp_path / "state"
    write_live_lease(state)
    evidence = tmp_path / "evidence"
    packet, _ = make_gate_packet(evidence, gate_worktree, base, candidate)
    install_success_mocks(monkeypatch)
    monkeypatch.setattr(
        runtime,
        "_run_reviewer",
        lambda argv, prompt, cwd: subprocess.CompletedProcess(
            argv, 0, b"BLOCKER: defect\nVERDICT: REJECTED\n", b""
        ),
    )
    with pytest.raises(runtime.ControlError, match="gates failed"):
        runtime.gate_and_ship(
            repo,
            packet,
            evidence / "gate.json",
            state_dir=state,
            cwd=gate_worktree,
            base_sha=base,
            candidate_sha=candidate,
            token="test-token",
        )
    assert remote_sha(repo) == base


def test_video_raw_output_rejects_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, base, candidate, gate_worktree = make_repo(tmp_path)
    evidence = tmp_path / "evidence"
    packet, _ = make_gate_packet(evidence, gate_worktree, base, candidate)
    install_success_mocks(monkeypatch)
    outside = tmp_path / "outside-video.json"
    outside.write_text("keep")
    (evidence / "video-analysis.raw.json").symlink_to(outside)
    result = runtime.run_gate(
        packet,
        evidence / "gate.json",
        cwd=gate_worktree,
        branch="sid/opentui",
        base_sha=base,
        candidate_sha=candidate,
        token="test-token",
    )
    assert (
        next(item for item in result["checks"] if item["id"] == "video-analysis")[
            "status"
        ]
        == "failed"
    )
    assert outside.read_text() == "keep"


def test_openrouter_endpoint_normalization_is_exact() -> None:
    assert runtime._canonical_openrouter("https://openrouter.ai/api/v1/")
    assert not runtime._canonical_openrouter(
        "https://proxy.invalid/openrouter.ai/api/v1"
    )
    assert not runtime._canonical_openrouter("http://openrouter.ai/api/v1")


def test_video_analysis_uses_fixed_trusted_runtime_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    python = tmp_path / "fork-venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("")
    trusted = tmp_path / "trusted-fork"
    trusted.mkdir()
    video = tmp_path / "acceptance.mp4"
    video.write_bytes(b"video")
    expected = json.dumps({
        "success": True,
        "analysis": "Complete.\nVERDICT: PASS",
    })
    framed = runtime.VIDEO_RESULT_PREFIX + base64.b64encode(expected.encode()) + b"\n"
    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_run(argv: list[str], **kwargs: object):
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 0, framed, b"diagnostic")

    monkeypatch.setattr(runtime, "FORK_SOURCE_ROOT", trusted)
    monkeypatch.setattr(runtime, "FORK_VENV_PYTHON", python)
    monkeypatch.setattr(runtime.subprocess, "run", fake_run)

    assert runtime._invoke_video_analyze(video) == expected
    [(argv, kwargs)] = calls
    assert argv[:3] == [str(python), "-I", "-c"]
    assert Path(argv[-3]) == Path(runtime.__file__).resolve()
    assert argv[-2:] == [str(trusted), str(video)]
    assert kwargs["cwd"] == trusted
    assert kwargs["shell"] is False
    assert kwargs["capture_output"] is True
    assert kwargs["timeout"] == runtime.VIDEO_ANALYSIS_TIMEOUT_SECONDS
    env = kwargs["env"]
    assert isinstance(env, dict)
    assert env["PYTHONPATH"] == str(trusted)
    assert env["HERMES_PYTHON_SRC_ROOT"] == str(trusted)
    assert env["HERMES_PYTHON"] == str(python)
    assert env["HERMES_CWD"] == str(trusted)
    assert env["TERMINAL_CWD"] == str(trusted)
    assert "PYTHONHOME" not in env


def _write_fake_video_runtime(root: Path, label: str) -> None:
    (root / "agent").mkdir(parents=True)
    (root / "tools").mkdir()
    (root / "agent" / "__init__.py").write_text("", encoding="utf-8")
    (root / "tools" / "__init__.py").write_text("", encoding="utf-8")
    (root / "agent" / "auxiliary_client.py").write_text(
        "from types import SimpleNamespace\n\n"
        "def _resolve_task_provider_model(task, model=None):\n"
        "    return ('openrouter', model, 'https://openrouter.ai/api/v1', 'test-key', None)\n\n"
        "def resolve_vision_provider_client(provider, model, base_url, api_key, async_mode):\n"
        "    return (provider, SimpleNamespace(base_url=base_url), model)\n",
        encoding="utf-8",
    )
    (root / "tools" / "vision_tools.py").write_text(
        "import json\n\n"
        "async def video_analyze_tool(video_path, prompt, model):\n"
        f"    return json.dumps({{'success': True, 'analysis': '{label}\\nVERDICT: PASS'}})\n",
        encoding="utf-8",
    )


def test_video_analysis_real_isolated_process_ignores_malicious_candidate_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    trusted = tmp_path / "trusted"
    malicious = tmp_path / "malicious"
    _write_fake_video_runtime(trusted, "trusted")
    _write_fake_video_runtime(malicious, "malicious")
    video = tmp_path / "acceptance.mp4"
    video.write_bytes(b"video")
    monkeypatch.setattr(runtime, "FORK_SOURCE_ROOT", trusted)
    monkeypatch.setattr(runtime, "FORK_VENV_PYTHON", Path(sys.executable))
    monkeypatch.setenv("PYTHONPATH", str(malicious))
    monkeypatch.chdir(malicious)

    result = json.loads(runtime._invoke_video_analyze(video))

    assert result["analysis"] == "trusted\nVERDICT: PASS"


def test_video_analysis_rejects_missing_result_frame(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    python = tmp_path / "fork-venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text("")
    video = tmp_path / "acceptance.mp4"
    video.write_bytes(b"video")
    monkeypatch.setattr(runtime, "FORK_VENV_PYTHON", python)
    monkeypatch.setattr(
        runtime.subprocess,
        "run",
        lambda argv, **kwargs: subprocess.CompletedProcess(argv, 0, b"noise\n", b""),
    )

    with pytest.raises(runtime.ControlError, match="no unique result frame"):
        runtime._invoke_video_analyze(video)
