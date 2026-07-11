"""Lifecycle ownership for isolated subprocess groups.

Long-running build helpers start children in their own process group so a
timeout can terminate the complete tree.  That isolation also means the
children no longer receive a terminal HUP when their Python parent exits.
This module gives those process groups explicit, thread-safe ownership:

* every isolated child is registered until its runner has reaped it;
* a context-local scope lets an async caller cancel work running in a thread;
* a main-thread signal fence terminates registered groups before chaining the
  process's existing TERM/HUP handler.

The registry is intentionally independent of asyncio.  The subprocess runner
can register from a worker thread while dashboard shutdown and signal cleanup
run on the main thread.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
import logging
import os
import signal
import subprocess
import threading
from types import FrameType
from typing import Any


logger = logging.getLogger(__name__)

Terminator = Callable[[subprocess.Popen[Any]], int]


class ManagedSubprocess:
    """One registered process group with idempotent termination."""

    def __init__(
        self,
        proc: subprocess.Popen[Any],
        terminator: Terminator,
        scope: ProcessScope | None,
    ) -> None:
        self.proc = proc
        self._terminator = terminator
        self._scope = scope
        self._lock = threading.RLock()
        self._active = True
        self._termination_started = False
        self._termination_result: int | None = None

    @property
    def active(self) -> bool:
        with self._lock:
            return self._active

    def terminate(self) -> int:
        """Terminate the process tree once and return its exit status."""
        with self._lock:
            if self._termination_started:
                if self._termination_result is not None:
                    return self._termination_result
                return self.proc.poll() if self.proc.poll() is not None else -1
            if not self._active:
                return self.proc.poll() if self.proc.poll() is not None else -1
            self._termination_started = True
            try:
                result = self._terminator(self.proc)
            except BaseException:
                # A later shutdown/global pass must be allowed to retry a
                # transient failure instead of treating it as termination.
                self._termination_started = False
                raise
            self._termination_result = result
            return result

    def close(self) -> None:
        """Release registry ownership after the runner has reaped the child."""
        with self._lock:
            if not self._active:
                return
            self._active = False
        _REGISTRY.discard(self)
        if self._scope is not None:
            self._scope._discard(self)


class ProcessScope:
    """Cancellation scope propagated into a worker through ``ContextVar``."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._members: set[ManagedSubprocess] = set()
        self._cancelled = False

    @property
    def cancelled(self) -> bool:
        with self._lock:
            return self._cancelled

    def _add(self, managed: ManagedSubprocess) -> bool:
        """Attach a child; return false when cancellation already won."""
        with self._lock:
            if self._cancelled:
                return False
            self._members.add(managed)
            return True

    def _discard(self, managed: ManagedSubprocess) -> None:
        with self._lock:
            self._members.discard(managed)

    def cancel(self) -> None:
        """Reject every future child without waiting on current process trees."""
        with self._lock:
            self._cancelled = True

    def terminate(self) -> None:
        """Cancel the scope and synchronously terminate every attached tree.

        Marking the scope first closes the spawn race: a worker that reaches
        ``Popen`` after cancellation registers into an already-cancelled scope
        and its new process group is terminated immediately.
        """
        with self._lock:
            self._cancelled = True
            members = tuple(self._members)
        for managed in members:
            try:
                managed.terminate()
            except BaseException:
                logger.exception(
                    "Failed to terminate scoped subprocess group pid=%s",
                    managed.proc.pid,
                )


class _ProcessRegistry:
    """Thread-safe set of all isolated subprocesses owned by this process."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._members: set[ManagedSubprocess] = set()

    def add(self, managed: ManagedSubprocess) -> None:
        with self._lock:
            self._members.add(managed)

    def discard(self, managed: ManagedSubprocess) -> None:
        with self._lock:
            self._members.discard(managed)

    def snapshot(self) -> tuple[ManagedSubprocess, ...]:
        with self._lock:
            return tuple(self._members)

    def active_count(self) -> int:
        with self._lock:
            return len(self._members)


_REGISTRY = _ProcessRegistry()
_CURRENT_SCOPE: ContextVar[ProcessScope | None] = ContextVar(
    "hermes_subprocess_scope", default=None
)


@contextmanager
def bind_process_scope(scope: ProcessScope) -> Iterator[None]:
    """Bind ``scope`` while scheduling work whose context will be copied."""
    token = _CURRENT_SCOPE.set(scope)
    try:
        yield
    finally:
        _CURRENT_SCOPE.reset(token)


def current_process_scope() -> ProcessScope | None:
    """Return the process scope propagated to the current thread, if any."""
    return _CURRENT_SCOPE.get()


def register_isolated_subprocess(
    proc: subprocess.Popen[Any], terminator: Terminator
) -> ManagedSubprocess:
    """Register an isolated child before waiting for it.

    The active context scope is copied by ``asyncio.to_thread``.  Attaching
    the handle after adding it to the global registry means both dashboard
    shutdown and per-request cancellation can always find the child.
    """
    scope = current_process_scope()
    managed = ManagedSubprocess(proc, terminator, scope)
    _REGISTRY.add(managed)
    if scope is not None and not scope._add(managed):
        managed.terminate()
    return managed


def terminate_active_subprocesses() -> None:
    """Terminate every currently registered isolated process group."""
    for managed in _REGISTRY.snapshot():
        try:
            managed.terminate()
        except BaseException:
            logger.exception(
                "Failed to terminate registered subprocess group pid=%s",
                managed.proc.pid,
            )


def active_subprocess_count() -> int:
    """Return the registry size (primarily for lifecycle contract tests)."""
    return _REGISTRY.active_count()


class SignalCleanup:
    """Main-thread TERM/HUP fence that preserves the prior dispositions."""

    def __init__(self) -> None:
        self._previous: dict[int, Any] = {}
        self._handlers: dict[int, Callable[[int, FrameType | None], None]] = {}

    @property
    def installed(self) -> bool:
        return bool(self._handlers)

    def install(self) -> SignalCleanup:
        """Install when signal APIs are legal; otherwise remain a no-op."""
        if os.name != "posix" or threading.current_thread() is not threading.main_thread():
            return self

        for signum in (signal.SIGTERM, signal.SIGHUP):
            previous = signal.getsignal(signum)

            def _handle(
                received: int,
                frame: FrameType | None,
                *,
                prior: Any = previous,
            ) -> None:
                terminate_active_subprocesses()
                if prior == signal.SIG_IGN:
                    return
                if callable(prior):
                    prior(received, frame)
                    return
                # Preserve default supervisor-visible signal semantics after
                # every isolated group has been terminated and reaped.
                signal.signal(received, signal.SIG_DFL)
                os.kill(os.getpid(), received)

            signal.signal(signum, _handle)
            self._previous[signum] = previous
            self._handlers[signum] = _handle
        return self

    def restore(self) -> None:
        """Restore only handlers still owned by this fence."""
        for signum, previous in tuple(self._previous.items()):
            if signal.getsignal(signum) is self._handlers.get(signum):
                signal.signal(signum, previous)
        self._previous.clear()
        self._handlers.clear()


def install_signal_cleanup() -> SignalCleanup:
    """Install and return a restorable TERM/HUP cleanup fence."""
    return SignalCleanup().install()
