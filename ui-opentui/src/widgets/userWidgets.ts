/**
 * User widget apps — Hermes authors its own TUI widgets: drop `<name>.mjs`
 * into `$HERMES_HOME/tui-widgets/`, default-export `register(sdk)`, and the
 * app surfaces in `/` completions and dispatch automatically (the registry is
 * the catalog). A port of `ui-tui/src/sdk/userWidgets.ts` — same directory,
 * same file contract, same hot-load semantics — feeding the native sdk.
 *
 * Trust model matches `~/.hermes/plugins/`: files under HERMES_HOME execute
 * with the TUI's privileges. Load errors log and skip — a broken widget never
 * takes the TUI down (per-file isolation; the scan continues).
 */
import { watch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { getLog } from '../boundary/log.ts'
import { reconcileWidgetInstances, retireWidget } from './host.ts'
import { listWidgetApps, removeWidgetApp } from './registry.ts'
import { widgetSdk, type WidgetSdk } from './sdk.ts'

const widgetsDir = () => join(process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes'), 'tui-widgets')

export interface UserWidgetLoadResult {
  /** App ids newly registered by this scan. */
  added: string[]
  errors: { file: string; message: string }[]
  loaded: string[]
  /** App ids unregistered because their file disappeared. */
  removed: string[]
}

/** Which app ids each user file registered — the delete-sync source of
 *  truth (file gone on the next scan ⇒ its apps unregister). */
const fileApps = new Map<string, string[]>()

const listeners = new Set<(result: UserWidgetLoadResult) => void>()

/** Subscribe to scan results — the entry announces loads in the transcript
 *  so a hot-loaded widget is VISIBLY live (silent success is
 *  indistinguishable from failure). */
export function onUserWidgets(listener: (result: UserWidgetLoadResult) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Cache-busting counter for re-imports (monotonic — edits reload without
 *  restarting the TUI; last-writer-wins shadows stale definitions). */
let importGeneration = 0

/** Scan + import + register, diffing the registry per file. Files that
 *  vanished unregister their apps AND retire them from the dock. */
export async function loadUserWidgets(dir = widgetsDir()): Promise<UserWidgetLoadResult> {
  const result: UserWidgetLoadResult = { added: [], errors: [], loaded: [], removed: [] }

  let files: string[] = []
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.mjs')).sort()
  } catch {
    // No directory: fall through so previously-loaded files still delete-sync.
  }

  for (const [file, ids] of fileApps) {
    if (!files.includes(file)) {
      fileApps.delete(file)
      for (const id of ids) {
        if (removeWidgetApp(id)) {
          retireWidget(id)
          result.removed.push(id)
        }
      }
    }
  }

  for (const file of files) {
    const before = new Set(listWidgetApps().map(app => app.id))
    try {
      importGeneration += 1
      const url = `${pathToFileURL(join(dir, file)).href}?t=${Date.now()}-${importGeneration}`
      const mod = (await import(url)) as { default?: unknown }
      if (typeof mod.default !== 'function') {
        throw new Error('default export must be register(sdk)')
      }
      ;(mod.default as (sdk: WidgetSdk) => void)(widgetSdk)
      result.loaded.push(file)

      const ids = listWidgetApps()
        .map(app => app.id)
        .filter(id => !before.has(id))
      // Re-registrations of existing ids keep their prior file attribution.
      if (ids.length) {
        fileApps.set(file, ids)
        result.added.push(...ids)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.errors.push({ file, message })
      getLog().warn('widgets', 'user widget failed to load', { file, message })
    }
  }

  // Hot reload: a re-registered id that is currently docked gets a fresh
  // instance so the new definition shadows the stale one on the next paint.
  reconcileWidgetInstances()

  if (result.added.length) {
    getLog().info('widgets', 'user widgets registered', { ids: result.added.join(', ') })
  }
  for (const listener of listeners) listener(result)
  return result
}

/** Generative-UI hot loading: watch the widgets directory and re-scan on
 *  every change, so a widget Hermes writes appears within ~a second — no
 *  `/widgets-reload`, no restart. Debounced (editors and write_file emit
 *  bursts); watches the PARENT until the directory exists so the very first
 *  widget ever written also hot-loads. Returns a stop() that releases every
 *  watcher and timer (the entry registers it as a scoped finalizer). */
export function watchUserWidgets(dir = widgetsDir()): () => void {
  let stopped = false
  let debounce: NodeJS.Timeout | undefined
  let poll: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined
  let parentWatcher: FSWatcher | undefined

  const attach = (): boolean => {
    try {
      watcher = watch(dir, () => {
        clearTimeout(debounce)
        debounce = setTimeout(() => void loadUserWidgets(dir), 300)
        debounce.unref()
      })
      watcher.unref()
      return true
    } catch {
      return false // directory doesn't exist yet
    }
  }

  if (!attach()) {
    try {
      parentWatcher = watch(dirname(dir), () => {
        if (stopped) return
        if (attach()) {
          parentWatcher?.close()
          parentWatcher = undefined
          void loadUserWidgets(dir)
        }
      })
      parentWatcher.unref()
    } catch {
      poll = setInterval(() => {
        if (stopped) return
        if (attach()) {
          if (poll) clearInterval(poll)
          poll = undefined
          void loadUserWidgets(dir)
        }
      }, 2_000)
      poll.unref()
    }
  }

  return () => {
    stopped = true
    if (debounce) clearTimeout(debounce)
    if (poll) clearInterval(poll)
    watcher?.close()
    parentWatcher?.close()
  }
}

/** Test/reset hook: forget file attributions (registry cleanup is the
 *  caller's business). */
export function resetUserWidgetFiles(): void {
  fileApps.clear()
}
