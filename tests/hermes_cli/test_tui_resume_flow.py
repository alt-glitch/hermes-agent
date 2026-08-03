from argparse import Namespace
import os
from pathlib import Path
import subprocess
import sys
import textwrap
import types

import pytest


def _args(**overrides):
    base = {
        "continue_last": None,
        "model": None,
        "provider": None,
        "resume": None,
        "toolsets": None,
        "tui": True,
        "tui_dev": False,
    }
    base.update(overrides)
    return Namespace(**base)


def _raise_exit(rc):
    raise SystemExit(rc)


@pytest.fixture
def main_mod(monkeypatch):
    import hermes_cli.main as mod

    monkeypatch.setattr(mod, "_has_any_provider_configured", lambda: True)
    # Reset the idempotency guard so each test starts fresh.
    monkeypatch.setattr(mod, "_oneshot_cleanup_done", False)
    return mod


def test_cmd_chat_tui_continue_uses_latest_tui_session(monkeypatch, main_mod):
    calls = []
    captured = {}

    def fake_resolve_last(source="cli"):
        calls.append(source)
        return "20260408_235959_a1b2c3" if source == "tui" else None

    def fake_launch(
        resume_session_id=None,
        tui_dev=False,
        model=None,
        provider=None,
        toolsets=None,
        **kwargs,
    ):
        captured["resume"] = resume_session_id
        raise SystemExit(0)

    monkeypatch.setattr(main_mod, "_resolve_last_session", fake_resolve_last)
    monkeypatch.setattr(main_mod, "_resolve_session_by_name_or_id", lambda val: val)
    monkeypatch.setattr(main_mod, "_launch_tui", fake_launch)

    with pytest.raises(SystemExit):
        main_mod.cmd_chat(_args(continue_last=True))

    assert calls == ["tui"]
    assert captured["resume"] == "20260408_235959_a1b2c3"


def test_cmd_chat_tui_continue_falls_back_to_latest_cli_session(monkeypatch, main_mod):
    calls = []
    captured = {}

    def fake_resolve_last(source="cli"):
        calls.append(source)
        if source == "tui":
            return None
        if source == "cli":
            return "20260408_235959_d4e5f6"
        return None

    def fake_launch(
        resume_session_id=None,
        tui_dev=False,
        model=None,
        provider=None,
        toolsets=None,
        **kwargs,
    ):
        captured["resume"] = resume_session_id
        raise SystemExit(0)

    monkeypatch.setattr(main_mod, "_resolve_last_session", fake_resolve_last)
    monkeypatch.setattr(main_mod, "_resolve_session_by_name_or_id", lambda val: val)
    monkeypatch.setattr(main_mod, "_launch_tui", fake_launch)

    with pytest.raises(SystemExit):
        main_mod.cmd_chat(_args(continue_last=True))

    assert calls == ["tui", "cli"]
    assert captured["resume"] == "20260408_235959_d4e5f6"


def test_cmd_chat_tui_resume_resolves_title_before_launch(monkeypatch, main_mod):
    captured = {}

    def fake_launch(
        resume_session_id=None,
        tui_dev=False,
        model=None,
        provider=None,
        toolsets=None,
        **kwargs,
    ):
        captured["resume"] = resume_session_id
        raise SystemExit(0)

    monkeypatch.setattr(
        main_mod, "_resolve_session_by_name_or_id", lambda val: "20260409_000000_aa11bb"
    )
    monkeypatch.setattr(main_mod, "_launch_tui", fake_launch)

    with pytest.raises(SystemExit):
        main_mod.cmd_chat(_args(resume="my t0p session"))

    assert captured["resume"] == "20260409_000000_aa11bb"


def test_bare_resume_parses_to_picker_sentinel():
    from hermes_cli._parser import build_top_level_parser

    parser, _subparsers, _chat_parser = build_top_level_parser()

    args = parser.parse_args(["--tui", "--resume"])
    assert args.resume is True

    args = parser.parse_args(["--resume", "abc123"])
    assert args.resume == "abc123"

    args = parser.parse_args(["chat", "--tui", "--resume"])
    assert args.resume is True


