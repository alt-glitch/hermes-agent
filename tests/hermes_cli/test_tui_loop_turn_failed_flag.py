"""The TUI turn path marks a /loop wakeup turn as failed when chat() raises.

`cli_loops_mixin` reads `_last_loop_turn_failed` after the turn to abandon the loop tick instead of
recording a failed wakeup as completed. The flag is set on the TUI submit path (fork behaviour); an
upstream merge once dropped it silently because nothing pinned it.
"""
from __future__ import annotations

import pytest

from hermes_cli.cli_tui_runtime_mixin import CLITuiRuntimeMixin


class _App:
    def invalidate(self):
        pass


class _Cli(CLITuiRuntimeMixin):
    def __init__(self, fail: bool):
        self._fail = fail
        self._app = _App()
        self._pending_resume_sessions = None
        self.after_turn_calls = 0

    # collaborators the turn path touches
    def _tui_unwrap_input(self, user_input):
        return user_input, False, False

    def _typed_voice_stop(self, _text):
        return False

    def _print_user_message_preview(self, _text):
        pass

    def _turn_summary_begin(self):
        pass

    def _tui_after_turn(self):
        self.after_turn_calls += 1

    def _expand_paste_references(self, text):
        return text

    def handle_bang_shell(self, _text):
        return False

    def chat(self, *_args, **_kwargs):
        if self._fail:
            raise RuntimeError("provider exploded")


def test_failed_chat_marks_loop_turn_failed_and_still_runs_after_turn():
    cli = _Cli(fail=True)
    with pytest.raises(RuntimeError):
        cli._tui_process_one_input("hello")
    assert cli._last_loop_turn_failed is True
    assert cli.after_turn_calls == 1


def test_successful_chat_leaves_loop_turn_flag_false():
    cli = _Cli(fail=False)
    cli._tui_process_one_input("hello")
    assert cli._last_loop_turn_failed is False
    assert cli.after_turn_calls == 1
