from __future__ import annotations

import importlib.util
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "scripts" / "sync_probe.py"
SPEC = importlib.util.spec_from_file_location("sync_probe", SCRIPT)
assert SPEC and SPEC.loader
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


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
