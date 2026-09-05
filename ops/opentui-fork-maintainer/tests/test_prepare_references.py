from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess

import pytest


SCRIPT = Path(__file__).parents[1] / "scripts/prepare_references.py"
SPEC = importlib.util.spec_from_file_location("prepare_references", SCRIPT)
assert SPEC and SPEC.loader
refs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(refs)


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", *args],
        cwd=cwd, check=True, capture_output=True, text=True,
    ).stdout.strip()


@pytest.fixture
def repository(tmp_path, monkeypatch):
    source, remote, root = tmp_path / "source", tmp_path / "remote.git", tmp_path / "refs"
    source.mkdir()
    git(source, "init", "--initial-branch=main")
    (source / "file.txt").write_text("original\n")
    (source / ".gitignore").write_text("local.txt\n")
    git(source, "add", ".")
    git(source, "commit", "-m", "initial")
    git(tmp_path, "init", "--bare", str(remote))
    git(source, "remote", "add", "origin", str(remote))
    git(source, "push", "origin", "main")
    root.mkdir()
    checkout = root / "sample"
    git(tmp_path, "clone", "--branch", "main", str(remote), str(checkout))
    monkeypatch.setattr(refs, "REFERENCES", {"sample": (str(remote), "main")})
    return source, remote, root, checkout


def test_missing_status_is_read_only(tmp_path, monkeypatch):
    monkeypatch.setattr(refs, "REFERENCES", {"sample": ("unused", "main")})
    root = tmp_path / "absent"
    result = refs.prepare(root, ["sample"], False)
    assert result["references"]["sample"]["available"] is False
    assert not root.exists()


def test_existing_status_preserves_head_worktree_and_index(repository):
    _, _, root, checkout = repository
    head = git(checkout, "rev-parse", "HEAD")
    branch = git(checkout, "symbolic-ref", "HEAD")
    tracked = checkout / "file.txt"
    stat = tracked.stat()
    os.utime(tracked, ns=(stat.st_atime_ns, stat.st_mtime_ns + 2_000_000_000))
    index = (checkout / ".git/index").read_bytes()
    result = refs.prepare(root, ["sample"], False)
    assert result["references"]["sample"]["sha"] == head
    assert git(checkout, "symbolic-ref", "HEAD") == branch
    assert tracked.read_text() == "original\n"
    assert (checkout / ".git/index").read_bytes() == index
    assert not (checkout / ".git/FETCH_HEAD").exists()


def test_wrong_remote_refuses_before_fetch(repository):
    _, _, root, checkout = repository
    git(checkout, "remote", "set-url", "origin", "https://example.invalid/not-allowed.git")
    with pytest.raises(ValueError, match="allowlist"):
        refs.prepare(root, ["sample"], True)
    assert not (checkout / ".git/FETCH_HEAD").exists()


@pytest.mark.parametrize("name", ["file.txt", "untracked.txt"])
def test_dirty_checkout_is_not_modified(repository, name):
    _, _, root, checkout = repository
    target = checkout / name
    target.write_text("local work\n")
    head = git(checkout, "rev-parse", "HEAD")
    with pytest.raises(ValueError, match="local work"):
        refs.prepare(root, ["sample"], True)
    assert target.read_text() == "local work\n"
    assert git(checkout, "rev-parse", "HEAD") == head
    assert not (checkout / ".git/FETCH_HEAD").exists()


@pytest.mark.parametrize("kind", ["root", "checkout", "ancestor"])
def test_symlink_alias_is_refused(repository, tmp_path, kind):
    _, _, root, checkout = repository
    if kind == "root":
        alias = tmp_path / "alias"
        alias.symlink_to(root, target_is_directory=True)
        requested = alias
    elif kind == "checkout":
        requested = tmp_path / "other"
        requested.mkdir()
        (requested / "sample").symlink_to(checkout, target_is_directory=True)
    else:
        alias = tmp_path / "alias"
        alias.symlink_to(tmp_path, target_is_directory=True)
        requested = alias / root.name
    with pytest.raises(ValueError, match="symlink"):
        refs.prepare(requested, ["sample"], True)
    assert not (checkout / ".git/FETCH_HEAD").exists()


def test_ignored_local_file_cannot_be_overwritten_by_refresh(repository):
    source, _, root, checkout = repository
    (checkout / "local.txt").write_text("local work\n")
    (source / "local.txt").write_text("upstream content\n")
    git(source, "add", "--force", "local.txt")
    git(source, "commit", "-m", "track formerly ignored path")
    git(source, "push", "origin", "main")
    with pytest.raises(ValueError, match="local work"):
        refs.prepare(root, ["sample"], True)
    assert (checkout / "local.txt").read_text() == "local work\n"


def test_refresh_advances_only_selected_checkout_from_allowlisted_local_remote(repository):
    source, remote, root, checkout = repository
    previous = git(checkout, "rev-parse", "HEAD")
    (source / "file.txt").write_text("upstream content\n")
    git(source, "commit", "-am", "upstream advance")
    git(source, "push", "origin", "main")
    expected = git(source, "rev-parse", "HEAD")
    result = refs.prepare(root, ["sample"], True)
    assert expected != previous
    assert result["references"]["sample"]["sha"] == expected
    assert git(checkout, "rev-parse", "HEAD") == expected
    assert git(checkout, "branch", "--show-current") == ""
    assert (checkout / "file.txt").read_text() == "upstream content\n"
    assert git(remote, "rev-parse", "main") == expected


def test_refresh_clones_missing_reference_from_allowlisted_local_remote(repository):
    source, _, root, _ = repository
    fresh = root.parent / "fresh"
    result = refs.prepare(fresh, ["sample"], True)
    assert result["references"]["sample"]["sha"] == git(source, "rev-parse", "HEAD")
    assert (fresh / "sample/file.txt").read_text() == "original\n"
