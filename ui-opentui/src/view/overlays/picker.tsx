/**
 * Picker — the generic fuzzy picker overlay (spec §2b; Epic 7 model picker v2;
 * picker v2.1). Powers /model and /skills: a native `<input>` query line (real
 * editing — word-delete, home/end, kill-line come free) filters live across
 * label AND group AND extra haystacks (provider slug / lab name — `son4` finds
 * claude-sonnet-4, `copilot` narrows to the GitHub Copilot group); results
 * render GROUPED with non-selectable headers, and ↑↓ traverse the flat item
 * order seamlessly ACROSS group boundaries. Enter picks, Esc/Ctrl+C closes
 * (keymap layer + fallback).
 *
 * v2.1 (direct user feedback):
 * - The input stays focused the whole time; ↑↓/Enter/Ctrl+U/Ctrl+R are handled
 *   by the GLOBAL key handler (which the renderer runs BEFORE routing to the
 *   focused renderable — composer pattern) with `preventDefault` so the input
 *   never also applies them (Ctrl+U is natively kill-to-line-start!).
 * - `unavailable` rows (unconfigured providers, `no API key — set <ENV_VAR>`)
 *   are hidden by default; Ctrl+U reveals them dimmed + NON-selectable and
 *   traversal skips them (buildPickerRows index -1).
 * - Ctrl+R re-fetches the catalog via the seam registered by the opener
 *   (logic/slash.ts registerPickerRefresh) and swaps the rows in live, with a
 *   transient `refreshing…` note — also self-heals a stale ✓.
 *
 * v2.2 (provider tabs, user feedback): when the opener registers a tab
 * derivation (registerPickerTabs — `/model` registers buildModelTabs), a chip
 * strip renders under the query line: one chip per configured provider
 * (Nous-first) plus a trailing `All` (the classic full grouped view, where
 * Ctrl+U still reveals unconfigured providers). The active tab filters rows
 * BEFORE the fuzzy query (search-within-tab). The strip is styled text — NOT a
 * focused tab_select — so the search input keeps focus; Tab/Shift+Tab cycle
 * (free inside the picker: the composer and its completion menu are unmounted
 * while an overlay replaces them), and ←/→ also cycle while the query is
 * empty (the resume-picker design doc §A specs this same pattern).
 *
 * Everything heavy is memoized off (query, toggle, tab, items): keystrokes
 * re-score at most once and unrelated store updates don't.
 */
