"""Gateway /loop command tests — dispatch, routing capture, mid-run guard."""

import logging
import time
from unittest.mock import AsyncMock, Mock

import pytest

from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.base import MessageEvent, MessageType
from gateway.run import GatewayRunner, _profile_runtime_scope
from gateway.session import SessionSource
from hermes_cli import goals, loops
from hermes_constants import get_hermes_home


class _FakeSessionEntry:
    session_id = "sid-gateway-loop"

    def __init__(self):
        self.origin = None
        self.resume_pending = False


class _FakeSessionStore:
    def __init__(self):
        self.entry = _FakeSessionEntry()

    def get_or_create_session(self, source, *, touch_activity=True):
        self.entry.origin = source
        return self.entry

    def _generate_session_key(self, source):
        return "agent:main:discord:channel:loop-test"

    def lookup_by_session_id(self, session_id):
        return self.entry if session_id == self.entry.session_id else None

    def lookup_by_session_key(self, session_key):
        return self.entry if session_key else None


@pytest.fixture
def loop_env(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    goals._DB_CACHE.clear()
    yield home
    goals._DB_CACHE.clear()


def _make_runner():
    runner = object.__new__(GatewayRunner)
    runner.config = GatewayConfig(
        platforms={Platform.DISCORD: PlatformConfig(enabled=True, token="token")}
    )
    runner.session_store = _FakeSessionStore()
    runner.adapters = {}
    runner._queued_events = {}
    runner._running_agents = {}
    runner._profile_adapters = {}
    return runner


def _make_event(text: str) -> MessageEvent:
    return MessageEvent(
        text=text,
        message_type=MessageType.TEXT,
        source=SessionSource(
            platform=Platform.DISCORD,
            chat_id="chat-loop",
            chat_type="channel",
            thread_id="thread-9",
            user_id="user-loop",
            scope_id="guild-7",
            parent_chat_id="parent-3",
            profile="work",
        ),
        message_id="msg-loop",
    )


@pytest.mark.asyncio
async def test_gateway_loop_create_captures_route(loop_env):
    runner = _make_runner()
    response = await GatewayRunner._handle_loop_command(runner, _make_event("/loop 5m check the deploy"))
    assert "Loop set" in response
    assert "every 5m" in response

    state = loops.load_loop("sid-gateway-loop")
    assert state is not None
    assert state.prompt == "check the deploy"
    assert state.route["platform"] == "discord"
    assert state.route["chat_id"] == "chat-loop"
    assert state.route["thread_id"] == "thread-9"
    assert state.route["scope_id"] == "guild-7"
    assert state.route["parent_chat_id"] == "parent-3"
    assert state.route["profile"] == "work"


def test_restart_claim_metadata_uses_source_profile(loop_env, tmp_path):
    runner = _make_runner()
    source = _make_event("/loop status").source
    profile_home = tmp_path / "work-profile"
    profile_home.mkdir()
    runner._resolve_profile_home_for_source = lambda _source: profile_home

    default_mgr = loops.LoopManager("sid-gateway-loop")
    default_mgr.set("default poll", interval_seconds=60)
    default_mgr.state.next_due_at = time.time() - 1
    assert default_mgr.fire_tick() is not None
    default_claim_id = default_mgr.state.claim_id

    with _profile_runtime_scope(profile_home):
        mgr = loops.LoopManager("sid-gateway-loop")
        mgr.set("poll CI", interval_seconds=60)
        mgr.state.next_due_at = time.time() - 1
        assert mgr.fire_tick() is not None
        claim_id = mgr.state.claim_id

    metadata = runner._loop_claim_metadata("sid-gateway-loop", source)
    assert claim_id != default_claim_id
    assert metadata == {"hermes_loop_claim_id": claim_id}


@pytest.mark.asyncio
async def test_gateway_loop_status_pause_stop(loop_env):
    runner = _make_runner()
    await GatewayRunner._handle_loop_command(runner, _make_event("/loop 5m poll CI"))

    status = await GatewayRunner._handle_loop_command(runner, _make_event("/loop status"))
    assert "poll CI" in status

    paused = await GatewayRunner._handle_loop_command(runner, _make_event("/loop pause"))
    assert "paused" in paused.lower()

    stopped = await GatewayRunner._handle_loop_command(runner, _make_event("/loop stop"))
    assert "stopped" in stopped.lower()


@pytest.mark.asyncio
async def test_gateway_loop_goal_note_when_goal_active(loop_env):
    from hermes_cli.goals import GoalManager

    GoalManager(session_id="sid-gateway-loop").set("finish the migration")
    runner = _make_runner()
    response = await GatewayRunner._handle_loop_command(runner, _make_event("/loop 5m poll CI"))
    assert "active /goal" in response


@pytest.mark.asyncio
async def test_post_turn_loop_completion_completes_inflight_tick(loop_env):
    runner = _make_runner()
    await GatewayRunner._handle_loop_command(runner, _make_event("/loop 5m poll CI"))

    mgr = loops.LoopManager(session_id="sid-gateway-loop")
    mgr.state.next_due_at = time.time() - 1
    assert mgr.fire_tick() is not None
    claim_id = mgr.state.claim_id

    entry = _FakeSessionEntry()
    await GatewayRunner._post_turn_loop_completion(
        runner,
        session_entry=entry,
        source=None,
        final_response="CI is done.\nLOOP_COMPLETE",
        claim_id=claim_id,
    )
    reloaded = loops.load_loop("sid-gateway-loop")
    assert reloaded.status == "done"


@pytest.mark.asyncio
async def test_post_turn_loop_completion_preserves_executor_context(loop_env):
    runner = _make_runner()
    await GatewayRunner._handle_loop_command(
        runner, _make_event("/loop 5m poll CI --until build is green")
    )
    mgr = loops.LoopManager(session_id="sid-gateway-loop")
    mgr.state.next_due_at = time.time() - 1
    assert mgr.fire_tick() is not None
    claim_id = mgr.state.claim_id

    calls = []

    async def run_with_context(fn, *args):
        calls.append(getattr(fn, "__name__", ""))
        return fn(*args)

    runner._run_in_executor_with_context = run_with_context
    await GatewayRunner._post_turn_loop_completion(
        runner,
        session_entry=_FakeSessionEntry(),
        source=None,
        final_response="still building",
        claim_id=claim_id,
    )
    assert calls == ["_get_session_db", "<lambda>"]


@pytest.mark.asyncio
async def test_gateway_scan_injects_due_discord_loop_into_original_thread(loop_env):
    runner = _make_runner()
    event = _make_event("/loop 5m poll CI")
    await GatewayRunner._handle_loop_command(runner, event)
    mgr = loops.LoopManager(session_id="sid-gateway-loop")
    mgr.state.next_due_at = time.time() - 1
    loops.save_loop(mgr.session_id, mgr.state)

    adapter = type("Adapter", (), {})()
    adapter.handle_message = AsyncMock()
    adapter.prime_routing_cache = None
    runner._profile_adapters = {"work": {Platform.DISCORD: adapter}}
    await GatewayRunner._fire_due_loop_wakeups_once(runner, now=time.time())

    adapter.handle_message.assert_awaited_once()
    wake = adapter.handle_message.await_args.args[0]
    assert wake.internal is True
    assert wake.source.chat_id == "chat-loop"
    assert wake.source.thread_id == "thread-9"
    assert wake.source.scope_id == "guild-7"
    assert wake.source.parent_chat_id == "parent-3"
    assert wake.source.profile == "work"
    claim_id = wake.metadata.get("hermes_loop_claim_id")
    assert claim_id
    assert loops.LoopManager("sid-gateway-loop").state.claim_id == claim_id


@pytest.mark.asyncio
async def test_unowned_gateway_turn_cannot_complete_loop_claim(loop_env):
    runner = _make_runner()
    await GatewayRunner._handle_loop_command(runner, _make_event("/loop 5m poll CI"))
    mgr = loops.LoopManager(session_id="sid-gateway-loop")
    mgr.state.next_due_at = time.time() - 1
    assert mgr.fire_tick() is not None
    claim_id = mgr.state.claim_id

    await GatewayRunner._post_turn_loop_completion(
        runner,
        session_entry=_FakeSessionEntry(),
        source=None,
        final_response="an unrelated user response",
    )

    state = loops.LoopManager("sid-gateway-loop").state
    assert state.awaiting_response is True
    assert state.claim_id == claim_id


@pytest.mark.asyncio
async def test_gateway_scan_recovers_expired_claim_but_not_resume_pending(loop_env):
    runner = _make_runner()
    await GatewayRunner._handle_loop_command(runner, _make_event("/loop 5m poll CI"))
    mgr = loops.LoopManager(session_id="sid-gateway-loop")
    mgr.state.next_due_at = time.time() - 1
    mgr.fire_tick()
    mgr.state.next_due_at = time.time() - 1
    loops.save_loop(mgr.session_id, mgr.state)

    adapter = type("Adapter", (), {})()
    adapter.handle_message = AsyncMock()
    adapter.prime_routing_cache = None
    runner._profile_adapters = {"work": {Platform.DISCORD: adapter}}
    runner.session_store.entry.resume_pending = True
    await GatewayRunner._fire_due_loop_wakeups_once(runner, now=time.time())
    adapter.handle_message.assert_not_awaited()

    runner.session_store.entry.resume_pending = False
    await GatewayRunner._fire_due_loop_wakeups_once(runner, now=time.time())
    adapter.handle_message.assert_awaited_once()
    assert "wakeup #1" in adapter.handle_message.await_args.args[0].text


@pytest.mark.asyncio
async def test_gateway_scan_does_not_reclaim_adapter_owned_session(loop_env):
    runner = _make_runner()
    await GatewayRunner._handle_loop_command(runner, _make_event("/loop 5m poll CI"))
    mgr = loops.LoopManager(session_id="sid-gateway-loop")
    mgr.state.next_due_at = time.time() - 1
    mgr.fire_tick()
    mgr.state.next_due_at = time.time() - 1
    loops.save_loop(mgr.session_id, mgr.state)

    adapter = type("Adapter", (), {})()
    adapter.handle_message = AsyncMock()
    adapter.has_active_or_pending_session = lambda _key: True
    runner._profile_adapters = {"work": {Platform.DISCORD: adapter}}

    await GatewayRunner._fire_due_loop_wakeups_once(runner, now=time.time())

    adapter.handle_message.assert_not_awaited()
    state = loops.LoopManager("sid-gateway-loop").state
    assert state.awaiting_response is True
    assert state.ticks_fired == 1


@pytest.mark.asyncio
async def test_gateway_scan_never_falls_back_to_default_profile_discord(loop_env):
    runner = _make_runner()
    await GatewayRunner._handle_loop_command(runner, _make_event("/loop 5m poll CI"))
    mgr = loops.LoopManager(session_id="sid-gateway-loop")
    mgr.state.next_due_at = time.time() - 1
    loops.save_loop(mgr.session_id, mgr.state)

    default_adapter = type("Adapter", (), {})()
    default_adapter.handle_message = AsyncMock()
    runner.adapters = {Platform.DISCORD: default_adapter}

    await GatewayRunner._fire_due_loop_wakeups_once(runner, now=time.time())

    default_adapter.handle_message.assert_not_awaited()
    assert loops.LoopManager("sid-gateway-loop").state.awaiting_response is False


@pytest.mark.asyncio
async def test_gateway_scan_uses_shared_relay_for_profile_discord(loop_env):
    runner = _make_runner()
    await GatewayRunner._handle_loop_command(runner, _make_event("/loop 5m poll CI"))
    mgr = loops.LoopManager(session_id="sid-gateway-loop")
    mgr.state.next_due_at = time.time() - 1
    loops.save_loop(mgr.session_id, mgr.state)

    relay = type("Relay", (), {})()
    relay.fronts_platform = lambda platform: platform == Platform.DISCORD
    relay.handle_message = AsyncMock()
    relay.prime_routing_cache = None
    runner.adapters = {Platform.RELAY: relay}
    runner.config.platforms = {
        Platform.RELAY: PlatformConfig(enabled=True, token="token")
    }

    await GatewayRunner._fire_due_loop_wakeups_once(runner, now=time.time())

    relay.handle_message.assert_awaited_once()
    wake = relay.handle_message.await_args.args[0]
    assert wake.source.delivered_via_upstream_relay is True
    assert wake.source.platform == Platform.DISCORD
    assert wake.source.profile == "work"


@pytest.mark.asyncio
async def test_loop_watcher_scans_each_multiplex_profile(tmp_path, monkeypatch):
    runner = _make_runner()
    runner.config.multiplex_profiles = True
    runner._running = True
    homes = [("alpha", tmp_path / "alpha"), ("beta", tmp_path / "beta")]
    for _, home in homes:
        home.mkdir()
    monkeypatch.setattr("gateway.run._multiplex_profile_homes", lambda _cfg: homes)

    seen = []

    async def scan_once(*, profile_name=None, now=None, warned_no_route=None):
        seen.append((profile_name, get_hermes_home()))
        if len(seen) == len(homes):
            runner._running = False

    runner._fire_due_loop_wakeups_once = scan_once
    await GatewayRunner._loop_wakeup_watcher(runner, interval=0)

    assert seen == [(name, home) for name, home in homes]


@pytest.mark.asyncio
async def test_post_turn_loop_completion_noop_without_inflight_tick(loop_env):
    runner = _make_runner()
    await GatewayRunner._handle_loop_command(runner, _make_event("/loop 5m poll CI"))
    entry = _FakeSessionEntry()
    # No tick fired — the ordinary user turn must not consume loop state.
    await GatewayRunner._post_turn_loop_completion(
        runner,
        session_entry=entry,
        source=None,
        final_response="regular reply LOOP_COMPLETE",
    )
    reloaded = loops.load_loop("sid-gateway-loop")
    assert reloaded.status == "active"
    assert reloaded.ticks_fired == 0


def test_streamed_already_sent_none_recovers_text_for_hooks():
    """Streamed turns return None. Hooks must still see the delivered reply."""
    event = _make_event("wakeup")
    event._streamed_final_response = "CI is green.\nLOOP_COMPLETE"
    assert GatewayRunner._final_text_for_post_turn_hooks(None, event) == (
        "CI is green.\nLOOP_COMPLETE"
    )
    assert GatewayRunner._final_text_for_post_turn_hooks(None, _make_event("x")) == ""
    assert (
        GatewayRunner._final_text_for_post_turn_hooks(
            {"final_response": "from dict"}, event
        )
        == "from dict"
    )


@pytest.mark.asyncio
async def test_streamed_already_sent_completes_loop_tick(loop_env):
    """A streamed wakeup must not leave awaiting_response stuck."""
    runner = _make_runner()
    await GatewayRunner._handle_loop_command(runner, _make_event("/loop 5m poll CI"))

    mgr = loops.LoopManager(session_id="sid-gateway-loop")
    mgr.state.next_due_at = time.time() - 1
    assert mgr.fire_tick() is not None
    claim_id = mgr.state.claim_id
    assert mgr.state.awaiting_response is True
    assert mgr.is_due() is False

    event = _make_event("wakeup")
    event._streamed_final_response = "CI is done.\nLOOP_COMPLETE"
    # Same inputs the already_sent branch leaves for _handle_message.
    final_text = GatewayRunner._final_text_for_post_turn_hooks(None, event)
    assert final_text.strip()

    await GatewayRunner._post_turn_loop_completion(
        runner,
        session_entry=_FakeSessionEntry(),
        source=None,
        final_response=final_text,
        claim_id=claim_id,
    )
    reloaded = loops.load_loop("sid-gateway-loop")
    assert reloaded.awaiting_response is False
    assert reloaded.status == "done"


@pytest.mark.asyncio
async def test_empty_agent_result_releases_inflight_loop_tick(loop_env):
    runner = _make_runner()
    await GatewayRunner._handle_loop_command(runner, _make_event("/loop 5m poll CI"))

    mgr = loops.LoopManager(session_id="sid-gateway-loop")
    mgr.state.next_due_at = time.time() - 1
    assert mgr.fire_tick() is not None
    claim_id = mgr.state.claim_id
    assert mgr.state.awaiting_response is True

    runner._post_turn_goal_continuation = AsyncMock()
    await GatewayRunner._run_post_turn_hooks(
        runner,
        agent_result={"final_response": ""},
        source=_make_event("wakeup").source,
        is_internal=True,
        loop_claim_id=claim_id,
    )

    runner._post_turn_goal_continuation.assert_not_awaited()
    reloaded = loops.load_loop("sid-gateway-loop")
    assert reloaded.awaiting_response is False
    assert reloaded.status == "active"
    assert reloaded.next_due_at > time.time()


@pytest.mark.asyncio
async def test_goal_hook_failure_does_not_block_loop_completion(loop_env, caplog):
    runner = _make_runner()
    await GatewayRunner._handle_loop_command(runner, _make_event("/loop 5m poll CI"))

    mgr = loops.LoopManager(session_id="sid-gateway-loop")
    mgr.state.next_due_at = time.time() - 1
    assert mgr.fire_tick() is not None
    claim_id = mgr.state.claim_id

    runner._post_turn_goal_continuation = AsyncMock(side_effect=RuntimeError("judge failed"))
    with caplog.at_level(logging.DEBUG, logger="gateway.run"):
        await GatewayRunner._run_post_turn_hooks(
            runner,
            agent_result={"final_response": "still working"},
            source=_make_event("wakeup").source,
            is_internal=True,
            loop_claim_id=claim_id,
        )

    reloaded = loops.load_loop("sid-gateway-loop")
    assert reloaded.awaiting_response is False
    assert "goal continuation hook failed: judge failed" in caplog.text


@pytest.mark.asyncio
async def test_post_turn_session_resolution_failure_is_logged(loop_env, caplog):
    runner = _make_runner()
    runner.session_store.get_or_create_session = Mock(side_effect=RuntimeError("store unavailable"))

    with caplog.at_level(logging.DEBUG, logger="gateway.run"):
        await GatewayRunner._run_post_turn_hooks(
            runner,
            agent_result={"final_response": ""},
            source=_make_event("wakeup").source,
            is_internal=True,
        )

    assert "post-turn session resolution failed: store unavailable" in caplog.text
