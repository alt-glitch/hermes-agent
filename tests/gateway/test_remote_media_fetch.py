"""MEDIA tags pointing into a remote terminal sandbox are fetched for delivery (#466).

The host cannot see files an agent writes inside an ssh/modal/daytona sandbox, so
``filter_media_delivery_paths`` used to drop them silently. With a remote backend active the path is
pulled through the environment's ``fetch_file`` into the document cache — after the SAME denylist
the host applies, so a sandbox path (or a symlink) at ``~/.ssh/...`` never crosses.
"""

from pathlib import Path

import pytest

import gateway.media_fetch as media_fetch
from gateway.platforms.base import BasePlatformAdapter
from tools.environments.base import BaseEnvironment, FileFetchError


class _FakeRemoteEnv:
    """Stands in for a live SSHEnvironment: a tiny remote filesystem + symlink table."""

    _remote_home = "/home/agent"

    def __init__(self):
        self.files = {"/home/agent/out/report.txt": b"hello from sandbox",
                      "/home/agent/.ssh/id_rsa": b"SECRET"}
        self.links = {"/home/agent/out/innocent.txt": "/home/agent/.ssh/id_rsa"}
        self.fetched: list = []

    def fetch_realpath(self, remote_path):
        return self.links.get(remote_path, remote_path)

    def fetch_file(self, remote_path, local_dest, *, max_bytes):
        self.fetched.append(remote_path)
        if remote_path not in self.files:
            raise FileFetchError("missing")
        Path(local_dest).write_bytes(self.files[remote_path])


@pytest.fixture
def remote_env(monkeypatch, tmp_path):
    env = _FakeRemoteEnv()
    monkeypatch.setattr(media_fetch, "_active_remote_env", lambda: env)
    monkeypatch.setattr("gateway.platforms.base.DOCUMENT_CACHE_DIR", tmp_path / "cache" / "documents")
    monkeypatch.setattr("gateway.platforms.base.MEDIA_DELIVERY_SAFE_ROOTS", (tmp_path / "cache" / "documents",))
    return env


def test_sandbox_artifact_is_fetched_but_credentials_and_symlinks_to_them_are_not(remote_env):
    media = [("/home/agent/out/report.txt", False), ("/home/agent/out/innocent.txt", False),
             ("/home/agent/.ssh/id_rsa", False), ("~/out/report.txt", False)]
    delivered = BasePlatformAdapter.filter_media_delivery_paths(media)

    assert [Path(p).read_bytes() for p, _ in delivered] == [b"hello from sandbox", b"hello from sandbox"]
    assert all(Path(p).name.endswith("_report.txt") for p, _ in delivered)
    # The credential file and the symlink that resolves to it were refused BEFORE any bytes moved.
    assert remote_env.fetched == ["/home/agent/out/report.txt", "/home/agent/out/report.txt"]


def test_local_backend_and_strict_mode_do_not_fetch(monkeypatch, tmp_path, remote_env):
    """Strict mode keeps its recency gate: a fetched copy would land in an allowlisted root and skip it."""
    monkeypatch.setenv("HERMES_MEDIA_DELIVERY_STRICT", "1")
    assert BasePlatformAdapter.filter_media_delivery_paths([("/home/agent/out/report.txt", False)]) == []
    monkeypatch.delenv("HERMES_MEDIA_DELIVERY_STRICT")
    monkeypatch.setattr(media_fetch, "_active_remote_env", lambda: None)
    assert BasePlatformAdapter.filter_media_delivery_paths([(str(tmp_path / "nope.txt"), False)]) == []
    assert remote_env.fetched == []


class _ScriptedEnv(BaseEnvironment):
    """Runs the fetch command through a real shell so the transport (marker fencing, in-sandbox
    size bound, base64 round-trip) is exercised end to end."""

    def __init__(self):
        pass

    def cleanup(self):
        pass

    def execute(self, command, cwd="", **kwargs):
        import subprocess
        proc = subprocess.run(["bash", "-c", command], capture_output=True,
                              text=True, encoding="utf-8", timeout=10)
        return {"output": "echo login-noise\n" + proc.stdout + proc.stderr, "returncode": proc.returncode}


