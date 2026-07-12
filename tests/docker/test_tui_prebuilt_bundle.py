"""Harness: the image ships both production TUI engines.

Regression guard for the hosted-chat failure where the embedded dashboard
Chat tab died with a 502 / "[session ended]". Root cause: the image installs
only a subset of the npm monorepo workspaces (root/web/ui-tui, never apps/*),
so the actualized node_modules permanently disagrees with the canonical
package-lock.json. Without HERMES_TUI_DIR set, ``_make_tui_argv`` falls
through to ``_tui_need_npm_install`` (which returns True forever) and tries a
runtime ``npm install`` that can never converge and races itself across
concurrent /api/pty connections → ENOTEMPTY.

The fix is ``ENV HERMES_TUI_DIR=/opt/hermes/ui-tui`` in the Dockerfile, which
makes the launcher take the prebuilt-bundle fast path (``node --expose-gc
.../dist/entry.js``) and skip the install check entirely. These tests assert
that Ink fallback invariant plus OpenTUI's automatic native launch contract.
"""
from __future__ import annotations

import json
import shlex
import subprocess


def _exec_py(image: str, py: str) -> str:
    """Run a Python snippet inside the image as the hermes user, return stdout."""
    inner = (
        "source /opt/hermes/.venv/bin/activate && "
        "cd /opt/hermes && "
        f"python3 -c {shlex.quote(py)}"
    )
    # Drop to the hermes user (UID 10000) so we exercise the same path the
    # dashboard PTY child runs as — not root.
    cmd = [
        "docker", "run", "--rm", "--entrypoint", "su", image,
        "hermes", "-s", "/bin/bash", "-c", inner,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, f"in-container python failed:\n{r.stderr[-2000:]}"
    return r.stdout.strip()


def test_hermes_tui_dir_env_is_set(built_image: str) -> None:
    """HERMES_TUI_DIR must point at the prebuilt bundle dir in the image."""
    r = subprocess.run(
        ["docker", "run", "--rm", "--entrypoint", "sh", built_image,
         "-c", 'printf "%s" "$HERMES_TUI_DIR"'],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, r.stderr[-2000:]
    assert r.stdout.strip() == "/opt/hermes/ui-tui", (
        f"HERMES_TUI_DIR={r.stdout.strip()!r} (expected /opt/hermes/ui-tui)"
    )


def test_prebuilt_bundle_present_and_no_runtime_install(built_image: str) -> None:
    """The launcher must (a) find the prebuilt bundle and (b) NOT want an
    npm install — i.e. it takes the same path as a nix/packaged release."""
    py = (
        "import json\n"
        "from pathlib import Path\n"
        "from hermes_cli.main import _tui_need_npm_install, _find_bundled_tui, _make_tui_argv\n"
        "ui = Path('/opt/hermes/ui-tui')\n"
        "argv, cwd = _make_tui_argv(ui, tui_dev=False)\n"
        "out = {\n"
        "  'dist_entry_exists': (ui / 'dist' / 'entry.js').is_file(),\n"
        "  'need_npm_install': _tui_need_npm_install(ui),\n"
        "  'argv': argv,\n"
        "  'uses_prebuilt': ('dist/entry.js' in ' '.join(argv)) and ('npm' not in argv[0].lower()),\n"
        "}\n"
        "print(json.dumps(out))\n"
    )
    out = json.loads(_exec_py(built_image, py))
    assert out["dist_entry_exists"], "prebuilt ui-tui/dist/entry.js missing from image"
    # With HERMES_TUI_DIR set, _make_tui_argv returns the prebuilt path BEFORE
    # ever reaching the install check — so the resolved argv is what matters.
    assert out["uses_prebuilt"], f"launcher did not take prebuilt path: argv={out['argv']!r}"
    assert "npm" not in out["argv"][0].lower(), (
        f"launcher resolved to an npm invocation, not the prebuilt bundle: {out['argv']!r}"
    )


def test_opentui_baked_runtime_and_automatic_selection(built_image: str) -> None:
    """The supported Linux image selects its baked OpenTUI runtime without npm."""
    py = (
        "import json, os, platform\n"
        "from pathlib import Path\n"
        "os.environ.pop('HERMES_TUI_ENGINE', None)\n"
        "os.environ['HERMES_HOME'] = '/tmp/hermes-release-contract'\n"
        "from hermes_cli.main import _make_opentui_argv, _resolve_tui_engine\n"
        "root = Path('/opt/hermes/ui-opentui')\n"
        "argv, cwd = _make_opentui_argv(tui_dev=False)\n"
        "arch = {'x86_64': 'linux-x64', 'aarch64': 'linux-arm64'}[platform.machine()]\n"
        "native = root / 'node_modules' / ('@opentui/core-' + arch)\n"
        "print(json.dumps({\n"
        "  'engine': _resolve_tui_engine(),\n"
        "  'cwd': str(cwd),\n"
        "  'argv': argv,\n"
        "  'bundle': (root / 'dist/main.js').is_file(),\n"
        "  'native': native.is_dir(),\n"
        "}))\n"
    )
    out = json.loads(_exec_py(built_image, py))
    assert out["engine"] == "opentui"
    assert out["cwd"] == "/opt/hermes/ui-opentui"
    assert out["bundle"] and out["native"]
    assert out["argv"][1:4] == ["--experimental-ffi", "--no-warnings", "--expose-gc"]
    assert out["argv"][-1] == "/opt/hermes/ui-opentui/dist/main.js"


def test_opentui_node_can_load_host_native_library(built_image: str) -> None:
    """Load the pruned native package before a separate real-PTY smoke."""
    script = "import('@opentui/core').then(() => process.stdout.write('ok'))"
    r = subprocess.run(
        [
            "docker", "run", "--rm", "--entrypoint", "sh", built_image, "-c",
            "cd /opt/hermes/ui-opentui && node --experimental-ffi --no-warnings "
            f"-e {shlex.quote(script)}",
        ],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, r.stderr[-2000:]
    assert r.stdout == "ok"
