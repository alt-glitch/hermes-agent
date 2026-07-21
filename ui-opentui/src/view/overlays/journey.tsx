import type { BoxRenderable, MouseEvent, ScrollBoxRenderable, TextareaRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import {
  decodeJourneyDetail,
  decodeJourneyFrames,
  decodeJourneyMutation,
  type JourneyFrames
} from '../../boundary/schema/JourneyResponses.ts'
import { journeyRows, journeyStep, journeyWindowStart } from '../../logic/journey.ts'
import { useDimensions } from '../dimensions.tsx'
import { useCloseLayer } from '../keymap.tsx'
import { useTheme } from '../theme.tsx'

interface JourneyLegendItem {
  color?: string
  glyph: string
  label: string
  style?: string
}
interface JourneyRun {
  0: string
  1?: string
  2?: number
  3?: string | null
}
interface JourneyFrame {
  grid?: JourneyRun[][]
}
interface JourneyVisual {
  axis: { end: string; start: string }
  categories?: JourneyLegendItem[]
  frames: JourneyFrame[]
  legend: JourneyLegendItem[]
}

export interface JourneyOps {
  frames(cols: number, rows: number): Promise<unknown>
  detail(id: string): Promise<unknown>
  edit(id: string, content: string): Promise<unknown>
  delete(id: string): Promise<unknown>
}
export function JourneyOverlay(props: { ops: JourneyOps; onClose(): void }) {
  const theme = useTheme(),
    dims = useDimensions()
  let root: BoxRenderable | undefined,
    listBox: BoxRenderable | undefined,
    editor: TextareaRenderable | undefined,
    detailScroll: ScrollBoxRenderable | undefined
  let loadGeneration = 0
  let disposed = false
  let pendingListHeight: number | undefined
  const [data, setData] = createSignal<JourneyFrames>()
  const [cursor, setCursor] = createSignal(0)
  const [listHeight, setListHeight] = createSignal(4)
  const [mode, setMode] = createSignal<'timeline' | 'detail' | 'edit'>('timeline')
  const [loading, setLoading] = createSignal(true),
    [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal(''),
    [notice, setNotice] = createSignal(''),
    [confirm, setConfirm] = createSignal(false),
    [content, setContent] = createSignal('')
  const rows = createMemo(() => journeyRows(data()))
  const visual = createMemo(() => data() as unknown as JourneyVisual | undefined)
  const chart = createMemo(() => {
    if (dims().width < 80) return []
    const grid = visual()?.frames.at(-1)?.grid ?? []
    return grid
      .filter(
        row =>
          !row
            .map(run => run[0])
            .join('')
            .trimStart()
            .startsWith('trajectory')
      )
      .slice(-8)
  })
  const runColor = (run: JourneyRun) =>
    run[3] ||
    (run[1] === 'bright' ? theme().color.accent : run[1] === 'dim' ? theme().color.muted : theme().color.primary)
  const active = () => rows()[cursor()]
  const node = () => {
    const r = active()
    return r?.kind === 'node' ? r.node : undefined
  }
  const bucket = () => active()?.bucket
  const load = async () => {
    const generation = ++loadGeneration
    setLoading(true)
    setError('')
    try {
      const decoded = decodeJourneyFrames(
        await props.ops.frames(Math.max(20, dims().width - 8), Math.max(5, Math.floor(dims().height * 0.32)))
      )
      if (!decoded) throw new Error('invalid learning.frames response')
      if (disposed || generation !== loadGeneration) return
      setData(decoded)
      setCursor(Math.max(0, journeyRows(decoded).length - 1))
    } catch (e) {
      if (disposed || generation !== loadGeneration) return
      setError(e instanceof Error ? e.message : 'could not load journey')
    } finally {
      if (!disposed && generation === loadGeneration) setLoading(false)
    }
  }
  createEffect(() => {
    void dims().width
    void dims().height
    root?.focus()
    void load()
  })
  onCleanup(() => {
    disposed = true
    loadGeneration++
  })
  useCloseLayer(
    () => root,
    () => {
      if (mode() === 'edit') setMode('detail')
      else if (mode() === 'detail') setMode('timeline')
      else props.onClose()
    }
  )
  const open = async (edit = false) => {
    const n = node()
    if (!n) return
    if (!edit && n.body) {
      setContent(n.body)
      setMode('detail')
      return
    }
    setBusy(true)
    try {
      const d = decodeJourneyDetail(await props.ops.detail(n.id))
      if (!d?.ok || d.content === undefined) throw new Error(d?.message || 'cannot load detail')
      setContent(d.content)
      setMode(edit ? 'edit' : 'detail')
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'cannot load detail')
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    const n = node()
    if (!n) return
    setBusy(true)
    try {
      const r = decodeJourneyMutation(await props.ops.edit(n.id, editor?.plainText ?? content()))
      if (!r) throw new Error('invalid learning.edit response')
      setNotice(r.message)
      if (r.ok) {
        setMode('timeline')
        await load()
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'edit failed')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    const n = node()
    if (!n) return
    setBusy(true)
    try {
      const r = decodeJourneyMutation(await props.ops.delete(n.id))
      if (!r) throw new Error('invalid learning.delete response')
      setNotice(r.message)
      if (r.ok) {
        setMode('timeline')
        await load()
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'delete failed')
    } finally {
      setBusy(false)
      setConfirm(false)
    }
  }
  useKeyboard(k => {
    if (busy()) return
    if (confirm()) {
      k.preventDefault()
      if (k.name.toLowerCase() === 'y') void remove()
      else setConfirm(false)
      return
    }
    if (mode() === 'edit') {
      if (k.ctrl && k.name.toLowerCase() === 's') {
        k.preventDefault()
        void save()
      }
      return
    }
    if (k.name === 'q') {
      props.onClose()
      return
    }
    if (k.name === 'r') {
      void load()
      return
    }
    if (k.name === 'left' || k.name.toLowerCase() === 'h') {
      if (mode() === 'detail') setMode('timeline')
      else props.onClose()
      return
    }
    if (node() && k.name.toLowerCase() === 'e') {
      void open(true)
      return
    }
    if (node() && k.name.toLowerCase() === 'd') {
      setConfirm(true)
      return
    }
    if (mode() === 'detail') {
      const page = Math.max(4, dims().height - 10)
      if (k.name === 'up' || k.name.toLowerCase() === 'k') detailScroll?.scrollBy(-2)
      else if (k.name === 'down' || k.name.toLowerCase() === 'j') detailScroll?.scrollBy(2)
      else if (k.name === 'pageup' || (k.ctrl && k.name.toLowerCase() === 'u')) detailScroll?.scrollBy(-page)
      else if (k.name === 'pagedown' || (k.ctrl && k.name.toLowerCase() === 'd') || k.name === 'space')
        detailScroll?.scrollBy(page)
      else if (k.name.toLowerCase() === 'g') detailScroll?.scrollTo(k.shift ? Number.MAX_SAFE_INTEGER : 0)
      return
    }
    if (k.name === 'return' || k.name === 'right') {
      void open()
      return
    }
    if (k.name === 'up' || k.name.toLowerCase() === 'k') setCursor(i => journeyStep(rows(), i, -1))
    if (k.name === 'down' || k.name.toLowerCase() === 'j') setCursor(i => journeyStep(rows(), i, 1))
    if (k.name.toLowerCase() === 'g') setCursor(k.shift ? Math.max(0, rows().length - 1) : 0)
  })
  createEffect(() => {
    if (mode() === 'edit' && editor && !editor.isDestroyed && editor.plainText !== content()) {
      editor.setText(content())
      editor.cursorOffset = content().length
    }
  })
  const visible = createMemo(() => {
    const h = Math.max(1, listHeight()),
      s = journeyWindowStart(cursor(), rows().length, h)
    return rows()
      .slice(s, s + h)
      .map((row, i) => ({ row, index: s + i }))
  })
  const syncListHeight = () => {
    const measured = Math.floor(listBox?.height ?? 0)
    const next = Number.isFinite(measured) && measured > 0 ? measured : 1
    if (next === listHeight() || next === pendingListHeight) return
    pendingListHeight = next
    // onSizeChange fires inside Yoga's active layout pass. Mutating the Solid
    // tree synchronously from that callback can feed negative/transient
    // coordinates into the native hit grid, so commit after the pass returns.
    queueMicrotask(() => {
      const measured = pendingListHeight
      pendingListHeight = undefined
      if (!disposed && measured !== undefined && measured !== listHeight()) setListHeight(measured)
    })
  }
  const scrollTimeline = (event: MouseEvent) => {
    if (mode() !== 'timeline') return
    const direction = event.scroll?.direction
    if (direction !== 'up' && direction !== 'down') return
    event.preventDefault()
    event.stopPropagation()
    if (busy() || confirm()) return
    const distance = Math.max(1, Math.ceil(Math.abs(event.scroll?.delta ?? 1)))
    setCursor(index => journeyStep(rows(), index, direction === 'up' ? -distance : distance))
  }
  return (
    <box
      ref={e => (root = e)}
      border
      onMouseScroll={scrollTimeline}
      style={{ borderColor: theme().color.border, flexDirection: 'column', flexGrow: 1, padding: 1 }}
    >
      <text flexShrink={0} fg={theme().color.accent} truncate wrapMode="none">
        <b>✦ Journey</b>
        <span style={{ fg: theme().color.muted }}> learned skills & memories over time</span>
      </text>
      <Show when={loading()}>
        <text fg={theme().color.muted}>assembling your learning map…</text>
      </Show>
      <Show when={error()}>{e => <text fg={theme().color.error}>error: {e()} · r retry</text>}</Show>
      <Show when={!loading() && !error() && data()?.count === 0}>
        <text fg={theme().color.muted}>No learning yet — learned skills and memories will map out here.</text>
      </Show>
      <Show when={mode() === 'timeline'}>
        <box style={{ flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
          <text flexShrink={0} truncate wrapMode="none">
            {visual()?.legend.map((item, index) => (
              <span style={{ fg: item.color || theme().color.muted }}>
                {index ? '   ' : ''}
                {item.glyph} {item.label}
              </span>
            ))}
          </text>
          <Show when={visual()?.categories?.length}>
            <text flexShrink={0} truncate wrapMode="none">
              {visual()?.categories?.map((item, index) => (
                <span style={{ fg: item.color || theme().color.muted }}>
                  {index ? '  ' : ''}
                  {item.glyph} {item.label}
                </span>
              ))}
            </text>
          </Show>
          <Show when={dims().width < 80}>
            <text flexShrink={0} fg={theme().color.muted} truncate wrapMode="none">
              starmap hidden below 80 columns · resize to view
            </text>
          </Show>
          <For each={chart()}>
            {row => (
              <text flexShrink={0} truncate wrapMode="none">
                {row.map(run => (
                  <span style={{ fg: runColor(run) }}>{run[0]}</span>
                ))}
              </text>
            )}
          </For>
          <box style={{ flexDirection: 'row', flexShrink: 0, justifyContent: 'space-between', overflow: 'hidden' }}>
            <text flexShrink={0} fg={theme().color.muted} wrapMode="none">
              {visual()?.axis.start}
            </text>
            <text flexShrink={0} fg={theme().color.muted} wrapMode="none">
              {visual()?.axis.end}
            </text>
          </box>
        </box>
        <text flexShrink={0} fg={theme().color.muted} truncate wrapMode="none">
          {data()?.summary.join(' · ')}
        </text>
        <box
          ref={e => (listBox = e)}
          onSizeChange={syncListHeight}
          style={{ flexDirection: 'column', flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: 'hidden' }}
        >
          <For each={visible()}>
            {item => {
              const selected = () => item.index === cursor()
              return (
                <box
                  onMouseDown={() => setCursor(item.index)}
                  style={{
                    backgroundColor: selected() ? theme().color.selectionBg : 'transparent',
                    flexShrink: 0,
                    height: 1,
                    overflow: 'hidden'
                  }}
                >
                  <text
                    flexGrow={1}
                    fg={selected() ? theme().color.text : theme().color.muted}
                    truncate
                    wrapMode="none"
                  >
                    {item.row.kind === 'slice'
                      ? `${item.row.bucket.label} · ${item.row.bucket.skills} skills · ${item.row.bucket.memories} memories`
                      : ` ${item.row.last ? '└─' : '├─'} ${item.row.node.glyph} ${item.row.node.fullLabel || item.row.node.label}  ${item.row.node.meta}${item.row.node.body ? ' ›' : ''}`}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
      <Show when={mode() === 'detail'}>
        <text fg={theme().color.accent}>
          {node()?.glyph} {node()?.fullLabel || node()?.label}
        </text>
        <text fg={theme().color.muted}>
          {bucket()?.label} · {node()?.meta}
        </text>
        <scrollbox ref={e => (detailScroll = e)} style={{ flexGrow: 1, minHeight: 0 }}>
          <box style={{ flexDirection: 'column', paddingBottom: 1 }}>
            <For each={content().split('\n')}>{line => <text fg={theme().color.text}>{line || ' '}</text>}</For>
          </box>
        </scrollbox>
      </Show>
      <Show when={mode() === 'edit'}>
        <text fg={theme().color.warn}>Editing {node()?.fullLabel || node()?.label} · Ctrl+S save · Esc cancel</text>
        <textarea
          ref={e => (editor = e)}
          focused
          onContentChange={setContent}
          textColor={theme().color.text}
          cursorColor={theme().color.accent}
          style={{ flexGrow: 1, minHeight: 4 }}
        />
      </Show>
      <Show when={confirm()}>
        <text fg={theme().color.warn}>Delete “{node()?.fullLabel || node()?.label}”? y confirm · any key cancel</text>
      </Show>
      <Show when={notice()}>{n => <text fg={theme().color.muted}>{n()}</text>}</Show>
      <text flexShrink={0} fg={theme().color.muted} truncate wrapMode="none">
        {mode() === 'timeline'
          ? 'wheel/↑↓/jk move · Enter open · e edit · d delete · r retry · q close'
          : '↑↓ scroll · e edit · d delete · Esc back · q close'}
      </text>
    </box>
  )
}
