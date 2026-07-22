/**
 * The widget runtime — a bounded, crash-isolated evaluator for the shared
 * `register(sdk)` widget contract (see the tui-widgets skill).
 *
 * The Ink engine runs widget code as real React components; user templates
 * therefore author against a small React surface (`h`, `useState`,
 * `useEffect`, `useMemo`, `useRef`, `useCallback` — the surface the skill
 * documents). This runtime implements exactly that surface natively: it walks
 * the `h()` element tree, gives function components hook slots keyed by tree
 * path, and resolves everything into plain {box,text} descriptor nodes
 * (`RNode`) that the Solid dock renders. State updates (setState from a timer,
 * a fetch, a click) schedule a coalesced re-render on a microtask.
 *
 * Fail-closed per widget: a throw anywhere (render, component body, effect)
 * yields an `error` node — the dock shows a compact ⚠ chip and the rest of
 * the TUI never sees the exception. A runaway setState loop trips a render
 * budget and freezes the widget with the same chip.
 */
import { createSignal, type Accessor } from 'solid-js'

import { getLog } from '../boundary/log.ts'
import { isPrimitiveMarker, isWElement, type WElement, type WNode } from './element.ts'
import type { Theme } from '../logic/theme.ts'
import type { WidgetApp, WidgetRenderCtx } from './types.ts'

// ── resolved descriptor tree (what the Solid view renders) ───────────

export interface RSpan {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
}

export interface RBox {
  kind: 'box'
  style: Record<string, number | string>
  border: boolean
  borderStyle?: 'double' | 'heavy' | 'rounded' | 'single'
  borderColor?: string
  title?: string
  onClick?: () => void
  children: RNode[]
}

export interface RText {
  kind: 'text'
  spans: RSpan[]
}

export interface RError {
  kind: 'error'
  message: string
}

export type RNode = RBox | RError | RText

// ── hooks machinery ──────────────────────────────────────────────────

interface EffectSlot {
  deps: unknown[] | undefined
  cleanup: (() => void) | undefined
  /** Set during render, consumed by the post-render flush. */
  pendingFn: (() => unknown) | undefined
  pendingDeps: unknown[] | undefined
  hasPending: boolean
}

interface ComponentRecord {
  fn: unknown
  hooks: unknown[]
  hookCursor: number
  effects: EffectSlot[]
  effectCursor: number
}

let currentInstance: WidgetInstance | undefined
let currentRecord: ComponentRecord | undefined

function requireRecord(hook: string): ComponentRecord {
  if (!currentRecord || !currentInstance) {
    throw new Error(`${hook} called outside a widget component render`)
  }
  return currentRecord
}

function depsEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false
  }
  return true
}

export function useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
  const record = requireRecord('useState')
  const instance = currentInstance as WidgetInstance
  const at = record.hookCursor
  record.hookCursor += 1
  if (record.hooks.length <= at) {
    record.hooks.push(typeof initial === 'function' ? (initial as () => T)() : initial)
  }
  const setter = (next: T | ((prev: T) => T)): void => {
    const prev = record.hooks[at] as T
    const value = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
    if (Object.is(prev, value)) return
    record.hooks[at] = value
    instance.invalidate()
  }
  return [record.hooks[at] as T, setter]
}

export function useEffect(fn: () => unknown, deps?: unknown[]): void {
  const record = requireRecord('useEffect')
  const at = record.effectCursor
  record.effectCursor += 1
  if (record.effects.length <= at) {
    record.effects.push({
      cleanup: undefined,
      deps: undefined,
      hasPending: false,
      pendingDeps: undefined,
      pendingFn: undefined
    })
  }
  const slot = record.effects[at] as EffectSlot
  slot.pendingFn = fn
  slot.pendingDeps = deps
  slot.hasPending = true
}

export function useMemo<T>(fn: () => T, deps?: unknown[]): T {
  const record = requireRecord('useMemo')
  const at = record.hookCursor
  record.hookCursor += 1
  const slot = record.hooks[at] as { deps: unknown[] | undefined; value: T } | undefined
  if (slot && depsEqual(slot.deps, deps)) return slot.value
  const value = fn()
  record.hooks[at] = { deps, value }
  return value
}

export function useRef<T>(initial: T): { current: T } {
  const record = requireRecord('useRef')
  const at = record.hookCursor
  record.hookCursor += 1
  if (record.hooks.length <= at) record.hooks.push({ current: initial })
  return record.hooks[at] as { current: T }
}

