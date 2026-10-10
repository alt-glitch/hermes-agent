"""Git trampoline recovery; branch updates use the real target-identity suite."""

import subprocess
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from hermes_cli import update_cmd


@pytest.fixture(autouse=True)
def _isolate_venv_holders(monkeypatch):
    """The update flow's venv-holder guard sees the live gateway processes on
    a dev machine and aborts with SystemExit 2 before reaching the branch
    logic under test.  Isolate it so the test exercises the intended path."""
    monkeypatch.setattr("hermes_cli.update_cmd_windows._detect_venv_python_processes", list)


class TestGitTrampolineSelfHeal:
    """Proactive Git-for-Windows trampoline self-heal (#87876).

    A broken bin\\git.exe / cmd\\git.exe shim (~46KB) refuses every git call
    with a "BUG (fork bomb)" guard instead of re-execing the real git-core
    binary. _ensure_non_trampoline_git detects this up front and swaps in a
    real git binary when one can be located, so the normal git update path
    survives instead of degrading to the ZIP fallback.
    """

    @staticmethod
    def _fake_run_healthy(command, **_kwargs):
        return subprocess.CompletedProcess(
            command, 0, stdout="git version 2.50.0.windows.1\n", stderr=""
        )

    @staticmethod
    def _fake_run_trampoline(command, **_kwargs):
        return subprocess.CompletedProcess(
            command,
            1,
            stdout="",
            stderr="BUG (fork bomb): tried to spawn itself, check your PATH\n",
        )

    @pytest.mark.platforms("windows")
    def test_healthy_git_command_unchanged(self):
        from hermes_cli import update_cmd

        git_cmd = ["git", "-c", "windows.appendAtomically=false"]
        with (
            patch(
                "hermes_cli.update_cmd.subprocess.run",
                side_effect=self._fake_run_healthy,
            ),
            patch("hermes_cli.update_cmd._locate_real_git") as locate,
        ):
            result = update_cmd._ensure_non_trampoline_git(git_cmd)
        assert result == git_cmd
        locate.assert_not_called()

    @pytest.mark.platforms("windows")
    def test_trampoline_swaps_to_real_git(self, capsys):
        from pathlib import Path

        from hermes_cli import update_cmd

        git_cmd = ["git", "-c", "windows.appendAtomically=false"]
        real = Path(r"C:\Program Files\Git\mingw64\libexec\git-core\git.exe")
        with (
            patch(
                "hermes_cli.update_cmd.subprocess.run",
                side_effect=self._fake_run_trampoline,
            ),
            patch(
                "hermes_cli.update_cmd._locate_real_git", return_value=real
            ),
        ):
            result = update_cmd._ensure_non_trampoline_git(git_cmd)
        assert result == [str(real), "-c", "windows.appendAtomically=false"]
        out = capsys.readouterr().out
        assert "switching to real git" in out

    @pytest.mark.platforms("windows")
    def test_trampoline_no_real_git_keeps_command(self, capsys):
        from hermes_cli import update_cmd

        git_cmd = ["git", "-c", "windows.appendAtomically=false"]
        with (
            patch(
                "hermes_cli.update_cmd.subprocess.run",
                side_effect=self._fake_run_trampoline,
            ),
            patch("hermes_cli.update_cmd._locate_real_git", return_value=None),
        ):
            result = update_cmd._ensure_non_trampoline_git(git_cmd)
        assert result == git_cmd
        out = capsys.readouterr().out
        assert "ZIP path" in out

    @pytest.mark.platforms("not windows")
    def test_off_windows_noop(self):
        from hermes_cli import update_cmd

        git_cmd = ["git"]
        with patch("hermes_cli.update_cmd.subprocess.run") as run:
            result = update_cmd._ensure_non_trampoline_git(git_cmd)
        assert result == git_cmd
        run.assert_not_called()

    def test_portable_git_candidates_check_shared_root_first(self, tmp_path, monkeypatch):
        # Profile-scoped layout: HERMES_HOME = <root>/profiles/foo, but the
        # PortableGit tree lives under the SHARED root (monerostar review on
        # #88136). The candidate list must check get_default_hermes_root()
        # before the profile home.
        import hermes_constants
        from hermes_cli.update_cmd_git import _portable_git_candidates

        root = tmp_path / "root"
        profile_home = root / "profiles" / "foo"

        monkeypatch.setattr(hermes_constants, "get_default_hermes_root", lambda: root)
        monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: profile_home)

        candidates = _portable_git_candidates()
        assert candidates[0] == (
            root / "git" / "mingw64" / "libexec" / "git-core" / "git.exe"
        )
        assert candidates[1] == (
            profile_home / "git" / "mingw64" / "libexec" / "git-core" / "git.exe"
        )


