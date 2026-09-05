"""Picker previews share the durable display history used by resume."""

from hermes_state import SessionDB
from tui_gateway import server


def test_peek_follows_compression_and_remains_read_only(monkeypatch, tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("root", source="tui")
        db.append_message("root", role="user", content="original prompt")
        db.append_message("root", role="assistant", content="original answer")
        db.end_session("root", "compression")
        db.create_session("tip", source="tui", parent_session_id="root")
        db.append_message("tip", role="user", content="latest prompt")
        db.append_message("tip", role="assistant", content="latest answer")
        db.end_session("tip", "tui_shutdown")
        monkeypatch.setattr(server, "_get_db", lambda: db)
        monkeypatch.setattr(server, "_make_agent", lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("preview must not build an agent")))
        before = [db.get_session(key) for key in ("root", "tip")]
        live_before = dict(server._sessions)

        result = server._methods["session.peek"]("preview", {
            "session_id": "root", "head": 1, "tail": 1,
        })["result"]

        assert [row["content"] for row in result["head"]] == ["original prompt"]
        assert [row["content"] for row in result["tail"]] == ["latest answer"]
        assert result["session"]["id"] == "tip"
        assert result["session"]["end_reason"] == "tui_shutdown"
        assert result["total_messages"] == 4
        assert all(isinstance(row["id"], int) for row in result["head"] + result["tail"])
        assert [db.get_session(key) for key in ("root", "tip")] == before
        assert server._sessions == live_before
    finally:
        db.close()