import type { BoxRenderable, InputRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'

import { buildPickerRows, fuzzyFilter, visibleRows, type FuzzyField } from '../../logic/fuzzy.ts'
import { canRefreshPicker, pickerTabs, runPickerRefresh } from '../../logic/slash.ts'
import type { PickerItem } from '../../logic/store.ts'
import { useCloseLayer } from '../keymap.tsx'
import { useTheme } from '../theme.tsx'

/** Max visible rows (headers + items) before the window scrolls. */
const MAX_ROWS = 12

/** The fuzzy haystacks of a row: label ×2 (opencode's title weighting), then
 *  group (lab name), description and any extra haystacks (provider slug).
 *  Unavailable rows match on provider IDENTITY only (group + haystacks) — their
 *  hint label (`no API key — …`) must not make `api`/`set` match every row. */
function fieldsOf(item: PickerItem): FuzzyField[] {
  const fields: FuzzyField[] = item.unavailable ? [] : [{ text: item.label, weight: 2 }]
  if (item.group) fields.push({ text: item.group })
  if (item.description) fields.push({ text: item.description })
  for (const h of item.haystacks ?? []) fields.push({ text: h })
  return fields
}

/**
 * Styled-text chip strip (the picker's tab bar) — deliberately a standalone,
 * reusable piece: the resume-session picker renders the SAME strip (design doc
 * docs/plans/opentui-resume-picker.md §A — chips as styled text, NOT a focused
 * `<tab_select>`, so focus stays on the search input). Active chip: bracketed
 * + theme-highlighted; inactive: dimmed with breathing space.
 */
export function TabChips(props: { labels: string[]; active: number }) {
  const theme = useTheme()
  // Chip descriptors are derived in a memo: `<For>` runs its callback OUTSIDE
  // a tracking scope (Solid mapArray), so a ternary on `props.active` inside
  // it would never re-render. Fresh descriptor objects per change re-key the
  // <For> instead — a handful of chips, so the re-create is free.
  const chips = createMemo(() => props.labels.map((label, at) => ({ active: at === props.active, label })))
  return (
    <text>
      <For each={chips()}>
        {chip =>
          chip.active ? (
            <span style={{ bg: theme().color.selectionBg, fg: theme().color.accent }}>
              <b>{`[ ${chip.label} ]`}</b>
            </span>
          ) : (
            <span style={{ fg: theme().color.muted }}>{`  ${chip.label}  `}</span>
          )
        }
      </For>
    </text>
  )
}

export function Picker(props: {
  title: string
  items: PickerItem[]
  errorLabel?: string
  initialRefresh?: boolean
  initialTab?: 'all' | 'current'
  loadingLabel?: string
  onPick: (value: string) => void
  onClose: () => void
}) {
  const theme = useTheme()
  let rootRef: BoxRenderable | undefined
  let inputRef: InputRenderable | undefined
  // Esc/Ctrl+C close via the native keymap, scoped focus-within to the root box
  // (the focused `<input>` is a descendant, so the layer stays active).
  useCloseLayer(
    () => rootRef,
    () => props.onClose()
  )

  const [query, setQuery] = createSignal('')
  // Ctrl+U availability toggle: unavailable (unconfigured-provider) rows are
  // out of the pool by default; toggled on they join — dimmed, non-selectable.
  const [showAll, setShowAll] = createSignal(false)
  // Ctrl+R live-refreshed rows override the (static) opener snapshot.
  const [live, setLive] = createSignal<PickerItem[] | undefined>(undefined)
  const [refreshing, setRefreshing] = createSignal(false)
  const [initialPending, setInitialPending] = createSignal(props.initialRefresh === true)
  const [refreshFailed, setRefreshFailed] = createSignal(false)
  const items = () => live() ?? props.items

  // ── provider tabs (v2.2) ────────────────────────────────────────────────
  // Derived through the opener-registered seam over the LIVE rows (a Ctrl+R
  // swap re-derives). `undefined` = the trailing `All` tab (classic view).
  const tabs = createMemo(() => pickerTabs(items()))
  // Open lands on the CURRENT (✓) item's provider tab; All when it has none.
  const [activeTab, setActiveTab] = createSignal<string | undefined>(
    (() => {
      if (props.initialTab === 'all') return undefined
      const cur = props.items.find(it => it.current)?.group
      return cur !== undefined && pickerTabs(props.items).includes(cur) ? cur : undefined
    })()
  )
  // A live-refresh can drop the active tab's provider — degrade to All.
  const tab = createMemo(() => {
    const t = activeTab()
    return t !== undefined && tabs().includes(t) ? t : undefined
  })
  // Ctrl+U only applies under All (provider tabs never hold unavailable rows).
  const hasUnavailable = createMemo(() => tab() === undefined && items().some(it => it.unavailable))

  // pool → score → group → window, all memoized: typing re-scores once; nothing else does.
  // The active tab filters BEFORE the fuzzy query (search-within-tab).
  const pool = createMemo(() => {
    const t = tab()
    if (t !== undefined) return items().filter(it => !it.unavailable && it.group === t)
    return showAll() ? items() : items().filter(it => !it.unavailable)
  })
  const filtered = createMemo(() => fuzzyFilter(query(), pool(), fieldsOf))
  const grouped = createMemo(() =>
    buildPickerRows(
      filtered(),
      it => it.group,
      it => !it.unavailable
    )
  )

  // Start on the current (✓) item; reset to the top match whenever the QUERY,
  // the Ctrl+U toggle or a live row swap changes the filter. Tab switches are
  // deliberately NOT in this list — cycleTab re-seats the selection itself
  // (on the ✓ row when the new tab holds it).
  const [sel, setSel] = createSignal(
    Math.max(
      0,
      grouped().flat.findIndex(it => it.current)
    )
  )
  createEffect(on([query, showAll], () => setSel(0), { defer: true }))
  createEffect(
    on(
      live,
      () =>
        setSel(
          Math.max(
            0,
            grouped().flat.findIndex(it => it.current)
          )
        ),
      { defer: true }
    )
  )

  /** Cycle the chip strip (Tab/Shift+Tab; ←/→ on an empty query): provider
   *  tabs in registered order, then the trailing All, wrapping both ways. */
  const cycleTab = (dir: 1 | -1) => {
    const order: (string | undefined)[] = [...tabs(), undefined]
    if (order.length <= 1) return
    const at = order.indexOf(tab())
    setActiveTab(order[(at + dir + order.length) % order.length])
    setSel(
      Math.max(
        0,
        grouped().flat.findIndex(it => it.current)
      )
    )
  }

  const win = createMemo(() => visibleRows(grouped().rows, sel(), MAX_ROWS))

  const pick = (item: PickerItem | undefined) => {
    if (item) props.onPick(item.value)
  }

  /** Ctrl+R: run the opener-registered catalog re-fetch, swap the rows in live. */
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  const refresh = (force = true) => {
    if (refreshing()) return
    const pending = runPickerRefresh(force)
    if (!pending) return
    setRefreshing(true)
    setRefreshFailed(false)
    pending
      .then(fresh => {
        if (!disposed && fresh.length) setLive(fresh)
      })
      .catch(() => {
        if (!disposed) setRefreshFailed(true)
      })
      .finally(() => {
        if (disposed) return
        setRefreshing(false)
        setInitialPending(false)
      })
  }

  onMount(() => {
    if (props.initialRefresh) refresh(false)
  })

  useKeyboard(key => {
    // Esc/Ctrl+C also close via the keymap layer above; handling them here too
    // keeps close working even when focus never landed.
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return props.onClose()
    // Picker chords are consumed BEFORE the focused input sees them
    // (preventDefault) — Ctrl+U would otherwise kill-to-line-start, Enter would
    // fire the input's own submit, ↑↓ would move its cursor.
    const count = grouped().flat.length
    if (key.name === 'return') {
      key.preventDefault()
      return pick(grouped().flat[sel()])
    }
    if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
      key.preventDefault()
      if (count) setSel(s => (s - 1 + count) % count)
      return
    }
    if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
      key.preventDefault()
      if (count) setSel(s => (s + 1) % count)
      return
    }
    // Tab strip cycling (v2.2): Tab is FREE inside the picker (the composer's
    // completion-accept Tab is unmounted while an overlay replaces it); ←/→
    // only cycle on an EMPTY query — with text they stay native cursor moves.
    if (key.name === 'tab' && tabs().length) {
      key.preventDefault()
      cycleTab(key.shift ? -1 : 1)
      return
    }
    if ((key.name === 'left' || key.name === 'right') && tabs().length && !query()) {
      key.preventDefault()
      cycleTab(key.name === 'left' ? -1 : 1)
      return
    }
    if (key.ctrl && key.name === 'u') {
      key.preventDefault()
      setShowAll(v => !v)
      return
    }
    if (key.ctrl && key.name === 'r') {
      key.preventDefault()
      refresh(true)
      return
    }
    // everything else (printables, backspace, word-delete, home/end…) belongs
    // to the focused native input.
  })

  return (
    <box
      ref={el => (rootRef = el)}
      style={{ borderColor: theme().color.border, flexDirection: 'column', flexShrink: 0, marginTop: 1, padding: 1 }}
      border
    >
      <box style={{ flexDirection: 'row' }}>
        <text fg={theme().color.accent}>
          <b>{props.title}</b>
        </text>
        <text fg={theme().color.label}>{'  '}</text>
        <text fg={theme().color.prompt}>{'> '}</text>
        <input
          ref={el => (inputRef = el)}
          focused
          onInput={setQuery}
          onMouseDown={() => inputRef?.focus()}
          placeholder="type to filter"
          placeholderColor={theme().color.muted}
          textColor={theme().color.text}
          cursorColor={theme().color.accent}
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          style={{ flexGrow: 1, minWidth: 0 }}
        />
        <Show when={refreshing() && !initialPending()}>
          <text fg={theme().color.muted}>refreshing…</text>
        </Show>
      </box>
      <Show when={tabs().length > 0}>
        <TabChips
          labels={[...tabs(), 'All']}
          active={tab() === undefined ? tabs().length : tabs().indexOf(tab() as string)}
        />
      </Show>
      <Show when={win().above > 0}>
        <text fg={theme().color.muted}>{`  ↑ ${win().above} more`}</text>
      </Show>
      <For each={win().rows}>
        {row =>
          row.kind === 'header' ? (
            <text fg={theme().color.label}>
              <b>{row.label}</b>
            </text>
          ) : row.index === -1 ? (
            // unavailable (unconfigured provider) — dimmed hint, never selectable
            <text fg={theme().color.muted}>{`  ${row.item.label}`}</text>
          ) : (
            <text
              bg={row.index === sel() ? theme().color.selectionBg : 'transparent'}
              onMouseDown={() => pick(row.item)}
            >
              <span style={{ fg: row.index === sel() ? theme().color.text : theme().color.muted }}>
                {row.index === sel() ? '› ' : '  '}
              </span>
              <span style={{ fg: theme().color.text }}>{row.item.label}</span>
              <Show when={row.item.current}>
                <span style={{ fg: theme().color.ok }}> ✓</span>
              </Show>
              <Show when={row.item.description}>
                <span style={{ fg: theme().color.muted }}> {row.item.description}</span>
              </Show>
            </text>
          )
        }
      </For>
      <Show when={filtered().length === 0}>
        <text fg={refreshFailed() ? theme().color.error : theme().color.muted}>
          {initialPending()
            ? ` ${props.loadingLabel || 'Loading…'}`
            : refreshFailed()
              ? ` ${props.errorLabel || 'Could not load options'} · Ctrl+R retry`
              : ' (no matches)'}
        </text>
      </Show>
      <Show when={win().below > 0}>
        <text fg={theme().color.muted}>{`  ↓ ${win().below} more`}</text>
      </Show>
      <text fg={theme().color.muted}>
        {`↑↓ select · Enter pick${tabs().length ? ' · Tab provider' : ''}${
          hasUnavailable() ? ` · Ctrl+U ${showAll() ? 'hide' : 'show'} unconfigured` : ''
        }${canRefreshPicker() ? ' · Ctrl+R refresh' : ''} · Esc close`}
      </text>
    </box>
  )
}
