/**
 * StatusLine — the transient line just below the transcript (spec §3 chrome).
 * Shows EITHER:
 *   - a `hint` (e.g. "Ctrl+C again to quit" — item 11), in the warn colour and
 *     taking priority; or
 *   - an ANIMATED busy indicator (kaomoji face + optional wings, cycling) plus
 *     the verb from `thinking.delta`/`status.update` WHILE a turn runs, dim,
 *     cleared on `message.complete`. Faces/verbs/wings come from the active skin
 *     (`theme.spinner`); empty skin data falls back to the engine defaults below.
 * This keeps those transient indicators OUT of the transcript. Renders nothing
 * when both are idle.
 *
 * Idle/auto compaction (upstream 3a542bbef4d1 — #97239): while the store's
 * `compacting` latch is set the spinner stays visible even though
 * `info.running` is false, and the verb FREEZES on "compacting" — later
 * status/thinking traffic updates the system note, not the visible verb — so a
 * between-turns compaction pause never reads as a hung or vanished session.
 *
 * ARCHITECTURE (per the skins-spec adversarial gate): the animation is a BOUNDED
 * `setInterval` ARMED only while `info.running` or `compacting` and CLEARED on
 * stop/cleanup — NOT a `setFrameCallback` (the lone permanent frame callback is
 * the windowing poll; a second per-frame timer would fight it and defeat
 * idle-GC). The tick rate is ~10fps, far below a render-loop cadence, and the
 * timer never runs while idle, so it adds zero idle cost.
 */
import { createEffect, createSignal, onCleanup, Show } from 'solid-js'

import type { SessionStore } from '../logic/store.ts'
import { useTheme } from './theme.tsx'

// Engine-default spinner faces (used when the skin ships no `spinner` block).
const DEFAULT_FACES = ['(·)', '(•)', '(◦)', '(•)']
const TICK_MS = 100 // ~10fps — well below the render loop; never runs while idle.

export function StatusLine(props: { store: SessionStore }) {
  const theme = useTheme()
  const compacting = () => props.store.state.compacting
  // Frozen verb for the whole compaction pause; the raw status text otherwise.
  const verb = () => (compacting() ? 'compacting' : props.store.state.status)
  const busy = () => (props.store.state.info.running === true || compacting()) && props.store.state.hint === undefined

  // Animation frame counter — only advances while a turn runs (or compaction).
  const [frame, setFrame] = createSignal(0)
  createEffect(() => {
    if (!busy()) return // disarmed when idle — no timer, no cost.
    const id = setInterval(() => setFrame(f => f + 1), TICK_MS)
    onCleanup(() => clearInterval(id))
  })

  // Skin faces/wings (theme.spinner) with engine-default fallback.
  const faces = () => {
    const f = theme().spinner.thinkingFaces
    return f.length ? f : DEFAULT_FACES
  }
  const wings = () => theme().spinner.wings
  const face = () => {
    const fs = faces()
    return fs[frame() % fs.length] ?? DEFAULT_FACES[0]
  }
  const wing = () => {
    const w = wings()
    return w.length ? w[frame() % w.length] : undefined
  }

  // The animated busy prefix: optional left-wing + face (+ right-wing).
  const busyPrefix = () => {
    const w = wing()
    return w ? `${w[0]} ${face()} ${w[1]}` : face()
  }

  const hintText = () => props.store.state.hint
  // Three display states, in priority order:
  //   busy (running or compacting) → animated face (+ verb if present), accent
  //   hint                         → the hint text, warn
  //   idle                         → nothing
  return (
    <Show
      when={busy()}
      fallback={
        <Show when={hintText()}>
          {text => (
            <box style={{ flexShrink: 0 }}>
              <text selectable={false}>
                <span style={{ fg: theme().color.warn }}>{text()}</span>
              </text>
            </box>
          )}
        </Show>
      }
    >
      <box style={{ flexShrink: 0 }}>
        <text selectable={false}>
          <span style={{ fg: theme().color.accent }}>{busyPrefix()}</span>
          <Show when={verb()}>
            <span style={{ fg: theme().color.muted }}>{` ${verb()}`}</span>
          </Show>
        </text>
      </box>
    </Show>
  )
}
