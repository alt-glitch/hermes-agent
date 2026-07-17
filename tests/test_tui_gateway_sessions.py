import threading
from types import SimpleNamespace

from tui_gateway import server


def test_session_info_prefers_inflight_derived_title(monkeypatch):
    agent = SimpleNamespace(
        model="model",
        provider="provider",
        session_id="inflight-session-key",
        tools=[],
    )
    session = {"agent": agent}

    class _DB:
        def get_session_title(self, key):
            assert key == "inflight-session-key"
            return "inflight derived title"

    monkeypatch.setattr(server, "_get_db", lambda: _DB())

    assert server._session_info(agent, session)["title"] == "inflight derived title"


def test_queued_compute_host_prompt_emits_acks(monkeypatch):
    emitted = []
    session = {
        "history_lock": threading.Lock(),
        "queued_prompt": {
            "text": "queued prompt",
            "transport": None,
            "client_submission_ids": ["submission-a", "submission-b"],
        },
        "running": False,
    }
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda _session: True)
    monkeypatch.setattr(
        server,
        "_submit_prompt_to_compute_host",
        lambda *_args: {"result": {"status": "streaming"}},
    )
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, sid, payload=None: emitted.append((event, sid, payload)),
    )

    assert server._drain_queued_prompt("request", "session", session) is True
    assert emitted == [
        (
            "message.start",
            "session",
            {"client_submission_ids": ["submission-a", "submission-b"]},
        )
    ]
