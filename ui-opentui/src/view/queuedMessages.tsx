/** Fixed-height queued-message chrome (Ink `QueuedMessages` parity).
 *
 * Only three prompt previews mount at once; a large queue therefore grows plain
 * store strings, not native renderables. The active row is the one loaded into
 * the composer for Enter-send / Ctrl+X-delete / Esc-cancel.
 */
import { For, Show } from 'solid-js'

import { BUSY_QUEUE_MAX_EDIT_CHARS, queuePreview, queueWindow } from '../logic/busyQueue.ts'
import { useDimensions } from './dimensions.tsx'
import { useTheme } from './theme.tsx'

export interface QueuedMessagesProps {
  readonly editIndex: number | undefined
  readonly queued: readonly string[]
}

export function QueuedMessages(props: QueuedMessagesProps) {
  const theme = useTheme()
  const dims = useDimensions()
  const window = () => queueWindow(props.queued.length, props.editIndex)
  const visible = () => props.queued.slice(window().start, window().end)
  const previewWidth = () => Math.max(16, dims().width - 12)
  const oversizedEdit = () => {
    const index = props.editIndex
    return index !== undefined && (props.queued[index]?.length ?? 0) > BUSY_QUEUE_MAX_EDIT_CHARS
  }

  return (
    <Show when={props.queued.length > 0}>
      <box style={{ flexDirection: 'column', flexShrink: 0, paddingLeft: 1, paddingTop: 1 }}>
        <text selectable={false} fg={theme().color.muted}>
          {`queued (${props.queued.length})${
            props.editIndex === undefined
              ? ''
              : oversizedEdit()
                ? ` · selected ${props.editIndex + 1} · Enter send · Ctrl+X delete · Esc cancel · too large to edit`
                : ` · editing ${props.editIndex + 1} · Ctrl+X delete · Esc cancel`
          }`}
        </text>
        <Show when={window().showLead}>
          <text selectable={false} fg={theme().color.muted}>
            {'  …'}
          </text>
        </Show>
        <For each={visible()}>
          {(item, visibleIndex) => {
            const index = () => window().start + visibleIndex()
            const active = () => props.editIndex === index()
            return (
              <box
                style={{
                  backgroundColor: active() ? theme().color.selectionBg : 'transparent',
                  flexShrink: 0
                }}
              >
                <text selectable={false} fg={active() ? theme().color.accent : theme().color.muted}>
                  {`${active() ? '▸' : ' '} ${index() + 1}. ${queuePreview(item, previewWidth())}`}
                </text>
              </box>
            )
          }}
        </For>
        <Show when={window().showTail}>
          <text selectable={false} fg={theme().color.muted}>
            {`  …and ${props.queued.length - window().end} more`}
          </text>
        </Show>
      </box>
    </Show>
  )
}