export function useCallback<T extends (...args: never[]) => unknown>(fn: T, deps?: unknown[]): T {
  return useMemo(() => fn, deps)
}

/** The theme of the instance currently rendering — lets runtime-provided
 *  components (Dialog, Accordion) derive colors without a prop, mirroring the
 *  Ink primitives that read the theme store. */
export function useWidgetTheme(): Theme {
  if (!currentInstance) throw new Error('useWidgetTheme called outside a widget render')
  return currentInstance.themeForRender()
}

// ── the instance ─────────────────────────────────────────────────────

/** Renders trigger at most this many times per second before the widget is
 *  frozen fail-closed (a setState loop in user code must not spin the TUI). */
const RENDER_BUDGET_PER_SECOND = 240

const EMPTY_TREE: RNode = { kind: 'text', spans: [] }

export class WidgetInstance {
  readonly app: WidgetApp<never>
  readonly tree: Accessor<RNode>
  private readonly setTree: (node: RNode) => void
  private records = new Map<string, ComponentRecord>()
  private lastCtx: WidgetRenderCtx<unknown> | undefined
  private disposed = false
  private frozen = false
  private scheduled = false
  private burstStart = 0
  private burstCount = 0

  constructor(app: WidgetApp<never>) {
    this.app = app
    const [tree, setTree] = createSignal<RNode>(EMPTY_TREE)
    this.tree = tree
    this.setTree = node => setTree(node)
  }

  themeForRender(): Theme {
    if (!this.lastCtx) throw new Error('no render context')
    return this.lastCtx.t
  }

  /** Render with a fresh host context (state / theme / dimensions). */
  render(ctx: WidgetRenderCtx<unknown>): void {
    this.lastCtx = ctx
    this.renderNow()
  }

