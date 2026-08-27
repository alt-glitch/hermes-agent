/**
 * terminalSetup — IDE (VS Code-family) keybinding install + the legacy
 * multiline-sequence migration (Ink parity port).
 *
 * The modified-Enter bindings must send the atomic kitty CSI u encodings
 * (ESC[13;2u / ESC[13;5u / ESC[13;9u): the old `\` + CRLF sendSequence text
 * arrived as separate key events (backslash, then a submitting return).
 * Old on-disk bindings that still carry the legacy text are migrated in place;
 * a fully CSI-u file is left untouched (idempotent, no backup churn).
 */
import { describe, expect, it, vi } from 'vitest'

import { configureTerminalKeybindings, shouldPromptForTerminalSetup } from '../boundary/terminalSetup.ts'

const SHIFT_ENTER = '\u001b[13;2u'
const CTRL_ENTER = '\u001b[13;5u'
const SUPER_ENTER = '\u001b[13;9u'
const LEGACY_TEXT = '\\\r\n'

const SEND_SEQUENCE = 'workbench.action.terminal.sendSequence'

type Binding = { args?: { text?: string }; command?: string; key?: string; when?: string }

const enterBinding = (key: string, text: string): Binding => ({
  key,
  command: SEND_SEQUENCE,
  when: 'terminalFocus',
  args: { text }
})

/** The full non-mac target set with the given texts on the three Enter chords. */
const linuxBindings = (shift: string, ctrl: string, superText: string): Binding[] => [
  enterBinding('shift+enter', shift),
  enterBinding('ctrl+enter', ctrl),
  enterBinding('cmd+enter', superText),
  enterBinding('cmd+z', '\u001b[122;9u'),
  enterBinding('shift+cmd+z', '\u001b[122;10u')
]

function fileOpsWith(content: string | undefined) {
  const readFile =
    content === undefined
      ? vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      : vi.fn().mockResolvedValue(content)
  return {
    copyFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile,
    writeFile: vi.fn().mockResolvedValue(undefined)
  }
}

const configure = (ops: ReturnType<typeof fileOpsWith>) =>
  configureTerminalKeybindings('vscode', {
    env: {} as NodeJS.ProcessEnv,
    fileOps: ops,
    homeDir: '/home/me',
    platform: 'linux'
  })

const writtenBindings = (ops: ReturnType<typeof fileOpsWith>): Binding[] =>
  JSON.parse(ops.writeFile.mock.calls[0]?.[1] as string) as Binding[]

const textFor = (bindings: Binding[], key: string): string | undefined =>
  bindings.find(b => b.key === key && b.command === SEND_SEQUENCE && b.when === 'terminalFocus')?.args?.text

