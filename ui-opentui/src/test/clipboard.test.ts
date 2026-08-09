import { EventEmitter } from 'node:events'

import { describe, expect, test, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn }))
vi.mock('node:fs', () => ({ existsSync: () => true }))
vi.mock('node:os', () => ({ platform: () => 'linux' }))

import { readClipboardImage, readClipboardText, writeClipboard } from '../boundary/clipboard.ts'

function clipboardChild(stdout: Buffer = Buffer.alloc(0)) {
  const childStdout = new EventEmitter()
  const childStdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  const child = Object.assign(new EventEmitter(), {
    stdin: childStdin,
    stdout: childStdout,
    unref: vi.fn()
  })
  queueMicrotask(() => {
    if (stdout.length > 0) childStdout.emit('data', stdout)
    child.emit('close', 0)
  })
  return child
}

describe('clipboard child lifetime', () => {
  test('unrefs writes but keeps text and image reads referenced', async () => {
    const writeChild = clipboardChild()
    let textChild: ReturnType<typeof clipboardChild> | undefined
    let imageChild: ReturnType<typeof clipboardChild> | undefined
    spawn
      .mockReturnValueOnce(writeChild)
      .mockImplementationOnce(() => (textChild = clipboardChild(Buffer.from('clipboard text'))))
      .mockImplementationOnce(() => (imageChild = clipboardChild(Buffer.from('png bytes'))))

    await writeClipboard('copied text')
    await expect(readClipboardText('linux', undefined, {}, () => true)).resolves.toBe('clipboard text')
    await expect(readClipboardImage()).resolves.toEqual({
      data: Buffer.from('png bytes').toString('base64'),
      mime: 'image/png'
    })

    expect(writeChild.unref).toHaveBeenCalledOnce()
    expect(textChild?.unref).not.toHaveBeenCalled()
    expect(imageChild?.unref).not.toHaveBeenCalled()
    expect(spawn.mock.calls[0]?.[2]).toEqual({ stdio: ['pipe', 'ignore', 'ignore'] })
    expect(spawn.mock.calls[1]?.[2]).toEqual({ stdio: ['ignore', 'pipe', 'ignore'] })
    expect(spawn.mock.calls[2]?.[2]).toEqual({ stdio: ['ignore', 'pipe', 'ignore'] })
  })
})

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
