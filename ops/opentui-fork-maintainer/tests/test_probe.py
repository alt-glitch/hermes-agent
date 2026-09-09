from __future__ import annotations

import importlib.util
import io
import json
import subprocess
from contextlib import redirect_stdout
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "scripts" / "sync_probe.py"
SPEC = importlib.util.spec_from_file_location("sync_probe", SCRIPT)
assert SPEC and SPEC.loader
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


def git(repo: Path, *args: str, check: bool = True) -> CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=check,
        capture_output=True,
        text=True,
    )


def commit_file(repo: Path, name: str) -> str:
    path = repo / name
    path.write_text(f"{name}\n")
    git(repo, "add", name)
    git(repo, "commit", "-m", name)
    return git(repo, "rev-parse", "HEAD").stdout.strip()


def remote_fixture(tmp_path: Path) -> tuple[Path, Path, Path, Path]:
    source = tmp_path / "source"
    upstream = tmp_path / "upstream.git"
    origin = tmp_path / "origin.git"
    fork = tmp_path / "fork"
    for repo in (source, upstream, origin, fork):
        repo.mkdir()

    git(source, "init", "--initial-branch=main")
    git(source, "config", "user.name", "Probe Test")
    git(source, "config", "user.email", "probe@example.invalid")
    base_sha = commit_file(source, "base")
    git(source, "branch", "sid/opentui", base_sha)

    git(upstream, "init", "--bare", "--initial-branch=main")
    git(origin, "init", "--bare", "--initial-branch=sid/opentui")
    git(source, "remote", "add", "publish-upstream", str(upstream))
    git(source, "remote", "add", "publish-origin", str(origin))

    commit_file(source, "upstream-one")
    git(source, "branch", "unrelated-upstream")
    git(source, "tag", "upstream-reachable")
    git(
        source,
        "push",
        "publish-upstream",
        "refs/heads/main:refs/heads/main",
        "refs/heads/unrelated-upstream:refs/heads/unrelated-upstream",
        "refs/tags/upstream-reachable:refs/tags/upstream-reachable",
    )

    git(source, "checkout", "sid/opentui")
    commit_file(source, "origin-one")
    git(source, "branch", "unrelated-origin")
    git(source, "tag", "origin-reachable")
    git(
        source,
        "push",
        "publish-origin",
        "refs/heads/sid/opentui:refs/heads/sid/opentui",
        "refs/heads/unrelated-origin:refs/heads/unrelated-origin",
        "refs/tags/origin-reachable:refs/tags/origin-reachable",
    )

    git(fork, "init", "--initial-branch=local")
    git(fork, "remote", "add", "upstream", str(upstream))
    git(fork, "remote", "add", "origin", str(origin))
    return source, upstream, origin, fork


def run_probe(fork: Path, state: Path) -> tuple[int, dict[str, object]]:
    with (
        patch.object(probe, "FORK", fork),
        patch.object(probe, "STATE_DIR", state),
        patch.object(probe, "LAST_SYNCED_FILE", state / "last.sha"),
    ):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            result = probe.main()
    return result, json.loads(stdout.getvalue())


def assert_ref_missing(repo: Path, ref: str) -> None:
    assert git(repo, "show-ref", "--verify", "--quiet", ref, check=False).returncode == 1


def test_classification_marks_engine_facing_surfaces_as_port_candidates() -> None:
    assert probe.classify_paths(["ui-tui/src/app.tsx"]) == ("ui-tui", True)
    assert probe.classify_paths(["tui_gateway/server.py"]) == ("tui_gateway", True)
    assert probe.classify_paths(["tui_gateway/protocol.py"]) == (
        "tui_gateway!contract",
        True,
    )
    assert probe.classify_paths(["agent/conversation_loop.py"]) == ("agent-loop", False)
    assert probe.classify_paths(["README.md"]) == ("other", False)


