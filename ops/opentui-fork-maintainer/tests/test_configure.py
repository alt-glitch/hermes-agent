from __future__ import annotations

import importlib.util
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from ruamel.yaml import YAML


SCRIPT = Path(__file__).parents[1] / "scripts" / "configure.py"
SPEC = importlib.util.spec_from_file_location("opentui_maintainer_configure", SCRIPT)
assert SPEC and SPEC.loader
configure = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(configure)


def _write_config(path: Path, effort: str = "medium") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"agent:\n  reasoning_effort: {effort}\n", encoding="utf-8")


def _persisted_job_from_update(update: dict) -> dict:
    """Represent an update as the raw shape returned by cron.jobs.get_job."""
    job = {
        key: value
        for key, value in update.items()
        if key not in {"action", "job_id", "schedule"}
    }
    job["id"] = update["job_id"]
    job["schedule"] = {"kind": "cron", "display": update["schedule"]}
    job["schedule_display"] = update["schedule"]
    job["base_url"] = update.get("base_url") or None
    job["workdir"] = str(Path(update["workdir"]).resolve())
    return job


def _stateful_cron(initial: dict) -> tuple[list[dict], dict, object, object]:
    """Small supported-API fake: updates retain the job's paused state."""
    calls: list[dict] = []
    holder = {"job": dict(initial)}

    def cron_call(**kwargs):
        calls.append(kwargs)
        action = kwargs["action"]
        if action == "pause":
            holder["job"].update({"state": "paused", "enabled": False})
        elif action == "resume":
            holder["job"].update({
                "state": "scheduled",
                "enabled": True,
                "next_run_at": "2099-01-01T00:00:00+00:00",
            })
        elif action == "update":
            state = holder["job"].get("state", "scheduled")
            enabled = holder["job"].get("enabled", True)
            next_run_at = holder["job"].get("next_run_at")
            holder["job"] = _persisted_job_from_update(kwargs)
            holder["job"].update({
                "state": state,
                "enabled": enabled,
                "next_run_at": next_run_at,
            })
        job = holder["job"]
        formatted = {
            "job_id": job["id"],
            "name": job.get("name"),
            "prompt_preview": str(job.get("prompt") or "")[:100],
            "enabled": job.get("enabled", True),
            "state": job.get("state"),
            "next_run_at": job.get("next_run_at"),
            "paused_at": job.get("paused_at"),
            "paused_reason": job.get("paused_reason"),
        }
        return json.dumps({"success": True, "job": formatted})

    def read_call(_job_id: str):
        return holder["job"]

    return calls, holder, cron_call, read_call


def _deployment_fixture(tmp_path: Path, monkeypatch):
    source = tmp_path / "source"
    runtime = tmp_path / "runtime"
    hermes_home = tmp_path / "hermes"
    (source / "prompts").mkdir(parents=True)
    (source / "scripts").mkdir()
    (source / "prompts/maintainer.md").write_text("new policy\n")
    for name in (
        "opentui_fork_sync.py",
        "sync_probe.py",
        "maintainer_runtime.py",
        "worktree.sh",
    ):
        (source / "scripts" / name).write_text("new\n")
    _write_config(hermes_home / "config.yaml")
    skill_sources = {}
    for name in configure.MAINTAINER_SKILL_SOURCES:
        skill = tmp_path / "skill-sources" / name
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(f"---\nname: {name}\n---\n")
        skill_sources[name] = skill
    monkeypatch.setattr(configure, "MAINTAINER_SKILL_SOURCES", skill_sources)
    for name in ("codex", "claude-code", "adversarial-review-loop"):
        installed = hermes_home / "skills/other" / name
        installed.mkdir(parents=True)
        (installed / "SKILL.md").write_text(f"---\nname: {name}\n---\n")
    return source, runtime, hermes_home


def _active_prior_job() -> dict:
    return {
        "id": configure.JOB_ID,
        "prompt": "old prompt",
        "schedule_display": "0 1 * * *",
        "name": "old maintainer",
        "deliver": "local",
        "skills": ["codex"],
        "model": "old-model",
        "provider": "openrouter",
        "base_url": None,
        "script": "old_wrapper.py",
        "enabled_toolsets": ["terminal"],
        "workdir": "/old/workdir",
        "no_agent": False,
        "enabled": True,
        "state": "scheduled",
    }


