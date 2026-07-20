import { For, type JSXElement, Show } from 'solid-js'

import type { UsageBarData, UsageModelData } from '../../boundary/billing.ts'
import { useTheme } from '../theme.tsx'

const CELLS = 14

function line(bar: UsageBarData): string {
  const fill = Math.max(0, Math.min(CELLS, Math.round(bar.fill_fraction * CELLS)))
  const meter = '█'.repeat(fill) + '░'.repeat(CELLS - fill)
  const pct = bar.pct_used == null ? '' : ` · ${String(Math.round(bar.pct_used))}% used`
  return `${bar.kind === 'plan' ? 'plan' : 'top-up'}  ${meter}  ${bar.remaining_display} left of ${bar.total_display}${pct}`
}

export function UsageBars(props: { model: UsageModelData | undefined }): JSXElement {
  const theme = useTheme()
  const rows = () => [props.model?.plan_bar, props.model?.topup_bar].filter((v): v is UsageBarData => Boolean(v))
  return (
    <Show when={props.model?.available && rows().length}>
      <box style={{ flexDirection: 'column' }}>
        <For each={rows()}>{bar => <text fg={theme().color.muted}>{line(bar)}</text>}</For>
      </box>
    </Show>
  )
}