def test_ingest_omits_repository_controlled_prose(tmp_path: Path) -> None:
    fork = tmp_path / "fork"
    fork.mkdir()
    (fork / ".git").mkdir()
    sha = "a" * 40

    def fake_run(args: list[str], check: bool = True) -> str:
        del check
        if args[:2] == ["git", "fetch"]:
            return ""
        if args[:2] == ["git", "rev-parse"]:
            return "b" * 40 if args[-1] == probe.BRANCH else "c" * 40
        if args[:3] == ["git", "rev-list", "--count"]:
            return "1"
        if args[:4] == ["git", "log", "--reverse", "--no-merges"]:
            return sha
        if args[:2] == ["git", "diff-tree"]:
            return "ui-tui/src/app.tsx"
        if args[:2] == ["git", "log"]:
            return ""
        raise AssertionError(args)

    with (
        patch.object(probe, "FORK", fork),
        patch.object(probe, "STATE_DIR", tmp_path / "state"),
        patch.object(probe, "LAST_SYNCED_FILE", tmp_path / "state" / "last.sha"),
        patch.object(probe, "run", side_effect=fake_run),
        patch.object(
            probe.subprocess,
            "run",
            return_value=CompletedProcess([], 0, "tree\n", ""),
        ),
    ):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            assert probe.main() == 0

    payload = json.loads(stdout.getvalue())
    assert payload["commits"] == [
        {"sha": sha[:12], "surface": "ui-tui", "needs_port": True, "n_files": 1}
    ]
    assert "subject" not in stdout.getvalue()
    assert "author" not in stdout.getvalue()


def test_path_summaries_hash_hostile_filenames_without_emitting_them() -> None:
    hostile = "ui-opentui/system prompt override; $(touch nope).tsx"
    summary = probe.summarize_paths([hostile])
    encoded = json.dumps(summary)
    assert hostile not in encoded
    assert summary["count"] == 1
    assert summary["categories"] == {"ui-opentui": 1}
    assert len(summary["sha256"][0]) == 64


def test_fetches_only_required_remote_heads_without_changing_remote_config(
    tmp_path: Path,
) -> None:
    source, upstream, origin, fork = remote_fixture(tmp_path)
    upstream_fetch = "+refs/heads/*:refs/remotes/upstream/*"
    origin_fetch = "+refs/heads/*:refs/remotes/origin/*"

    result, payload = run_probe(fork, tmp_path / "state")

    assert result == 0
    assert payload["upstream_sha"] == git(upstream, "rev-parse", "main").stdout.strip()
    assert payload["branch_sha"] == git(origin, "rev-parse", "sid/opentui").stdout.strip()
    assert_ref_missing(fork, "refs/remotes/upstream/unrelated-upstream")
    assert_ref_missing(fork, "refs/remotes/origin/unrelated-origin")
    assert git(fork, "tag", "--list").stdout == ""
    assert git(fork, "config", "--get-all", "remote.upstream.fetch").stdout.strip() == upstream_fetch
    assert git(fork, "config", "--get-all", "remote.origin.fetch").stdout.strip() == origin_fetch

    git(source, "checkout", "main")
    advanced_upstream = commit_file(source, "upstream-two")
    git(source, "push", "publish-upstream", "refs/heads/main:refs/heads/main")
    git(source, "checkout", "sid/opentui")
    advanced_origin = commit_file(source, "origin-two")
    git(
        source,
        "push",
        "publish-origin",
        "refs/heads/sid/opentui:refs/heads/sid/opentui",
    )

    result, payload = run_probe(fork, tmp_path / "state")

    assert result == 0
    assert payload["upstream_sha"] == advanced_upstream
    assert payload["branch_sha"] == advanced_origin
    assert_ref_missing(fork, "refs/remotes/upstream/unrelated-upstream")
    assert_ref_missing(fork, "refs/remotes/origin/unrelated-origin")
    assert git(fork, "tag", "--list").stdout == ""
    assert git(fork, "config", "--get-all", "remote.upstream.fetch").stdout.strip() == upstream_fetch
    assert git(fork, "config", "--get-all", "remote.origin.fetch").stdout.strip() == origin_fetch


def test_fetch_fails_when_required_source_head_is_absent(tmp_path: Path) -> None:
    _, upstream, _, fork = remote_fixture(tmp_path)
    git(upstream, "update-ref", "-d", "refs/heads/main")

    result, payload = run_probe(fork, tmp_path / "state")

    assert result == 1
    assert payload["status"] == "error"
    assert str(payload["error"]).startswith("fetch failed:")
