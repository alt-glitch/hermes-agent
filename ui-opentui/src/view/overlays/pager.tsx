/**
 * Pager — a full-height scrollable text viewer (spec §2b `FloatBox` pager).
 * Porting it unlocks the long-output slash commands (/status /logs /history
 * /tools) at once. Replaces the transcript+composer while open (the App swaps it
 * in on `store.state.pager`).
 *
 * Scrolling is driven explicitly via a GLOBAL `useKeyboard` → `scrollBy`/`scrollTo`
 * (no reliance on focus); Esc/Ctrl+C close via the native keymap. Carries the §8 #2
 * scrollbox gotchas (minHeight:0 wrapper+box, NO flexDirection on the box root).
 */
import { type BoxRenderable, type ScrollBoxRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { onMount } from 'solid-js'

import { useCloseLayer } from '../keymap.tsx'
import { useTheme } from '../theme.tsx'

const PAGE = 10

export function Pager(props: { title: string; text: string; onClose: () => void }) {
  const theme = useTheme()
  let rootRef: BoxRenderable | undefined
  let box: ScrollBoxRenderable | undefined

  // Close (Esc/Ctrl+C) is the native keymap; scroll keys stay in the raw global
  // handler below. Focus the root box on mount so the focus-within close layer is
  // active (the scrollbox isn't focused — scroll is global, not focus-gated).
  onMount(() => rootRef?.focus())
  useCloseLayer(
    () => rootRef,
    () => props.onClose()
  )

  useKeyboard(key => {
    // `q` closes (the footer advertises "Esc/q close"); Esc/Ctrl+C close via the
    // keymap layer above. Scroll stays raw (not focus-gated).
    if (key.name === 'q') return props.onClose()
    if (!box) return
    if (key.name === 'up' || key.name === 'k') box.scrollBy(-1)
    else if (key.name === 'down' || key.name === 'j') box.scrollBy(1)
    else if (key.name === 'pageup' || key.name === 'b') box.scrollBy(-PAGE)
    else if (key.name === 'pagedown' || key.name === 'f' || key.name === 'space' || key.name === 'return') {
      key.preventDefault()
      const maxScrollTop = Math.max(0, box.scrollHeight - box.viewport.height)
      if (box.scrollTop >= maxScrollTop) props.onClose()
      else box.scrollBy(PAGE)
    } else if (key.name === 'home' || (key.name === 'g' && !key.shift)) box.scrollTo(0)
    else if (key.name === 'end' || (key.name === 'g' && key.shift)) box.scrollTo({ x: 0, y: box.scrollHeight })
  })

  return (
    <box
      ref={el => (rootRef = el)}
      focusable
      style={{ borderColor: theme().color.accent, flexDirection: 'column', flexGrow: 1, minHeight: 0 }}
      border
    >
      <box style={{ flexShrink: 0, paddingLeft: 1 }}>
        <text fg={theme().color.accent}>
          <b>{props.title}</b>
        </text>
      </box>
      <box style={{ flexGrow: 1, minHeight: 0 }}>
        <scrollbox ref={el => (box = el)} style={{ flexGrow: 1, minHeight: 0 }}>
          {/* One multiline native text buffer, not one renderable per line. A
              3k-message /history can contain tens of thousands of explicit
              lines; mapping each line to <text> exhausts OpenTUI's process-wide
              65k native-handle table and bypasses transcript windowing. */}
          <text fg={theme().color.text}>{props.text}</text>
        </scrollbox>
      </box>
      <box style={{ flexShrink: 0, paddingLeft: 1 }}>
        <text fg={theme().color.muted}>Esc/q close · ↑↓/jk · Enter/Space/PgDn · g/G scroll</text>
      </box>
    </box>
  )
}