def test_cmd_chat_tui_bare_resume_skips_resolution_and_launches_picker(
    monkeypatch, main_mod
):
    captured = {}

    def fake_launch(resume_session_id=None, **kwargs):
        captured["resume"] = resume_session_id
        raise SystemExit(0)

    def boom(_val):
        raise AssertionError("bare --resume must not hit name/id resolution")

    monkeypatch.setattr(main_mod, "_resolve_session_by_name_or_id", boom)
    monkeypatch.setattr(main_mod, "_launch_tui", fake_launch)

    with pytest.raises(SystemExit):
        main_mod.cmd_chat(_args(resume=True))

    assert captured["resume"] is True


def test_cmd_chat_bare_resume_without_tui_exits_with_guidance(
    monkeypatch, capsys, main_mod
):
    monkeypatch.setattr(main_mod, "_resolve_use_tui", lambda args: False)
    monkeypatch.setattr(
        main_mod,
        "_launch_tui",
        lambda *a, **kw: pytest.fail("must not launch the TUI"),
    )

    with pytest.raises(SystemExit) as exc:
        main_mod.cmd_chat(_args(tui=False, resume=True))

    assert exc.value.code == 2
    out = capsys.readouterr().out
    assert "requires the TUI" in out
    assert "hermes --tui --resume" in out


def test_launch_tui_sets_picker_env_for_bare_resume(monkeypatch, main_mod):
    captured = {}

    monkeypatch.setenv("HERMES_TUI_RESUME", "stale-missing-session")
    monkeypatch.setattr(
        main_mod,
        "_make_tui_argv",
        lambda tui_dir, tui_dev: (["node", "dist/entry.js"], Path(".")),
    )
    monkeypatch.setattr(
        main_mod.subprocess,
        "call",
        lambda argv, cwd=None, env=None: captured.update({"env": env}) or 1,
    )

    with pytest.raises(SystemExit):
        main_mod._launch_tui(resume_session_id=True)

    assert captured["env"]["HERMES_TUI_RESUME"] == "picker"


def test_cmd_chat_tui_passes_model_and_provider(monkeypatch, main_mod):
    captured = {}

    def fake_launch(
        resume_session_id=None,
        tui_dev=False,
        model=None,
        provider=None,
        toolsets=None,
        **kwargs,
    ):
        captured.update(
            {
                "model": model,
                "provider": provider,
                "resume": resume_session_id,
                "toolsets": toolsets,
                "tui_dev": tui_dev,
            }
        )
        raise SystemExit(0)

    monkeypatch.setattr(main_mod, "_launch_tui", fake_launch)

    with pytest.raises(SystemExit):
        main_mod.cmd_chat(
            _args(model="anthropic/claude-sonnet-4.6", provider="anthropic")
        )

    assert captured == {
        "model": "anthropic/claude-sonnet-4.6",
        "provider": "anthropic",
        "resume": None,
        "toolsets": None,
        "tui_dev": False,
    }


def test_cmd_chat_tui_passes_toolsets(monkeypatch, main_mod):
    captured = {}

    def fake_launch(
        resume_session_id=None,
        tui_dev=False,
        model=None,
        provider=None,
        toolsets=None,
        **kwargs,
    ):
        captured["toolsets"] = toolsets
        raise SystemExit(0)

    monkeypatch.setattr(main_mod, "_launch_tui", fake_launch)

    with pytest.raises(SystemExit):
        main_mod.cmd_chat(_args(toolsets="web,terminal"))

    assert captured["toolsets"] == "web,terminal"


