"""Synthetic acceptance must not inherit a developer's conversation inputs."""
import importlib.util
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "runtime_capture_env", Path(__file__).parents[1] / "scripts/maintainer_runtime.py"
)
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


@pytest.fixture
def environment(tmp_path, monkeypatch):
    profile = tmp_path / "profile"
    profile.mkdir()
    (profile / ".env").write_text('OPENROUTER_API_KEY="synthetic-key"\n', encoding="utf-8")
    candidate = tmp_path / "candidate"
    candidate.mkdir()
    monkeypatch.setattr(runtime, "SYNTHETIC_PROFILE", profile)
    return profile, candidate


def test_unknown_inherited_inputs_are_not_forwarded(environment, monkeypatch):
    _, candidate = environment
    for key in (
        "HERMES_TUI_QUERY", "HERMES_TUI_PROMPT", "HERMES_TUI_IMAGE",
        "HERMES_TUI_RESUME", "HERMES_TUI_GATEWAY_URL", "HERMES_TUI_FAKE",
        "HERMES_TUI_ACTIVE_SESSION_FILE", "HERMES_SESSION_ID", "HERMES_UI_SESSION_ID",
        "HERMES_SESSION_SOURCE", "HERMES_TUI_DIR", "HERMES_ACCEPT_HOOKS",
        "HERMES_TUI_SKILLS", "HERMES_TUI_FUTURE_PRIVATE_INPUT",
        "NODE_OPTIONS", "LD_PRELOAD", "PYTHONSTARTUP", "PYTHONHOME",
        "OPENAI_API_KEY", "OPENROUTER_API_KEY", "TERMINAL_CWD", "PWD",
    ):
        monkeypatch.setenv(key, "private-untrusted-input")
    env = runtime._synthetic_capture_environment(candidate)
    assert "private-untrusted-input" not in env.values()
    assert env["HERMES_HOME"] == str(environment[0])
    assert env["TERMINAL_CWD"] == str(candidate)


@pytest.mark.parametrize("relative", [".env", ".op.env"])
def test_candidate_dotenv_cannot_reintroduce_startup_inputs(environment, relative):
    _, candidate = environment
    (candidate / relative).write_text("HERMES_TUI_QUERY=private\n", encoding="utf-8")
    with pytest.raises(runtime.ControlError, match="dotenv"):
        runtime._synthetic_capture_environment(candidate)


@pytest.mark.parametrize("content", [
    "OPENROUTER_API_KEY=allowed\nHERMES_TUI_QUERY=private\n",
    "export HERMES_TUI_GATEWAY_URL=wss://private.invalid\n",
    "OPENROUTER_API_KEY=allowed\nOTHER_API_KEY=wrong-profile\n",
])
def test_profile_dotenv_only_allows_provisioned_openrouter_key(environment, content):
    profile, candidate = environment
    (profile / ".env").write_text(content, encoding="utf-8")
    with pytest.raises(runtime.ControlError, match="dotenv"):
        runtime._synthetic_capture_environment(candidate)


def test_profile_extra_secret_source_is_rejected(environment):
    profile, candidate = environment
    (profile / ".op.env").write_text("OP_SERVICE_ACCOUNT_TOKEN=private\n", encoding="utf-8")
    with pytest.raises(runtime.ControlError, match="dotenv"):
        runtime._synthetic_capture_environment(candidate)


def test_unsupported_input_added_after_sanitization_cannot_receive_scope(environment):
    _, candidate = environment
    env = runtime._synthetic_capture_environment(candidate)
    actions = [{"send": ["text:/help", "enter"]}]
    assert runtime._synthetic_capture_scope(env, actions, candidate) is not None
    env["HERMES_TUI_FUTURE_PRIVATE_INPUT"] = "private"
    assert runtime._synthetic_capture_scope(env, actions, candidate) is None
