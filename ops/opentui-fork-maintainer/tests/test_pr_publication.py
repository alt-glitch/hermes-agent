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


def publish(capture):
    root, manifest, _ = capture
    return pub.publish_preview(root.parent, root, manifest, node=NODE)


def green_checks():
    return [{
        "__typename": "CheckRun", "name": name,
        "status": "COMPLETED", "conclusion": "SUCCESS",
    } for name in ("Greptile Review", "Python tests")]


def review_comment(score="5", candidate="a" * 40, login="greptile-apps[bot]"):
    return {
        "id": 1, "user": {"login": login}, "updated_at": "2026-09-05T16:00:00Z",
        "html_url": "https://github.com/alt-glitch/hermes-agent/pull/42#issuecomment-1",
        "body": f"Confidence Score: {score}/5\nLast reviewed commit: [title](https://github.com/alt-glitch/hermes-agent/commit/{candidate})",
    }


def review_pr():
    return {"headRefOid": "a" * 40, "state": "OPEN", "baseRefName": pub.BASE,
            "statusCheckRollup": green_checks()}


@pytest.mark.parametrize("comment", [
    review_comment(candidate="b" * 40),
    review_comment(login="not-the-review-bot"),
    {**review_comment(), "user": None},
])
def test_review_requires_authenticated_current_candidate(comment):
    assert pub.review_status(review_pr(), [comment], "a" * 40) is None


def test_review_rejects_lower_score_and_later_downgrade():
    earlier = review_comment()
    later = {**review_comment(score="3"), "id": 2}
    with pytest.raises(pub.PublicationError, match="not 5/5"):
        pub.review_status(review_pr(), [earlier, later], "a" * 40)


@pytest.mark.parametrize("change", [{"headRefOid": "b" * 40}, {"state": "MERGED"}, {"baseRefName": "main"}])
def test_review_refuses_changed_pr(change):
    with pytest.raises(pub.PublicationError, match="changed or closed"):
        pub.review_status({**review_pr(), **change}, [review_comment()], "a" * 40)


def test_review_requires_finished_green_checks():
    pr = review_pr()
    pr["statusCheckRollup"][1]["status"] = "IN_PROGRESS"
    assert pub.review_status(pr, [review_comment()], "a" * 40) is None
    pr["statusCheckRollup"][1].update(status="COMPLETED", conclusion="FAILURE")
    with pytest.raises(pub.PublicationError, match="PR check failed"):
        pub.review_status(pr, [review_comment()], "a" * 40)


def test_review_timeout_keeps_target_untouched(capture, github, monkeypatch):
    root, _, _ = capture
    github.pr = review_pr()
    github.pr["statusCheckRollup"] = []
    clock = iter([0, 1801])
    monkeypatch.setattr(pub.time, "monotonic", lambda: next(clock))
    with pytest.raises(pub.PublicationError, match="still pending"):
        pub.wait_for_review(root, 42, "a" * 40)
    assert all(argv[0] == str(pub.GH) for argv in github.calls)
    assert not (root / "pr-review.json").exists()


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
    prefix, suffix = "human intro  \n\n", "\n\n## Testing\n  keep trailing spaces  \n"
    github.pr["body"] = prefix + pub.START + "\nold\n" + pub.END + suffix
    publish(capture)
    assert github.pr["body"].startswith(prefix)
    assert github.pr["body"].endswith(suffix)


def test_changed_formatter_requires_revalidation(capture, github, monkeypatch):
    monkeypatch.setattr(pub, "FORMATTER_SHA256", "0" * 64)
    with pytest.raises(pub.PublicationError, match="formatter changed"):
        publish(capture)
    assert not any(a[:2] == ["git", "push"] for a in github.calls)