def test_fetch_file_round_trips_bytes_and_enforces_the_in_sandbox_size_cap(tmp_path):
    src = tmp_path / "artifact.bin"
    src.write_bytes(bytes(range(256)) * 40)
    dest = tmp_path / "copy.bin"
    env = _ScriptedEnv()

    env.fetch_file(str(src), dest, max_bytes=len(src.read_bytes()))
    assert dest.read_bytes() == src.read_bytes()

    with pytest.raises(FileFetchError, match="exceeds"):
        env.fetch_file(str(src), dest, max_bytes=100)
    with pytest.raises(FileFetchError, match="could not read"):
        env.fetch_file(str(tmp_path), dest, max_bytes=100)  # a directory is not a regular file


@pytest.mark.parametrize("swap_parent", [False, True])
def test_delivery_refuses_symlink_swap_after_remote_validation(monkeypatch, tmp_path, swap_parent):
    home = tmp_path / "home"
    public = home / "out"
    private = home / ".ssh"
    public.mkdir(parents=True)
    private.mkdir()
    artifact = public / "report.txt"
    artifact.write_bytes(b"PUBLIC-ARTIFACT")
    secret = private / "report.txt"
    secret.write_bytes(b"DENIED-SENSITIVE-CONTENT")
    cache = tmp_path / "cache"

    class RacingEnv(_ScriptedEnv):
        _remote_home = str(home)

        def fetch_file(self, remote_path, local_dest, *, max_bytes):
            if swap_parent:
                public.rename(home / "original-out")
                public.symlink_to(private, target_is_directory=True)
            else:
                artifact.unlink()
                artifact.symlink_to(secret)
            super().fetch_file(remote_path, local_dest, max_bytes=max_bytes)

    monkeypatch.setattr(media_fetch, "_active_remote_env", RacingEnv)
    monkeypatch.setattr("gateway.platforms.base.DOCUMENT_CACHE_DIR", cache)
    monkeypatch.setattr("gateway.platforms.base.MEDIA_DELIVERY_SAFE_ROOTS", (cache,))
    assert media_fetch.fetch_remote_media(str(artifact)) is None
    assert not list(cache.glob("*"))


def test_fetch_refuses_hard_link_alias_and_fifo(tmp_path):
    import os

    source = tmp_path / "private.txt"
    source.write_bytes(b"SECRET")
    alias = tmp_path / "alias.txt"
    alias.hardlink_to(source)
    fifo = tmp_path / "pipe"
    os.mkfifo(fifo)
    dest = tmp_path / "copy"
    for path in (alias, fifo):
        with pytest.raises(FileFetchError, match="could not read"):
            _ScriptedEnv().fetch_file(str(path), dest, max_bytes=100)
        assert not dest.exists()


def test_transfer_reads_the_open_file_even_if_its_name_changes(tmp_path):
    import shlex

    source = tmp_path / "artifact.bin"
    source.write_bytes(b"PUBLIC-ARTIFACT")
    secret = tmp_path / "secret.bin"
    secret.write_bytes(b"SECRET")
    dest = tmp_path / "copy.bin"

    class SwapAfterOpen(_ScriptedEnv):
        def execute(self, command, **kwargs):
            argv = shlex.split(command)
            # Interpose the actual remote os.open, after it returns a descriptor.
            # The production read script is otherwise unchanged.
            prefix = f"""
import os
original_open = os.open
def swapping_open(path, *args, **kwargs):
    fd = original_open(path, *args, **kwargs)
    if path == 'artifact.bin':
        os.rename({str(source)!r}, {str(source.with_suffix('.old'))!r})
        os.symlink({str(secret)!r}, {str(source)!r})
    return fd
os.open = swapping_open
"""
            argv[4] = prefix + argv[4]
            return super().execute(shlex.join(argv), **kwargs)

    SwapAfterOpen().fetch_file(str(source), dest, max_bytes=100)
    assert source.is_symlink()
    assert dest.read_bytes() == b"PUBLIC-ARTIFACT"


def test_missing_remote_python_fails_closed_with_actionable_error(tmp_path):
    class MissingPython(_ScriptedEnv):
        def execute(self, command, **kwargs):
            return {"returncode": 127, "output": "python3: command not found"}

    dest = tmp_path / "copy"
    with pytest.raises(FileFetchError, match="require python3 in the sandbox"):
        MissingPython().fetch_file("/out/file", dest, max_bytes=100)
    assert not dest.exists()
