/** Unified live + resumable session orchestrator. Transport is supplied by the caller. */
import type { BoxRenderable, InputRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/solid'
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

import {
  decodeSessionCloseResponse,
  decodeSessionDeleteResponse,
  decodeSessionListResponse
} from '../../boundary/schema/SessionOrchestratorResponses.ts'
import {
  closeFallbackAfterClose,
  currentSessionSelectionIndex,
  draftModelDisplayLabel,
  draftTitleFromPrompt,
  orchestratorContextHint,
  orchestratorGlobalHotkeyHint,
  reanchorOrchestratorSelection,
  resumeRowContextHintSegments,
  relativeSessionAge,
  resumableHistory,
  sessionStatusGlyph,
  sessionStatusLabel,
  sessionsCountLabel,
  shortSessionModel,
  unifiedSessionRowAction,
  type ActiveSessionRow,
  type SessionHistoryRow
} from '../../logic/sessionOrchestrator.ts'
import type { PickerItem } from '../../logic/store.ts'
import { truncRight } from '../../logic/truncate.ts'
import { useDimensions } from '../dimensions.tsx'
import { useCloseLayer } from '../keymap.tsx'
import { useTheme } from '../theme.tsx'
import { Picker } from './picker.tsx'

export interface SessionOrchestratorOps {
  readonly history: () => Promise<unknown>
  readonly refresh: () => Promise<void>
  readonly close: (sessionId: string) => Promise<unknown>
  readonly delete: (sessionId: string) => Promise<unknown>
}

export interface SessionOrchestratorProps {
  readonly currentSessionId: () => string | null
  readonly liveSessions: () => readonly ActiveSessionRow[]
  readonly ops: SessionOrchestratorOps
  readonly onActivate: (sessionId: string) => void
  readonly onResume: (sessionId: string) => void
  readonly onNew: () => void
  readonly onNewPrompt: (prompt: string, modelArg?: string) => void
  readonly onClose: () => void
  /** Current model catalog. Tab on +new opens the standard picker in place. */
  readonly modelItems?: (() => readonly PickerItem[]) | undefined
  /** Cache-miss loader. The overlay owns its visible loading/error state. */
  readonly loadModelItems?: (() => Promise<readonly PickerItem[]>) | undefined
}

const LOADING_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const LOADING_TICK_MS = 90
const MAX_VISIBLE_ROWS = 12

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'request failed'
}

