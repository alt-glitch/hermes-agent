import { describe, expect, test } from 'vitest'

import { DEFAULT_THEME } from '../logic/theme.ts'
import { CustomModelSetup, readCustomModelProbe } from '../view/overlays/customModelSetup.tsx'
import { ThemeProvider } from '../view/theme.tsx'
import { captureFrame } from './lib/render.ts'

describe('custom model setup', () => {
  test('decodes discovered local models without trusting malformed rows', () => {
    expect(
      readCustomModelProbe(
        {
          models: ['qwen3.5:27b', null, 42, 'devstral'],
          reachable: true,
          resolved_base_url: 'http://localhost:11434/v1'
        },
        'http://localhost:11434'
      )
    ).toEqual({
      models: ['qwen3.5:27b', 'devstral'],
      reachable: true,
      resolvedBaseUrl: 'http://localhost:11434/v1'
    })
  })

  test('starts with a responsive endpoint step and local-runtime guidance', async () => {
    const frame = await captureFrame(
      () => (
        <ThemeProvider theme={() => DEFAULT_THEME}>
          <CustomModelSetup setup={{ request: async () => ({}), onSaved: () => {} }} onClose={() => {}} />
        </ThemeProvider>
      ),
      { width: 72, height: 10 }
    )
    expect(frame).toContain('Add local/custom model · 1/5')
    expect(frame).toContain('Ollama')
    expect(frame).toContain('http://localhost:11434/v1')
    expect(frame).toContain('Enter continue · Esc cancel')
  })
})
