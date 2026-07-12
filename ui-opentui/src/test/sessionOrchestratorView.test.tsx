import { createSignal } from 'solid-js'
import { describe, expect, test, vi } from 'vitest'

import type { ActiveSessionRow } from '../logic/sessionOrchestrator.ts'
import { DEFAULT_THEME } from '../logic/theme.ts'
import { SessionOrchestrator, type SessionOrchestratorOps } from '../view/overlays/sessionOrchestrator.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe, type RenderProbe } from './lib/render.ts'

const LIVE = [
  { id: 'live-a', model: 'openrouter/model-a', status: 'working', title: 'Build release' },
  { current: true, id: 'live-b', model: 'model-b', status: 'idle', title: 'Current chat' }
] as const
const HISTORY = [
  { id: 'live-a', message_count: 3, preview: 'duplicate', started_at: 1, title: 'duplicate' },
  { id: 'old-a', message_count: 12, preview: 'old work', started_at: 1, title: 'Older work' }
]

interface Harness {
  readonly activated: string[]
  readonly closed: { value: boolean }
  readonly closeCalls: string[]
  readonly deleteCalls: string[]
  readonly newCount: { value: number }
  readonly prompts: Array<{ model?: string; prompt: string }>
  readonly probe: RenderProbe
  readonly refreshCount: { value: number }
  readonly resumed: string[]
  readonly setLive: (rows: readonly ActiveSessionRow[]) => void
}

async function mount(
  options: {
    history?: unknown
    historyReject?: boolean
    historyDelay?: number
    refreshReject?: boolean
    modelItems?: 'empty'
    loadModelItems?: () => Promise<readonly { group?: string; label: string; value: string }[]>
    width?: number
    height?: number
    liveRows?: readonly ActiveSessionRow[]
  } = {}
): Promise<Harness> {
  const [live, setLive] = createSignal<readonly ActiveSessionRow[]>(options.liveRows ?? LIVE)
  const activated: string[] = []
  const resumed: string[] = []
  const closeCalls: string[] = []
  const deleteCalls: string[] = []
  const prompts: Array<{ model?: string; prompt: string }> = []
  const closed = { value: false }
  const newCount = { value: 0 }
  const refreshCount = { value: 0 }
  const ops: SessionOrchestratorOps = {
    history: async () => {
      if (options.historyDelay) await new Promise(resolve => setTimeout(resolve, options.historyDelay))
      if (options.historyReject) throw new Error('offline')
      return options.history ?? { sessions: HISTORY }
    },
    refresh: () => {
      refreshCount.value++
      return options.refreshReject ? Promise.reject(new Error('live offline')) : Promise.resolve()
    },
    close: id => {
      closeCalls.push(id)
      return Promise.resolve({ closed: true })
    },
    delete: id => {
      deleteCalls.push(id)
      return Promise.resolve({ deleted: id })
    }
  }
  const probe = await renderProbe(
    () => (
      <ThemeProvider theme={() => DEFAULT_THEME}>
        <SessionOrchestrator
          currentSessionId={() => 'live-b'}
          liveSessions={live}
          ops={ops}
          onActivate={id => activated.push(id)}
          onResume={id => resumed.push(id)}
          onNew={() => newCount.value++}
          onNewPrompt={(prompt, model) => prompts.push(model ? { model, prompt } : { prompt })}
          modelItems={() =>
            options.modelItems === 'empty'
              ? []
              : [
                  {
                    current: true,
                    group: 'OpenRouter',
                    label: 'model-picked',
                    value: '--provider openrouter model-picked'
                  },
                  { group: 'Nous', label: 'model-other', value: '--provider nous model-other' }
                ]
          }
          {...(options.loadModelItems ? { loadModelItems: options.loadModelItems } : {})}
          onClose={() => (closed.value = true)}
        />
      </ThemeProvider>
    ),
    { height: options.height ?? 25, kittyKeyboard: true, width: options.width ?? 100 }
  )
  if (!options.historyDelay) await probe.waitForFrame(frame => !frame.includes('loading sessions'))
  return { activated, closed, closeCalls, deleteCalls, newCount, probe, prompts, refreshCount, resumed, setLive }
}

