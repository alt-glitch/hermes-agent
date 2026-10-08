/**
 * HomeHint — the empty-transcript home screen (items 12 + 9; Ink `branding.tsx`
 * parity). The HERMES-AGENT banner + a tagline, then a session info block
 * (model · Nous Research / dir / Session id), then SEPARATE collapsible sections —
 * Available Tools (enabled toolsets + their tools), Available Skills, MCP Servers —
 * and a summary line. Fully themed; decorative, so `selectable={false}` (item 4).
 */
import { createSignal, For, type JSX, onCleanup, Show } from 'solid-js'

import { SHIMMER_ANIMATE_MS, SHIMMER_SKELETON_ROWS, SHIMMER_TICK_MS, shimmerSegments } from '../logic/shimmer.ts'
import { mcpServerNote } from '../logic/mcpStatus.ts'
import type { SessionStore } from '../logic/store.ts'
import { truncate } from '../logic/toolOutput.ts'
import { useDimensions } from './dimensions.tsx'
import { useTheme } from './theme.tsx'

// The canonical HERMES-AGENT block logo (hermes_cli/banner.py), gold→amber→bronze.
const BANNER: ReadonlyArray<readonly [string, 'primary' | 'accent' | 'border']> = [
  ['██╗  ██╗███████╗██████╗ ███╗   ███╗███████╗███████╗       █████╗  ██████╗ ███████╗███╗   ██╗████████╗', 'primary'],
  ['██║  ██║██╔════╝██╔══██╗████╗ ████║██╔════╝██╔════╝      ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝', 'primary'],
  ['███████║█████╗  ██████╔╝██╔████╔██║█████╗  ███████╗█████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║', 'accent'],
  ['██╔══██║██╔══╝  ██╔══██╗██║╚██╔╝██║██╔══╝  ╚════██║╚════╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║', 'accent'],
  ['██║  ██║███████╗██║  ██║██║ ╚═╝ ██║███████╗███████║      ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║', 'border'],
  ['╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝', 'border']
]
const BANNER_W = 102
const TOOLSETS_MAX = 10

/** `anthropic/claude-opus-4-8` → `claude-opus-4-8`. */
const shortModel = (m: string) => (m.includes('/') ? (m.split('/').at(-1) ?? m) : m)
const HOME = process.env.HOME ?? ''
const shortCwd = (cwd: string) => (HOME && cwd.startsWith(HOME) ? '~' + cwd.slice(HOME.length) : cwd)

const SHIMMER_CHAR = '▁'

/** One shimmering run: muted base with a label-toned band at `phase`. */
function ShimmerRun(props: { width: number; phase: number; color: string; highlight: string }) {
  const seg = () => shimmerSegments(props.width, props.phase)
  return (
    <>
      <span style={{ fg: props.color }}>{SHIMMER_CHAR.repeat(seg()[0])}</span>
      <span style={{ fg: props.highlight }}>{SHIMMER_CHAR.repeat(seg()[1])}</span>
      <span style={{ fg: props.color }}>{SHIMMER_CHAR.repeat(seg()[2])}</span>
    </>
  )
}

/** Skeleton rows shaped like toolset lines while the catalog is pending (Ink
 *  0ada7837e4). One bounded interval per mount, cleared on unmount. */
function ShimmerRows(props: { color: string; highlight: string }) {
  const [phase, setPhase] = createSignal(0)
  const started = Date.now()
  const id = setInterval(() => {
    if (Date.now() - started > SHIMMER_ANIMATE_MS) return clearInterval(id)
    setPhase(n => n + 1)
  }, SHIMMER_TICK_MS)
  onCleanup(() => clearInterval(id))
  return (
    <For each={SHIMMER_SKELETON_ROWS}>
      {([label, value], i) => (
        <text selectable={false}>
          <ShimmerRun width={label} phase={phase() - i() * 2} color={props.color} highlight={props.highlight} />
          <span style={{ fg: props.color }}> </span>
          <ShimmerRun width={value} phase={phase() - i() * 2} color={props.color} highlight={props.highlight} />
        </text>
      )}
    </For>
  )
}

