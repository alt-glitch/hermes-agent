from types import SimpleNamespace

import tui_gateway._stdin_recovery as recovery


def _fcntl_returning(flags: int) -> SimpleNamespace:
    return SimpleNamespace(F_GETFL=3, fcntl=lambda _fd, _operation: flags)


def test_spurious_eof_restores_blocking_stdin(monkeypatch):
    logs: list[str] = []
    set_blocking: list[tuple[int, bool]] = []
    recovery_times: list[float] = []

    monkeypatch.setattr(recovery, "_HAS_FCNTL", True)
    monkeypatch.setattr(recovery, "_fcntl", _fcntl_returning(recovery.os.O_NONBLOCK))
    monkeypatch.setattr(recovery, "_HAS_SOCKET", False)
    monkeypatch.setattr(recovery, "diagnose_stdin_state", lambda: "O_NONBLOCK=1")
    monkeypatch.setattr(recovery.time, "time", lambda: 100.0)
    monkeypatch.setattr(recovery.os, "set_blocking", lambda fd, blocking: set_blocking.append((fd, blocking)))

    assert recovery.handle_spurious_eof(recovery_times, logs.append) is True
    assert recovery_times == [100.0]
    assert set_blocking == [(0, True)]
    assert logs == ["stdin spurious EOF (subprocess O_NONBLOCK flip), recovering: O_NONBLOCK=1"]


def test_genuine_eof_exits_without_mutating_stdin(monkeypatch):
    logs: list[str] = []
    set_blocking: list[tuple[int, bool]] = []

    monkeypatch.setattr(recovery, "_HAS_FCNTL", True)
    monkeypatch.setattr(recovery, "_fcntl", _fcntl_returning(0))
    monkeypatch.setattr(recovery.os, "set_blocking", lambda fd, blocking: set_blocking.append((fd, blocking)))

    assert recovery.handle_spurious_eof([], logs.append) is False
    assert set_blocking == []
    assert logs == ["stdin EOF (peer closed)"]


def test_recovery_rate_limit_exits_before_restoring_stdin(monkeypatch):
    logs: list[str] = []
    set_blocking: list[tuple[int, bool]] = []
    recovery_times = [99.0] * recovery.MAX_RECOVERIES_PER_MINUTE

    monkeypatch.setattr(recovery, "_HAS_FCNTL", True)
    monkeypatch.setattr(recovery, "_fcntl", _fcntl_returning(recovery.os.O_NONBLOCK))
    monkeypatch.setattr(recovery.time, "time", lambda: 100.0)
    monkeypatch.setattr(recovery.os, "set_blocking", lambda fd, blocking: set_blocking.append((fd, blocking)))

    assert recovery.handle_spurious_eof(recovery_times, logs.append) is False
    assert len(recovery_times) == recovery.MAX_RECOVERIES_PER_MINUTE + 1
    assert set_blocking == []
    assert logs == [
        "stdin spurious-EOF recovery rate exceeded "
        f"({recovery.MAX_RECOVERIES_PER_MINUTE + 1}/min, cap {recovery.MAX_RECOVERIES_PER_MINUTE})"
    ]


def test_platform_without_fcntl_treats_eof_as_peer_close(monkeypatch):
    logs: list[str] = []

    monkeypatch.setattr(recovery, "_HAS_FCNTL", False)
    monkeypatch.setattr(recovery, "_fcntl", None)

    assert recovery.handle_spurious_eof([], logs.append) is False
    assert logs == ["stdin EOF (peer closed)"]