  /** Coalesced re-render with the last context (hook state changed). */
  invalidate(): void {
    if (this.disposed || this.frozen || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (!this.disposed) this.renderNow()
    })
  }

  /** Tear down: run every effect cleanup (timers die here) and go inert.
   *  A late invalidate()/render() after dispose is a no-op — a closed widget
   *  can never resurrect. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.records.values()) runCleanups(record, this.app.id)
    this.records.clear()
    this.setTree(EMPTY_TREE)
  }

  isDisposed(): boolean {
    return this.disposed
  }

  private renderNow(): void {
    if (this.disposed || this.frozen || !this.lastCtx) return
    const now = Date.now()
    if (now - this.burstStart > 1000) {
      this.burstStart = now
      this.burstCount = 0
    }
    this.burstCount += 1
    if (this.burstCount > RENDER_BUDGET_PER_SECOND) {
      // Sticky freeze: cleanups run, further invalidates no-op. Relaunching
      // the widget builds a fresh instance.
      this.frozen = true
      getLog().warn('widgets', 'render budget exceeded — freezing widget', { id: this.app.id })
      for (const record of this.records.values()) runCleanups(record, this.app.id)
      this.records.clear()
      this.setTree({ kind: 'error', message: 'render loop — widget frozen' })
      return
    }

    const visited = new Set<string>()
    let resolved: RNode
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- module-level render cursor for the hook functions
    currentInstance = this
    try {
      const raw = this.app.render(this.lastCtx as WidgetRenderCtx<never>)
      const nodes = resolveChildren([raw], this, '', visited)
      resolved =
        nodes.length === 1
          ? (nodes[0] as RNode)
          : { border: false, children: nodes, kind: 'box', style: { flexDirection: 'column' } }
    } catch (error) {
      resolved = { kind: 'error', message: error instanceof Error ? error.message : String(error) }
      getLog().warn('widgets', 'widget render crashed', { error: String(error), id: this.app.id })
    } finally {
      currentInstance = undefined
      currentRecord = undefined
    }

    // Unmount components that disappeared from the tree this pass.
    for (const [path, record] of this.records) {
      if (!visited.has(path)) {
        runCleanups(record, this.app.id)
        this.records.delete(path)
      }
    }

    this.flushEffects(visited)
    this.setTree(resolved)
  }

  recordFor(path: string, fn: unknown): ComponentRecord {
    const existing = this.records.get(path)
    if (existing && existing.fn === fn) {
      existing.hookCursor = 0
      existing.effectCursor = 0
      return existing
    }
    // Same slot, different component (hot reload) — old hooks don't transfer.
    if (existing) runCleanups(existing, this.app.id)
    const fresh: ComponentRecord = { effectCursor: 0, effects: [], fn, hookCursor: 0, hooks: [] }
    this.records.set(path, fresh)
    return fresh
  }

  private flushEffects(visited: Set<string>): void {
    for (const path of visited) {
      const record = this.records.get(path)
      if (!record) continue
      for (const slot of record.effects) {
        if (!slot.hasPending) continue
        const fn = slot.pendingFn
        const deps = slot.pendingDeps
        slot.hasPending = false
        slot.pendingFn = undefined
        slot.pendingDeps = undefined
        if (depsEqual(slot.deps, deps)) continue
        try {
          slot.cleanup?.()
        } catch (error) {
          getLog().warn('widgets', 'effect cleanup crashed', { error: String(error), id: this.app.id })
        }
        slot.cleanup = undefined
        slot.deps = deps
        if (!fn) continue
        try {
          const result = fn()
          if (typeof result === 'function') slot.cleanup = result as () => void
        } catch (error) {
          getLog().warn('widgets', 'effect crashed', { error: String(error), id: this.app.id })
        }
      }
    }
  }
}

function runCleanups(record: ComponentRecord, appId: string): void {
  for (const slot of record.effects) {
    try {
      slot.cleanup?.()
    } catch (error) {
      getLog().warn('widgets', 'effect cleanup crashed', { error: String(error), id: appId })
    }
    slot.cleanup = undefined
    slot.deps = undefined
    slot.hasPending = false
    slot.pendingFn = undefined
    slot.pendingDeps = undefined
  }
}

// ── tree resolution ──────────────────────────────────────────────────

function componentName(fn: unknown): string {
  if (typeof fn === 'function' && fn.name) return fn.name
  return 'anonymous'
}

function resolveChildren(nodes: WNode[], instance: WidgetInstance, path: string, visited: Set<string>): RNode[] {
  const out: RNode[] = []
  nodes.forEach((child, index) => {
    out.push(...resolveNode(child, instance, `${path}/${index}`, visited))
  })
  return out
}

function resolveNode(node: WNode, instance: WidgetInstance, path: string, visited: Set<string>): RNode[] {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') {
    const text = String(node)
    return text.length > 0 ? [{ kind: 'text', spans: [{ text }] }] : []
  }
  if (Array.isArray(node)) return resolveChildren(node, instance, path, visited)
  if (!isWElement(node)) return []

  const type = node.type
  if (typeof type === 'function') {
    const componentPath = `${path}#${componentName(type)}`
    visited.add(componentPath)
    const record = instance.recordFor(componentPath, type)
    const parentRecord = currentRecord
    currentRecord = record
    let rendered: WNode
    try {
      rendered = (type as (props: Record<string, unknown>) => WNode)(propsWithChildren(node))
    } finally {
      currentRecord = parentRecord
    }
    return resolveNode(rendered, instance, componentPath, visited)
  }

  if (isPrimitiveMarker(type)) {
    if (type.widgetPrimitive === 'fragment') return resolveChildren(node.children, instance, path, visited)
    if (type.widgetPrimitive === 'text') {
      const spans: RSpan[] = []
      collectSpans(node, instance, path, visited, {}, spans)
      return [{ kind: 'text', spans }]
    }
    return [resolveBox(node, instance, path, visited)]
  }

  return [{ kind: 'error', message: 'unknown element type' }]
}

function propsWithChildren(el: WElement): Record<string, unknown> {
  const children = el.children.length === 0 ? undefined : el.children.length === 1 ? el.children[0] : el.children
  return children === undefined ? { ...el.props } : { ...el.props, children }
}

// ── text spans ───────────────────────────────────────────────────────

type SpanStyle = Omit<RSpan, 'text'>

function spanStyleFrom(props: Record<string, unknown>, inherited: SpanStyle): SpanStyle {
  const style: SpanStyle = { ...inherited }
  if (typeof props['color'] === 'string') style.fg = props['color']
  if (typeof props['backgroundColor'] === 'string') style.bg = props['backgroundColor']
  if (props['bold'] === true) style.bold = true
  if (props['italic'] === true) style.italic = true
  if (props['underline'] === true) style.underline = true
  if (props['dimColor'] === true) style.dim = true
  return style
}

/** Flatten a `<Text>` subtree into styled spans. Nested Text merges styles
 *  (child wins per property); function components inside Text (Shimmer) are
 *  resolved through the runtime and contribute their spans. */
