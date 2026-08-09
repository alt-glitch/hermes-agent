import { describe, expect, test, vi } from 'vitest'

import { readClipboardText } from '../boundary/clipboard.ts'

describe('PowerShell clipboard text reads', () => {
  test.each([
    { command: 'powershell.exe', env: {}, label: 'Windows', platform: 'win32' as const },
    {
      command: 'powershell.exe',
      env: { WSL_INTEROP: '/tmp/wsl-socket' },
      label: 'WSL',
      platform: 'linux' as const
    }
  ])('round-trips CJK and emoji as UTF-8 on $label', async ({ command, env, platform }) => {
    const clipboard = '你好，世界 🌏🚀'
    const execute = vi.fn(async () => Buffer.from(Buffer.from(clipboard, 'utf8').toString('base64'), 'utf8'))

    await expect(readClipboardText(platform, execute, env, () => true)).resolves.toBe(clipboard)
    expect(execute).toHaveBeenCalledWith(command, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      expect.stringContaining('ToBase64String')
    ])
  })

  test('keeps the WSL fallback chain when PowerShell fails', async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error('PowerShell unavailable'))
      .mockResolvedValueOnce(Buffer.from('Wayland fallback', 'utf8'))

    await expect(
      readClipboardText('linux', execute, { WAYLAND_DISPLAY: 'wayland-1', WSL_INTEROP: '/tmp/wsl-socket' }, () => true)
    ).resolves.toBe('Wayland fallback')
    expect(execute.mock.calls.map(([command]) => command)).toEqual(['powershell.exe', 'wl-paste'])
  })
})
