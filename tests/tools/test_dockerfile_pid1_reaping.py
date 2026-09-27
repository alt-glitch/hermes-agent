"""Fork contract tests for the native OpenTUI engine in the container Dockerfile.

Upstream's Dockerfile has no ``ui-opentui`` steps; the fork adds them and every
upstream sync can silently drop them when upstream restructures the image (the
build moved to PM-provisioned Node and separate ``frontend_build`` / ``runtime``
stages). These static checks run without Docker; the image-level behaviour
(baked ``dist/main.js``, pruned host-native ``@opentui/core``, automatic engine
selection) is covered by ``tests/docker/test_tui_prebuilt_bundle.py``.

They assert:

- ui-opentui dependencies are installed with ``npm ci`` (exactly the committed
  lockfile, matching the opentui-tests CI job), not ``npm install``.
- the native bundle is built and devDependencies are pruned AFTER the final
  source ``COPY . .``, so the launcher's freshness check never sees sources
  newer than ``dist/main.js`` at container startup.
- both steps run in the final (runtime) stage, since OpenTUI needs its
  ``node_modules`` at runtime and nothing copies them out of another stage.
"""

from __future__ import annotations

from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = REPO_ROOT / "Dockerfile"


@pytest.fixture(scope="module")
def dockerfile_text() -> str:
    if not DOCKERFILE.exists():
        pytest.skip("Dockerfile not present in this checkout")
    return DOCKERFILE.read_text(encoding="utf-8")


def _dockerfile_instructions(dockerfile_text: str) -> list[str]:
    """Logical instructions with comments dropped and continuations joined."""
    instructions: list[str] = []
    current = ""

    for raw_line in dockerfile_text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        continued = line.removesuffix("\\").strip()
        current = f"{current} {continued}".strip()
        if not line.endswith("\\"):
            instructions.append(current)
            current = ""

    return instructions


def _final_stage(dockerfile_text: str) -> list[str]:
    instructions = _dockerfile_instructions(dockerfile_text)
    starts = [i for i, ins in enumerate(instructions) if ins.upper().startswith("FROM ")]
    assert starts, "Dockerfile has no FROM instruction"
    return instructions[starts[-1]:]


def _index(instructions: list[str], predicate, what: str) -> int:
    matches = [i for i, ins in enumerate(instructions) if predicate(ins)]
    assert matches, f"final Dockerfile stage is missing {what}"
    return matches[-1]


def _is_opentui_install(ins: str) -> bool:
    return ins.startswith("RUN ") and "ui-opentui" in ins and "npm ci" in ins


def _is_final_source_copy(ins: str) -> bool:
    parts = ins.split()
    return parts[0] == "COPY" and parts[-2:] == [".", "."]


def test_dockerfile_installs_opentui_dependencies_with_npm_ci(dockerfile_text):
    stage = _final_stage(dockerfile_text)
    install = _index(
        stage,
        _is_opentui_install,
        "a RUN step that installs ui-opentui dependencies with `npm ci`",
    )
    assert "npm install" not in stage[install], (
        "ui-opentui must use `npm ci` so the image installs exactly the "
        "committed package-lock.json that CI validates."
    )
    source = _index(
        stage,
        lambda ins: ins.startswith("COPY ") and "ui-opentui" in ins,
        "a COPY of the ui-opentui package before its dependency install",
    )
    assert source < install, "ui-opentui must be copied before `npm ci` runs"


def test_dockerfile_builds_opentui_bundle_after_final_source_copy(dockerfile_text):
    stage = _final_stage(dockerfile_text)
    build = _index(
        stage,
        lambda ins: (
            ins.startswith("RUN ")
            and "ui-opentui" in ins
            and "npm run build" in ins
            and "npm prune --omit=dev" in ins
        ),
        "a RUN step that builds the ui-opentui bundle and prunes devDependencies",
    )
    source_copy = _index(stage, _is_final_source_copy, "the final `COPY . .` source copy")
    install = _index(
        stage,
        _is_opentui_install,
        "a RUN step that installs ui-opentui dependencies with `npm ci`",
    )
    assert install < source_copy < build, (
        "Install ui-opentui dependencies before the final source copy (cached "
        "layer) and build + prune after it, so dist/main.js is never older "
        "than the sources the launcher's freshness check compares against."
    )