function collectSpans(
  el: WElement,
  instance: WidgetInstance,
  path: string,
  visited: Set<string>,
  inherited: SpanStyle,
  out: RSpan[]
): void {
  const style = spanStyleFrom(el.props, inherited)
  el.children.forEach((child, index) => {
    collectSpanChild(child, instance, `${path}/${index}`, visited, style, out)
  })
}

function collectSpanChild(
  node: WNode,
  instance: WidgetInstance,
  path: string,
  visited: Set<string>,
  style: SpanStyle,
  out: RSpan[]
): void {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') {
    const text = String(node)
    if (text.length > 0) out.push({ ...style, text })
    return
  }
  if (Array.isArray(node)) {
    node.forEach((child, index) => collectSpanChild(child, instance, `${path}/${index}`, visited, style, out))
    return
  }
  if (!isWElement(node)) return
  const type = node.type
  if (isPrimitiveMarker(type) && type.widgetPrimitive === 'text') {
    collectSpans(node, instance, path, visited, style, out)
    return
  }
  if (isPrimitiveMarker(type) && type.widgetPrimitive === 'fragment') {
    node.children.forEach((child, index) => collectSpanChild(child, instance, `${path}/${index}`, visited, style, out))
    return
  }
  if (typeof type === 'function') {
    // A component nested inside Text (e.g. Shimmer rows) — resolve it and
    // absorb any text rows it produced into this row's spans.
    for (const resolved of resolveNode(node, instance, path, visited)) {
      if (resolved.kind === 'text') out.push(...resolved.spans.map(span => ({ ...style, ...span })))
    }
  }
  // A Box inside Text is invalid on both engines — dropped, not fatal.
}

// ── box props ────────────────────────────────────────────────────────

const BORDER_STYLES: Record<string, RBox['borderStyle']> = {
  bold: 'heavy',
  classic: 'single',
  double: 'double',
  round: 'rounded',
  rounded: 'rounded',
  single: 'single'
}

const PASSTHROUGH_NUMBER = [
  'columnGap',
  'flexBasis',
  'flexGrow',
  'flexShrink',
  'gap',
  'height',
  'margin',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'marginTop',
  'maxHeight',
  'maxWidth',
  'minHeight',
  'minWidth',
  'padding',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'rowGap',
  'width'
] as const

const PASSTHROUGH_STRING = [
  'alignItems',
  'alignSelf',
  'flexDirection',
  'flexWrap',
  'justifyContent',
  'overflow'
] as const

function resolveBox(el: WElement, instance: WidgetInstance, path: string, visited: Set<string>): RBox {
  const props = el.props
  // Ink Box defaults to row; native <box> defaults differ — pin the shared
  // contract's default so templates lay out identically on both engines.
  const style: Record<string, number | string> = { flexDirection: 'row' }
  for (const key of PASSTHROUGH_NUMBER) {
    const v = props[key]
    if (typeof v === 'number') style[key] = v
    else if (typeof v === 'string' && key === 'width') style[key] = v
    else if (typeof v === 'string' && key === 'height') style[key] = v
  }
  for (const key of PASSTHROUGH_STRING) {
    const v = props[key]
    if (typeof v === 'string') style[key] = v
  }
  // Ink axis shorthands.
  if (typeof props['paddingX'] === 'number') {
    style['paddingLeft'] = props['paddingX']
    style['paddingRight'] = props['paddingX']
  }
  if (typeof props['paddingY'] === 'number') {
    style['paddingTop'] = props['paddingY']
    style['paddingBottom'] = props['paddingY']
  }
  if (typeof props['marginX'] === 'number') {
    style['marginLeft'] = props['marginX']
    style['marginRight'] = props['marginX']
  }
  if (typeof props['marginY'] === 'number') {
    style['marginTop'] = props['marginY']
    style['marginBottom'] = props['marginY']
  }
  if (typeof props['backgroundColor'] === 'string') style['backgroundColor'] = props['backgroundColor']

  const borderStyleRaw = props['borderStyle']
  const borderStyle = typeof borderStyleRaw === 'string' ? BORDER_STYLES[borderStyleRaw] : undefined
  const box: RBox = {
    border: borderStyle !== undefined,
    children: resolveChildren(el.children, instance, path, visited),
    kind: 'box',
    style
  }
  if (borderStyle !== undefined) box.borderStyle = borderStyle
  if (typeof props['borderColor'] === 'string') box.borderColor = props['borderColor']
  if (typeof props['title'] === 'string') box.title = props['title']
  const onClick = props['onClick']
  if (typeof onClick === 'function') box.onClick = () => (onClick as () => void)()
  return box
}
