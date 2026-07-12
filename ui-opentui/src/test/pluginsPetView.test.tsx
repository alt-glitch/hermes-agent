import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_THEME } from '../logic/theme.ts'
import { PetPicker } from '../view/overlays/petPicker.tsx'
import { PluginsHub } from '../view/overlays/pluginsHub.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { renderProbe } from './lib/render.ts'

describe('PluginsHub native overlay', () => {
  test('loads user scope, tabs to bundled rows, and toggles selection', async () => {
    const toggle = vi.fn(async (name: string, enable: boolean) => ({
      ok: true,
      plugin: { name, source: name === 'core' ? 'bundled' : 'user', status: enable ? 'enabled' : 'disabled' }
    }))
    const closed = { value: false }
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => DEFAULT_THEME}>
          <PluginsHub
            ops={{
              list: async () => ({
                bundled_count: 1,
                user_count: 1,
                plugins: [
                  { name: 'demo', source: 'user', status: 'enabled' },
                  { name: 'core', source: 'bundled', status: 'disabled' }
                ]
              }),
              toggle
            }}
            onClose={() => (closed.value = true)}
          />
        </ThemeProvider>
      ),
      { height: 24, kittyKeyboard: true, width: 90 }
    )
    try {
      await probe.waitForFrame(frame => frame.includes('demo'))
      expect(probe.frame()).not.toContain('core')
      probe.keys.pressTab()
      await probe.settle()
      expect(probe.frame()).toContain('core')
      probe.keys.pressArrow('down')
      probe.keys.pressEnter()
      await probe.settle()
      expect(toggle).toHaveBeenCalledWith('core', true)
      probe.keys.pressEscape()
      await probe.settle()
      expect(closed.value).toBe(true)
    } finally {
      probe.destroy()
    }
  })
})

describe('PetPicker native overlay', () => {
  test('filters with native input, adopts highlighted pet, and closes on success', async () => {
    const selected: string[] = []
    const closed = { value: false }
    const probe = await renderProbe(
      () => (
        <ThemeProvider theme={() => DEFAULT_THEME}>
          <PetPicker
            ops={{
              gallery: async () => ({
                active: '',
                enabled: false,
                pets: [
                  { displayName: 'Fox Friend', installed: false, curated: true, slug: 'fox' },
                  { displayName: 'Cat Friend', installed: true, slug: 'cat' }
                ]
              }),
              select: async slug => {
                selected.push(slug)
                return { displayName: slug, ok: true, slug }
              }
            }}
            onClose={() => (closed.value = true)}
          />
        </ThemeProvider>
      ),
      { height: 24, kittyKeyboard: true, width: 80 }
    )
    try {
      await probe.waitForFrame(frame => frame.includes('Fox Friend'))
      await probe.keys.typeText('fox')
      await probe.settle()
      expect(probe.frame()).toContain('Fox Friend')
      expect(probe.frame()).not.toContain('Cat Friend')
      probe.keys.pressEnter()
      await probe.settle()
      expect(selected).toEqual(['fox'])
      expect(closed.value).toBe(true)
    } finally {
      probe.destroy()
    }
  })
})
