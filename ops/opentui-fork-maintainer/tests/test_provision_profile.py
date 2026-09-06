from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

from dotenv import dotenv_values
import pytest
from ruamel.yaml import YAML


SCRIPT = Path(__file__).parents[1] / "scripts/provision_profile.py"
SPEC = importlib.util.spec_from_file_location("maintainer_provision", SCRIPT)
assert SPEC and SPEC.loader
provisioner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(provisioner)


@pytest.fixture
def environment(tmp_path: Path, monkeypatch):
    profile = tmp_path / "profile"
    profile.mkdir()
    (profile / ".no-bundled-skills").touch()
    (profile / "config.yaml").write_text("mcp_servers:\n  personal: {}\n")
    (profile / "SOUL.md").write_text("old identity\n")
    credential_home = tmp_path / "demo"
    credential_home.mkdir()
    (credential_home / ".env").write_text("OPENROUTER_API_KEY=test-key\nOTHER_SECRET=private\n")
    (credential_home / "MEMORY.md").write_text("personal memory\n")
    source = tmp_path / "source"
    source.mkdir()
    (source / "profile-SOUL.md").write_text("maintainer identity\n")
    skill = source / "skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("---\nname: test-skill\n---\nv1\n")
    monkeypatch.setattr(provisioner, "PROFILE", profile)
    monkeypatch.setattr(provisioner, "SOURCE_ROOT", source)
    monkeypatch.setattr(provisioner, "REPO_ROOT", tmp_path / "repo")
    monkeypatch.setattr(provisioner, "skill_sources", lambda _: {"test-skill": skill})
    return profile, credential_home, source, skill


def test_plan_does_not_mutate_profile_or_copy_credentials(environment):
    profile, demo, source, skill = environment
    before = {path.relative_to(profile): path.read_bytes() for path in profile.rglob("*") if path.is_file()}
    plan = provisioner.provision(skill, demo, False, True)
    assert plan["credential_names"] == ["OPENROUTER_API_KEY"]
    assert plan["compaction_tokens"] == 300_000
    assert before == {path.relative_to(profile): path.read_bytes() for path in profile.rglob("*") if path.is_file()}


def test_apply_isolates_credentials_and_installs_policy(environment):
    profile, demo, source, skill = environment
    credentials_before = (demo / ".env").read_bytes()
    provisioner.provision(skill, demo, True)
    assert dotenv_values(profile / ".env") == {"OPENROUTER_API_KEY": "test-key"}
    assert (profile / ".env").stat().st_mode & 0o777 == 0o600
    assert (demo / ".env").read_bytes() == credentials_before
    assert not (profile / "MEMORY.md").exists()
    assert (profile / "SOUL.md").read_text() == (source / "profile-SOUL.md").read_text()
    config = YAML(typ="safe").load(profile / "config.yaml")
    assert config["model"] == {"default": provisioner.MODEL, "provider": "nous"}
    assert config["auxiliary"]["compression"] == {"provider": "nous", "model": provisioner.MODEL}
    assert config["providers"]["nous"]["models"][provisioner.MODEL]["stale_timeout_seconds"] == 600
    assert config["approvals"]["mode"] == "off"
    assert config["timezone"] == "Asia/Kolkata"
    assert not (profile / "auth.json").exists()
    assert config["compression"]["threshold_tokens"] == 300_000
    assert config["mcp_servers"] == {} and config["fallback_model"] is None
    assert config["terminal"]["home_mode"] == "real"
    assert config["tool_output"]["max_bytes"] == 12_000
    assert any(path.read_text() == "old identity\n" for path in (profile / "setup-backups").rglob("SOUL.md"))


