from pathlib import Path
import re
import subprocess


REPO_ROOT = Path(__file__).resolve().parents[2]
SETUP_SCRIPT = REPO_ROOT / "setup-hermes.sh"


def test_setup_hermes_script_is_valid_shell():
    result = subprocess.run(
        ["bash", "-n", str(SETUP_SCRIPT)], capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr


def test_setup_hermes_installs_worktree_aware_launcher():
    """Fork: the shared launcher writer publishes first, then the worktree-aware
    generator replaces its forwarder (never a symlink into the checkout)."""
    content = SETUP_SCRIPT.read_text(encoding="utf-8")

    assert "scripts/write-hermes-launcher.sh" in content
    generator_args = '"$bin_dir/hermes" "$SCRIPT_DIR/.hermes/bin/hermes" "$SCRIPT_DIR"'
    assert generator_args in content
    assert not re.search(r'ln -s\S*\s+\S+\s+"\$bin_dir/hermes"', content)
    # The shared writer refuses to publish over a launcher it doesn't own, so a
    # previous run's worktree launcher (``managed_cli=`` line) is set aside first.
    set_aside = content.index("grep -q '^managed_cli=' \"$bin_dir/hermes\"")
    publish = content.index("hermes_cli/_launchers.py \"$bin_dir\"")
    assert set_aside < publish < content.index(generator_args)
