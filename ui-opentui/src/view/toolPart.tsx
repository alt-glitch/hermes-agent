/**
 * ToolPart — one tool call, rendered COLLAPSED by default with a clear expand
 * affordance. This is the SHARED SHELL: the header (glyph + name + subtitle +
 * duration + line count + optional hint) and the expand/collapse mechanics —
 * what's INSIDE varies per tool and is dispatched through the tool renderer
 * registry (`view/tools/registry.tsx`, Epic 2.2):
 *
 *   ⚡ terminal  sleep 8  · 12s                   ← running (elapsed ticks live)
 *   $ terminal  ls -la src  · 0.3s  (12 lines)   ← collapsed (default; per-tool glyph)
 *   ▼ terminal  ls -la src  · 0.3s               ← expanded header
 *   │ <renderer body>                            ← labeled fields / output / …
 *   ✗ terminal  ✗ exit 1  · 0.1s  (3 lines)      ← failed (error-colored glyph)
 *
 * Lifecycle + identity are legible from the HEAD GLYPH alone (Epic 2.5 + the
 * visual-hierarchy design pass): `⚡` running in accent heat (with a live `· Ns`
 * elapsed off the shared 1s tick in `elapsed.ts` — never a timer per part), the
 * PER-TOOL glyph (`glyphFor` — `$`/`◇`/`◆`/`○`/…) in machinery BLUE
 * (`shellDollar`) when settled, `▼` (blue) only while expanded, `✗` failed
 * (theme error color). Tools are the machinery tier: the whole part nests +2
 * columns under the turn, the name is muted-bright (statusFg) bold — never the
 * full-bright answer color — and args/durations/counts stay muted grey.
 * Clicking an expandable header toggles it (wrapped in useScrollAnchor so
 * expanding never yanks the viewport); running parts have no expand
 * affordance. The header row is chrome (selectable=false) — a free-form drag
 * copies only the expanded body content. Fully themed (no hardcoded styles).
 */
import { type ToolPartState } from '../logic/store.ts'
import type { ThemeColors } from '../logic/theme.ts'
import { useDimensions } from './dimensions.tsx'
import { useDisplay } from './display.tsx'
import { createSignal, Show } from 'solid-js'

import { argsCapColumns, truncate } from '../logic/toolOutput.ts'
import { elapsedSeconds, useElapsedTick } from './elapsed.ts'
import { useScrollAnchor } from './scrollAnchor.tsx'
import { useSessionInfo } from './sessionInfo.tsx'
import { useTheme } from './theme.tsx'
import { resultLines } from './tools/defaultTool.tsx'
import { glyphFor, rendererFor } from './tools/registry.tsx'

const GUTTER = 2
/** Machinery-tier nesting (design pass): tools indent +2 under the turn. */
const INDENT = 2

function fmtDuration(s: number): string {
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return r ? `${m}m ${r}s` : `${m}m`
}

