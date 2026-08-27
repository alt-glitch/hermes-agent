"""Regression tests for install.sh Python environment sanitization.

When install.sh is launched from another Python-driven tool session, inherited
PYTHONPATH/PYTHONHOME can shadow the freshly installed checkout. The installer
must sanitize those vars both during installation and at runtime launch.
"""

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"
LAUNCHER_GENERATOR = REPO_ROOT / "scripts" / "write-hermes-launcher.sh"


def test_install_script_unsets_pythonpath_and_pythonhome_early() -> None:
    text = INSTALL_SH.read_text()

    # During install, inherited Python env must be sanitized before pip/venv use.
    assert "unset PYTHONPATH" in text
    assert "unset PYTHONHOME" in text


def test_hermes_launcher_wrapper_clears_python_env_before_exec() -> None:
    install_text = INSTALL_SH.read_text()
    launcher_text = LAUNCHER_GENERATOR.read_text()

    assert 'scripts/write-hermes-launcher.sh"' in install_text
    assert '"$INSTALL_DIR" "$_SCRIPT_DIR/.."' in install_text
    assert "unset PYTHONPATH" in launcher_text
    assert "unset PYTHONHOME" in launcher_text
    assert "export PYTHONSAFEPATH=1" in launcher_text
    assert 'exec "$managed_cli" "$@"' in launcher_text
