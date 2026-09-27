"""Dashboard build freshness/serialization and checkout bytecode sweep.

Split out of ``hermes_cli/main.py``. Names that still live in main (``PROJECT_ROOT``, ...)
are imported lazily inside the functions that use them (avoids an import cycle).
"""

import logging
import os
import signal
import subprocess
import sys
import threading
import time as _time

from pathlib import Path
from hermes_cli import subprocess_lifecycle as _subprocess_lifecycle

# Log-record parity with the origin module.
logger = logging.getLogger("hermes_cli.main")

# Checkout fingerprint the bytecode cache was last validated against. Lives next
# to the checkout (NOT in HERMES_HOME): __pycache__ is per-checkout state shared
# by every profile.
_BYTECODE_FINGERPRINT_FILE = ".bytecode-fingerprint"


def _record_bytecode_fingerprint() -> None:
    """Persist the current checkout fingerprint after a bytecode sweep. Never raises."""
    from hermes_cli.main import PROJECT_ROOT, _read_git_revision_fingerprint
    try:
        fingerprint = _read_git_revision_fingerprint(PROJECT_ROOT)
        if not fingerprint:
            return
        stamp_path = PROJECT_ROOT / _BYTECODE_FINGERPRINT_FILE
        tmp_path = stamp_path.with_name(stamp_path.name + ".tmp")
        tmp_path.write_text(fingerprint, encoding="utf-8")
        tmp_path.replace(stamp_path)
    except OSError as exc:
        logger.debug("Could not record bytecode fingerprint: %s", exc)


def _sweep_stale_bytecode_if_checkout_changed() -> None:
    """Clear ``__pycache__`` at launch when the checkout fingerprint changed since the last sweep.

    Update-time clears can't close the stale-bytecode class: ``hermes update`` runs
    the PRE-pull updater code and manual pulls never run it. Cheap file reads, no
    git subprocess. Never raises.

    The stale-bytecode bug class (issues #6207, #60242; Dhruv's WhatsApp ``cannot import name
    'parse_model_flags_detailed'`` report) has one shared shape: the checkout's ``.py`` files change (git
    pull inside ``hermes update``, a manual ``git pull``, a ZIP update, a file-sync restore) while
    ``__pycache__`` retains bytecode from the previous revision, and a later process trusts the stale
    ``.pyc`` instead of the fresh source.
    """
    from hermes_cli.main import PROJECT_ROOT, _clear_bytecode_cache, _read_git_revision_fingerprint
    try:
        fingerprint = _read_git_revision_fingerprint(PROJECT_ROOT)
        if not fingerprint:
            return  # non-git install — the ZIP update path clears explicitly
        stamp_path = PROJECT_ROOT / _BYTECODE_FINGERPRINT_FILE
        try:
            recorded = stamp_path.read_text(encoding="utf-8-sig").strip()
        except OSError:
            recorded = ""
        if recorded == fingerprint:
            return
        removed = _clear_bytecode_cache(PROJECT_ROOT)
        if removed:
            logger.info(
                "Checkout changed since last launch (%s -> %s): cleared %d stale __pycache__ director%s",
                recorded or "unknown", fingerprint, removed, "y" if removed == 1 else "ies",
            )
        _record_bytecode_fingerprint()
    except Exception as exc:
        logger.debug("Stale-bytecode launch sweep failed: %s", exc)


def _web_project_root(web_dir: Path) -> Path:
    """Repo root for a frontend dir (``web/`` or ``apps/<name>/``)."""
    return web_dir.parent.parent if web_dir.parent.name == "apps" else web_dir.parent


def _web_dist_dir(web_dir: Path) -> Path:
    """Vite outputs to ``hermes_cli/web_dist/`` (vite.config.ts outDir), NOT ``web/dist/``."""
    return _web_project_root(web_dir) / "hermes_cli" / "web_dist"


def _web_ui_build_needed(web_dir: Path) -> bool:
    from hermes_cli.source_build import source_product_current

    return not source_product_current(_web_project_root(web_dir), "web", _web_dist_dir(web_dir))


def _write_web_ui_build_stamp(project_root: Path, web_dir: Path) -> None:
    """Historical updater entrypoint; current builders publish their own receipts."""
    from hermes_cli._old_updater import stop_for_relaunch
    stop_for_relaunch()


def _console_print(text: str) -> None:
    """print() that survives cp1252-style consoles (arrow/check glyphs) via errors="replace"."""
    try:
        print(text)
    except UnicodeEncodeError:
        encoding = getattr(sys.stdout, "encoding", None) or "ascii"
        print(text.encode(encoding, errors="replace").decode(encoding, errors="replace"))


