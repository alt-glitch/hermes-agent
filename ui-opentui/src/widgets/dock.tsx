/**
 * Widget chrome — the ambient dock rows and the modal widget panel.
 *
 * Placement (per the pinned-chrome rules): everything here sits OUTSIDE the
 * transcript `<scrollbox>`/windowing boundary, in the flex chrome column.
 * `dock-top` renders under the header, `dock-bottom` directly above the
 * status bar; both are in-FLOW (they reserve real rows, never paint over the
 * transcript) and BOUNDED — the dock clamps to `DOCK_MAX_ROWS` rows so a
 * misbehaving widget cannot eat the screen. Ambient widgets capture no input:
 * the composer stays mounted and focused.
 *
 * The modal panel replaces the composer in the input-zone `<Switch>` (Picker
 * pattern) and routes every keypress to the app's reducer.
 */
import { useKeyboard } from '@opentui/solid'
import { createEffect, createMemo, For, Match, Show, Switch } from 'solid-js'

import { useDimensions } from '../view/dimensions.tsx'
import { useTheme } from '../view/theme.tsx'
import {
  ambientWidgets,
  dispatchWidgetInput,
  dockPlacementOf,
  widgetInstanceFor,
  widgetInstancesVersion,
  zoneOf
} from './host.ts'
import type { RBox, RNode, RSpan } from './runtime.ts'
import type { ActiveWidget, WidgetInput } from './types.ts'

/** Rows an ambient dock may reserve above the status bar / under the header. */
export const DOCK_MAX_ROWS = 6

// ── key adaptation (native KeyEvent → the shared WidgetInput contract) ─

interface NativeKeyEvent {
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  option?: boolean
  sequence: string
  eventType?: string
}

export function toWidgetInput(key: NativeKeyEvent): WidgetInput {
  const printable = key.sequence.length === 1 && !key.ctrl && !key.meta && key.sequence >= ' ' ? key.sequence : ''
  return {
    ch: printable,
    key: {
      backspace: key.name === 'backspace',
      ctrl: key.ctrl,
      delete: key.name === 'delete',
      downArrow: key.name === 'down',
      escape: key.name === 'escape',
      leftArrow: key.name === 'left',
      meta: key.meta || key.option === true,
      pageDown: key.name === 'pagedown',
      pageUp: key.name === 'pageup',
      return: key.name === 'return' || key.name === 'linefeed',
      rightArrow: key.name === 'right',
      shift: key.shift,
      tab: key.name === 'tab',
      upArrow: key.name === 'up'
    }
  }
}

// ── descriptor tree → native renderables ─────────────────────────────

function SpanRun(props: { span: RSpan }) {
  const theme = useTheme()
  const style = createMemo(() => ({
    fg: props.span.fg ?? (props.span.dim ? theme().color.muted : theme().color.text),
    ...(props.span.bg ? { bg: props.span.bg } : {})
  }))
  const styled = () => {
    let inner = <span style={style()}>{props.span.text}</span>
    if (props.span.bold) inner = <b>{inner}</b>
    if (props.span.italic) inner = <i>{inner}</i>
    if (props.span.underline) inner = <u>{inner}</u>
    return inner
  }
  return <>{styled()}</>
}

function BoxNode(props: { box: RBox }) {
  return (
    <box
      style={props.box.style}
      {...(props.box.border ? { border: true } : {})}
      {...(props.box.borderStyle !== undefined ? { borderStyle: props.box.borderStyle } : {})}
      {...(props.box.borderColor !== undefined ? { borderColor: props.box.borderColor } : {})}
      {...(props.box.title !== undefined ? { title: props.box.title } : {})}
      {...(props.box.onClick !== undefined ? { onMouseDown: props.box.onClick } : {})}
    >
      <For each={props.box.children}>{child => <RenderNode node={child} />}</For>
    </box>
  )
}

export function RenderNode(props: { node: RNode }) {
  const theme = useTheme()
  return (
    <Switch>
      <Match when={props.node.kind === 'box' ? props.node : undefined}>{b => <BoxNode box={b()} />}</Match>
      <Match when={props.node.kind === 'text' ? props.node : undefined}>
        {t => (
          <text>
            <For each={t().spans}>{span => <SpanRun span={span} />}</For>
          </text>
        )}
      </Match>
      <Match when={props.node.kind === 'error' ? props.node : undefined}>
        {e => <text fg={theme().color.error}>⚠ {e().message}</text>}
      </Match>
    </Switch>
  )
}

// ── cards ────────────────────────────────────────────────────────────

/** One active widget: keeps the runtime instance rendered with the live
 *  host context (state / theme / terminal size) and paints its tree. */
function WidgetCard(props: { active: ActiveWidget }) {
  const theme = useTheme()
  const dims = useDimensions()
  const instance = createMemo(() => {
    widgetInstancesVersion() // re-lookup after hot reload / dispose
    return widgetInstanceFor(props.active.appId)
  })
  createEffect(() => {
    instance()?.render({ cols: dims().width, rows: dims().height, state: props.active.state, t: theme() })
  })
  return <Show when={instance()}>{inst => <RenderNode node={inst().tree()} />}</Show>
}

/** An in-FLOW dock row: right-aligned cards, bounded height, real reserved
 *  rows (never covers content). Renders nothing while empty. */
export function WidgetDock(props: { placement: 'dock-bottom' | 'dock-top' }) {
  const docked = createMemo(() =>
    ambientWidgets().filter(active => dockPlacementOf(zoneOf(active)) === props.placement)
  )
  return (
    <Show when={docked().length > 0}>
      {/* paddingRight keeps card borders off the terminal's last column. */}
      <box
        style={{
          alignItems: 'flex-start',
          columnGap: 1,
          flexDirection: 'row',
          flexShrink: 0,
          justifyContent: 'flex-end',
          maxHeight: DOCK_MAX_ROWS,
          overflow: 'hidden',
          paddingRight: 2,
          width: '100%'
        }}
      >
        {/* flexShrink:0 keeps each card at natural height so an oversized
            widget CLIPS at the dock bound instead of flex-squishing rows. */}
        <For each={docked()}>
          {active => (
            <box style={{ flexShrink: 0 }}>
              <WidgetCard active={active} />
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

/** The modal widget panel — replaces the composer (input-zone Switch) and
 *  owns every keypress: each key feeds the app's reducer; `null` closes. */
export function WidgetModal(props: { active: ActiveWidget }) {
  useKeyboard(key => {
    if (key.eventType === 'release') return
    // Every key belongs to the app while modal (shared contract). The app
    // closes itself from its reducer (Esc/q by convention).
    dispatchWidgetInput(toWidgetInput(key))
    key.preventDefault()
  })
  return (
    <box style={{ flexDirection: 'row', flexShrink: 0, justifyContent: 'center', paddingBottom: 1, paddingTop: 1 }}>
      <WidgetCard active={props.active} />
    </box>
  )
}
