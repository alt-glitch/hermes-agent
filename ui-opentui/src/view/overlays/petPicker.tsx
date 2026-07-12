import type { BoxRenderable, InputRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { PetGalleryResponse, PetSelectResponse } from '../../boundary/schema/PetResponses.ts'
import { petCursor, petMarker, petTag, petWindow, visiblePets } from '../../logic/petPicker.ts'
import { useDimensions } from '../dimensions.tsx'
import { useCloseLayer } from '../keymap.tsx'
import { useTheme } from '../theme.tsx'

export interface PetOps {
  gallery(): Promise<PetGalleryResponse>
  select(slug: string): Promise<PetSelectResponse>
}
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function PetPicker(props: { ops: PetOps; onClose(): void }) {
  const theme = useTheme(),
    dims = useDimensions()
  let root: BoxRenderable | undefined, input: InputRenderable | undefined
  let disposed = false,
    generation = 0
  const [gallery, setGallery] = createSignal<PetGalleryResponse>()
  const [query, setQuery] = createSignal(''),
    [cursor, setCursor] = createSignal(0)
  const [loading, setLoading] = createSignal(true),
    [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const rows = createMemo(() => visiblePets(gallery(), query()))
  const selected = createMemo(() => petCursor(rows().length, cursor(), 0))
  const windowed = createMemo(() => petWindow(rows(), selected()))

  onMount(() => {
    root?.focus()
    input?.focus()
    const current = ++generation
    props.ops
      .gallery()
      .then(response => {
        if (disposed || current !== generation) return
        setGallery(response)
        setError('')
      })
      .catch(cause => {
        if (!disposed && current === generation) setError(errorText(cause))
      })
      .finally(() => {
        if (!disposed && current === generation) setLoading(false)
      })
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
  const adopt = async (): Promise<void> => {
    const row = rows()[selected()]
    if (!row || busy()) return
    const current = generation
    setBusy(true)
    setError('')
    try {
      const response = await props.ops.select(row.slug)
      if (disposed || current !== generation) return
      if (!response.ok) throw new Error('pet adoption failed')
      props.onClose()
    } catch (cause) {
      if (!disposed && current === generation) setError(errorText(cause))
    } finally {
      if (!disposed && current === generation) setBusy(false)
    }
  }
  useKeyboard(key => {
    if (busy()) {
      key.preventDefault()
      return
    }
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return props.onClose()
    if (key.name === 'up') {
      key.preventDefault()
      setCursor(value => petCursor(rows().length, value, -1))
      return
    }
    if (key.name === 'down') {
      key.preventDefault()
      setCursor(value => petCursor(rows().length, value, 1))
      return
    }
    if (key.name === 'return') {
      key.preventDefault()
      void adopt()
    }
  })
  return (
    <box
      ref={value => (root = value)}
      border
      style={{
        borderColor: theme().color.border,
        flexDirection: 'column',
        flexShrink: 0,
        marginTop: 1,
        padding: 1,
        width: Math.max(40, Math.min(90, dims().width - 6))
      }}
    >
      <Show when={!loading()} fallback={<text fg={theme().color.muted}>loading pets…</text>}>
        <Show when={gallery()} fallback={<text fg={theme().color.error}>error: {error()}</text>}>
          {value => (
            <>
              <box style={{ flexDirection: 'row' }}>
                <text fg={theme().color.accent}>
                  <b>Pets</b>
                </text>
                <text fg={theme().color.muted}>{'  '}</text>
                <input
                  ref={item => (input = item)}
                  focused
                  value={query()}
                  onInput={text => {
                    setQuery(text)
                    setCursor(0)
                  }}
                  placeholder="type to filter"
                  placeholderColor={theme().color.muted}
                  textColor={theme().color.text}
                  cursorColor={theme().color.accent}
                  style={{ flexGrow: 1, minWidth: 0 }}
                />
              </box>
              <text
                fg={theme().color.muted}
              >{`${query() ? `filter: ${query()}` : 'type to filter'} · ${String(rows().length)} pet${rows().length === 1 ? '' : 's'}`}</text>
              <Show when={windowed().offset > 0}>
                <text fg={theme().color.muted}>{` ↑ ${String(windowed().offset)} more`}</text>
              </Show>
              <Show
                when={rows().length > 0}
                fallback={
                  <text fg={theme().color.muted}>{query() ? `no pets match “${query()}”` : 'no pets available'}</text>
                }
              >
                <For each={windowed().rows}>
                  {(row, local) => {
                    const absolute = () => windowed().offset + local(),
                      active = () => absolute() === selected()
                    return (
                      <text fg={active() ? theme().color.accent : theme().color.muted} wrapMode="none">
                        <span style={{ bg: active() ? theme().color.selectionBg : 'transparent' }}>
                          {`${active() ? '▸' : ' '} ${petMarker(row, value())} ${row.displayName} (${row.slug}${petTag(row)})`}
                        </span>
                      </text>
                    )
                  }}
                </For>
              </Show>
              <Show when={windowed().offset + windowed().rows.length < rows().length}>
                <text
                  fg={theme().color.muted}
                >{` ↓ ${String(rows().length - windowed().offset - windowed().rows.length)} more`}</text>
              </Show>
              <Show when={error()}>{message => <text fg={theme().color.error}>error: {message()}</text>}</Show>
              <Show when={busy()}>
                <text fg={theme().color.accent}>adopting…</text>
              </Show>
            </>
          )}
        </Show>
      </Show>
      <text fg={theme().color.muted}>↑/↓ select · Enter adopt · type to filter · Esc cancel</text>
    </box>
  )
}
