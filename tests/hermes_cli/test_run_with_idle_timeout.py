"""Coverage for _run_with_idle_timeout — the streaming subprocess helper.

Kept in a dedicated test file because the tests spawn real ``subprocess.Popen``
instances; pytest-isolate runs each test file in its own worker process, so
isolating these here prevents real-Popen state from racing with the
``subprocess.run`` / ``_run_with_idle_timeout`` patches used by
``test_web_ui_build.py``.

Added for issue #33788: ``hermes update`` got stuck at "webui-build" because
``npm run build`` ran with ``capture_output=True`` and no timeout. The helper
fixes both halves — streams output AND idle-kills the process.
"""

import os
import signal
import subprocess
import sys as _sys
import time
from pathlib import Path

import pytest

from hermes_cli.main import _run_with_idle_timeout


def test_streams_output_and_returns_zero_on_success(tmp_path):
    script = tmp_path / "ok.py"
    script.write_text("print('line one'); print('line two')\n")
    result = _run_with_idle_timeout(
        [_sys.executable, str(script)], cwd=tmp_path, idle_timeout_seconds=10
    )
    assert result.returncode == 0
    assert "line one" in result.stdout
    assert "line two" in result.stdout


def test_propagates_nonzero_exit(tmp_path):
    script = tmp_path / "fail.py"
    script.write_text("import sys; print('boom', file=sys.stderr); sys.exit(7)\n")
    result = _run_with_idle_timeout(
        [_sys.executable, str(script)], cwd=tmp_path, idle_timeout_seconds=10
    )
    assert result.returncode == 7
    # stderr is merged into stdout in the helper.
    assert "boom" in result.stdout


def test_kills_process_on_idle_timeout(tmp_path):
    # Sleeps without printing — exactly the failure mode users see when
    # `npm run build` stalls. Idle timeout must terminate it.
    script = tmp_path / "stall.py"
    script.write_text("import time; time.sleep(30)\n")

    start = time.monotonic()
    result = _run_with_idle_timeout(
        [_sys.executable, str(script)],
        cwd=tmp_path,
        idle_timeout_seconds=1,
    )
    elapsed = time.monotonic() - start
    # Should have died well before the 30s sleep completes.
    assert elapsed < 15
    assert result.returncode != 0
    assert "produced no output" in result.stdout


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group contract")
def test_idle_timeout_kills_the_whole_process_tree(tmp_path):
    grandchild_pid = tmp_path / "grandchild.pid"
    script = tmp_path / "tree.py"
    script.write_text(
        "import subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, '-c', "
        "'import os, signal, sys, time; from pathlib import Path; "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        "Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)', "
        "sys.argv[1]])\n"
        "while not __import__('pathlib').Path(sys.argv[1]).exists(): time.sleep(0.01)\n"
        "time.sleep(30)\n"
    )

    result = _run_with_idle_timeout(
        [_sys.executable, str(script), str(grandchild_pid)],
        cwd=tmp_path,
        idle_timeout_seconds=0.3,
    )

    pid = int(grandchild_pid.read_text())
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        proc_status = Path(f"/proc/{pid}/status")
        if proc_status.is_file() and "State:\tZ" in proc_status.read_text():
            break
        time.sleep(0.05)
    else:
        pytest.fail(f"grandchild process {pid} survived the idle timeout")

    assert result.returncode != 0
    assert "produced no output" in result.stdout


@pytest.mark.skipif(os.name != "posix", reason="POSIX signal/process-group contract")
@pytest.mark.parametrize("termination_signal", [signal.SIGTERM, signal.SIGHUP])
def test_parent_termination_reaps_silent_isolated_tree(
    tmp_path, termination_signal
):
    grandchild_pid = tmp_path / "grandchild.pid"
    tree_script = tmp_path / "silent-tree.py"
    tree_script.write_text(
        "import subprocess, sys, time\n"
        "subprocess.Popen([sys.executable, '-c', "
        "'import os, sys, time; from pathlib import Path; "
        "Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)', "
        "sys.argv[1]])\n"
        "while not __import__('pathlib').Path(sys.argv[1]).exists(): time.sleep(0.01)\n"
        "time.sleep(30)\n"
    )
    parent_script = tmp_path / "build-parent.py"
    parent_script.write_text(
        "import sys\n"
        "from pathlib import Path\n"
        "from hermes_cli.main import _run_with_idle_timeout\n"
        "_run_with_idle_timeout([sys.executable, sys.argv[1], sys.argv[2]], "
        "cwd=Path(sys.argv[3]), idle_timeout_seconds=30)\n"
    )
    env = os.environ.copy()
    repo_root = Path(__file__).resolve().parents[2]
    env["PYTHONPATH"] = os.pathsep.join(
        filter(None, (str(repo_root), env.get("PYTHONPATH", "")))
    )
    parent = subprocess.Popen(
        [
            _sys.executable,
            str(parent_script),
            str(tree_script),
            str(grandchild_pid),
            str(tmp_path),
        ],
        cwd=tmp_path,
        env=env,
    )
    child_pid = None
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not grandchild_pid.is_file():
            if parent.poll() is not None:
                pytest.fail(f"build parent exited early with {parent.returncode}")
            time.sleep(0.01)
        assert grandchild_pid.is_file()
        child_pid = int(grandchild_pid.read_text())

        os.kill(parent.pid, termination_signal)
        assert parent.wait(timeout=10) == -termination_signal

        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                break
            proc_status = Path(f"/proc/{child_pid}/status")
            if proc_status.is_file() and "State:\tZ" in proc_status.read_text():
                break
            time.sleep(0.05)
        else:
            pytest.fail(
                f"grandchild process {child_pid} survived parent signal "
                f"{termination_signal}"
            )
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=3)
        if child_pid is not None:
            try:
                os.kill(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_returns_127_when_binary_missing(tmp_path):
    result = _run_with_idle_timeout(
        ["/nonexistent/binary/does/not/exist"],
        cwd=tmp_path,
        idle_timeout_seconds=5,
    )
    assert result.returncode == 127
