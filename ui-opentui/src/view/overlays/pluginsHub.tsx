import type { BoxRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { PluginRow, PluginsListResponse, PluginsToggleResponse } from '../../boundary/schema/PluginResponses.ts'
import {
  pluginCursor,
  pluginLabel,
  pluginQuickIndex,
  replacePluginRow,
  pluginToggleTarget,
  pluginWindow,
  scopePlugins,
  type PluginScope
} from '../../logic/pluginsHub.ts'
import { useDimensions } from '../dimensions.tsx'
import { useCloseLayer } from '../keymap.tsx'
import { useTheme } from '../theme.tsx'

export interface PluginOps {
  list(): Promise<PluginsListResponse>
  toggle(row: PluginRow, enable: boolean): Promise<PluginsToggleResponse>
}
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function PluginsHub(props: { ops: PluginOps; onClose(): void }) {
  const theme = useTheme(),
    dims = useDimensions()
  let root: BoxRenderable | undefined
  let disposed = false,
    generation = 0
  const [rows, setRows] = createSignal<readonly PluginRow[]>([])
  const [userCount, setUserCount] = createSignal(0),
    [bundledCount, setBundledCount] = createSignal(0)
  const [scope, setScope] = createSignal<PluginScope>('user'),
    [cursor, setCursor] = createSignal(0)
  const [loading, setLoading] = createSignal(true),
    [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const scoped = createMemo(() => scopePlugins(rows(), scope()))
  const selected = createMemo(() => pluginCursor(scoped().rows.length, cursor(), 0))
  const windowed = createMemo(() => pluginWindow(scoped().rows, selected()))

  const load = async (): Promise<void> => {
    const current = ++generation
    setLoading(true)
    try {
      const response = await props.ops.list()
      if (disposed || current !== generation) return
      setRows(response.plugins ?? [])
      setUserCount(response.user_count ?? 0)
      setBundledCount(response.bundled_count ?? 0)
      setError('')
    } catch (cause) {
      if (!disposed && current === generation) setError(errorText(cause))
    } finally {
      if (!disposed && current === generation) setLoading(false)
    }
  }
  const toggle = async (row: PluginRow | undefined): Promise<void> => {
    if (!row || busy()) return
    const current = generation
    setBusy(true)
    setError('')
    try {
      const response = await props.ops.toggle(row, pluginToggleTarget(row))
      if (disposed || current !== generation) return
      if (response.plugin) {
        const next = response.plugin
        setRows(previous => replacePluginRow(previous, row, next))
      } else await load()
    } catch (cause) {
      if (!disposed && current === generation) setError(errorText(cause))
    } finally {
      if (!disposed && current === generation) setBusy(false)
    }
  }
  onMount(() => {
    root?.focus()
    void load()
  })
  onCleanup(() => {
    disposed = true
    generation += 1
  })
  useCloseLayer(
    () => root,
    () => {
      if (!busy()) props.onClose()
    }
  )
  useKeyboard(key => {
    if (busy()) return
    const count = scoped().rows.length
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return props.onClose()
    if (key.name === 'q') return props.onClose()
    if (key.name === 'up') return setCursor(value => pluginCursor(count, value, -1))
    if (key.name === 'down') return setCursor(value => pluginCursor(count, value, 1))
    if (key.name === 'tab') {
      key.preventDefault()
      setScope(value => (value === 'user' ? 'all' : 'user'))
      setCursor(0)
      return
    }
    if (key.name === 'return' || key.name === 'space') {
      key.preventDefault()
      void toggle(scoped().rows[selected()])
      return
    }
    const quick = pluginQuickIndex(key.name, count, selected())
    if (quick !== undefined) {
      key.preventDefault()
      setCursor(quick)
      void toggle(scoped().rows[quick])
    }
  })
  const scopeLabel = createMemo(() =>
    scoped().scope === 'user'
      ? `${String(userCount())} user plugin(s)${bundledCount() ? ` · +${String(bundledCount())} bundled (Tab)` : ''}`
      : `all ${String(rows().length)} plugins`
  )
  return (
    <box
      ref={value => (root = value)}
      focusable
      border
      style={{
        borderColor: theme().color.border,
        flexDirection: 'column',
        flexShrink: 0,
        marginTop: 1,
        padding: 1,
        width: Math.max(44, Math.min(96, dims().width - 6))
      }}
    >
      <Show when={!loading()} fallback={<text fg={theme().color.muted}>loading plugins…</text>}>
        <Show
          when={rows().length > 0}
          fallback={
            <box style={{ flexDirection: 'column' }}>
              <text fg={theme().color.accent}>
                <b>Plugins Hub</b>
              </text>
              <text fg={error() ? theme().color.error : theme().color.muted}>
                {error() ? `error: ${error()}` : 'no plugins installed'}
              </text>
              <Show when={!error()}>
                <text fg={theme().color.muted}>install: hermes plugins install owner/repo</text>
              </Show>
            </box>
          }
        >
          <text fg={theme().color.accent}>
            <b>Plugins Hub</b>
          </text>
          <text fg={theme().color.muted}>{scopeLabel()}</text>
          <Show when={windowed().offset > 0}>
            <text fg={theme().color.muted}>{` ↑ ${String(windowed().offset)} more`}</text>
          </Show>
          <For each={windowed().rows}>
            {(row, local) => {
              const absolute = () => windowed().offset + local(),
                active = () => absolute() === selected()
              return (
                <text fg={active() ? theme().color.accent : theme().color.muted} wrapMode="none">
                  <span style={{ bg: active() ? theme().color.selectionBg : 'transparent' }}>
                    {`${active() ? '▸' : ' '} ${String(local() + 1)}. ${pluginLabel(row, scoped().scope)}`}
                  </span>
                </text>
              )
            }}
          </For>
          <Show when={windowed().offset + windowed().rows.length < scoped().rows.length}>
            <text
              fg={theme().color.muted}
            >{` ↓ ${String(scoped().rows.length - windowed().offset - windowed().rows.length)} more`}</text>
          </Show>
          <Show when={error()}>{value => <text fg={theme().color.error}>error: {value()}</text>}</Show>
          <Show when={busy()}>
            <text fg={theme().color.accent}>updating…</text>
          </Show>
        </Show>
      </Show>
      <text fg={theme().color.muted}>↑/↓ select · Enter/Space toggle · Tab user/all · 1-9,0 quick · Esc/q close</text>
    </box>
  )
}
