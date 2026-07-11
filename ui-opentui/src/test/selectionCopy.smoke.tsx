/**
 * Real-TTY acceptance smoke for the Node-FFI Markdown + selection path.
 *
 * This intentionally is not a Vitest/headless test: the headless renderer does
 * not reliably paint native Markdown. `scripts/acceptance.sh` compiles this
 * entry, launches it inside tmux with Node 26 `--experimental-ffi`, and reads
 * the deterministic JSON written to `SEL_SMOKE_OUT`.
 *
 * Copy contract:
#   - native selection extraction returns the rendered text the user highlighted;
 *     concealed Markdown delimiters cannot be reconstructed for a partial
 *     selection;
#   - the full-source `/copy` helper preserves the original Markdown string.
 * Mouse input routing and multi-click behavior are exercised separately by the
 * headless renderer suite; this smoke owns the real-TTY native/FFI seam.
 */
import { createCliRenderer, type CliRenderer, type Renderable, RGBA, SyntaxStyle } from '@opentui/core'
import { render } from '@opentui/solid'
import { writeFile } from 'node:fs/promises'

import { registerRemoteParsers } from '../boundary/parsers.ts'
import { messageText } from '../logic/copy.ts'

const OUTPUT_PATH = process.env.SEL_SMOKE_OUT ?? '/tmp/opentui-selection-smoke.json'
const SELECTED_RENDERED_TEXT = 'selected-rendered-token'
const CODE_PAINT_MARKER = 'ffiPaintMarker'
const MARKDOWN_SOURCE = [
  '# Markdown FFI smoke',
  '',
  `**${SELECTED_RENDERED_TEXT}**`,
  '',
  '```ts',
  `const ${CODE_PAINT_MARKER} = true`,
  '```'
].join('\n')

const decoder = new TextDecoder()

interface SmokeResult {
  pass: boolean
  markdownPainted: boolean
  codePainted: boolean
  selectionCreated: boolean
  selectedText: string
  expectedSelectedText: string
  sourceCopyPreserved: boolean
  error: string
}

function initialResult(): SmokeResult {
  return {
    pass: false,
    markdownPainted: false,
    codePainted: false,
    selectionCreated: false,
    selectedText: '',
    expectedSelectedText: SELECTED_RENDERED_TEXT,
    sourceCopyPreserved: false,
    error: ''
  }
}

function frameText(renderer: CliRenderer): string {
  return decoder.decode(renderer.currentRenderBuffer.getRealCharBytes(true))
}

async function waitForPaint(renderer: CliRenderer, timeoutMs = 8_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let frame = ''
  while (Date.now() < deadline) {
    renderer.requestRender()
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    frame = frameText(renderer)
    if (frame.includes(SELECTED_RENDERED_TEXT) && frame.includes(CODE_PAINT_MARKER)) return frame
  }
  return frame
}

function deepestSelectableAt(root: Renderable, x: number, y: number): Renderable | undefined {
  let found: Renderable | undefined
  const visit = (node: Renderable): void => {
    if (!node.isDestroyed && node.selectable && node.shouldStartSelection(x, y)) found = node
    for (const child of node.getChildren()) visit(child)
  }
  visit(root)
  return found
}

function createSelection(renderer: CliRenderer, frame: string): string {
  const rows = frame.split('\n')
  const y = rows.findIndex(row => row.includes(SELECTED_RENDERED_TEXT))
  const x = y >= 0 ? (rows[y]?.indexOf(SELECTED_RENDERED_TEXT) ?? -1) : -1
  if (x < 0 || y < 0) throw new Error('painted selection marker was not found')

  const target = deepestSelectableAt(renderer.root, x, y)
  if (!target) throw new Error('painted selection marker had no selectable renderable')

  renderer.startSelection(target, x, y)
  // OpenTUI's native text-buffer selection uses a half-open focus column.
  renderer.updateSelection(target, x + SELECTED_RENDERED_TEXT.length, y, {
    finishDragging: true
  })

  const selection = renderer.getSelection()
  if (!selection?.isActive || selection.isDragging) throw new Error('selection did not finish')
  return selection.getSelectedText()
}

async function main(): Promise<void> {
  const result = initialResult()
  let renderer: CliRenderer | undefined

  try {
    // Leave a deterministic failure sentinel even if native initialization
    // terminates the process before JavaScript can reach the normal teardown.
    await writeFile(OUTPUT_PATH, `${JSON.stringify(result)}\n`, 'utf8')
    // Same parser registration ordering as the production entry: before the
    // first native <markdown> mount initializes the global Tree-sitter client.
    registerRemoteParsers()
    const syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: RGBA.fromHex('#E6EDF3') },
      'markup.heading': { bold: true, fg: RGBA.fromHex('#8BD5CA') },
      'markup.bold': { bold: true, fg: RGBA.fromHex('#E6EDF3') },
      keyword: { bold: true, fg: RGBA.fromHex('#C6A0F6') },
      variable: { fg: RGBA.fromHex('#E6EDF3') }
    })

    renderer = await createCliRenderer({
      consoleMode: 'disabled',
      externalOutputMode: 'passthrough',
      exitOnCtrlC: false,
      exitSignals: [],
      openConsoleOnError: false,
      targetFps: 30,
      useKittyKeyboard: null,
      useMouse: false
    })

    await render(
      () => (
        <box flexDirection="column" padding={1}>
          <markdown content={MARKDOWN_SOURCE} syntaxStyle={syntaxStyle} internalBlockMode="top-level" conceal />
        </box>
      ),
      renderer
    )

    const frame = await waitForPaint(renderer)
    result.markdownPainted = frame.includes('Markdown FFI smoke') && frame.includes(SELECTED_RENDERED_TEXT)
    result.codePainted = frame.includes(CODE_PAINT_MARKER)
    result.selectedText = createSelection(renderer, frame)
    result.selectionCreated = true

    // Source-bearing `/copy` uses the message text, not the concealed native
    // selection. Exercise that helper here so the two contracts cannot drift.
    result.sourceCopyPreserved = messageText({ role: 'assistant', text: MARKDOWN_SOURCE }) === MARKDOWN_SOURCE
    result.pass =
      result.markdownPainted &&
      result.codePainted &&
      result.selectedText === result.expectedSelectedText &&
      result.sourceCopyPreserved
  } catch (cause) {
    result.error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    try {
      renderer?.destroy()
    } catch {
      // The JSON result is more useful than a teardown exception. The process
      // exits immediately below, so no native renderer can linger.
    }
    await writeFile(OUTPUT_PATH, `${JSON.stringify(result)}\n`, 'utf8')
    process.exitCode = result.pass ? 0 : 1
  }
}

await main()
