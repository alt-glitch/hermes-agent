/**
 * Python resolution for spawning the `tui_gateway` — mirrors Ink's
 * `resolvePython` (ui-tui/src/gatewayClient.ts, 3d12e86ef1) so behavior is
 * identical across engines (spec v4 §4). NEVER "probe any python".
 *
 * Trust HERMES_PYTHON only. The launcher guarantees it for both engines
 * (`hermes_cli/main_tui_launch.py` `_apply_tui_python_env` validates it and
 * falls back to its own `sys.executable`; the dashboard path and the Nix
 * wrapper set it too). Scanning PYTHON / $VIRTUAL_ENV / <root>/.venv can only
 * find a DIFFERENT interpreter than the parent runs on — with the pm store a
 * stale venv is actively dangerous. The bare `python3` (`python` on win32)
 * fallback is for `npm run dev` straight out of ui-opentui/, where the
 * developer's activated environment owns PATH.
 */
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export function resolvePython(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const configured = env.HERMES_PYTHON?.trim()
  if (configured) return configured
  return platform === 'win32' ? 'python' : 'python3'
}

/** The Hermes checkout root used as PYTHONPATH / HERMES_PYTHON_SRC_ROOT for the child. */
export function resolveSrcRoot(): string {
  const configured = process.env.HERMES_PYTHON_SRC_ROOT?.trim()
  if (configured) return configured
  // Fallback (no launcher env): walk up from this module to the Hermes checkout
  // root — the dir holding the `hermes_cli` package / `pyproject.toml`. Bundle-
  // agnostic, so it works whether running the source tree (.../src/boundary/gateway)
  // or the built `dist/main.js`. (Under the real launcher this never runs — the
  // launcher always sets HERMES_PYTHON_SRC_ROOT.)
  let dir = import.meta.dirname
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'hermes_cli')) || existsSync(resolve(dir, 'pyproject.toml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(import.meta.dirname, '../../../../')
}