# ---------------------------------------------------------------------------
# Fork: bare ``hermes update`` follows the checkout's own branch (sid/opentui)
# ---------------------------------------------------------------------------


def _git_checkout_fake(branch, *, remote_branches, commit_count="2"):
    """``subprocess.run`` fake modelling a checkout on ``branch``.

    The current branch follows ``git checkout <b>`` so post-fallback reads see
    the branch the updater actually switched to. ``remote_branches`` lists the
    ``origin/<b>`` refs that exist; fetching any other branch fails the way git
    reports a missing remote ref.
    """
    state = {"branch": branch}

    def side_effect(cmd, **_kwargs):
        args = [str(c) for c in cmd]
        joined = " ".join(args)
        if "rev-parse" in args and "--abbrev-ref" in args:
            return subprocess.CompletedProcess(cmd, 0, stdout=f"{state['branch']}\n", stderr="")
        if "branch" in args and "--show-current" in args:
            return subprocess.CompletedProcess(cmd, 0, stdout=f"{state['branch']}\n", stderr="")
        if "fetch" in args:
            # The fetch may be by branch name (old shape) or by tracking refspec
            # (`+refs/heads/<b>:refs/remotes/origin/<b>`); both reduce to the branch.
            fetched = args[-1]
            for candidate in reversed(args):
                candidate = str(candidate)
                if candidate.startswith("+refs/heads/"):
                    fetched = candidate[len("+refs/heads/"):].split(":", 1)[0]
                    break
            if fetched in remote_branches:
                return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
            return subprocess.CompletedProcess(
                cmd, 128, stdout="", stderr=f"fatal: couldn't find remote ref {fetched}\n")
        if "rev-parse" in args and "--verify" in args:
            ref = args[-1].split("^{", 1)[0]  # `<ref>^{commit}` resolves the ref itself
            ok = ref.startswith("origin/") and ref[len("origin/"):] in remote_branches
            if "--quiet" not in args and not ok:
                return subprocess.CompletedProcess(cmd, 128, stdout="", stderr="")
            # Resolution checks (`rev-parse -q --verify <ref>^{commit}`) return the sha
            # when the tracking ref exists, empty stdout otherwise.
            return subprocess.CompletedProcess(
                cmd, 0, stdout=("a" * 40 + "\n") if ok else "", stderr="")
        if "checkout" in args and "-B" not in args and "--detach" not in args:
            state["branch"] = args[-1]
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        if "rev-list" in joined:
            return subprocess.CompletedProcess(cmd, 0, stdout=f"{commit_count}\n", stderr="")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    return side_effect