export function SessionOrchestrator(props: SessionOrchestratorProps) {
  const theme = useTheme()
  const dims = useDimensions()
  let rootRef: BoxRenderable | undefined
  let modelStatusRef: BoxRenderable | undefined
  let promptRef: InputRenderable | undefined
  const [history, setHistory] = createSignal<SessionHistoryRow[]>([])
  const [selected, setSelected] = createSignal(0)
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [liveError, setLiveError] = createSignal('')
  const [historyError, setHistoryError] = createSignal('')
  const [actionError, setActionError] = createSignal('')
  const [draft, setDraft] = createSignal('')
  const [draftModel, setDraftModel] = createSignal('')
  const [pickingModel, setPickingModel] = createSignal(false)
  const [modelLoading, setModelLoading] = createSignal(false)
  const [modelError, setModelError] = createSignal('')
  const [loadedModelItems, setLoadedModelItems] = createSignal<readonly PickerItem[] | undefined>()
  const [confirmDeleteId, setConfirmDeleteId] = createSignal<string | undefined>()
  const [loadingFrame, setLoadingFrame] = createSignal(0)
  let initialized = false
  let historySeq = 0
  let modelSeq = 0
  let previousLive: readonly ActiveSessionRow[] = []
  let previousHistory: readonly SessionHistoryRow[] = []

  const live = () => props.liveSessions()
  const errorMessages = createMemo(() => [liveError(), historyError(), actionError()].filter(Boolean))
  const resumable = createMemo(() => resumableHistory(history(), live()))
  const total = () => 1 + live().length + resumable().length
  const selectedKind = () => (selected() === 0 ? 'new' : selected() <= live().length ? 'live' : 'history')

  function reanchor(nextLive: readonly ActiveSessionRow[], nextHistory: readonly SessionHistoryRow[]): void {
    setSelected(index => {
      if (!initialized) {
        initialized = true
        return nextLive.length ? currentSessionSelectionIndex(nextLive, props.currentSessionId()) + 1 : 0
      }
      return reanchorOrchestratorSelection(index, previousLive, previousHistory, nextLive, nextHistory)
    })
    previousLive = nextLive
    previousHistory = nextHistory
  }

  createEffect(() => reanchor(live(), resumable()))

  function loadHistory(): Promise<void> {
    const seq = ++historySeq
    return props.ops
      .history()
      .then(raw => {
        if (seq !== historySeq) return
        const decoded = decodeSessionListResponse(raw)
        if (!decoded) {
          setHistoryError('invalid response: session.list')
          return
        }
        setHistory(
          (decoded.sessions ?? []).map(row => ({
            id: row.id,
            message_count: row.message_count,
            preview: row.preview,
            started_at: row.started_at,
            title: row.title
          }))
        )
        setHistoryError('')
      })
      .catch(() => {
        if (seq === historySeq) setHistoryError('could not load resumable sessions')
      })
  }

  onMount(() => {
    rootRef?.focus()
    setLoading(true)
    void Promise.allSettled([props.ops.refresh(), loadHistory()]).then(([liveResult]) => {
      if (liveResult.status === 'rejected')
        setLiveError(`could not load live sessions: ${errorMessage(liveResult.reason)}`)
      else setLiveError('')
      setLoading(false)
    })
  })

  useCloseLayer(
    () => (pickingModel() && (modelLoading() || modelError()) ? modelStatusRef : rootRef),
    () => (pickingModel() ? closeModelPicker() : props.onClose())
  )

  createEffect(() => {
    if (!loading() && !busy() && !modelLoading()) {
      setLoadingFrame(0)
      return
    }
    const timer = setInterval(() => setLoadingFrame(frame => frame + 1), LOADING_TICK_MS)
    onCleanup(() => clearInterval(timer))
  })
  const activityGlyph = () => {
    const frames = theme().spinner.waitingFaces.length ? theme().spinner.waitingFaces : LOADING_FRAMES
    return frames[loadingFrame() % frames.length] ?? LOADING_FRAMES[0]
  }

  createEffect(() => {
    if (selected() === 0) promptRef?.focus()
    else rootRef?.focus()
  })

  function move(delta: 1 | -1): void {
    setConfirmDeleteId(undefined)
    setSelected(index => Math.max(0, Math.min(total() - 1, index + delta)))
  }

  function activateIndex(index: number): void {
    setConfirmDeleteId(undefined)
    setSelected(Math.max(0, Math.min(total() - 1, index)))
    const action = unifiedSessionRowAction(index, live(), resumable())
    if (action.action === 'activate') props.onActivate(action.sessionId)
    else if (action.action === 'resume') props.onResume(action.sessionId)
  }

  function submitDraft(): void {
    const prompt = (promptRef?.value ?? draft()).trim()
    if (!prompt) return props.onNew()
    setDraft('')
    props.onNewPrompt(prompt, draftModel() || undefined)
  }

  function submitSelected(): void {
    if (selectedKind() === 'new') {
      return submitDraft()
    }
    activateIndex(selected())
  }

  async function fullRefresh(): Promise<void> {
    if (busy()) return
    setBusy(true)
    setActionError('')
    const [liveResult] = await Promise.allSettled([props.ops.refresh(), loadHistory()])
    if (liveResult.status === 'rejected') setLiveError(`refresh failed: ${errorMessage(liveResult.reason)}`)
    else setLiveError('')
    setBusy(false)
  }

  async function closeSelected(): Promise<void> {
    const target = live()[selected() - 1]
    if (!target || busy()) return
    setBusy(true)
    setActionError('')
    try {
      const decoded = decodeSessionCloseResponse(await props.ops.close(target.id))
      if (!decoded) setActionError('invalid response: session.close')
      else if (!decoded.closed && !decoded.ok) setActionError('session was already closed')
      else {
        await Promise.allSettled([props.ops.refresh(), loadHistory()])
        const fallback = closeFallbackAfterClose(target.id, props.currentSessionId(), live())
        if (fallback.action === 'activate') props.onActivate(fallback.sessionId)
        else if (fallback.action === 'new') props.onNew()
      }
    } catch (cause) {
      setActionError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  async function deleteHistory(id: string): Promise<void> {
    if (busy()) return
    setBusy(true)
    setActionError('')
    try {
      const decoded = decodeSessionDeleteResponse(await props.ops.delete(id))
      if (!decoded || decoded.deleted !== id) setActionError('invalid response: session.delete')
      else setHistory(rows => rows.filter(row => row.id !== id))
    } catch (cause) {
      setActionError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  function closeModelPicker(): void {
    modelSeq++
    setPickingModel(false)
    setModelLoading(false)
  }

  function openModelPicker(): void {
    const cached = props.modelItems?.() ?? []
    setLoadedModelItems(cached.length ? [...cached] : undefined)
    setModelError('')
    setPickingModel(true)
    if (cached.length) return
    const load = props.loadModelItems
    if (!load) {
      setModelError('model catalog unavailable')
      return
    }
    const seq = ++modelSeq
    setModelLoading(true)
    void load()
      .then(items => {
        if (seq !== modelSeq) return
        if (!items.length) setModelError('no models available')
        else setLoadedModelItems([...items])
      })
      .catch(cause => {
        if (seq === modelSeq) setModelError(`could not load models: ${errorMessage(cause)}`)
      })
      .finally(() => {
        if (seq === modelSeq) setModelLoading(false)
      })
  }

  useKeyboard(key => {
    // The standard Picker owns all input while it replaces this overlay body.
    // Keeping this component mounted retains the new-session prompt and model.
    if (pickingModel()) return
    if (busy()) return
    const armed = confirmDeleteId()
    if (armed !== undefined) {
      key.preventDefault()
      setConfirmDeleteId(undefined)
      if (key.name.toLowerCase() === 'd' && !key.ctrl) void deleteHistory(armed)
      return
    }
    if (key.name === 'escape') {
      key.preventDefault()
      return props.onClose()
    }
    if (key.ctrl && key.name.toLowerCase() === 'n') {
      key.preventDefault()
      return props.onNew()
    }
    if (key.ctrl && key.name.toLowerCase() === 'r') {
      key.preventDefault()
      return void fullRefresh()
    }
    if (key.ctrl && key.name.toLowerCase() === 'd') {
      key.preventDefault()
      return void closeSelected()
    }
    if (key.name === 'tab' && selected() === 0) {
      key.preventDefault()
      openModelPicker()
      return
    }
    if (key.name.toLowerCase() === 'd' && !key.ctrl && selectedKind() === 'history') {
      key.preventDefault()
      const row = resumable()[selected() - 1 - live().length]
      if (row) setConfirmDeleteId(row.id)
      return
    }
    if (selected() === 0 && draft().trim()) return
    if (key.name === 'up') {
      key.preventDefault()
      return move(-1)
    }
    if (key.name === 'down') {
      key.preventDefault()
      return move(1)
    }
    if (key.name === 'return') {
      key.preventDefault()
      submitSelected()
    }
  })

  /** Budget rows against the real terminal, not only the list length. The App
   * chrome (header, transcript floor, status bar) and this overlay's border,
   * pinned new row/input, overflow markers and two footer lines all share the
   * same viewport. A conservative floor keeps controls visible at 40x24 while
   * larger terminals still reach the upstream 12-row window. */
  const visibleRowLimit = createMemo(() => {
    const fixedRows = selected() === 0 ? 20 : 19
    const transientRows = (loading() || busy() ? 1 : 0) + errorMessages().length
    return Math.max(2, Math.min(MAX_VISIBLE_ROWS, dims().height - fixedRows - transientRows))
  })
  const visibleIndexes = createMemo(() => {
    const count = total()
    const selectedIndex = selected()
    const limit = visibleRowLimit()
    const offset = Math.max(1, Math.min(Math.max(1, selectedIndex - Math.floor(limit / 2)), count - limit))
    const visible = Math.max(0, Math.min(limit, count - offset))
    return Array.from({ length: visible }, (_, index) => offset + index)
  })
  const hiddenAbove = () => Math.max(0, (visibleIndexes()[0] ?? 1) - 1)
  const hiddenBelow = () => Math.max(0, total() - 1 - (visibleIndexes().at(-1) ?? 0))

  const rowBudget = () => Math.max(12, dims().width - 6)
  const sessionIdentity = (row: ActiveSessionRow) =>
    row.current || row.id === props.currentSessionId() ? 'current' : row.id
  const liveRowText = (index: number, row: ActiveSessionRow) => {
    const prefix = `${String(index).padStart(2)}. ${sessionIdentity(row)}  ${sessionStatusGlyph(row.status)} ${sessionStatusLabel(row.status)}`
    const detail =
      dims().width >= 60
        ? `  ${shortSessionModel(row.model)}  ${row.title || row.preview || row.id}`
        : `  ${row.title || row.preview || row.id}`
    return truncRight(prefix + detail, rowBudget() - 2)
  }
  const historyRowText = (index: number, row: SessionHistoryRow | undefined) => {
    if (!row) return ''
    const title = confirmDeleteId() === row.id ? 'press d again to delete' : row.title || row.preview || '(untitled)'
    const detail =
      dims().width >= 60 ? `  ${relativeSessionAge(row.started_at)}  ${row.message_count} msgs  ${title}` : `  ${title}`
    return truncRight(`${String(index).padStart(2)}. ${row.id}${detail}`, rowBudget() - 2)
  }
  const footerText = () => {
    if (dims().width < 60) {
      if (selectedKind() === 'new') return '↵ start · Tab model · Esc close'
      if (selectedKind() === 'history') return '↵ resume · d×2 delete · Esc close'
      return '↵ switch · ^D close · Esc close'
    }
    return selectedKind() === 'history'
      ? resumeRowContextHintSegments.map(segment => segment.text).join('')
      : orchestratorContextHint(selected() === 0)
  }
  const globalFooterText = () => (dims().width < 60 ? '↑↓ move · ^N new · ^R refresh' : orchestratorGlobalHotkeyHint)

  const modelPickerItems = createMemo(() => {
    const selectedModel = draftModel()
    const rows = loadedModelItems() ?? props.modelItems?.() ?? []
    if (!selectedModel) return [...rows]
    return rows.map(row => ({ ...row, current: row.value === selectedModel }))
  })

  return (
    <Show
      when={pickingModel()}
      fallback={
        <box
          ref={element => (rootRef = element)}
          border
          style={{ borderColor: theme().color.border, flexDirection: 'column', flexShrink: 0, padding: 1 }}
        >
          <text fg={theme().color.accent}>
            <b>Sessions</b>
          </text>
          <text fg={theme().color.muted}>{sessionsCountLabel(live().length, resumable().length)}</text>
          <Show when={loading() || busy()}>
            <text selectable={false}>
              <span style={{ fg: theme().color.accent }}>{activityGlyph()}</span>
              <span style={{ fg: theme().color.muted }}>{loading() ? ' loading sessions…' : ' working…'}</span>
            </text>
          </Show>
          <For each={errorMessages()}>
            {message => (
              <text fg={theme().color.warn} wrapMode="none">
                {truncRight(`error: ${message}`, rowBudget())}
              </text>
            )}
          </For>

          <box
            onMouseDown={() => setSelected(0)}
            style={{
              backgroundColor: selected() === 0 ? theme().color.selectionBg : 'transparent',
              flexDirection: 'row'
            }}
          >
            <text fg={selected() === 0 ? theme().color.text : theme().color.muted} wrapMode="none">
              {truncRight(
                `${selected() === 0 ? '▸ ' : '  '} +  new  ✎ draft  ${draftModelDisplayLabel(draftModel())}  ${draftTitleFromPrompt(draft()) || 'Start a new live session'}`,
                rowBudget()
              )}
            </text>
          </box>
          <Show when={selected() === 0}>
            <box style={{ flexDirection: 'row' }}>
              <text fg={theme().color.prompt}>{'> '}</text>
              <input
                ref={element => (promptRef = element)}
                focused
                value={draft()}
                onInput={setDraft}
                onSubmit={submitDraft}
                onMouseDown={() => promptRef?.focus()}
                placeholder="type a prompt for the new session"
                placeholderColor={theme().color.muted}
                textColor={theme().color.text}
                cursorColor={theme().color.accent}
                backgroundColor="transparent"
                focusedBackgroundColor="transparent"
                style={{ flexGrow: 1, minWidth: 0 }}
              />
            </box>
          </Show>
          <Show when={hiddenAbove() > 0}>
            <text fg={theme().color.muted}>{`  ↑ ${hiddenAbove()} more`}</text>
          </Show>
          <For each={visibleIndexes()}>
            {index => {
              const liveRow = () => live()[index - 1]
              const historyRow = () => resumable()[index - 1 - live().length]
              const isSelected = () => selected() === index
              return (
                <box
                  onMouseDown={() => activateIndex(index)}
                  style={{
                    backgroundColor: isSelected() ? theme().color.selectionBg : 'transparent',
                    flexDirection: 'row'
                  }}
                >
                  <Show
                    when={liveRow()}
                    fallback={
                      <text fg={isSelected() ? theme().color.text : theme().color.muted} wrapMode="none">
                        {`${isSelected() ? '▸ ' : '  '}${historyRowText(index, historyRow())}`}
                      </text>
                    }
                  >
                    {row => (
                      <text fg={isSelected() ? theme().color.text : theme().color.muted} wrapMode="none">
                        {`${isSelected() ? '▸ ' : '  '}${liveRowText(index, row())}`}
                      </text>
                    )}
                  </Show>
                </box>
              )
            }}
          </For>
          <Show when={hiddenBelow() > 0}>
            <text fg={theme().color.muted}>{`  ↓ ${hiddenBelow()} more`}</text>
          </Show>
          <Show when={total() === 1 && !loading()}>
            <text fg={theme().color.muted}>no other sessions — Enter on +new to start one</text>
          </Show>
          <text fg={theme().color.muted} wrapMode="none">
            {truncRight(footerText(), rowBudget())}
          </text>
          <text fg={theme().color.muted} wrapMode="none">
            {truncRight(globalFooterText(), rowBudget())}
          </text>
        </box>
      }
    >
      <Show
        when={!modelLoading() && !modelError()}
        fallback={
          <box
            ref={element => (modelStatusRef = element)}
            border
            style={{ borderColor: theme().color.border, flexDirection: 'column', flexShrink: 0, padding: 1 }}
          >
            <text fg={theme().color.accent} wrapMode="none">
              <b>Model for new session</b>
            </text>
            <text fg={modelError() ? theme().color.warn : theme().color.muted} wrapMode="none">
              {modelError() ? `error: ${modelError()}` : `${activityGlyph()} loading models…`}
            </text>
            <text fg={theme().color.muted} wrapMode="none">
              Esc back
            </text>
          </box>
        }
      >
        <Picker
          title="Model for new session"
          items={modelPickerItems()}
          onPick={value => {
            setDraftModel(value)
            closeModelPicker()
          }}
          onClose={closeModelPicker}
        />
      </Show>
    </Show>
  )
}