/** Live elapsed format — whole seconds (the tick advances 1s at a time). */
function fmtElapsed(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m}m ${r}s` : `${m}m`
}

/**
 * Header tool-NAME style — the name says what a settled tool IS, but a tool is
 * MACHINERY, not the answer: it renders muted-BRIGHT (the statusFg silver — one
 * step up from muted grey) + BOLD, demoted from the full-bright answer color so
 * the eye lands on prose, not tool names (visual-hierarchy design pass). The
 * failed state's error coloring wins (still bold — failures should be
 * unmistakable alongside the ✗ glyph); a running part keeps its muted
 * treatment (the ⚡ glyph + live elapsed already carry the running signal).
 * Exported so tests can pin the selection logic (char frames carry no
 * color/attribute info).
 */
export function toolNameStyle(
  state: { failed: boolean; running: boolean },
  color: ThemeColors
): { fg: string; bold: boolean } {
  if (state.failed) return { bold: true, fg: color.error }
  if (state.running) return { bold: false, fg: color.muted }
  return { bold: true, fg: color.statusFg }
}

/**
 * Live `  · 12s` elapsed for a RUNNING part. Mounted only under the running
 * `<Show>`, so its useElapsedTick subscription starts/stops the SHARED 1s
 * interval with the part's lifecycle (the last cleanup clears it). Falls back
 * to the plain ` …` marker when startedAt is unknown (e.g. a tool.complete
 * that arrived without a local tool.start).
 */
function RunningElapsed(props: { startedAt: number | undefined }) {
  const theme = useTheme()
  const tick = useElapsedTick()
  const text = () => {
    tick() // re-read every shared tick — Date.now() alone is not reactive
    return props.startedAt === undefined ? ' …' : `  · ${fmtElapsed(elapsedSeconds(props.startedAt))}`
  }
  return <span style={{ fg: theme().color.muted }}>{text()}</span>
}

export function ToolPart(props: { part: ToolPartState }) {
  const theme = useTheme()
  const dims = useDimensions()
  const info = useSessionInfo() // session cwd for path-relativizing renderers
  const anchor = useScrollAnchor()
  const display = useDisplay()
  // /details expanded → settled bodies default-OPEN; a manual click overrides
  // either way (and a later global flip applies again to un-overridden parts).
  const [override, setOverride] = createSignal<boolean | undefined>(undefined)
  const expanded = () => override() ?? display().details === 'expanded'
  const toggle = () => anchor(() => setOverride(!expanded()))

  // Per-tool renderer (re-dispatches if the name settles on tool.complete).
  const renderer = () => rendererFor(props.part.name)
  const bodyWidth = () => Math.max(20, dims().width - GUTTER - INDENT - 4)
  // "(N lines)" counts what the renderer's body will actually show (per-tool
  // `lines`, e.g. read_file's content), not the raw resultText.
  const lines = () => renderer().lines?.(props.part) ?? resultLines(props.part)
  const running = () => props.part.state === 'running'
  // Expandable when the renderer says there's a body to reveal beyond the header.
  const collapsible = () => !running() && renderer().expandable(props.part)
  // Header subtitle: errors win; otherwise the renderer's collapsed summary.
  const subtitle = () =>
    props.part.error
      ? `✗ ${props.part.error}`
      : running() && props.part.progressPreview
        ? props.part.progressPreview
        : renderer().subtitle(props.part, info().cwd)
  const hint = () => renderer().hint?.(props.part)
  // Optional `+N −M` change summary (file tools) — themed, settled parts only.
  const stats = () => (running() || props.part.error ? undefined : renderer().stats?.(props.part))

  // Head glyph = lifecycle + identity (design pass): `✗` failed (error), `⚡`
  // running (accent heat), `▼` only while expanded, else the PER-TOOL glyph
  // (`$`/`◇`/`◆`/`○`/… — the vocabulary survives the default collapsed view).
  // `error` only lands on tool.complete, so running stays ⚡.
  const failed = () => !running() && Boolean(props.part.error)
  const headGlyph = () =>
    failed()
      ? '✗'
      : running()
        ? '⚡'
        : collapsible() && expanded()
          ? '▼'
          : glyphFor(props.part.name, theme().toolEmojis)
  // Settled machinery is BLUE (`shellDollar` — "blue is the hum of machinery");
  // running is accent heat; failed is error. The NAME is muted-bright bold (see
  // toolNameStyle); subtitle/metadata stay muted grey — the machinery tier
  // below the bright assistant answer.
  const headColor = () =>
    failed() ? theme().color.error : running() ? theme().color.accent : theme().color.shellDollar
  const subWidth = () => Math.max(1, bodyWidth() - props.part.name.length - 2)
  // Args are context, not content: cap the collapsed args preview to ~half the
  // pane (argsCapColumns) so a long command/path can never become the loudest
  // mass on screen. Error subtitles keep the full row — failures must stay
  // readable.
  const subCap = () => (props.part.error ? subWidth() : Math.max(1, Math.min(subWidth(), argsCapColumns(dims().width))))

  return (
    // Spacing between parts is owned by the parts column (gap), not per-part
    // margins — so a tool appearing mid-stream doesn't shift the layout.
    // marginLeft nests the machinery tier +2 under the turn (answers at base).
    <box style={{ flexDirection: 'column', flexShrink: 0, marginLeft: INDENT }}>
      {/* header — clickable to toggle when there's an expandable body */}
      <box style={{ flexDirection: 'row', flexShrink: 0 }} onMouseDown={() => collapsible() && toggle()}>
        <box style={{ flexShrink: 0, width: GUTTER }}>
          <text selectable={false}>
            <span style={{ fg: headColor() }}>{headGlyph()}</span>
          </text>
        </box>
        <box style={{ flexDirection: 'row', flexGrow: 1, minWidth: 0 }}>
          {/* the whole header row is a collapsed SUMMARY (tool name + subtitle +
              duration + "(N lines)") — chrome, not the copyable body — so a
              free-form drag over a tool yields only the expanded body content,
              never the header label. */}
          <text selectable={false}>
            {/* the NAME identifies the machinery (muted-bright + bold; error
                when failed; muted while running) — see toolNameStyle. Subtitle
                stays muted. */}
            <span style={toolNameStyle({ failed: failed(), running: running() }, theme().color)}>
              {props.part.name}
            </span>
            {/* subtitle shows while running too (the gateway argsPreview — e.g.
                the command being executed) so a running tool reads `⚡ terminal
                sleep 8 · 12s`, Ink parity. */}
            <Show when={subtitle()}>
              <span style={{ fg: props.part.error ? theme().color.error : theme().color.muted }}>
                {`  ${truncate(subtitle(), subCap())}`}
              </span>
            </Show>
            <Show when={stats()}>
              {/* `+N −M` change summary (file tools) — added in the ok/added color,
                  removed in the error/removed color (themed, never hardcoded). */}
              {s => (
                <>
                  <span style={{ fg: theme().color.ok }}>{`  +${s().added}`}</span>
                  <span style={{ fg: theme().color.error }}>{` −${s().removed}`}</span>
                </>
              )}
            </Show>
            <Show when={hint()}>
              {/* per-tool muted hint (e.g. delegate_task's "(/agents to monitor)") —
                  shown while running too, Ink parity. */}
              <span style={{ fg: theme().color.muted }}>{`  ${hint() ?? ''}`}</span>
            </Show>
            <Show when={!running() && props.part.duration !== undefined}>
              <span style={{ fg: theme().color.muted }}>{`  · ${fmtDuration(props.part.duration ?? 0)}`}</span>
            </Show>
            {/* live elapsed (running only) — the <Show> scopes the shared-tick
                subscription to the running lifecycle (see RunningElapsed). */}
            <Show when={running()}>
              <RunningElapsed startedAt={props.part.startedAt} />
            </Show>
            <Show when={collapsible() && !expanded() && lines().length > 1}>
              <span style={{ fg: theme().color.muted }}>{`  (${lines().length} lines)`}</span>
            </Show>
          </text>
        </box>
      </box>

      {/* expanded body — the per-tool renderer's Body, inside a single
          left-bordered column (a `│` rule, not a bg fill — opencode's BlockTool
          style; also renders faithfully and reads cleaner). The rule is
          machinery blue (error wins) — same family as the head glyph. */}
      <Show when={collapsible() && expanded()}>
        <box
          style={{ flexDirection: 'column', flexGrow: 1, minWidth: 0, marginLeft: GUTTER, paddingLeft: 1 }}
          border={['left']}
          borderColor={props.part.error ? theme().color.error : theme().color.shellDollar}
        >
          {(() => {
            const Body = renderer().Body
            return <Body part={props.part} width={bodyWidth() - 2} cwd={info().cwd} />
          })()}
        </box>
      </Show>
    </box>
  )
}
