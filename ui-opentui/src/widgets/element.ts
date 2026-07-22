/**
 * Widget element trees — the `h()` layer of the native widget runtime.
 *
 * User widget files (`~/.hermes/tui-widgets/*.mjs`) are plain ESM with no JSX
 * and no bundler; they build UI with `sdk.h(type, props, ...children)` exactly
 * like the Ink engine (`sdk.h` is React.createElement there). Here `h` builds
 * a plain serializable-ish tree the runtime (runtime.ts) resolves into native
 * renderable descriptors. Nothing in this file touches Solid or the renderer.
 */

/** Leaf primitives the resolver understands. Everything else in the sdk
 *  (Dialog, Accordion, Shimmer, …) is a plain function component built on
 *  these two. */
export interface PrimitiveMarker {
  readonly widgetPrimitive: 'box' | 'fragment' | 'text'
}

export const Box: PrimitiveMarker = { widgetPrimitive: 'box' }
export const Text: PrimitiveMarker = { widgetPrimitive: 'text' }
export const Fragment: PrimitiveMarker = { widgetPrimitive: 'fragment' }

/** A function component in widget space: plain JS, may call the runtime's
 *  hooks (useState/useEffect/…) while the runtime is rendering it. */
export type WidgetComponent = (props: Record<string, unknown>) => WNode

/** Anything a widget render may return / nest as a child. `type` is typed
 *  `unknown` because user code can pass anything — the resolver validates. */
export interface WElement {
  readonly widgetElement: true
  type: unknown
  props: Record<string, unknown>
  children: WNode[]
}

export type WNode = WElement | WNode[] | string | number | boolean | null | undefined

export function isWElement(node: unknown): node is WElement {
  return typeof node === 'object' && node !== null && (node as { widgetElement?: unknown }).widgetElement === true
}

export function isPrimitiveMarker(type: unknown): type is PrimitiveMarker {
  if (typeof type !== 'object' || type === null) return false
  const kind = (type as { widgetPrimitive?: unknown }).widgetPrimitive
  return kind === 'box' || kind === 'text' || kind === 'fragment'
}

/** createElement. Children may come as varargs (React style) or a `children`
 *  prop; varargs win. Null props tolerated (user code passes `null`). */
export function h(type: unknown, props?: Record<string, unknown> | null, ...children: WNode[]): WElement {
  const p: Record<string, unknown> = { ...(props ?? {}) }
  const kids = children.length > 0 ? children : childrenFromProps(p)
  delete p['children']
  return { children: kids, props: p, type, widgetElement: true }
}

function childrenFromProps(props: Record<string, unknown>): WNode[] {
  const c = props['children']
  if (c === undefined) return []
  return Array.isArray(c) ? (c as WNode[]) : [c as WNode]
}