def test_documented_uv_project_apply_reaches_hermes_imports(tmp_path: Path) -> None:
    hermes_home = tmp_path / "hermes"
    runtime_home = tmp_path / "runtime"
    _write_config(hermes_home / "config.yaml")
    repo_root = SCRIPT.parents[3]
    result = subprocess.run(
        [
            "uv",
            "run",
            "--project",
            str(repo_root),
            str(SCRIPT),
            "--apply",
            "--runtime-home",
            str(runtime_home),
            "--hermes-home",
            str(hermes_home),
        ],
        cwd=repo_root,
        env={**__import__("os").environ, "HERMES_HOME": str(hermes_home)},
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 2
    assert "maintainer cron job" in result.stderr
    assert "does not exist" in result.stderr
    assert "ModuleNotFoundError" not in result.stderr
    assert not configure._deployment_journal_path(runtime_home).exists()


def test_bootstrap_is_small_scanner_safe_and_points_to_disk() -> None:
    from tools.cronjob_tools import _scan_cron_prompt

    prompt = configure.bootstrap_prompt(Path("/runtime"))
    assert len(prompt) < 1000
    assert "/runtime/prompts/maintainer.md" in prompt
    assert "/runtime/state/ingest.latest.json" in prompt
    assert not _scan_cron_prompt(prompt)


def test_cron_update_pins_runtime_and_resource_contract() -> None:
    from inspect import signature
    from tools.cronjob_tools import cronjob

    update = configure.cron_update(Path("/runtime"), Path("/hermes"))
    assert set(update) <= set(signature(cronjob).parameters)
    assert update["action"] == "update"
    assert update["job_id"] == "c57fe4db4d43"
    assert update["schedule"] == "0 9,21 * * *"
    assert update["provider"] == "openrouter"
    assert update["model"] == "openai/gpt-5.6-sol"
    assert update["enabled_toolsets"] == [
        "terminal",
        "file",
        "skills",
        "delegation",
        "video",
        "todo",
        "no_mcp",
    ]
    assert update["skills"] == [
        "codex",
        "claude-code",
        "adversarial-review-loop",
        "terminal-control",
        "opentui-tui-engineering",
        "tmux-pane-screenshot",
    ]
    assert update["script"] == "opentui_fork_sync.py"
    assert update["no_agent"] is False


def test_real_update_cannot_create_a_missing_maintainer_job(tmp_path: Path) -> None:
    from cron.jobs import get_job, list_jobs, use_cron_store
    from tools.cronjob_tools import cronjob

    hermes_home = tmp_path / "hermes"
    with use_cron_store(hermes_home):
        result = json.loads(cronjob(**configure.cron_update(tmp_path, hermes_home)))
        assert result["success"] is False
        assert "not found" in result["error"]
        assert get_job(configure.JOB_ID) is None
        assert list_jobs(include_disabled=True) == []


def test_medium_reasoning_is_required_because_job_has_no_effort_field(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.yaml"
    _write_config(config_path, "high")
    with pytest.raises(configure.ConfigurationError, match="must be 'medium'"):
        configure.require_medium_reasoning(config_path)


def test_configure_video_preserves_existing_yaml_and_pins_openrouter(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "# keep me\n"
        "agent:\n"
        "  reasoning_effort: medium\n"
        "auxiliary:\n"
        "  vision:\n"
        "    base_url: http://127.0.0.1:11434/v1\n"
        "    api_key: should-not-survive\n",
        encoding="utf-8",
    )

    configure.configure_video(config_path)

    text = config_path.read_text(encoding="utf-8")
    parsed = YAML(typ="safe").load(text)
    assert "# keep me" in text
    assert parsed["agent"]["reasoning_effort"] == "medium"
    assert parsed["auxiliary"]["vision"]["provider"] == "openrouter"
    assert parsed["auxiliary"]["vision"]["base_url"] == ""
    assert parsed["auxiliary"]["vision"]["api_key"] == ""
    assert parsed["auxiliary"]["video"] == {
        "provider": "openrouter",
        "model": "google/gemini-3.5-flash",
    }


def test_queue_backport_writes_strict_one_shot_request(tmp_path: Path) -> None:
    path = configure.queue_backport(tmp_path, ["ABCDEF1", "abcdef1", "1234567890ab"])
    assert json.loads(path.read_text()) == {
        "mode": "backport",
        "commits": ["abcdef1", "1234567890ab"],
    }
    with pytest.raises(configure.ConfigurationError, match="invalid backport SHA"):
        configure.queue_backport(tmp_path / "other", ["upstream/main; echo nope"])
    with pytest.raises(configure.ConfigurationError, match="already exists"):
        configure.queue_backport(tmp_path, ["fedcba9"])


def test_queue_backport_rejects_inflight_and_serializes_writers(
    tmp_path: Path,
) -> None:
    inflight_home = tmp_path / "inflight"
    inflight = inflight_home / "state/run-request.inflight.json"
    inflight.parent.mkdir(parents=True)
    inflight.write_text('{"mode":"backport","commits":["abcdef1"]}\n')
    with pytest.raises(configure.ConfigurationError, match="in-flight"):
        configure.queue_backport(inflight_home, ["fedcba9"])

    race_home = tmp_path / "race"

    def enqueue(sha: str) -> str:
        try:
            configure.queue_backport(race_home, [sha])
        except configure.ConfigurationError:
            return "rejected"
        return "queued"

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(enqueue, ["abcdef1", "fedcba9"]))
    assert sorted(outcomes) == ["queued", "rejected"]
    persisted = json.loads((race_home / "state/run-request.json").read_text())
    assert persisted["commits"] in (["abcdef1"], ["fedcba9"])


def test_apply_uses_supported_cron_api_after_deploy(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "source"
    runtime = tmp_path / "runtime"
    hermes_home = tmp_path / "hermes"
    (source / "prompts").mkdir(parents=True)
    (source / "scripts").mkdir()
    (source / "prompts/maintainer.md").write_text("policy\n")
    (source / "scripts/opentui_fork_sync.py").write_text("#!/usr/bin/env python3\n")
    (source / "scripts/sync_probe.py").write_text("#!/usr/bin/env python3\n")
    (source / "scripts/maintainer_runtime.py").write_text("#!/usr/bin/env python3\n")
    (source / "scripts/worktree.sh").write_text("#!/usr/bin/env bash\n")
    _write_config(hermes_home / "config.yaml")

    skill_sources = {}
    for name in configure.MAINTAINER_SKILL_SOURCES:
        path = tmp_path / "skills" / name
        path.mkdir(parents=True)
        (path / "SKILL.md").write_text(f"---\nname: {name}\n---\n")
        skill_sources[name] = path
    monkeypatch.setattr(configure, "MAINTAINER_SKILL_SOURCES", skill_sources)

    existing = {
        "codex": hermes_home / "skills/autonomous-ai-agents/codex",
        "claude-code": hermes_home / "skills/autonomous-ai-agents/claude-code",
        "adversarial-review-loop": hermes_home
        / "skills/software-development/adversarial-review-loop",
    }
    for name, path in existing.items():
        path.mkdir(parents=True)
        (path / "SKILL.md").write_text(f"---\nname: {name}\n---\n")

    initial_job = {
        "id": configure.JOB_ID,
        "state": "scheduled",
        "enabled": True,
        "prompt": "old",
        "schedule_display": "0 1 * * *",
    }
    calls, _holder, fake_cron, read_cron = _stateful_cron(initial_job)

    result = configure.apply_configuration(
        source_home=source,
        runtime_home=runtime,
        hermes_home=hermes_home,
        cron_call=fake_cron,
        cron_snapshot_call=read_cron,
        cron_read_call=read_cron,
    )

    assert result["success"] is True
    assert result["job"]["job_id"] == configure.JOB_ID
    assert "prompt" not in result["job"]
    assert result["job"]["state"] == "scheduled"
    assert result["job"]["enabled"] is True
    assert result["job"]["next_run_at"]
    assert [call["action"] for call in calls] == ["pause", "update", "resume"]
    assert calls[1] == configure.cron_update(runtime, hermes_home)
    assert (runtime / "prompts/maintainer.md").read_text() == "policy\n"
    assert (runtime / "scripts/opentui_fork_sync.py").is_file()
    assert (hermes_home / "scripts/opentui_fork_sync.py").is_file()
    assert (runtime / "scripts/sync_probe.py").is_file()
    assert (runtime / "scripts/worktree.sh").is_file()

    # Exercise the scheduler's real containment boundary: the deployed cron
    # path must be accepted from HERMES_HOME/scripts rather than merely persist.
    from cron import scheduler

    monkeypatch.setattr(scheduler, "_get_hermes_home", lambda: hermes_home)
    monkeypatch.setattr(
        scheduler.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args=args[0], returncode=0, stdout="ok\n", stderr=""
        ),
    )
    accepted, output = scheduler._run_job_script(calls[1]["script"])
    assert accepted is True
    assert output == "ok"

    for name in skill_sources:
        assert (
            hermes_home / "skills/software-development" / name / "SKILL.md"
        ).is_file()


def test_silently_mutated_cron_field_triggers_cron_and_local_rollback(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "source"
    runtime = tmp_path / "runtime"
    hermes_home = tmp_path / "hermes"
    (source / "prompts").mkdir(parents=True)
    (source / "scripts").mkdir()
    (source / "prompts/maintainer.md").write_text("new policy\n")
    for name in (
        "opentui_fork_sync.py",
        "sync_probe.py",
        "maintainer_runtime.py",
        "worktree.sh",
    ):
        (source / "scripts" / name).write_text("new\n")

    config_path = hermes_home / "config.yaml"
    _write_config(config_path)
    old_config = config_path.read_text()
    (runtime / "prompts").mkdir(parents=True)
    (runtime / "prompts/maintainer.md").write_text("old policy\n")

    skill_sources = {}
    for name in configure.MAINTAINER_SKILL_SOURCES:
        source_skill = tmp_path / "skill-sources" / name
        source_skill.mkdir(parents=True)
        (source_skill / "SKILL.md").write_text(f"---\nname: {name}\n---\nnew\n")
        skill_sources[name] = source_skill
        installed = hermes_home / "skills/software-development" / name
        installed.mkdir(parents=True)
        (installed / "SKILL.md").write_text(f"---\nname: {name}\n---\nold\n")
    monkeypatch.setattr(configure, "MAINTAINER_SKILL_SOURCES", skill_sources)
    for name in ("codex", "claude-code", "adversarial-review-loop"):
        installed = hermes_home / "skills/other" / name
        installed.mkdir(parents=True)
        (installed / "SKILL.md").write_text(f"---\nname: {name}\n---\n")

    prior_job = {
        "id": configure.JOB_ID,
        "prompt": "old prompt",
        "schedule_display": "0 1 * * *",
        "name": "old maintainer",
        "deliver": "local",
        "skills": ["codex"],
        "model": "old-model",
        "provider": "openrouter",
        "base_url": None,
        "script": "/old/wrapper.py",
        "enabled_toolsets": ["terminal"],
        "workdir": "/old/workdir",
        "no_agent": False,
        "enabled": True,
        "state": "scheduled",
    }
    cron_calls, holder, stateful_cron, read_cron = _stateful_cron(prior_job)

    def successful_but_mutating_cron(**kwargs):
        response = stateful_cron(**kwargs)
        if kwargs["action"] == "update" and kwargs.get("model") == configure.MODEL:
            holder["job"]["model"] = "silently-mutated-model"
        return response

    with pytest.raises(
        configure.ConfigurationError,
        match=r"persistence verification failed.*model",
    ):
        configure.apply_configuration(
            source_home=source,
            runtime_home=runtime,
            hermes_home=hermes_home,
            cron_call=successful_but_mutating_cron,
            cron_snapshot_call=read_cron,
            cron_read_call=read_cron,
        )

    assert [call["action"] for call in cron_calls] == [
        "pause",
        "update",
        "update",
        "resume",
    ]
    assert holder["job"]["model"] == "old-model"
    assert (runtime / "prompts/maintainer.md").read_text() == "old policy\n"
    assert not (runtime / "scripts/opentui_fork_sync.py").exists()
    assert config_path.read_text() == old_config
    for name in skill_sources:
        assert (
            (hermes_home / "skills/software-development" / name / "SKILL.md")
            .read_text()
            .endswith("old\n")
        )


def test_deployment_refuses_active_maintainer_lease(tmp_path: Path) -> None:
    state = tmp_path / "state"
    state.mkdir()
    (state / "run.lease.json").write_text(
        json.dumps({"token": "owner", "expires_unix": 4_000_000_000})
    )
    with pytest.raises(configure.ConfigurationError, match="active lease"):
        with configure._maintenance_quiescence_lock(tmp_path):
            pytest.fail("active maintainer lease must exclude deployment")


def test_cron_compensation_is_compare_and_swap_safe() -> None:
    snapshot = {
        "id": configure.JOB_ID,
        "prompt": "old",
        "schedule_display": "0 1 * * *",
        "name": "old",
        "deliver": "local",
        "skills": ["codex"],
        "model": "old-model",
        "provider": "openrouter",
        "base_url": None,
        "script": "/old.py",
        "enabled_toolsets": ["terminal"],
        "workdir": "/old",
        "no_agent": False,
        "enabled": True,
        "state": "scheduled",
    }
    intended = configure.cron_update(Path("/runtime"), Path("/hermes"))
    current = _persisted_job_from_update(intended)
    calls: list[dict] = []

    def cron_call(**kwargs):
        calls.append(kwargs)
        return json.dumps({"success": True})

    configure._compensate_cron_update_if_owned(
        cron_call, lambda _: current, snapshot, intended
    )
    assert calls and calls[0]["model"] == "old-model"

    calls.clear()
    concurrent = dict(current)
    concurrent["model"] = "operator-newer"
    with pytest.raises(configure.ConfigurationError, match="changed concurrently"):
        configure._compensate_cron_update_if_owned(
            cron_call, lambda _: concurrent, snapshot, intended
        )
    assert calls == []


def test_rollback_paths_restores_on_cooperative_interruption(tmp_path: Path) -> None:
    target = tmp_path / "asset"
    target.write_text("old")
    with pytest.raises(KeyboardInterrupt):
        with configure.rollback_paths([target]):
            target.write_text("partial")
            raise KeyboardInterrupt
    assert target.read_text() == "old"


def test_policy_requires_real_fanout_evidence_and_green_ship_gate() -> None:
    policy = (Path(__file__).parents[1] / "prompts/maintainer.md").read_text()
    assert "at most **two** workers concurrently" in policy
    assert "gpt-5.6-sol" in policy
    assert "fable-5" in policy
    assert "opus-4.8" in policy
    assert "Never use Haiku" in policy
    assert "video_analyze_tool" in policy
    assert "google/gemini-3.5-flash" in policy
    assert "termctrl-smoke" in policy
    assert "`drive` object" in policy
    assert "gate-and-ship" in policy
    assert "There is no standalone ship command" in policy
    assert "state/run-request.inflight.json" in policy
    assert policy.count("background=true") >= 2
    assert policy.count("notify_on_complete=true") >= 2
    assert policy.count('process(action="wait", session_id=...)') >= 2
    assert "Never advance or push `sid/opentui` unless" in policy
    assert "Complexity, novelty, conflict count" in policy


def test_cron_failure_rolls_back_local_deployment(tmp_path: Path, monkeypatch) -> None:
    source, runtime, hermes_home = (
        tmp_path / "source",
        tmp_path / "runtime",
        tmp_path / "hermes",
    )
    (source / "prompts").mkdir(parents=True)
    (source / "scripts").mkdir()
    (source / "prompts/maintainer.md").write_text("new policy\n")
    for name in (
        "opentui_fork_sync.py",
        "sync_probe.py",
        "maintainer_runtime.py",
        "worktree.sh",
    ):
        (source / "scripts" / name).write_text("new\n")
    _write_config(hermes_home / "config.yaml")
    old_config = (hermes_home / "config.yaml").read_text()
    (runtime / "prompts").mkdir(parents=True)
    (runtime / "prompts/maintainer.md").write_text("old policy\n")
    skill_sources = {}
    for name in configure.MAINTAINER_SKILL_SOURCES:
        src = tmp_path / "sources" / name
        src.mkdir(parents=True)
        (src / "SKILL.md").write_text(f"---\nname: {name}\n---\nnew\n")
        skill_sources[name] = src
        dst = hermes_home / "skills/software-development" / name
        dst.mkdir(parents=True)
        (dst / "SKILL.md").write_text(f"---\nname: {name}\n---\nold\n")
    monkeypatch.setattr(configure, "MAINTAINER_SKILL_SOURCES", skill_sources)
    for name in ("codex", "claude-code", "adversarial-review-loop"):
        dst = hermes_home / "skills/other" / name
        dst.mkdir(parents=True)
        (dst / "SKILL.md").write_text(f"---\nname: {name}\n---\n")
    request_seen_during_update = False
    prior_job = {
        "id": configure.JOB_ID,
        "prompt": "old prompt",
        "schedule_display": "0 1 * * *",
        "name": "old maintainer",
        "deliver": "local",
        "skills": ["codex"],
        "model": "old-model",
        "provider": "openrouter",
        "base_url": None,
        "script": "/old/wrapper.py",
        "enabled_toolsets": ["terminal"],
        "workdir": "/old/workdir",
        "no_agent": False,
        "enabled": True,
        "state": "scheduled",
    }

    cron_calls, _holder, stateful_cron, read_cron = _stateful_cron(prior_job)

    def failed_cron(**kwargs):
        nonlocal request_seen_during_update
        if kwargs["action"] == "update" and kwargs.get("model") == configure.MODEL:
            request_seen_during_update = (runtime / "state/run-request.json").is_file()
            cron_calls.append(kwargs)
            return json.dumps({"success": False})
        return stateful_cron(**kwargs)

    with pytest.raises(configure.ConfigurationError, match="cron update failed"):
        configure.apply_configuration(
            source_home=source,
            runtime_home=runtime,
            hermes_home=hermes_home,
            cron_call=failed_cron,
            cron_snapshot_call=read_cron,
            cron_read_call=read_cron,
            backport_commits=["abcdef1"],
        )
    assert request_seen_during_update is True
    assert [call["action"] for call in cron_calls] == [
        "pause",
        "update",
        "update",
        "resume",
    ]
    assert not (runtime / "state/run-request.json").exists()
    assert (runtime / "prompts/maintainer.md").read_text() == "old policy\n"
    assert not (runtime / "scripts/opentui_fork_sync.py").exists()
    assert (hermes_home / "config.yaml").read_text() == old_config
    for name in skill_sources:
        assert (
            (hermes_home / "skills/software-development" / name / "SKILL.md")
            .read_text()
            .endswith("old\n")
        )


def test_invalid_backport_is_rejected_before_live_deployment(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "source"
    runtime = tmp_path / "runtime"
    hermes_home = tmp_path / "hermes"
    marker = runtime / "prompts/maintainer.md"
    marker.parent.mkdir(parents=True)
    marker.write_text("untouched\n")

    with pytest.raises(configure.ConfigurationError, match="invalid backport SHA"):
        configure.apply_configuration(
            source_home=source,
            runtime_home=runtime,
            hermes_home=hermes_home,
            cron_call=lambda **_: json.dumps({"success": True}),
            backport_commits=["not-a-sha"],
        )
    assert marker.read_text() == "untouched\n"


def test_deployed_bootstrap_and_fixed_script_output_are_scanner_safe(
    tmp_path: Path, monkeypatch
) -> None:
    from cron import scheduler
    import tools.skill_usage as skill_usage

    runtime = tmp_path / "runtime"
    configure.deploy_assets(configure.SOURCE_HOME, runtime)
    script_output = json.dumps({
        "status": "behind",
        "ingest_file": str(runtime / "state/ingest.latest.json"),
        "gap": 3,
        "needs_port_count": 1,
        "probe_failures": 0,
        "run_token": "a" * 32,
        "wakeAgent": True,
    })
    monkeypatch.setattr(skill_usage, "bump_use", lambda *_: None)
    assembled = scheduler._build_job_prompt(
        configure.cron_update(runtime, tmp_path / "hermes"),
        prerun_script=(True, script_output),
    )
    assert assembled is not None
    cleaned = scheduler._scan_assembled_cron_prompt(
        assembled,
        configure.cron_update(runtime, tmp_path / "hermes"),
        has_skills=True,
        has_injected_data=True,
        user_prompt=configure.bootstrap_prompt(runtime),
    )
    assert cleaned == assembled
    assert script_output in assembled
    for skill in configure.SKILLS:
        assert skill in assembled


def test_apply_persists_journal_and_pauses_before_first_live_asset_mutation(
    tmp_path: Path, monkeypatch
) -> None:
    source, runtime, hermes_home = _deployment_fixture(tmp_path, monkeypatch)
    calls, holder, stateful_cron, read_cron = _stateful_cron(_active_prior_job())
    events: list[str] = []

    def tracked_cron(**kwargs):
        events.append(f"cron:{kwargs['action']}")
        return stateful_cron(**kwargs)

    original_deploy = configure.deploy_assets

    def tracked_deploy(source_home: Path, runtime_home: Path) -> None:
        journal = configure._deployment_journal_path(runtime)
        assert journal.is_file()
        assert holder["job"]["state"] == "paused"
        events.append("local:deploy-assets")
        original_deploy(source_home, runtime_home)

    monkeypatch.setattr(configure, "deploy_assets", tracked_deploy)
    configure.apply_configuration(
        source_home=source,
        runtime_home=runtime,
        hermes_home=hermes_home,
        cron_call=tracked_cron,
        cron_snapshot_call=read_cron,
        cron_read_call=read_cron,
    )

    assert events.index("cron:pause") < events.index("local:deploy-assets")
    assert [call["action"] for call in calls] == ["pause", "update", "resume"]
    assert calls[1]["script"] == configure.CRON_ENTRYPOINT_NAME
    assert not configure._deployment_journal_path(runtime).exists()


@pytest.mark.parametrize(
    ("broken_state", "broken_enabled", "broken_next_run"),
    [
        ("error", True, "2099-01-01T00:00:00+00:00"),
        ("scheduled", True, None),
        ("scheduled", True, "not-a-timestamp"),
        ("scheduled", True, "2020-01-01T00:00:00+00:00"),
    ],
)
def test_apply_rejects_non_runnable_final_cron_state(
    tmp_path: Path,
    monkeypatch,
    broken_state: str,
    broken_enabled: bool,
    broken_next_run: str | None,
) -> None:
    source, runtime, hermes_home = _deployment_fixture(tmp_path, monkeypatch)
    calls, holder, stateful_cron, read_cron = _stateful_cron(_active_prior_job())

    def corrupting_cron(**kwargs):
        response = stateful_cron(**kwargs)
        if kwargs["action"] == "resume":
            holder["job"].update({
                "state": broken_state,
                "enabled": broken_enabled,
                "next_run_at": broken_next_run,
            })
        return response

    with pytest.raises(
        configure.ConfigurationError, match="not durably scheduled with a future run"
    ):
        configure.apply_configuration(
            source_home=source,
            runtime_home=runtime,
            hermes_home=hermes_home,
            cron_call=corrupting_cron,
            cron_snapshot_call=read_cron,
            cron_read_call=read_cron,
        )

    assert [call["action"] for call in calls[:3]] == ["pause", "update", "resume"]


def test_stale_deployment_journal_is_paused_converged_and_resumed_on_rerun(
    tmp_path: Path, monkeypatch
) -> None:
    source, runtime, hermes_home = _deployment_fixture(tmp_path, monkeypatch)
    mixed = runtime / "prompts/maintainer.md"
    mixed.parent.mkdir(parents=True)
    mixed.write_text("partial from killed deploy\n")
    original = _active_prior_job()
    configure._write_deployment_journal(runtime, original)

    calls, holder, stateful_cron, read_cron = _stateful_cron(original)
    configure.apply_configuration(
        source_home=source,
        runtime_home=runtime,
        hermes_home=hermes_home,
        cron_call=stateful_cron,
        cron_snapshot_call=lambda _job_id: pytest.fail(
            "stale recovery must use the durable original snapshot"
        ),
        cron_read_call=read_cron,
    )

    assert [call["action"] for call in calls] == ["pause", "update", "resume"]
    assert mixed.read_text() == "new policy\n"
    assert holder["job"]["state"] == "scheduled"
    assert holder["job"]["enabled"] is True
    assert not configure._deployment_journal_path(runtime).exists()


def test_failed_stale_recovery_keeps_cron_paused_and_journal_for_retry(
    tmp_path: Path, monkeypatch
) -> None:
    source, runtime, hermes_home = _deployment_fixture(tmp_path, monkeypatch)
    original = _active_prior_job()
    configure._write_deployment_journal(runtime, original)
    _calls, holder, stateful_cron, read_cron = _stateful_cron(original)

    def fail_after_pause(_source_home: Path, _runtime_home: Path) -> None:
        assert holder["job"]["state"] == "paused"
        raise RuntimeError("simulated recovery failure")

    monkeypatch.setattr(configure, "deploy_assets", fail_after_pause)
    with pytest.raises(configure.ConfigurationError, match="RuntimeError"):
        configure.apply_configuration(
            source_home=source,
            runtime_home=runtime,
            hermes_home=hermes_home,
            cron_call=stateful_cron,
            cron_read_call=read_cron,
        )

    assert holder["job"]["state"] == "paused"
    assert holder["job"]["enabled"] is False
    assert configure._deployment_journal_path(runtime).is_file()