def test_cmd_chat_tui_forwards_chat_flags(monkeypatch, main_mod):
    captured = {}

    def fake_launch(resume_session_id=None, **kwargs):
        captured["resume_session_id"] = resume_session_id
        captured.update(kwargs)
        raise SystemExit(0)

    monkeypatch.setattr(main_mod, "_launch_tui", fake_launch)

    with pytest.raises(SystemExit):
        main_mod.cmd_chat(
            _args(
                skills=["foo,bar"],
                verbose=True,
                quiet=True,
                query="hello",
                image="/tmp/cat.png",
                worktree=True,
                checkpoints=True,
                pass_session_id=True,
                max_turns=7,
                accept_hooks=True,
            )
        )

    assert captured["skills"] == ["foo,bar"]
    assert captured["verbose"] is True
    assert captured["quiet"] is True
    assert captured["query"] == "hello"
    assert captured["image"] == "/tmp/cat.png"
    assert captured["worktree"] is True
    assert captured["checkpoints"] is True
    assert captured["pass_session_id"] is True
    assert captured["max_turns"] == 7
    assert captured["accept_hooks"] is True


def test_main_top_level_tui_accepts_toolsets(monkeypatch, main_mod):
    captured = {}

    import hermes_cli.config as config_mod

    monkeypatch.setattr(sys, "argv", ["hermes", "--tui", "--toolsets", "web,terminal"])
    monkeypatch.setitem(
        sys.modules,
        "hermes_cli.plugins",
        types.SimpleNamespace(discover_plugins=lambda: None),
    )
    monkeypatch.setitem(
        sys.modules,
        "tools.mcp_tool",
        types.SimpleNamespace(discover_mcp_tools=lambda: None),
    )
    monkeypatch.setattr(config_mod, "load_config", lambda: {})
    monkeypatch.setattr(config_mod, "get_container_exec_info", lambda: None)
    monkeypatch.setitem(
        sys.modules,
        "agent.shell_hooks",
        types.SimpleNamespace(
            register_from_config=lambda _cfg, accept_hooks=False: None
        ),
    )
    monkeypatch.setattr(
        main_mod,
        "cmd_chat",
        lambda args: captured.update({"toolsets": args.toolsets, "tui": args.tui}),
    )

    main_mod.main()

    assert captured == {"toolsets": "web,terminal", "tui": True}


def test_termux_fast_tui_launch_uses_light_parser(monkeypatch, main_mod):
    captured = {}

    monkeypatch.setenv("TERMUX_VERSION", "1")
    monkeypatch.setattr(
        sys, "argv", ["hermes", "--tui", "--toolsets", "web,terminal"]
    )
    monkeypatch.setattr(
        main_mod,
        "cmd_chat",
        lambda args: captured.update({"toolsets": args.toolsets, "tui": args.tui}),
    )

    assert main_mod._try_termux_fast_tui_launch() is True
    assert captured == {"toolsets": "web,terminal", "tui": True}


def test_termux_fast_tui_launch_skips_help(monkeypatch, main_mod):
    monkeypatch.setenv("TERMUX_VERSION", "1")
    monkeypatch.setattr(sys, "argv", ["hermes", "--tui", "--help"])

    assert main_mod._try_termux_fast_tui_launch() is False


def test_fast_tui_launch_is_termux_only(monkeypatch, main_mod):
    monkeypatch.delenv("TERMUX_VERSION", raising=False)
    monkeypatch.setenv("PREFIX", "/usr")
    monkeypatch.setattr(sys, "argv", ["hermes", "--tui"])

    assert main_mod._try_termux_fast_tui_launch() is False


def test_termux_fast_cli_launch_chat_uses_light_parser(monkeypatch, main_mod):
    captured = {}
    prepared = []

    monkeypatch.setenv("TERMUX_VERSION", "1")
    monkeypatch.delenv("HERMES_TUI", raising=False)
    monkeypatch.setattr(
        sys, "argv", ["hermes", "chat", "-q", "hello", "--toolsets", "web,terminal"]
    )
    monkeypatch.setattr(
        main_mod, "_prepare_agent_startup", lambda args: prepared.append(args.command)
    )
    monkeypatch.setattr(
        main_mod,
        "cmd_chat",
        lambda args: captured.update(
            {"query": args.query, "toolsets": args.toolsets, "command": args.command}
        ),
    )

    assert main_mod._try_termux_fast_cli_launch() is True
    assert prepared == ["chat"]
    assert captured == {
        "query": "hello",
        "toolsets": "web,terminal",
        "command": "chat",
    }