describe('SessionOrchestrator', () => {
  test('renders pinned new, live, and deduped resumable rows; selects the current live session', async () => {
    const h = await mount()
    try {
      const frame = h.probe.frame()
      expect(frame).toContain('2 live · 1 resumable')
      expect(frame).toContain('+  new')
      expect(frame).toContain('Build release')
      expect(frame).toContain('▸  2. current  ✓ idle  model-b  Current chat')
      expect(frame).toContain('Older work')
      expect(frame).not.toContain('duplicate')
    } finally {
      h.probe.destroy()
    }
  })

  test('keeps live rows and an animated in-body state when history independently fails', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const clearInterval = vi.spyOn(globalThis, 'clearInterval')
    const h = await mount({ historyDelay: 80, historyReject: true })
    try {
      expect(h.probe.frame()).toContain('loading sessions…')
      expect(h.probe.frame()).toContain('Current chat')
      expect(interval).toHaveBeenCalled()
      await new Promise(resolve => setTimeout(resolve, 100))
      await h.probe.settle()
      await h.probe.waitForFrame(frame => frame.includes('could not load resumable sessions'))
      expect(h.probe.frame()).toContain('Current chat')
      expect(clearInterval).toHaveBeenCalled()
    } finally {
      h.probe.destroy()
      vi.restoreAllMocks()
    }
  })

  test('supports switch, resume, refresh, close, and id-keyed two-d delete', async () => {
    const h = await mount()
    try {
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.activated).toEqual(['live-b'])

      h.probe.keys.pressArrow('down')
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.resumed).toEqual(['old-a'])

      h.probe.keys.pressKey('r', { ctrl: true })
      await h.probe.settle()
      expect(h.refreshCount.value).toBe(2)

      h.probe.keys.pressKey('d')
      await h.probe.settle()
      expect(h.probe.frame()).toContain('press d again to delete')
      h.setLive([LIVE[1], LIVE[0]])
      await h.probe.settle()
      h.probe.keys.pressKey('d')
      await h.probe.settle()
      expect(h.deleteCalls).toEqual(['old-a'])
      expect(h.probe.frame()).not.toContain('Older work')

      h.probe.keys.pressArrow('up')
      h.probe.keys.pressKey('d', { ctrl: true })
      await h.probe.settle()
      expect(h.closeCalls).toHaveLength(1)
    } finally {
      h.probe.destroy()
    }
  })

  test('loads live and history independently on mount', async () => {
    const h = await mount({ refreshReject: true })
    try {
      expect(h.probe.frame()).toContain('could not load live sessions: live offline')
      expect(h.probe.frame()).toContain('Older work')
      expect(h.refreshCount.value).toBe(1)
    } finally {
      h.probe.destroy()
    }
  })

  test('Tab exposes cache-miss model loading and failure instead of silently doing nothing', async () => {
    const delayed = await mount({
      modelItems: 'empty',
      loadModelItems: () =>
        new Promise(resolve =>
          setTimeout(
            () => resolve([{ group: 'Nous', label: 'loaded-model', value: 'loaded-model --provider nous' }]),
            40
          )
        )
    })
    try {
      delayed.probe.keys.pressArrow('up')
      delayed.probe.keys.pressArrow('up')
      delayed.probe.keys.pressTab()
      await delayed.probe.settle()
      expect(delayed.probe.frame()).toContain('loading models…')
      await new Promise(resolve => setTimeout(resolve, 60))
      await delayed.probe.settle()
      expect(delayed.probe.frame()).toContain('loaded-model')
    } finally {
      delayed.probe.destroy()
    }

    const failed = await mount({
      modelItems: 'empty',
      loadModelItems: () => Promise.reject(new Error('catalog offline'))
    })
    try {
      failed.probe.keys.pressArrow('up')
      failed.probe.keys.pressArrow('up')
      failed.probe.keys.pressTab()
      await failed.probe.settle()
      await failed.probe.waitForFrame(frame => frame.includes('could not load models: catalog offline'))
      expect(failed.closed.value).toBe(false)
    } finally {
      failed.probe.destroy()
    }
  })

  test.each([40, 60, 100])('keeps rows single-line and controls truthful at %i columns', async width => {
    const h = await mount({ width })
    try {
      expect(h.probe.frame()).toContain('current')
      h.probe.keys.pressArrow('down')
      await h.probe.settle()
      const frame = h.probe.frame()
      expect(frame).toContain('resume')
      expect(frame).toContain(width < 60 ? 'd×2 delete' : 'Resumable:')
      if (width < 60) expect(frame).toContain('Esc close')
      expect(frame.split('\n').every(line => [...line].length <= width)).toBe(true)
    } finally {
      h.probe.destroy()
    }
  })

  test('keeps live close, history delete, and Esc controls literal at 40x24', async () => {
    const h = await mount({ height: 24, width: 40 })
    try {
      let frame = h.probe.frame()
      expect(frame).toContain('↵ switch')
      expect(frame).toContain('^D close')
      expect(frame).toContain('Esc close')

      h.probe.keys.pressArrow('down')
      await h.probe.settle()
      frame = h.probe.frame()
      expect(frame).toContain('↵ resume')
      expect(frame).toContain('d×2 delete')
      expect(frame).toContain('Esc close')
      expect(frame.split('\n').every(line => [...line].length <= 40)).toBe(true)
    } finally {
      h.probe.destroy()
    }
  })

  test.each([24, 40])('keeps new-row controls visible in a 40x%i viewport with a long session list', async height => {
    const manyLive: ActiveSessionRow[] = [
      {
        id: 'live-b',
        current: true,
        model: 'provider/model-b',
        status: 'idle',
        title: 'Current responsive session title'
      },
      ...Array.from({ length: 18 }, (_, index) => ({
        id: `live-${index}`,
        model: 'provider/very-long-model-name',
        status: 'working',
        title: `Responsive session ${index} with a deliberately long title that must not wrap`
      }))
    ]
    const h = await mount({ height, liveRows: manyLive, width: 40 })
    try {
      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      const frame = h.probe.frame()
      expect(frame).toContain('↵ start')
      expect(frame).toContain('↑↓ move')
      expect(frame).toContain('↓')
      expect(frame.split('\n').every(line => [...line].length <= 40)).toBe(true)
    } finally {
      h.probe.destroy()
    }
  })

  test('new-row model picker preserves its draft; Ctrl+N and Esc retain global actions', async () => {
    const h = await mount()
    try {
      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      h.probe.keys.pressArrow('up')
      await h.probe.settle()
      expect(h.probe.frame()).toContain('type a prompt for the new session')
      await h.probe.keys.typeText('ship it')
      h.probe.keys.pressTab()
      await h.probe.settle()
      expect(h.probe.frame()).toContain('Model for new session')
      expect(h.probe.frame()).toContain('model-picked')
      h.probe.keys.pressEscape()
      await h.probe.settle()
      expect(h.probe.frame()).toContain('ship it')
      expect(h.closed.value).toBe(false)

      h.probe.keys.pressTab()
      await h.probe.settle()
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.probe.frame()).toContain('ship it')
      h.probe.keys.pressEnter()
      await h.probe.settle()
      expect(h.prompts).toEqual([{ model: '--provider openrouter model-picked', prompt: 'ship it' }])

      h.probe.keys.pressKey('n', { ctrl: true })
      h.probe.keys.pressEscape()
      await h.probe.settle()
      expect(h.newCount.value).toBe(1)
      expect(h.closed.value).toBe(true)
    } finally {
      h.probe.destroy()
    }
  })
})