def _terminate_subprocess_tree(proc: subprocess.Popen) -> int:
    """Terminate then force-kill the isolated subprocess tree."""
    if os.name == "posix":
        try:
            os.killpg(proc.pid, signal.SIGTERM)  # windows-footgun: ok — POSIX branch
        except ProcessLookupError:
            return proc.wait()
        try:
            rc = proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)  # windows-footgun: ok — POSIX branch
            except ProcessLookupError:
                pass
            return proc.wait()
        # The session leader may exit before a child that ignored SIGTERM.
        # Kill any remaining member of the isolated group before returning.
        try:
            os.killpg(proc.pid, signal.SIGKILL)  # windows-footgun: ok — POSIX branch
        except ProcessLookupError:
            pass
        return rc

    if os.name == "nt":
        # CREATE_NEW_PROCESS_GROUP below lets taskkill address the full tree.
        try:
            result = subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                timeout=5,
                check=False,
            )
            if result.returncode == 0:
                return proc.wait()
        except (OSError, subprocess.TimeoutExpired):
            pass

    proc.terminate()
    try:
        return proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
        return proc.wait()


class _BuildParentTermination(BaseException):
    """Internal control flow for default TERM/HUP during an isolated build."""

    def __init__(self, signum: int):
        super().__init__(signum)
        self.signum = signum


def _run_build_with_idle_timeout(
    cmd: list[str],
    cwd: Path,
    *,
    idle_timeout_seconds: int = 180,
    indent: str = "    ",
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    """Run a subprocess that streams output, with an idle-output timeout.

    Fork: the OpenTUI runtime refresh (``main_tui_launch._run_opentui_build_command``)
    runs its ``npm ci`` / bundle builds through this, isolated in its own process
    group and registered with ``subprocess_lifecycle`` so dashboard shutdown and
    TERM/HUP reap the whole tree. ``_run_with_idle_timeout`` below is upstream's
    frozen old-updater shim and must keep stopping for relaunch.

    Issue #33788: ``npm run build`` (Vite) was invoked with
    ``capture_output=True`` and no timeout. On low-memory hosts (notably
    WSL2 with the default 4 GB cap) the build can stall or sit silent for
    minutes; users see a frozen terminal, assume the update is hung, and
    reboot — leaving the editable install in a half-state with the
    ``hermes`` launcher present but ``hermes_cli`` not importable.

    This helper fixes both halves: stdout is streamed (so the user sees
    progress), and if no bytes have appeared on stdout/stderr for
    ``idle_timeout_seconds``, the process is terminated and the call
    returns with a non-zero ``returncode``. The caller's existing
    stale-dist fallback (#23817) takes over from there.

    Returns a ``CompletedProcess`` with merged stdout (text), empty
    stderr, and an integer returncode. Never raises on idle timeout —
    propagation of failure is via the returncode.
    """
    merged_chunks: list[str] = []
    last_output_ts = _time.monotonic()
    lock = threading.Lock()

    popen_options = {}
    if os.name == "posix":
        popen_options["start_new_session"] = True
    elif os.name == "nt" and hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        popen_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
            **popen_options,
        )
    except OSError as exc:
        # E.g. npm not on PATH between the which() check and now.
        return subprocess.CompletedProcess(cmd, 127, stdout="", stderr=str(exc))

    # Register immediately after Popen: dashboard hydration runs this helper
    # in a worker thread, so its main event-loop task and TERM/HUP handler need
    # a thread-safe way to own the isolated process group.
    managed_proc = _subprocess_lifecycle.register_isolated_subprocess(
        proc, _terminate_subprocess_tree
    )

    def _reader() -> None:
        nonlocal last_output_ts
        assert proc.stdout is not None
        for line in proc.stdout:
            _console_print(f"{indent}{line.rstrip()}")
            sys.stdout.flush()
            with lock:
                merged_chunks.append(line)
                last_output_ts = _time.monotonic()

    reader_thread = threading.Thread(target=_reader, daemon=True)
    try:
        reader_thread.start()
    except BaseException:
        managed_proc.terminate()
        managed_proc.close()
        raise

    previous_termination_handlers: dict[int, object] = {}

    def _raise_parent_termination(signum, _frame) -> None:
        raise _BuildParentTermination(signum)

    def _restore_termination_handlers() -> None:
        while previous_termination_handlers:
            signum, previous = previous_termination_handlers.popitem()
            signal.signal(signum, previous)

    # setsid protects the caller from descendants and enables reliable group
    # cleanup, but it also shields a silent child from terminal HUP when the
    # Python parent receives its default TERM/HUP disposition. Temporarily turn
    # only those default dispositions into Python control flow so the process
    # group is reaped first. Respect daemon/custom handlers, and signal APIs are
    # only legal from Python's main thread.
    try:
        if os.name == "posix" and threading.current_thread() is threading.main_thread():
            for termination_signal in (signal.SIGTERM, signal.SIGHUP):  # windows-footgun: ok — POSIX branch
                previous = signal.getsignal(termination_signal)
                if previous == signal.SIG_DFL:
                    signal.signal(termination_signal, _raise_parent_termination)
                    previous_termination_handlers[termination_signal] = previous
    except BaseException:
        try:
            managed_proc.terminate()
        finally:
            managed_proc.close()
            _restore_termination_handlers()
        raise

    idle_killed = False
    parent_termination_signal: int | None = None
    leader_reaped = False
    wait_poll_seconds = min(5.0, max(0.05, idle_timeout_seconds / 4))
    try:
        while True:
            try:
                rc = proc.wait(timeout=wait_poll_seconds)
                leader_reaped = True
                break
            except subprocess.TimeoutExpired:
                with lock:
                    idle = _time.monotonic() - last_output_ts
                if idle > idle_timeout_seconds:
                    idle_killed = True
                    rc = managed_proc.terminate()
                    break
    except _BuildParentTermination as exc:
        rc = managed_proc.terminate()
        parent_termination_signal = exc.signum
    except BaseException:
        managed_proc.terminate()
        reader_thread.join(timeout=2)
        raise
    finally:
        _restore_termination_handlers()
        try:
            if leader_reaped and os.name == "posix":
                # A successful process-group leader may have backgrounded a
                # descendant that still owns stdout. Drain the isolated group
                # before unregistering it; otherwise dashboard shutdown can no
                # longer find the child and the daemon reader remains blocked.
                managed_proc.terminate()
        finally:
            managed_proc.close()

    # Drain reader so we don't leak the stdout file descriptor.
    reader_thread.join(timeout=2)

    if parent_termination_signal is not None:
        # Re-deliver with the original default disposition so callers and
        # supervisors observe the same signal exit status as without this
        # cleanup fence. The SystemExit is a defensive fallback for platforms
        # that unexpectedly decline self-delivery.
        os.kill(os.getpid(), parent_termination_signal)
        raise SystemExit(128 + parent_termination_signal)

    combined = "".join(merged_chunks)
    if idle_killed:
        msg = (
            f"\n  ⚠ Build produced no output for {idle_timeout_seconds}s — terminated.\n"
            "    Common causes: out-of-memory on a low-RAM host (WSL/container),\n"
            "    a stuck Node process, or an antivirus scan stalling I/O.\n"
        )
        combined += msg
        # Force a non-zero rc even if terminate() raced with a clean exit.
        if rc == 0:
            rc = 124  # GNU `timeout` convention
    return subprocess.CompletedProcess(cmd, rc, stdout=combined, stderr="")