class TestForkBareUpdateFollowsCheckoutBranch:
    """Fork: ``_resolve_update_branch`` keeps a bare update on the checkout's branch.

    Upstream resolves every bare update through the source channel; a channel
    that resolves to plain ``main`` must not replace a fork checkout's branch,
    and a local-only checkout branch must still fall back to ``main``.
    """

    @pytest.fixture(autouse=True)
    def _isolated_checkout(self, tmp_path, monkeypatch):
        from hermes_cli import main as hm
        from hermes_cli import source_releases

        home, checkout = tmp_path / "home", tmp_path / "checkout"
        home.mkdir()
        (checkout / ".git").mkdir(parents=True)
        monkeypatch.setenv("HERMES_HOME", str(home))
        monkeypatch.setattr(hm, "PROJECT_ROOT", checkout)
        monkeypatch.setattr("hermes_cli.config.get_project_root", lambda: checkout)
        opts = update_cmd._UpdateOptions(
            pre_update_version=None, gw_input_fn=None, assume_yes=True, keep_stash=False,
            switch_branch=False, discard_local_changes=False)
        monkeypatch.setattr(update_cmd, "_resolve_update_options", lambda *_: opts)
        monkeypatch.setattr(update_cmd, "_begin_update_receipt_and_plan", lambda *_: None)
        monkeypatch.setattr(hm, "_run_pre_update_backup", lambda *_: None)
        monkeypatch.setattr(hm, "_pause_windows_gateways_for_update", lambda: None)
        monkeypatch.setattr(hm, "_resume_windows_gateways_after_update", lambda *_a, **_k: None)
        monkeypatch.setattr(
            update_cmd, "_prepare_git_command", lambda **_k: (False, ["git"], False))
        # The unpublished main record resolves to the main source branch without
        # reaching R2; the fork's checkout-branch following must survive it.
        monkeypatch.setattr(
            source_releases, "resolve_source_target",
            lambda channel, *_a, **_k: source_releases.SourceTarget(
                channel, channel, "NousResearch/hermes-agent", branch="main"))
        pulled = []
        monkeypatch.setattr(
            update_cmd, "_apply_pulled_update",
            lambda git_cmd, branch, *_a, **_k: pulled.append(branch))
        monkeypatch.setattr(update_cmd, "_verify_head_after_pull", lambda *_a, **_k: "0" * 40)
        # The fake answers every rev-parse -q --verify <ref>^{commit} with the same sha, so the
        # post-move head checks (which compare the HEAD read against the armed target) would
        # read that one sha as "landed off target" / "ref moved during the switch". Those
        # checks are upstream's to cover; this class pins branch resolution.
        monkeypatch.setattr(update_cmd, "_refuse_unselected_head", lambda *_a, **_k: None)
        # The fallback test's second leg switches a parked local-only branch to main; the
        # switch's own moved-ref guard needs a HEAD the fake cannot model. The pin this
        # class owns (fetch refspec, rev-list, pulled branch) is decided before this point.
        _plan = update_cmd._CheckoutPlan(
            auto_stash_ref=None, commit_count=1, in_place_update=False,
            parked_branch_switched=False, prompt_for_restore=False,
            switch_block_reason=None, upstream_checked=True)
        monkeypatch.setattr(
            update_cmd, "_prepare_checkout_for_update", lambda *_a, **_k: _plan)
        monkeypatch.setattr(update_cmd, "_rollback_if_pulled_syntax_error", lambda *_a, **_k: None)
        self.pulled = pulled

    @staticmethod
    def _commands(mock_run):
        return [" ".join(str(a) for a in c.args[0]) for c in mock_run.call_args_list]

    @patch("subprocess.run")
    def test_update_falls_back_to_main_when_current_branch_is_local_only(self, mock_run):
        mock_run.side_effect = _git_checkout_fake(
            "local/experiment", remote_branches={"main"}, commit_count="3")

        update_cmd._cmd_update_impl(SimpleNamespace(), False)

        commands = self._commands(mock_run)
        # The tracking refspec pins the fetched branch; the tree move merges the fetched
        # sha by design (commit-point hardening: `merge --ff-only <sha>`, never the ref).
        # The fallback run fetches twice: the local-only branch (refused), then main.
        assert "refs/heads/main:refs/remotes/origin/main" in [
            c for c in commands if "fetch" in c][-1]
        assert not any("local/experiment" in c for c in commands if "rev-list" in c)
        assert self.pulled == ["main"]

    @patch("subprocess.run")
    def test_bare_update_follows_remote_fork_branch(self, mock_run):
        mock_run.side_effect = _git_checkout_fake(
            "sid/opentui", remote_branches={"main", "sid/opentui"}, commit_count="2")

        update_cmd._cmd_update_impl(SimpleNamespace(), False)

        commands = self._commands(mock_run)
        # Same commit-point shape: the fetched sha is merged, the refspec proves the branch.
        assert "refs/heads/sid/opentui:refs/remotes/origin/sid/opentui" in next(
            c for c in commands if "fetch" in c)
        assert not any("checkout main" in c for c in commands)
        assert self.pulled == ["sid/opentui"]
