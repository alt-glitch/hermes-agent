/**
 * The widget-app host — owns which widgets are active and their state, the
 * per-widget runtime instances (hook state + effect cleanups), and the launch/
 * close/update/input contract. Semantics mirror `ui-tui/src/sdk/host.tsx`:
 *
 * - Ambient apps join a dock array (relaunching with no argument toggles them
 *   closed — they capture no input, so the command is their only dismissal).
 * - Modal apps take the single modal slot and own every keypress.
 * - `updateWidget` patches state ONLY while the app is still active in its
 *   slot — a late fetch resolution can never resurrect a closed app.
 * - Everything user-code-facing is try/caught: a broken init refuses the
 *   launch with a printable line, a broken reducer closes the app, a broken
 *   render yields the ⚠ chip (runtime.ts). The TUI never crashes.
 *
 * State lives in module-level Solid signals (launch-level like the theme —
 * widgets deliberately survive /clear and resume; the dock is chrome, not
 * transcript).
 */
import { createSignal } from 'solid-js'

import { getLog } from '../boundary/log.ts'
import { getWidgetApp } from './registry.ts'
import { WidgetInstance } from './runtime.ts'
import type { ActiveWidget, AmbientZone, WidgetApp, WidgetInput } from './types.ts'

const [ambient, setAmbient] = createSignal<ActiveWidget[]>([])
const [modal, setModal] = createSignal<ActiveWidget | undefined>(undefined)
/** Bumped whenever an instance is disposed/rebuilt so views re-lookup. */
const [instancesVersion, setInstancesVersion] = createSignal(0)

const instances = new Map<string, WidgetInstance>()

/** Host → transcript notices (reduce crashes, etc.). The entry registers the
 *  store's pushSystem; tests may register a probe. */
let notify: (text: string) => void = () => {}
export function registerWidgetNotifier(fn: (text: string) => void): void {
  notify = fn
}

export const ambientWidgets = ambient
export const modalWidget = modal
export const widgetInstancesVersion = instancesVersion

const isAmbient = (app: WidgetApp<never>) => app.mode === 'ambient'

/** The native engine reserves in-flow dock rows only; rail/corner zones map
 *  to the nearest dock. */
export function dockPlacementOf(zone: AmbientZone | undefined): 'dock-bottom' | 'dock-top' {
  if (zone === 'dock-top' || zone === 'top-left' || zone === 'top-right') return 'dock-top'
  return 'dock-bottom'
}

export const zoneOf = (active: ActiveWidget): AmbientZone => getWidgetApp(active.appId)?.zone ?? 'dock-bottom'

const withoutApp = (list: ActiveWidget[], id: string) => list.filter(active => active.appId !== id)

function disposeInstance(id: string): void {
  const instance = instances.get(id)
  if (instance) {
    instance.dispose()
    instances.delete(id)
    setInstancesVersion(v => v + 1)
  }
}

/** The runtime instance for an active widget — created on first access,
 *  rebuilt when the registry holds a NEWER definition for the id (hot
 *  reload: fresh definition, fresh hook state). */
export function widgetInstanceFor(id: string): WidgetInstance | undefined {
  const app = getWidgetApp(id)
  if (!app) return undefined
  const existing = instances.get(id)
  if (existing && existing.app === app && !existing.isDisposed()) return existing
  if (existing) disposeInstance(id)
  const fresh = new WidgetInstance(app)
  instances.set(id, fresh)
  return fresh
}

/** Route a launched app to its slot: ambient apps join the dock array
 *  (replacing any prior instance), modal apps take the single modal slot. */
function place(app: WidgetApp<never>, state: unknown): void {
  disposeInstance(app.id) // fresh mount semantics on relaunch
  if (isAmbient(app)) {
    setAmbient(list => [...withoutApp(list, app.id), { appId: app.id, state }])
  } else {
    const current = modal()
    if (current && current.appId !== app.id) disposeInstance(current.appId)
    setModal({ appId: app.id, state })
  }
}

/** Launch by id. Returns null on success, a printable error/usage line on
 *  refusal — the caller owns the transcript. Relaunching an active ambient
 *  app (with no new argument) toggles it away. */
export function launchWidget(id: string, arg = ''): null | string {
  const app = getWidgetApp(id)
  if (!app) return `unknown widget app: ${id}`

  if (isAmbient(app) && ambient().some(active => active.appId === id) && !arg.trim()) {
    setAmbient(list => withoutApp(list, id))
    disposeInstance(id)
    return null
  }

  let state: unknown
  try {
    state = app.init(arg)
  } catch (error) {
    return `/${id}: ${error instanceof Error ? error.message : String(error)}`
  }
  if (state === null) return app.usage ?? `usage: /${id}`

  place(app, state)
  return null
}

/** Close the MODAL app. Ambient apps dismiss via their launch toggle. */
export function closeWidget(): void {
  const current = modal()
  if (current) disposeInstance(current.appId)
  setModal(undefined)
}

/** Programmatic, TYPED launch — bypasses string parsing (auto-open widgets
 *  call this from register()). */
export const openWidget = <S>(app: WidgetApp<S>, state: S): void => place(app as WidgetApp<never>, state)

/** Async state delivery: patch the app's state ONLY while it is still active
 *  in its slot — a late resolution can never resurrect a closed app or
 *  clobber a different one. */
export function updateWidget<S>(app: WidgetApp<S>, fn: (state: S) => S): void {
  try {
    if (isAmbient(app as WidgetApp<never>)) {
      if (ambient().some(active => active.appId === app.id)) {
        setAmbient(list =>
          list.map(active => (active.appId === app.id ? { appId: app.id, state: fn(active.state as S) } : active))
        )
      }
      return
    }
    const current = modal()
    if (current?.appId === app.id) setModal({ appId: app.id, state: fn(current.state as S) })
  } catch (error) {
    getLog().warn('widgets', 'updateWidget crashed', { error: String(error), id: app.id })
  }
}

/** Feed one keypress to the active MODAL app. Returns true when a modal app
 *  is active — apps swallow every key while open. A throwing reducer closes
 *  the app (fail closed) and surfaces a notice. */
export function dispatchWidgetInput(input: WidgetInput): boolean {
  const active = modal()
  if (!active) return false
  const app = getWidgetApp(active.appId)
  if (!app) {
    closeWidget()
    return true
  }
  let next: unknown
  try {
    next = app.reduce(active.state as never, input)
  } catch (error) {
    closeWidget()
    const message = error instanceof Error ? error.message : String(error)
    getLog().warn('widgets', 'widget reducer crashed', { error: message, id: active.appId })
    notify(`⚠ /${active.appId} crashed and was closed: ${message}`)
    return true
  }
  if (next === null) closeWidget()
  else if (next !== active.state) setModal({ appId: active.appId, state: next })
  return true
}

/** Unplace + dispose an app (its file was deleted). */
export function retireWidget(id: string): void {
  setAmbient(list => withoutApp(list, id))
  if (modal()?.appId === id) setModal(undefined)
  disposeInstance(id)
}

/** After a registry rescan, rebuild instances whose definition changed so a
 *  hot-reloaded file shadows the stale definition on the next paint. */
export function reconcileWidgetInstances(): void {
  for (const [id, instance] of instances) {
    if (getWidgetApp(id) !== instance.app) disposeInstance(id)
  }
}

/** Test/reset hook: close everything and drop all instances. */
export function disposeAllWidgets(): void {
  for (const id of [...instances.keys()]) disposeInstance(id)
  setAmbient([])
  setModal(undefined)
}