export function HomeHint(props: { store: SessionStore }) {
  const theme = useTheme()
  const dims = useDimensions()
  const wide = () => dims().width >= BANNER_W
  const cat = () => props.store.state.catalog
  const info = () => props.store.state.info
  const enabledToolsets = () => (cat()?.tools.toolsets ?? []).filter(t => t.enabled)
  // Catalog not arrived yet, or the server says its build is still pending with
  // nothing to list: render a shimmer skeleton + `…` counts, never a blank gap
  // or a fake `0 tools · 0 skills`.
  // A server readiness warning already explains the wait in one row, so the
  // skeleton only fills the silent case (rows are scarce on short terminals).
  const catalogPending = () => {
    const c = cat()
    return !c || (c.readiness.status === 'pending' && c.tools.total === 0 && enabledToolsets().length === 0)
  }
  const showSkeleton = () => catalogPending() && !cat()?.readiness.warning
  const skillsPending = () => {
    const c = cat()
    return !c || (c.readiness.status === 'pending' && c.skills.total === 0)
  }
  const mcpStatus = (name: string) => info().mcpServerStatus?.find(s => s.name === name)

  // A collapsible section: ▸/▾ accent chevron + label title + optional muted suffix.
  function Section(p: { title: string; suffix?: string; open?: boolean; children: JSX.Element }) {
    const [open, setOpen] = createSignal(p.open ?? false)
    return (
      <box style={{ flexDirection: 'column', marginTop: 1 }}>
        <box style={{ flexDirection: 'row', flexShrink: 0 }} onMouseDown={() => setOpen(o => !o)}>
          <text selectable={false}>
            <span style={{ fg: theme().color.accent }}>{open() ? '▾ ' : '▸ '}</span>
            <span style={{ fg: theme().color.label }}>{p.title}</span>
            <Show when={p.suffix}>
              <span style={{ fg: theme().color.muted }}>{` ${p.suffix}`}</span>
            </Show>
          </text>
        </box>
        <Show when={open()}>
          <box
            style={{ flexDirection: 'column', marginLeft: 2, paddingLeft: 1 }}
            border={['left']}
            borderColor={theme().color.border}
          >
            {p.children}
          </box>
        </Show>
      </box>
    )
  }

  return (
    <box style={{ flexDirection: 'column', flexShrink: 0, paddingLeft: 1, marginTop: 1 }}>
      {/* banner — full block logo when there's room, else a compact brand line */}
      <Show
        when={wide()}
        fallback={
          <text selectable={false}>
            <span style={{ fg: theme().color.accent }}>{theme().brand.icon} </span>
            <span style={{ fg: theme().color.primary }}>
              <b>{theme().brand.name}</b>
            </span>
          </text>
        }
      >
        <For each={BANNER}>
          {([line, tone]) => (
            <text selectable={false}>
              <span style={{ fg: theme().color[tone] }}>{line}</span>
            </text>
          )}
        </For>
      </Show>
      <text selectable={false}>
        <span style={{ fg: theme().color.accent }}>{`${theme().brand.icon} `}</span>
        <span style={{ fg: theme().color.muted }}>Nous Research · Messenger of the Digital Gods</span>
      </text>

      {/* framed session panel (Ink SessionPanel parity) — the bordered box is the
          key "this is a designed home screen, not log output" signal. */}
      <box
        style={{ flexDirection: 'column', marginTop: 1, paddingLeft: 1, paddingRight: 1 }}
        border
        borderColor={theme().color.border}
      >
        {/* session info block: model · Nous Research / dir / Session id */}
        <box style={{ flexDirection: 'column' }}>
          <Show when={info().model}>
            {model => (
              <text selectable={false}>
                <span style={{ fg: theme().color.accent }}>{shortModel(model())}</span>
                <span style={{ fg: theme().color.muted }}> · Nous Research</span>
              </text>
            )}
          </Show>
          <Show when={info().cwd}>
            {cwd => (
              <text selectable={false}>
                <span style={{ fg: theme().color.muted }}>{shortCwd(cwd())}</span>
                <Show when={info().branch}>
                  <span style={{ fg: theme().color.muted }}>{` (${info().branch})`}</span>
                </Show>
              </text>
            )}
          </Show>
          <Show when={props.store.state.sessionId}>
            <text selectable={false}>
              <span style={{ fg: theme().color.muted }}>Session: </span>
              <span style={{ fg: theme().color.border }}>{props.store.state.sessionId}</span>
            </text>
          </Show>
        </box>

        {/* catalog pending: shimmer skeleton + `…` summary (Ink 0ada7837e4) */}
        <Show when={!cat()}>
          <box style={{ flexDirection: 'column' }}>
            <Section title="Available Tools" open>
              <ShimmerRows color={theme().color.border} highlight={theme().color.label} />
            </Section>
            <box style={{ marginTop: 1 }}>
              <text selectable={false}>
                <span style={{ fg: theme().color.text }}>… tools</span>
                <span style={{ fg: theme().color.muted }}>{' · … skills · '}</span>
                <span style={{ fg: theme().color.accent }}>/help</span>
                <span style={{ fg: theme().color.muted }}> for commands</span>
              </text>
            </box>
          </box>
        </Show>

        {/* SEPARATE collapsible sections (Ink parity) + summary */}
        <Show when={cat()}>
          {c => (
            <box style={{ flexDirection: 'column' }}>
              <Show when={c().readiness.warning}>
                {warning => (
                  <text selectable={false}>
                    <span style={{ fg: theme().color.warn }}>{warning()}</span>
                  </text>
                )}
              </Show>
              <Section title="Available Tools" open>
                <Show when={showSkeleton()}>
                  <ShimmerRows color={theme().color.border} highlight={theme().color.label} />
                </Show>
                <For each={enabledToolsets().slice(0, TOOLSETS_MAX)}>
                  {ts => (
                    <text selectable={false}>
                      <span style={{ fg: theme().color.label }}>{`${ts.name}: `}</span>
                      <span style={{ fg: theme().color.muted }}>
                        {truncate(
                          ts.tools.join(', ') || `${ts.count} tools`,
                          Math.max(20, dims().width - ts.name.length - 8)
                        )}
                      </span>
                    </text>
                  )}
                </For>
                <Show when={enabledToolsets().length > TOOLSETS_MAX}>
                  <text selectable={false}>
                    <span
                      style={{ fg: theme().color.muted }}
                    >{`(and ${enabledToolsets().length - TOOLSETS_MAX} more toolsets…)`}</span>
                  </text>
                </Show>
              </Section>

              <Section
                title={`Available Skills (${skillsPending() ? '…' : c().skills.total})`}
                suffix={`in ${c().skills.categories.length} categories`}
              >
                <text selectable={false}>
                  <span style={{ fg: theme().color.muted }}>
                    {c()
                      .skills.categories.map(s => `${s.name} (${s.count})`)
                      .join('  ')}
                  </span>
                </text>
              </Section>

              <Section
                title={`MCP Servers (${c().mcp.servers.length})`}
                suffix={c().mcp.servers.length ? 'enabled' : ''}
              >
                <Show
                  when={c().mcp.servers.length}
                  fallback={
                    <text selectable={false}>
                      <span style={{ fg: theme().color.muted }}>none configured</span>
                    </text>
                  }
                >
                  <For each={c().mcp.servers}>
                    {name => (
                      <text selectable={false}>
                        <span style={{ fg: theme().color.label }}>{name}</span>
                        <Show when={mcpServerNote(mcpStatus(name))}>
                          {note => (
                            <>
                              <span style={{ fg: theme().color.text }}>{` ${note().tools}`}</span>
                              <Show when={note().lazy}>
                                <span style={{ fg: theme().color.muted }}> (lazy)</span>
                              </Show>
                            </>
                          )}
                        </Show>
                      </text>
                    )}
                  </For>
                </Show>
              </Section>

              <box style={{ marginTop: 1 }}>
                <text selectable={false}>
                  <span style={{ fg: theme().color.text }}>{`${catalogPending() ? '…' : c().tools.total} tools`}</span>
                  <span
                    style={{ fg: theme().color.muted }}
                  >{` · ${skillsPending() ? '…' : c().skills.total} skills · ${c().mcp.servers.length} MCP · `}</span>
                  <span style={{ fg: theme().color.accent }}>/help</span>
                  <span style={{ fg: theme().color.muted }}> for commands</span>
                </text>
              </box>
            </box>
          )}
        </Show>
      </box>
      {/* end framed session panel */}

      <box style={{ marginTop: 1 }}>
        <text selectable={false}>
          <span style={{ fg: theme().color.muted }}>
            Type to chat · ↑↓ history · Alt+Enter newline · @file to mention · Ctrl+C to stop/quit
          </span>
        </text>
      </box>
    </box>
  )
}