@pytest.mark.parametrize("prior_provider", ["nous", "openrouter"])
def test_reprovisioned_job_resolves_nous_without_copying_oauth(environment, monkeypatch, prior_provider):
    from cron.scheduler import _load_cron_job_config, _resolve_job_runtime
    from hermes_cli import runtime_provider
    from hermes_time import get_timezone, reset_cache

    profile, demo, source, skill = environment
    (profile / "config.yaml").write_text(
        f"model:\n  provider: {prior_provider}\n  api_mode: codex_responses\n"
        "  base_url: https://old.invalid\napprovals:\n  mode: 'off'\n"
    )
    (demo / "auth.json").write_text('{"private": "must not copy"}')
    provisioner.provision(skill, demo, True)
    monkeypatch.setenv("HERMES_HOME", str(profile))
    monkeypatch.delenv("HERMES_TIMEZONE", raising=False)
    monkeypatch.delenv("HERMES_INFERENCE_PROVIDER", raising=False)
    monkeypatch.delenv("HERMES_NOUS_INFERENCE_BASE_URL", raising=False)
    # Only the remote credential acquisition is substituted; cron and the
    # built-in provider/wire resolver execute against the provisioned file.
    monkeypatch.setattr(runtime_provider, "load_pool", lambda _: None)
    calls = []
    def credentials(**kwargs):
        calls.append(kwargs)
        return {"api_key": "synthetic-invoke", "base_url": "https://portal.nousresearch.com/api/inference/v1"}
    monkeypatch.setattr(runtime_provider, "resolve_nous_runtime_credentials", credentials)
    spec = importlib.util.spec_from_file_location("route_configure", SCRIPT.with_name("configure.py"))
    assert spec and spec.loader
    configure = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(configure)
    job = configure.cron_update(profile / "runtime", profile)
    jc = _load_cron_job_config(job, "test", "test")
    runtime, model, provider = _resolve_job_runtime(job, "test", jc)
    assert provider == runtime["provider"] == "nous"
    assert runtime["api_mode"] == "chat_completions"
    assert model == provisioner.MODEL
    assert calls and not (profile / "auth.json").exists()
    assert jc.cfg["auxiliary"]["compression"]["provider"] == "nous"
    reset_cache()
    assert str(get_timezone()) == "Asia/Kolkata"


