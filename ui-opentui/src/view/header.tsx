/**
 * Header — the top chrome line (spec v4 §2 `view/header.tsx`). Variant A
 * (v6 Epic 1.3, signed off): the header STAYS this minimal brand line —
 * brand · engine · ready/connecting, fully themed (`useTheme()`, NO hardcoded
 * styles — §7.5). All session chrome (model/context/cost/duration/profile/mcp/
 * cwd) lives in the dense bottom status bar (`statusBar.tsx`).
 *
 * Design pass (Appendix C): persistent chrome must not spend gold — the `☤`
 * icon in accent is the ONLY warm pixel up here; the wordmark demotes to muted
 * bold. This component also owns painting the ROOT CANVAS: it is always
 * mounted, so a reactive effect pushes `theme.color.bg` (true black by
 * default; skins may override) into `renderer.setBackgroundColor` — the dark
 * room the rest of the ink budget assumes.
 */
import { useRenderer } from '@opentui/solid'
import { createEffect, Show } from 'solid-js'

import type { SessionStore } from '../logic/store.ts'
import { useTheme } from './theme.tsx'

export function Header(props: { store: SessionStore }) {
  const theme = useTheme()
  const renderer = useRenderer()
  // Root canvas paint — best-effort (a styling miss must never crash chrome).
  createEffect(() => {
    const bg = theme().color.bg
    // Default is `transparent` = leave the terminal's background alone; only a
    // skin's explicit ui_bg paints the canvas.
    if (bg === 'transparent') return
    try {
      renderer.setBackgroundColor(bg)
    } catch {
      /* canvas paint is cosmetic */
    }
  })
  return (
    <box style={{ flexShrink: 0 }}>
      <text selectable={false}>
        {/* the accent icon is the header's single warm pixel; the wordmark is
            muted BOLD — structure without spending gold on decoration. */}
        <span style={{ fg: theme().color.accent }}>{`${theme().brand.icon} `}</span>
        <span style={{ fg: theme().color.muted }}>
          <b>{theme().brand.name}</b>
        </span>
        <span style={{ fg: theme().color.muted }}> · opentui · </span>
        <Show when={props.store.state.ready} fallback={<span style={{ fg: theme().color.muted }}>connecting…</span>}>
          <span style={{ fg: theme().color.ok }}>ready</span>
        </Show>
      </text>
    </box>
  )
}
