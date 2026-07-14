/**
 * Background-activity notifications (P1) — the inline card + store wiring.
 *   1. store: notification.show → a distinct `notification` message + lastNotification;
 *      notification.clear {key} drops the matching card; bad payloads are ignored.
 *   2. frame: NotificationCard renders the `◆` marker + kind + text (distinct chrome).
 */
import { describe, expect, test } from 'vitest'

import { createSessionStore } from '../logic/store.ts'
import { DisplayProvider } from '../view/display.tsx'
import { NotificationCard } from '../view/notificationCard.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame } from './lib/render.ts'

describe('notification store wiring', () => {
  test('notification.show pushes a distinct notification card + records lastNotification', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({
      type: 'notification.show',
      payload: { text: 'dev server ready on :3000', level: 'info', kind: 'process.complete', key: 'p1', id: 'n1' }
    })
    const last = store.state.messages.at(-1)
    expect(last?.role).toBe('notification')
    expect(last?.notification?.text).toBe('dev server ready on :3000')
    expect(last?.notification?.kind).toBe('process.complete')
    expect(store.state.lastNotification?.id).toBe('n1')
  })

  test('notification.clear {key} drops only the matching card', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'notification.show', payload: { text: 'a', key: 'k1', id: 'n1' } })
    store.apply({ type: 'notification.show', payload: { text: 'b', key: 'k2', id: 'n2' } })
    store.apply({ type: 'notification.clear', payload: { key: 'k1' } })
    const notifs = store.state.messages.filter(m => m.role === 'notification')
    expect(notifs).toHaveLength(1)
    expect(notifs[0]?.notification?.key).toBe('k2')
  })

  test('a notification with no text is ignored (no empty card)', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({ type: 'notification.show', payload: { level: 'warn', kind: 'x' } })
    expect(store.state.messages.some(m => m.role === 'notification')).toBe(false)
  })

  test('preserves disclosure detail and always-visible metadata', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.apply({
      type: 'notification.show',
      payload: {
        id: 'deleg:test',
        kind: 'async delegation',
        level: 'success',
        text: 'deleg_test · 2 agents · all done · 2s',
        detail: 'FULL_DETAIL_SENTINEL',
        always_visible: true
      }
    })

    const message = store.state.messages.at(-1)
    expect(message?.notification?.detail).toBe('FULL_DETAIL_SENTINEL')
    expect(message?.notification?.alwaysVisible).toBe(true)
  })

  test('background.complete → a completion card + drops the bg task from the badge count', () => {
    const store = createSessionStore()
    store.apply({ type: 'gateway.ready' })
    store.addBgTask('bg_abc')
    expect(store.state.bgTasks).toEqual(['bg_abc'])
    store.apply({ type: 'background.complete', payload: { task_id: 'bg_abc', text: 'all done' } })
    expect(store.state.bgTasks).toEqual([]) // untracked → bg: badge decrements
    const last = store.state.messages.at(-1)
    expect(last?.role).toBe('notification')
    expect(last?.notification?.text).toContain('bg_abc')
    expect(last?.notification?.text).toContain('all done')
  })
})

describe('NotificationCard frame', () => {
  test('renders the ◆ marker, the kind label, and the text', async () => {
    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => createSessionStore().state.theme}>
          <NotificationCard notification={{ id: 'n1', text: 'build finished', level: 'info', kind: 'task.done' }} />
        </ThemeProvider>
      ),
      { width: 60, height: 4 }
    )
    expect(frame).toContain('◆')
    expect(frame).toContain('task.done')
    expect(frame).toContain('build finished')
  })

  test('keeps long async delegation detail collapsed by default', async () => {
    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => createSessionStore().state.theme}>
          <NotificationCard
            notification={{
              id: 'deleg:test',
              kind: 'async delegation',
              level: 'success',
              text: 'deleg_test · 2 agents · all done · 2s',
              detail: 'FULL_DETAIL_SENTINEL\n'.repeat(100),
              alwaysVisible: true
            }}
          />
        </ThemeProvider>
      ),
      { width: 80, height: 5 }
    )

    expect(frame).toContain('async delegation')
    expect(frame).toContain('2 agents')
    expect(frame).toContain('▶')
    expect(frame).not.toContain('FULL_DETAIL_SENTINEL')
  })

  test('/details activity expanded reveals detail without mouse input', async () => {
    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => createSessionStore().state.theme}>
          <DisplayProvider
            flags={() => ({
              compact: false,
              details: 'collapsed',
              detailsCommandOverride: false,
              reasoningFull: false,
              sections: { activity: 'expanded' },
              timestamps: false
            })}
          >
            <NotificationCard
              notification={{
                id: 'deleg:test',
                kind: 'async delegation',
                level: 'success',
                text: 'deleg_test · done',
                detail: 'FULL_DETAIL_SENTINEL',
                alwaysVisible: true
              }}
            />
          </DisplayProvider>
        </ThemeProvider>
      ),
      { width: 80, height: 8, until: 'FULL_DETAIL_SENTINEL' }
    )

    expect(frame).toContain('▼')
    expect(frame).toContain('FULL_DETAIL_SENTINEL')
  })
})
