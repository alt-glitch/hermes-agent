"""Fork: publication replaces the retired worktree-aware launcher.

Fork installs made before the PM cutover wrote ``~/.local/bin/hermes`` with
``scripts/write-hermes-launcher.sh``: a cwd-sensitive launcher bound to the
install's old ``venv/bin/hermes``. The generator is gone; the user-facing
command is the plain forwarder to the managed install, from any directory.
"""

from pathlib import Path
import shlex
import subprocess

import pytest

from hermes_cli import _launchers
from tests.hermes_cli.test_source_launcher_publication import fixture_tree, select_generation


def _legacy_fork_launcher(managed_cli, trust_file):
    # Shape of the retired generator's output (header, bindings, fallback exec).
    return (
        "#!/usr/bin/env bash\nset -euo pipefail\n\n"
        "unset PYTHONPATH\nunset PYTHONHOME\nexport PYTHONSAFEPATH=1\n"
        f"managed_cli={shlex.quote(str(managed_cli))}\n"
        f"trust_file={shlex.quote(str(trust_file))}\n"
        'if repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" &&\n'
        '    grep -Fqx -- "$repo_root/.git" "$trust_file"; then\n'
        '    exec "$repo_root/.venv/bin/python" -m hermes_cli.main "$@"\n'
        "fi\n"
        'exec "$managed_cli" "$@"\n'
    )


def _published_tree(tmp_path, monkeypatch):
    repo, home, _interpreter = fixture_tree(tmp_path, monkeypatch)
    monkeypatch.setattr(Path, "home", lambda: home)
    monkeypatch.setenv("HERMES_INSTALL_ROOT", str(repo))
    select_generation(repo, "current", "managed")
    out = home / ".local" / "bin"
    out.mkdir(parents=True)
    trust_file = out / "hermes.trusted-roots"
    trust_file.write_text(f"{tmp_path / 'dev' / '.git'}\n", encoding="utf-8")
    return repo, out, trust_file


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("entrypoint", ["venv/bin/hermes", ".hermes/bin/hermes", "symlinked"])
def test_publish_replaces_legacy_fork_launcher_with_plain_shim(tmp_path, monkeypatch, entrypoint):
    repo, out, trust_file = _published_tree(tmp_path, monkeypatch)
    bound = repo / entrypoint
    if entrypoint == "symlinked":
        # The generator recorded the install path as given, symlinks included.
        (tmp_path / "linked").symlink_to(repo, target_is_directory=True)
        bound = tmp_path / "linked" / "venv/bin/hermes"
    (out / "hermes").write_text(_legacy_fork_launcher(bound, trust_file), encoding="utf-8")

    result = _launchers.expose_cli()

    assert result["ok"], result
    assert "hermes" in result["written"]
    assert (out / "hermes").read_text(encoding="utf-8") == (
        f"#!/bin/sh\nexec {shlex.quote(str(repo / '.hermes/bin/hermes'))} \"$@\"\n"
    )
    # Nothing reads the trust list any more; it is left as the user's file.
    assert trust_file.read_text(encoding="utf-8") == f"{tmp_path / 'dev' / '.git'}\n"
    # From inside a checkout the command still runs the managed install.
    run = subprocess.run([str(out / "hermes"), "arg"], cwd=repo, capture_output=True,
                         text=True, timeout=30, encoding="utf-8")
    assert run.returncode == 7, run.stderr
    assert '"value": "managed"' in run.stdout


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("foreign", ["other-install", "user-script"])
def test_publish_leaves_foreign_launchers_alone(tmp_path, monkeypatch, foreign):
    repo, out, trust_file = _published_tree(tmp_path, monkeypatch)
    if foreign == "other-install":
        text = _legacy_fork_launcher(tmp_path / "other" / "venv/bin/hermes", trust_file)
    else:
        # A user's own script naming this install is not the retired generator's output.
        text = (f"#!/bin/sh\nmanaged_cli={shlex.quote(str(repo / '.hermes/bin/hermes'))}\n"
                'exec "$managed_cli" --profile work "$@"\n')
    (out / "hermes").write_text(text, encoding="utf-8")

    result = _launchers.expose_cli()

    assert result["ok"], result
    assert "hermes" not in result["written"]
    assert (out / "hermes").read_text(encoding="utf-8") == text