describe('configureTerminalKeybindings — atomic CSI u modified Enter', () => {
  it('writes the CSI u sequences for shift/ctrl/cmd+enter on a fresh install', async () => {
    const ops = fileOpsWith(undefined)
    const result = await configure(ops)

    expect(result.success).toBe(true)
    expect(result.requiresRestart).toBe(true)
    const bindings = writtenBindings(ops)
    expect(textFor(bindings, 'shift+enter')).toBe(SHIFT_ENTER)
    expect(textFor(bindings, 'ctrl+enter')).toBe(CTRL_ENTER)
    expect(textFor(bindings, 'cmd+enter')).toBe(SUPER_ENTER)
    // No CRLF-bearing text anywhere: the broken legacy sequence is never written.
    expect(bindings.some(b => b.args?.text?.includes('\r'))).toBe(false)
    expect(ops.copyFile).not.toHaveBeenCalled() // nothing existed to back up
  })

  it('migrates matching legacy bindings in place and backs the file up', async () => {
    const ops = fileOpsWith(JSON.stringify(linuxBindings(LEGACY_TEXT, LEGACY_TEXT, LEGACY_TEXT)))
    const result = await configure(ops)

    expect(result.success).toBe(true)
    expect(result.requiresRestart).toBe(true)
    expect(result.message).toContain('migrated 3 legacy bindings to CSI u encoding')
    expect(ops.copyFile).toHaveBeenCalledTimes(1) // backup before rewriting
    const bindings = writtenBindings(ops)
    expect(textFor(bindings, 'shift+enter')).toBe(SHIFT_ENTER)
    expect(textFor(bindings, 'ctrl+enter')).toBe(CTRL_ENTER)
    expect(textFor(bindings, 'cmd+enter')).toBe(SUPER_ENTER)
    // Migration replaces the three existing rows; it does not duplicate them.
    expect(bindings.filter(b => b.key === 'ctrl+enter')).toHaveLength(1)
  })

  it('leaves non-matching legacy-text bindings untouched', async () => {
    const foreign: Binding[] = [
      // Different key: not one of ours, must survive verbatim.
      enterBinding('alt+enter', LEGACY_TEXT),
      // Right key, but scoped to the editor (not terminalFocus): not ours either.
      { key: 'ctrl+enter', command: SEND_SEQUENCE, when: 'editorTextFocus', args: { text: LEGACY_TEXT } }
    ]
    const ops = fileOpsWith(JSON.stringify([...linuxBindings(LEGACY_TEXT, LEGACY_TEXT, LEGACY_TEXT), ...foreign]))
    const result = await configure(ops)

    expect(result.success).toBe(true)
    const bindings = writtenBindings(ops)
    expect(bindings.find(b => b.key === 'alt+enter')?.args?.text).toBe(LEGACY_TEXT)
    expect(bindings.find(b => b.key === 'ctrl+enter' && b.when === 'editorTextFocus')?.args?.text).toBe(LEGACY_TEXT)
    expect(textFor(bindings, 'ctrl+enter')).toBe(CTRL_ENTER)
  })

  it('is idempotent: a migrated file re-runs as a no-op without write or backup', async () => {
    const migrateOps = fileOpsWith(JSON.stringify(linuxBindings(LEGACY_TEXT, LEGACY_TEXT, LEGACY_TEXT)))
    await configure(migrateOps)
    const migratedContent = migrateOps.writeFile.mock.calls[0]?.[1] as string

    const rerunOps = fileOpsWith(migratedContent)
    const result = await configure(rerunOps)

    expect(result.success).toBe(true)
    expect(result.requiresRestart).toBeUndefined()
    expect(result.message).toContain('already configured')
    expect(rerunOps.writeFile).not.toHaveBeenCalled()
    expect(rerunOps.copyFile).not.toHaveBeenCalled()
  })

  it('reports both added and migrated counts when a partial legacy file is completed', async () => {
    // Legacy shift+enter only; the other four targets are missing entirely.
    const ops = fileOpsWith(JSON.stringify([enterBinding('shift+enter', LEGACY_TEXT)]))
    const result = await configure(ops)

    expect(result.success).toBe(true)
    expect(result.message).toContain('Added 4')
    expect(result.message).toContain('migrated 1 legacy binding to CSI u encoding')
    expect(ops.copyFile).toHaveBeenCalledTimes(1)
    const bindings = writtenBindings(ops)
    expect(textFor(bindings, 'shift+enter')).toBe(SHIFT_ENTER)
    expect(textFor(bindings, 'ctrl+enter')).toBe(CTRL_ENTER)
    expect(textFor(bindings, 'cmd+enter')).toBe(SUPER_ENTER)
  })
})

describe('shouldPromptForTerminalSetup — legacy bindings count as unconfigured', () => {
  const env = { TERM_PROGRAM: 'vscode' } as NodeJS.ProcessEnv

  it('prompts while legacy multiline bindings are on disk', async () => {
    const ops = fileOpsWith(JSON.stringify(linuxBindings(LEGACY_TEXT, LEGACY_TEXT, LEGACY_TEXT)))
    await expect(
      shouldPromptForTerminalSetup({ env, fileOps: ops, homeDir: '/home/me', platform: 'linux' })
    ).resolves.toBe(true)
  })

  it('stays quiet once the CSI u set is complete', async () => {
    const ops = fileOpsWith(JSON.stringify(linuxBindings(SHIFT_ENTER, CTRL_ENTER, SUPER_ENTER)))
    await expect(
      shouldPromptForTerminalSetup({ env, fileOps: ops, homeDir: '/home/me', platform: 'linux' })
    ).resolves.toBe(false)
  })
})
