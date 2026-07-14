/**
 * NotificationCard — the inline transcript card for a background-activity
 * notification (glitch 2026-06-13). Renders a `notification.show` as a distinct,
 * level-tinted one-line card so it's UNMISTAKABLY chrome, not model output (the
 * old behaviour leaked these as plain transcript lines that read like the agent
 * talking). Lives in the message stream (role `'notification'`) so it scrolls in
 * context; `selectable=false` keeps it out of copy/selection.
 *
 * Compact: a colored `◆` marker (distinct from the `●` status dot, the `·`
 * system glyph, and the `⚕`/`❯` turn glyphs) + a bold kind label + the text.
 */
import { createSignal, Show } from 'solid-js'

import type { ActivityNotification } from '../logic/backgroundActivity.ts'
import { sectionMode } from '../logic/details.ts'
import { useDisplay } from './display.tsx'
import { useScrollAnchor } from './scrollAnchor.tsx'
import { useTheme } from './theme.tsx'

export function NotificationCard(props: { notification: ActivityNotification; compact?: boolean }) {
  const theme = useTheme()
  const anchor = useScrollAnchor()
  const display = useDisplay()
  const [override, setOverride] = createSignal<boolean | undefined>(undefined)
  const n = () => props.notification
  const detail = () => n().detail?.trim() ?? ''
  const expanded = () =>
    override() ??
    sectionMode('activity', display().details, display().sections, display().detailsCommandOverride) === 'expanded'
  const toggle = () => anchor(() => setOverride(!expanded()))
  const levelColor = () => {
    const c = theme().color
    return n().level === 'error' ? c.error : n().level === 'warn' ? c.warn : c.accent
  }
  // A label for the card head: the kind if the gateway sent one, else a neutral word.
  const label = () => n().kind || 'notice'
  return (
    <box
      style={{
        flexDirection: 'column',
        flexShrink: 0,
        marginTop: props.compact ? 0 : 1,
        paddingLeft: 1,
        width: '100%'
      }}
    >
      <box style={{ flexDirection: 'row', flexShrink: 0 }} onMouseDown={() => detail() && toggle()}>
        <text selectable={false}>
          <span style={{ fg: levelColor() }}>
            <b>{'◆ '}</b>
          </span>
          <Show when={detail()}>
            <span style={{ fg: theme().color.muted }}>{expanded() ? '▼ ' : '▶ '}</span>
          </Show>
          <span style={{ fg: levelColor() }}>
            <b>{label()}</b>
          </span>
          <Show when={n().text}>
            <span style={{ fg: theme().color.muted }}>{`  ${n().text}`}</span>
          </Show>
        </text>
      </box>
      <Show when={detail() && expanded()}>
        <box
          style={{ flexDirection: 'column', flexShrink: 0, minWidth: 0, marginLeft: 2, paddingLeft: 1, width: '100%' }}
          border={['left']}
          borderColor={levelColor()}
        >
          <text fg={theme().color.muted}>{detail()}</text>
        </box>
      </Show>
    </box>
  )
}