def _run_with_idle_timeout(
    cmd: list[str], cwd: Path, *, idle_timeout_seconds: int = 180, indent: str = "    ",
    env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    """Stop an old updater instead of running the retired build path."""
    from hermes_cli._old_updater import stop_for_relaunch
    stop_for_relaunch()


def _nixos_build_env() -> dict[str, str] | None:
    """Stop an old updater instead of running the retired build path."""
    from hermes_cli._old_updater import stop_for_relaunch
    stop_for_relaunch()


def _run_npm_install_deterministic(
    npm: str, cwd: Path, *, extra_args: tuple[str, ...] = (), capture_output: bool = True,
    env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    """Stop an old updater instead of running the retired build path."""
    from hermes_cli._old_updater import stop_for_relaunch
    stop_for_relaunch()


def _build_web_ui(web_dir: Path, *, fatal: bool = False) -> bool:
    """Serialize dashboard rebuilds, checking freshness only after acquiring the lock."""
    from hermes_cli.runtime_state import _lock

    if not (web_dir / "package.json").exists():
        return True
    try:
        with (_web_project_root(web_dir) / ".web_ui_build.lock").open("ab") as lock_file:
            _lock(lock_file.fileno(), wait=True)
            return _do_build_web_ui(web_dir, fatal=fatal)
    except OSError as exc:
        _console_print(f"  ✗ Could not lock the web UI build: {exc}")
        return False


def _do_build_web_ui(web_dir: Path, *, fatal: bool = False) -> bool:
    """Build stale dashboard sources; failure is never reported as a usable build."""
    from hermes_cli.source_build import build_source_web, prepare_launch_dependencies, source_build_env

    if not (web_dir / "package.json").exists() or not _web_ui_build_needed(web_dir):
        return True
    project_root = _web_project_root(web_dir)
    _console_print("→ Building web UI...")
    try:
        env = source_build_env()
        prepare_launch_dependencies(project_root, env=env)
        build_source_web(project_root, env=env)
    except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
        _console_print(f"  {'✗' if fatal else '⚠'} Web UI build failed: {exc}")
        return False
    _console_print("  ✓ Web UI built")
    return True
