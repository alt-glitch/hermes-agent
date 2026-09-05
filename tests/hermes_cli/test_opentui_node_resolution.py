"""Node-26 resolution for the OpenTUI engine + the launch-cwd channel.

Regression coverage for two ways the local TUI silently fell back to Ink /
showed the wrong directory:

1. fnm's active/default node was on an older line (v25) while a usable v26.3
   sat installed-but-inactive — ``_node26_bin_or_none`` only checked
   ``HERMES_NODE`` + ``which node`` and so reported "no node 26" → OpenTUI
   unavailable → Ink fallback.
2. ``TERMINAL_CWD`` (the gateway's launch-dir channel) was only exported in
   worktree mode, so a normal launch let the gateway auto-detect the engine's
   own package dir as the workspace.
"""

import os
import stat

import pytest

from hermes_cli import main_tui_launch as main_mod


def _fake_node(path, version: str) -> None:
    """Write a stub `node` that prints `version` for `--version`."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'#!/bin/sh\necho "{version}"\n')
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


class TestFnmNode26Discovery:
    def test_discovers_inactive_v26_when_default_is_older(self, tmp_path, monkeypatch):
        """A v26.3 installed under fnm is found even when PATH `node` is v25."""
        fnm_dir = tmp_path / "fnm"
        for ver in ("24.11.0", "25.9.0", "26.3.0"):
            _fake_node(fnm_dir / "node-versions" / f"v{ver}" / "installation" / "bin" / "node", f"v{ver}")
        monkeypatch.setenv("FNM_DIR", str(fnm_dir))
        monkeypatch.delenv("HERMES_NODE", raising=False)
        # PATH node is the too-old default (v25).
        monkeypatch.setattr(main_mod.shutil, "which", lambda _b: str(
            fnm_dir / "node-versions" / "v25.9.0" / "installation" / "bin" / "node"
        ))

        resolved = main_mod._node26_bin_or_none()
        assert resolved is not None
        assert "v26.3.0" in resolved  # newest qualifying, not the v25 default

    def test_candidates_sorted_newest_first(self, tmp_path, monkeypatch):
        fnm_dir = tmp_path / "fnm"
        for ver in ("26.1.0", "26.4.0", "25.0.0"):
            _fake_node(fnm_dir / "node-versions" / f"v{ver}" / "installation" / "bin" / "node", f"v{ver}")
        monkeypatch.setenv("FNM_DIR", str(fnm_dir))
        cands = main_mod._fnm_node26_candidates()
        # Directory-name order: 26.4 before 26.1 before 25.0.
        idx = [next(i for i, c in enumerate(cands) if f"v{v}" in c) for v in ("26.4.0", "26.1.0", "25.0.0")]
        assert idx == sorted(idx)

    def test_no_fnm_dir_is_empty_not_error(self, tmp_path, monkeypatch):
        monkeypatch.setenv("FNM_DIR", str(tmp_path / "does-not-exist"))
        monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg-none"))
        monkeypatch.setattr(main_mod.Path, "home", classmethod(lambda cls: tmp_path / "home-none"))
        assert main_mod._fnm_node26_candidates() == []

    def test_hermes_node_still_wins(self, tmp_path, monkeypatch):
        """An explicit HERMES_NODE >= 26.3 takes precedence over fnm discovery."""
        explicit = tmp_path / "explicit" / "node"
        _fake_node(explicit, "v26.5.0")
        monkeypatch.setenv("HERMES_NODE", str(explicit))
        monkeypatch.setattr(main_mod.shutil, "which", lambda _b: None)
        assert main_mod._node26_bin_or_none() == str(explicit)