def test_termux_fast_cli_launch_bare_defers_agent_startup(monkeypatch, main_mod):
    captured = {}
    prepared = []

    monkeypatch.setenv("TERMUX_VERSION", "1")
    monkeypatch.delenv("HERMES_TUI", raising=False)
    monkeypatch.delenv("HERMES_DEFER_AGENT_STARTUP", raising=False)
    monkeypatch.delenv("HERMES_FAST_STARTUP_BANNER", raising=False)
    monkeypatch.setattr(sys, "argv", ["hermes"])
    monkeypatch.setattr(
        main_mod, "_prepare_agent_startup", lambda args: prepared.append(args.command)
    )
    monkeypatch.setattr(
        main_mod,
        "cmd_chat",
        lambda args: captured.update(
            {
                "query": args.query,
                "command": args.command,
                "compact": getattr(args, "compact", False),
            }
        ),
    )

    assert main_mod._try_termux_fast_cli_launch() is True
    assert prepared == []
    assert captured == {"query": None, "command": None, "compact": True}
    assert os.environ["HERMES_DEFER_AGENT_STARTUP"] == "1"
    assert os.environ["HERMES_FAST_STARTUP_BANNER"] == "1"


def test_termux_fast_cli_launch_oneshot_uses_light_parser(monkeypatch, main_mod):
    captured = {}
    prepared = []

    monkeypatch.setenv("TERMUX_VERSION", "1")
    monkeypatch.delenv("HERMES_TUI", raising=False)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "hermes",
            "-z",
            "hello",
            "--model",
            "gpt-test",
            "--provider",
            "openai",
            "--usage-file",
            "usage.json",
        ],
    )
    monkeypatch.setattr(
        main_mod, "_prepare_agent_startup", lambda args: prepared.append(args.command)
    )
    monkeypatch.setitem(
        sys.modules,
        "hermes_cli.oneshot",
        types.SimpleNamespace(
            run_oneshot=lambda prompt, **kwargs: captured.update(
                {"prompt": prompt, **kwargs}
            )
            or 17
        ),
    )
    monkeypatch.setattr(
        main_mod,
        "_exit_after_oneshot",
        _raise_exit,
    )

    with pytest.raises(SystemExit) as exc:
        main_mod._try_termux_fast_cli_launch()

    assert exc.value.code == 17
    assert prepared == [None]
    assert captured == {
        "prompt": "hello",
        "model": "gpt-test",
        "provider": "openai",
        "toolsets": None,
        "usage_file": "usage.json",
    }


def test_termux_fast_cli_launch_version_skips_update_check(monkeypatch, main_mod):
    captured = []

    monkeypatch.setenv("TERMUX_VERSION", "1")
    monkeypatch.delenv("HERMES_TUI", raising=False)
    monkeypatch.setattr(sys, "argv", ["hermes", "version"])
    monkeypatch.setattr(
        main_mod, "_print_version_info", lambda *, check_updates: captured.append(check_updates)
    )

    assert main_mod._try_termux_fast_cli_launch() is True
    assert captured == [False]


def test_termux_ultrafast_version_runs_before_heavy_startup(
    monkeypatch, capsys, main_mod
):
    monkeypatch.setenv("TERMUX_VERSION", "1")
    monkeypatch.delenv("HERMES_TERMUX_DISABLE_FAST_CLI", raising=False)
    monkeypatch.setattr(sys, "argv", ["hermes", "--version"])

    assert main_mod._try_termux_ultrafast_version() is True

    out = capsys.readouterr().out
    assert "Hermes Agent v" in out
    assert "Install directory:" in out
    assert "Python:" in out
    assert "OpenAI SDK:" in out


