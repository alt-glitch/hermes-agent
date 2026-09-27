"""session.list pages first, then computes previews.

Symptom: ``list_sessions_rich(order_by_last_active=True)`` (the TUI/desktop ``session.list`` path)
took 11-21 s on a 25k-session state.db. ORDER BY is on a computed column, so with the
first-user-message preview subquery in the same SELECT, SQLite evaluated the preview for every
eligible session before LIMIT. The fix selects the page (ids + ordering key) first and computes
the preview only for the returned rows; the rows themselves must not change.
"""

import random

import pytest

from hermes_state import SessionDB
from hermes_state_common import _shape_preview


@pytest.fixture
def db(tmp_path):
    database = SessionDB(tmp_path / "state.db")
    yield database
    database.close()


def _seed(db):
    rng = random.Random(7)
    order = list(range(300))
    rng.shuffle(order)
    for i in range(300):
        db.create_session(session_id=f"s{i:03d}", source="cli")
    # Messages land in shuffled order so last-active order differs from started_at order.
    for n, i in enumerate(order):
        sid = f"s{i:03d}"
        if i % 17 == 0:
            continue  # no messages: last_active falls back to started_at, preview is empty
        if i % 5 == 0:
            db.append_message(session_id=sid, role="assistant", content=f"greeting {i}", timestamp=1000.0 + n)
        db.append_message(session_id=sid, role="user", content=f"first prompt {i}", timestamp=1000.0 + n + 0.1)
        db.append_message(session_id=sid, role="user", content=f"second prompt {i}", timestamp=1000.0 + n + 0.2)


def _reference(db):
    """Unpaged formulation: every session's ordering key and first user message, sorted in Python."""
    conn = db._conn
    rows = conn.execute("SELECT id, started_at, last_activity_at FROM sessions").fetchall()
    expected = []
    for sid, started_at, last_activity_at in rows:
        msg_ts = conn.execute("SELECT MAX(timestamp) FROM messages WHERE session_id = ?", (sid,)).fetchone()[0]
        candidates = [v for v in (last_activity_at, msg_ts) if v is not None]
        effective = max(candidates) if candidates else started_at
        first = conn.execute(
            "SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY timestamp, id LIMIT 1",
            (sid,),
        ).fetchone()
        expected.append((effective, started_at, sid, _shape_preview(first[0] if first else "")))
    expected.sort(key=lambda r: (r[0], r[1], r[2]), reverse=True)
    return [(sid, preview) for _, _, sid, preview in expected]


def test_last_active_page_matches_unpaged_order_and_computes_preview_after_paging(db):
    _seed(db)
    reference = _reference(db)

    captured = []
    read_all = db._read_all

    def capture(sql, params=()):
        captured.append((sql, list(params)))
        return read_all(sql, params)

    db._read_all = capture
    first = db.list_sessions_rich(limit=5, order_by_last_active=True)
    second = db.list_sessions_rich(limit=5, offset=5, order_by_last_active=True)
    db._read_all = read_all

    assert [(s["id"], s["preview"]) for s in first] == reference[:5]
    assert [(s["id"], s["preview"]) for s in second] == reference[5:10]

    # The outer loop walks the page and looks sessions up by id; the old shape scanned sessions
    # at the top level and ran the preview subquery on every row before LIMIT.
    sql, params = captured[0]
    plan = db._conn.execute("EXPLAIN QUERY PLAN " + sql, params).fetchall()
    top_level = [detail for _, parent, _, detail in plan if parent == 0]
    assert "SCAN page" in top_level, top_level
    assert "SCAN s" not in top_level, top_level
    assert any(d.startswith("SEARCH s USING") and "(id=?)" in d for d in top_level), top_level