def test_provisioned_preview_limit_preserves_full_terminal_output(environment):
    profile, demo, source, skill = environment
    provisioner.provision(skill, demo, True)
    probe = """
import json
from pathlib import Path
from tools.terminal_tool import terminal_tool
result = json.loads(terminal_tool('/usr/bin/seq 1 10000', task_id='maintainer-preview-probe'))
assert result['exit_code'] == 0, result
assert 'OUTPUT TRUNCATED' in result['output']
assert len(result['output']) < 13000
assert '5000\\n' not in result['output']
full = Path(result['full_output_path']).read_text()
# The raw spill also retains the terminal's trailing cwd marker.
assert full.startswith(''.join(f'{i}\\n' for i in range(1, 10001)))
print(json.dumps({'preview_chars': len(result['output']), 'full_chars': len(full)}))
"""
    result = subprocess.run(
        [sys.executable, "-c", probe], cwd=SCRIPT.parents[3],
        env={"PATH": os.defpath, "HOME": str(profile), "HERMES_HOME": str(profile)},
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr
    sizes = json.loads(result.stdout)
    assert sizes["preview_chars"] < sizes["full_chars"]


def test_repeated_refresh_preserves_prior_versions_outside_skill_discovery(environment):
    profile, demo, source, skill = environment
    provisioner.provision(skill, demo, True)
    target = profile / "skills/maintenance/test-skill/SKILL.md"
    original = target.read_text()
    unrelated = profile / "skills/personal/SKILL.md"
    unrelated.parent.mkdir()
    unrelated.write_text("personal skill\n")
    for revision in ("v2", "v3"):
        (skill / "SKILL.md").write_text(f"---\nname: test-skill\n---\n{revision}\n")
        provisioner.provision(skill, demo, True, True)
        assert target.read_text().endswith(revision + "\n")
    backups = list((profile / "skill-backups").rglob("SKILL.md"))
    assert len(backups) == 2
    assert original in [path.read_text() for path in backups]
    assert len(list((profile / "skills").rglob("SKILL.md"))) == 2
    assert unrelated.read_text() == "personal skill\n"


def test_failed_skill_copy_leaves_installed_skill_intact(environment, monkeypatch):
    profile, demo, source, skill = environment
    provisioner.provision(skill, demo, True)
    target = profile / "skills/maintenance/test-skill/SKILL.md"
    before = target.read_bytes()
    def fail_copy(*args, **kwargs):
        raise OSError("simulated disk failure")
    monkeypatch.setattr(provisioner.shutil, "copytree", fail_copy)
    with pytest.raises(OSError, match="simulated disk failure"):
        provisioner.provision(skill, demo, True, True)
    assert target.read_bytes() == before


def test_failed_replacement_restores_installed_skill(environment, monkeypatch):
    profile, demo, source, skill = environment
    provisioner.provision(skill, demo, True)
    target = profile / "skills/maintenance/test-skill/SKILL.md"
    before = target.read_bytes()
    original_rename = Path.rename

    def fail_staged_rename(path, destination):
        if path.parent.name.startswith(".skill-staging-"):
            raise OSError("simulated replacement failure")
        return original_rename(path, destination)

    monkeypatch.setattr(Path, "rename", fail_staged_rename)
    with pytest.raises(OSError, match="simulated replacement failure"):
        provisioner.provision(skill, demo, True, True)
    assert target.read_bytes() == before


def test_skill_sources_prefer_versioned_testing_and_fresh_opentui(tmp_path, monkeypatch):
    source = tmp_path / "ops"
    repo = tmp_path / "repo"
    fresh_opentui = repo / ".repos/opentui/packages/web/src/content"
    fresh_opentui.mkdir(parents=True)
    (fresh_opentui / "SKILL.md").write_text("latest OpenTUI skill\n")
    monkeypatch.setattr(provisioner, "SOURCE_ROOT", source)
    monkeypatch.setattr(provisioner, "REPO_ROOT", repo)
    dev_skill = tmp_path / "attached-dev-skill"
    sources = provisioner.skill_sources(dev_skill)
    assert sources["hermes-agent-dev"] == dev_skill
    assert sources["herdr-agent-testing"] == source / "skills/herdr-agent-testing"
    assert sources["opentui-tui-engineering"] == source / "skills/opentui-tui-engineering"
    assert sources["opentui"] == fresh_opentui


@pytest.mark.parametrize("name", [".env", "config.yaml", "SOUL.md", "maintainer-environment.json"])
def test_destination_file_alias_is_refused_without_touching_external_data(environment, name):
    profile, demo, source, skill = environment
    external = profile.parent / "external"
    external.write_text("OTHER_SECRET=untouched\n")
    external.chmod(0o640)
    target = profile / name
    target.unlink(missing_ok=True)
    target.symlink_to(external)
    config_before = (profile / "config.yaml").read_bytes()
    with pytest.raises(ValueError, match="no symlinks"):
        provisioner.provision(skill, demo, True)
    assert external.read_text() == "OTHER_SECRET=untouched\n"
    assert external.stat().st_mode & 0o777 == 0o640
    assert (profile / "config.yaml").read_bytes() == config_before
    assert target.is_symlink()


@pytest.mark.parametrize("kind", ["profile", "ancestor"])
def test_profile_alias_is_refused_before_writes(environment, monkeypatch, kind):
    profile, demo, source, skill = environment
    alias = profile.parent / "alias"
    alias.symlink_to(profile if kind == "profile" else profile.parent, target_is_directory=True)
    monkeypatch.setattr(provisioner, "PROFILE", alias if kind == "profile" else alias / profile.name)
    before = (profile / "config.yaml").read_bytes()
    with pytest.raises(ValueError, match="no symlinks"):
        provisioner.provision(skill, demo, True)
    assert (profile / "config.yaml").read_bytes() == before
    assert not (profile / ".env").exists()


@pytest.mark.parametrize("name", ["skills", "skills/maintenance/test-skill", "setup-backups", "skill-backups"])
def test_skill_and_backup_aliases_are_refused_before_profile_mutation(environment, name):
    profile, demo, source, skill = environment
    external = profile.parent / "external-directory"
    external.mkdir()
    sentinel = external / "SKILL.md"
    sentinel.write_text("untouched external skill\n")
    target = profile / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.symlink_to(external, target_is_directory=True)
    before = (profile / "config.yaml").read_bytes()
    with pytest.raises(ValueError, match="no symlinks"):
        provisioner.provision(skill, demo, True, True)
    assert sentinel.read_text() == "untouched external skill\n"
    assert (profile / "config.yaml").read_bytes() == before
    assert not (profile / ".env").exists()


def test_legacy_staging_alias_is_not_followed_and_atomic_outputs_are_private(environment):
    profile, demo, source, skill = environment
    external = profile.parent / "external-config"
    external.write_text("untouched external config\n")
    staging = profile / "config.yaml.staging"
    staging.symlink_to(external)
    provisioner.provision(skill, demo, True)
    assert external.read_text() == "untouched external config\n"
    assert staging.is_symlink()
    for name in ("config.yaml", "maintainer-environment.json"):
        assert (profile / name).stat().st_mode & 0o777 == 0o600
        assert not list(profile.glob(f".{name}.*"))