def test_read_openai_version_fast(monkeypatch, tmp_path, main_mod):
    package_dir = tmp_path / "openai"
    package_dir.mkdir()
    (package_dir / "_version.py").write_text(
        '__version__ = "9.8.7"  # x-release-please-version\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(sys, "path", [str(tmp_path)])

    assert main_mod._read_openai_version_fast() == "9.8.7"


def test_termux_fast_cli_launch_skips_help(monkeypatch, main_mod):
    monkeypatch.setenv("TERMUX_VERSION", "1")
    monkeypatch.delenv("HERMES_TUI", raising=False)
    monkeypatch.setattr(sys, "argv", ["hermes", "chat", "--help"])

    assert main_mod._try_termux_fast_cli_launch() is False


def test_termux_fast_cli_launch_can_be_disabled(monkeypatch, main_mod):
    monkeypatch.setenv("TERMUX_VERSION", "1")
    monkeypatch.setenv("HERMES_TERMUX_DISABLE_FAST_CLI", "1")
    monkeypatch.delenv("HERMES_TUI", raising=False)
    monkeypatch.setattr(sys, "argv", ["hermes", "version"])

    assert main_mod._try_termux_fast_cli_launch() is False


def test_termux_bundled_skills_stamp_controls_sync(monkeypatch, tmp_path, main_mod):
    monkeypatch.setenv("TERMUX_VERSION", "1")
    monkeypatch.setattr(main_mod, "get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(main_mod, "_termux_bundled_skills_fingerprint", lambda: "fp1")

    assert main_mod._termux_bundled_skills_sync_needed() is True
    main_mod._mark_termux_bundled_skills_synced()
    assert main_mod._termux_bundled_skills_sync_needed() is False

    monkeypatch.setenv("HERMES_TERMUX_FORCE_SKILLS_SYNC", "1")
    assert main_mod._termux_bundled_skills_sync_needed() is True


def test_termux_skips_bundled_skill_sync_when_stamp_fresh(monkeypatch, tmp_path, main_mod):
    calls = []

    monkeypatch.setenv("TERMUX_VERSION", "1")
    monkeypatch.setattr(main_mod, "get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(main_mod, "_termux_bundled_skills_fingerprint", lambda: "fp1")
    main_mod._mark_termux_bundled_skills_synced()
    monkeypatch.setitem(
        sys.modules,
        "tools.skills_sync",
        types.SimpleNamespace(sync_skills=lambda quiet: calls.append(quiet)),
    )

    assert main_mod._sync_bundled_skills_for_startup() is False
    assert calls == []






def test_exit_after_oneshot_flushes_stdio_and_calls_os_exit(
    monkeypatch, main_mod
):
    flushed = []
    exits = []

    class FakeStream:
        def __init__(self, name):
            self.name = name

        def flush(self):
            flushed.append(self.name)

    def fake_exit(rc):
        exits.append(rc)
        raise SystemExit(rc)

    monkeypatch.setattr(main_mod.sys, "stdout", FakeStream("stdout"))
    monkeypatch.setattr(main_mod.sys, "stderr", FakeStream("stderr"))
    monkeypatch.setattr(main_mod.os, "_exit", fake_exit)
    monkeypatch.setattr("logging.shutdown", lambda: None)

    with pytest.raises(SystemExit) as exc:
        main_mod._exit_after_oneshot(17)

    assert exc.value.code == 17
    assert exits == [17]
    assert flushed == ["stdout", "stderr"]






def test_oneshot_subprocess_exits_without_teardown_abort():
    program = textwrap.dedent(
        """
        import hermes_cli.oneshot as oneshot
        from hermes_cli.main import _exit_after_oneshot

        oneshot._run_agent = lambda *args, **kwargs: ("ok", {"final_response": "ok"})
        _exit_after_oneshot(oneshot.run_oneshot("hello"))
        """
    )

    result = subprocess.run(
        [sys.executable, "-c", program],
        cwd=Path(__file__).resolve().parents[2],
        capture_output=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0
    assert result.stdout == b"ok\n"
    # Don't demand byte-empty stderr — an import-time warning from the heavy
    # CLI import chain shouldn't fail this. What matters is no crash traceback.
    assert b"Traceback" not in result.stderr








def _stub_plugin_discovery(monkeypatch):
    monkeypatch.setitem(
        sys.modules,
        "hermes_cli.plugins",
        types.SimpleNamespace(discover_plugins=lambda: None),
    )




def test_oneshot_wires_session_db_for_recall(monkeypatch):
    """hermes -z bypasses HermesCLI, but recall still needs SessionDB."""
    from hermes_cli.oneshot import _run_agent

    captured = {}
    sentinel_db = object()

    class FakeAgent:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.suppress_status_output = False
            self.stream_delta_callback = object()
            self.tool_gen_callback = object()

        def run_conversation(self, prompt, **_kwargs):
            captured["prompt"] = prompt
            return {"final_response": "ok", "failed": False, "partial": False}

    class FakeSessionDB:
        def __new__(cls):
            return sentinel_db

    def mod(name, **attrs):
        module = types.ModuleType(name)
        for key, value in attrs.items():
            setattr(module, key, value)
        return module

    monkeypatch.setitem(sys.modules, "run_agent", mod("run_agent", AIAgent=FakeAgent))
    monkeypatch.setitem(sys.modules, "hermes_state", mod("hermes_state", SessionDB=FakeSessionDB))
    monkeypatch.setitem(
        sys.modules,
        "hermes_cli.config",
        mod("hermes_cli.config", load_config=lambda: {"model": {"default": "m"}}),
    )
    monkeypatch.setitem(
        sys.modules,
        "hermes_cli.models",
        mod("hermes_cli.models", detect_provider_for_model=lambda *_args, **_kwargs: None),
    )
    monkeypatch.setitem(
        sys.modules,
        "hermes_cli.runtime_provider",
        mod(
            "hermes_cli.runtime_provider",
            resolve_runtime_provider=lambda **_kwargs: {
                "api_key": "k",
                "base_url": "u",
                "provider": "p",
                "api_mode": "chat_completions",
                "credential_pool": None,
            },
        ),
    )
    monkeypatch.setitem(
        sys.modules,
        "hermes_cli.tools_config",
        mod("hermes_cli.tools_config", _get_platform_tools=lambda *_args, **_kwargs: {"session_search"}),
    )

    text, result = _run_agent("recall this")
    assert text == "ok"
    assert not result.get("failed")
    assert captured["session_db"] is sentinel_db
    assert captured["enabled_toolsets"] == ["session_search"]
    assert captured["prompt"] == "recall this"


def test_launch_tui_exports_model_provider_and_toolsets(monkeypatch, main_mod):
    captured = {}
    active_path_during_call = None

    monkeypatch.setattr(
        main_mod,
        "_make_tui_argv",
        lambda tui_dir, tui_dev: (["node", "dist/entry.js"], Path(".")),
    )

    def fake_call(argv, cwd=None, env=None):
        nonlocal active_path_during_call
        captured.update({"argv": argv, "cwd": cwd, "env": env})
        active_path_during_call = Path(env["HERMES_TUI_ACTIVE_SESSION_FILE"])
        assert active_path_during_call.exists()
        return 1

    monkeypatch.setattr(main_mod.subprocess, "call", fake_call)

    with pytest.raises(SystemExit):
        main_mod._launch_tui(
            model="nous/hermes-test", provider="nous", toolsets="web, terminal"
        )

    env = captured["env"]
    assert env["HERMES_MODEL"] == "nous/hermes-test"
    assert env["HERMES_INFERENCE_MODEL"] == "nous/hermes-test"
    assert env["HERMES_TUI_PROVIDER"] == "nous"
    assert env["HERMES_INFERENCE_PROVIDER"] == "nous"
    assert env["HERMES_TUI_TOOLSETS"] == "web,terminal"
    active_path = Path(env["HERMES_TUI_ACTIVE_SESSION_FILE"])
    assert active_path.name.startswith("hermes-tui-active-session-")
    assert active_path.suffix == ".json"
    assert active_path_during_call == active_path
    assert not active_path.exists()
    assert env["NODE_ENV"] == "production"




def test_make_tui_argv_dev_prebuilds_hermes_ink(monkeypatch, main_mod, tmp_path):
    tui_dir = tmp_path / "ui-tui"
    tsx = tui_dir / "node_modules" / ".bin" / "tsx"
    ink_dir = tui_dir / "packages" / "hermes-ink"
    tsx.parent.mkdir(parents=True)
    ink_dir.mkdir(parents=True)
    tsx.write_text("#!/usr/bin/env node\n", encoding="utf-8")

    monkeypatch.setattr(main_mod, "_ensure_tui_node", lambda: None)
    monkeypatch.setattr(main_mod, "_tui_need_npm_install", lambda _tui_dir: False)
    monkeypatch.delenv("HERMES_TUI_DIR", raising=False)
    monkeypatch.setattr(main_mod.shutil, "which", lambda bin_name: f"/usr/bin/{bin_name}")
    # _make_tui_argv now dispatches on the TUI engine first; resolving "opentui"
    # availability probes `node --version` (a subprocess.run this test would
    # otherwise record). Pin the Ink engine — this test covers the Ink dev path.
    monkeypatch.setattr(main_mod, "_resolve_tui_engine", lambda: "ink")

    calls = []

    def fake_run(cmd, cwd=None, **_kwargs):
        calls.append((cmd, cwd))
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(main_mod.subprocess, "run", fake_run)

    argv, cwd = main_mod._make_tui_argv(tui_dir, tui_dev=True)

    assert argv == [str(tsx), "src/entry.tsx"]
    assert cwd == tui_dir
    assert calls == [(["/usr/bin/npm", "run", "build"], str(ink_dir))]




def test_print_tui_exit_summary_prefers_actual_active_session_file(
    monkeypatch, capsys, tmp_path
):
    import hermes_cli.main as main_mod

    seen = []

    class _FakeDB:
        def get_session(self, session_id):
            seen.append(session_id)
            return {
                "message_count": 1,
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "reasoning_tokens": 0,
            }

        def get_session_title(self, _session_id):
            return "actual"

        def close(self):
            return None

    active = tmp_path / "active.json"
    active.write_text('{"session_id":"actual_session"}', encoding="utf-8")
    monkeypatch.setitem(
        sys.modules, "hermes_state", types.SimpleNamespace(SessionDB=lambda: _FakeDB())
    )

    main_mod._print_tui_exit_summary("startup_resume", str(active))
    out = capsys.readouterr().out

    assert seen == ["actual_session"]
    assert "hermes --tui --resume actual_session" in out
    assert "startup_resume" not in out


def test_print_tui_exit_summary_honors_detached_active_session_tombstone(
    monkeypatch, capsys, tmp_path
):
    """A failed /new after close must not advertise the closed launch session."""
    import hermes_cli.main as main_mod

    active = tmp_path / "active.json"
    active.write_text('{"detached": true, "session_id": null}', encoding="utf-8")

    class _ShouldNotOpenDB:
        def __init__(self, *args, **kwargs):
            raise AssertionError("detached sidecar should return before SessionDB")

    monkeypatch.setitem(
        sys.modules, "hermes_state", types.SimpleNamespace(SessionDB=_ShouldNotOpenDB)
    )

    main_mod._print_tui_exit_summary("closed_launch_session", str(active))

    assert capsys.readouterr().out == ""
