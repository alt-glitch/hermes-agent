/**
 * Slash command system — the SOLID side (spec §1; mirrors Ink
 * `app/createSlashHandler.ts` + `domain/slash.ts`). Plain functions/data, NOT
 * Effect; the boundary injects a Promise-returning `request` so dispatch can call
 * `slash.exec` / `command.dispatch` / `commands.catalog`.
 *
 * Dispatch ladder (Ink parity):
 *   1. client-local command (the TUI-only set — handled in-process)
 *   2. `slash.exec {command, session_id}` → `{output, warning?}` → system line
 *   3. on reject → `command.dispatch {arg, name, session_id}` → typed action
 *      (exec/plugin → system · alias → re-dispatch · skill/send → submit a turn ·
 *       prefill → notice). Long output routes to the pager (Phase 5a).
 */
import { Option } from 'effect'

import { decodeSessionCompressResponse } from '../boundary/compression.ts'
import { buildManageSubscriptionUrl } from '../boundary/billing.ts'

import { delegationStatusText, type DelegationState } from './agentStatus.ts'
import { diagnosticsEnabled } from './env.ts'
import {
  DETAILS_SECTIONS,
  DETAILS_SECTION_USAGE,
  DETAILS_USAGE,
  isDetailsSection,
  type DetailsMode,
  type DetailsSections,
  nextDetailsMode,
  parseDetailsMode
} from './details.ts'
import { formatBytes, memReport, performHeapdump } from './diagnostics.ts'
import { formatSpawnTree, formatSpawnTreeList, readSpawnTreeEntries } from './replay.ts'
import { mapResumeHistory } from './resume.ts'
import { mapSessionRows, resolveSessionArg, type SessionTabId } from './sessionPicker.ts'
import type { SpawnHistoryState, SpawnSnapshot } from './spawnHistory.ts'
import type { CompletionItem, ConfirmRequest, CustomModelSetupState, PickerItem, PickerState } from './store.ts'
import type {
  BillingMutationResponse,
  BillingOverlayState,
  BillingStateResponse,
  SubscriptionOverlayState,
  SubscriptionPreviewResponse,
  SubscriptionStateResponse,
  SubscriptionUpgradeResponse
} from '../boundary/billing.ts'
import {
  type CommandsCatalogResponse,
  type SessionUndoResponse,
  decodeConfigValueResponse,
  decodeModelSwitchResponse,
  decodeCommandsCatalogResponse,
  decodeReloadEnvResponse,
  decodeReloadMcpResponse,
  decodeSessionSaveResponse,
  decodeSessionStatusResponse,
  decodeSessionTitleResponse,
  decodeSessionUndoResponse,
  decodeSkillsReloadResponse
} from '../boundary/schema/SessionCommandResponses.ts'
import { decodeToolsConfigureResponse } from '../boundary/schema/ToolsConfigureResponse.ts'
import { decodeBrowserManageResponse } from '../boundary/schema/BrowserResponses.ts'
import { decodeVoiceToggleResponse } from '../boundary/schema/VoiceResponses.ts'
import { openExternalUrl } from '../boundary/openExternalUrl.ts'
import {
  decodePersonalityResponse,
  decodeRollbackDiffResponse,
  decodeRollbackListResponse,
  decodeRollbackRestoreResponse,
  decodeSessionUsageResponse
} from '../boundary/schema/SecondaryCommandResponses.ts'
import { formatVoiceRecordKey } from './voiceKey.ts'
import { decodeDelegationPauseResponse, decodeSpawnTreeListResponse } from '../boundary/schema/Delegation.ts'
import { decodeProcessStopResponse } from '../boundary/schema/ProcessResponses.ts'
import { buildBillingCtx } from './billing.ts'
import { dailyFortune, randomFortune } from './fortunes.ts'
import { formatHelp } from './help.ts'
import type { Message } from './store.ts'
import { normalizeBusyInputMode, type BusyInputMode } from './busyQueue.ts'
import { batteryInfoFromResponse, batteryLabel } from './battery.ts'

export interface ParsedSlash {
  name: string
  arg: string
}

/** One dashboard-open intent. The entry/store integration owns the Solid
 * overlay state; slash handlers only describe which native surface to open. */
export interface AgentsDashboardOpenRequest {
  readonly diffPair?: {
    readonly baseline: SpawnSnapshot
    readonly candidate: SpawnSnapshot
  }
  /** 0 = live tree, 1 = newest completed tree, N = Nth newest tree. */
  readonly initialHistoryIndex?: number
}

/** Transport-free Agents domain callbacks supplied by the store integration.
 * Optional on SlashContext only for backwards-compatible embedders; the
 * production entry supplies the complete bundle. */
export interface AgentsSlashControl {
  readonly applyPauseResponse: (response: unknown) => boolean
  readonly delegation: () => DelegationState
  readonly history: () => SpawnHistoryState
  readonly loadSnapshot: (response: unknown, path: string) => SpawnSnapshot | null
}

/** Parse `/name rest…` → {name, arg}; null if not a slash command. */
export function parseSlash(input: string): ParsedSlash | null {
  if (!input.startsWith('/')) return null
  const [name = '', ...rest] = input.slice(1).split(/\s+/)
  if (!name && rest.length === 0) return null
  return { arg: rest.join(' '), name: name.toLowerCase() }
}

/** How a submitted composer line is routed (F9 + slash ladder): a `!cmd` runs a
 *  shell command, a `/command` goes through the slash dispatcher, everything else
 *  is a prompt turn. `payload` is the command (shell) with the lead `!` stripped
 *  and trimmed, or the original text (slash/prompt). */
export type SubmitRoute =
  | { kind: 'shell'; payload: string }
  | { kind: 'slash'; payload: string }
  | { kind: 'prompt'; payload: string }

export function classifySubmit(text: string): SubmitRoute {
  if (text.startsWith('!')) return { kind: 'shell', payload: text.slice(1).trim() }
  if (text.startsWith('/')) return { kind: 'slash', payload: text }
  return { kind: 'prompt', payload: text }
}

/** The host capabilities the dispatcher needs (wired by the entry boundary). */
export interface SlashContext {
  /** Server RPC (resolves with the result, rejects on GatewayError). */
  readonly request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  readonly sessionId: () => string | undefined
  /** Stable durable conversation id (unlike the gateway's ephemeral live SID). */
  readonly sessionOwnerId: () => string | undefined
  readonly pushSystem: (text: string) => void
  /** Open the full-screen pager (long output: /status, /logs, …). */
  readonly openPager: (title: string, text: string) => void
  /** Submit a user turn (skill/send dispatch results). */
  readonly submit: (text: string) => boolean | void
  /** Submit a SKILL invocation: the full body goes to the model, but the
   *  transcript renders a COLLAPSED `▶ /name · N lines` row instead of dumping
   *  the whole skill body. `command` is the slash invocation as typed (incl.
   *  args). (glitch 2026-06-23) */
  readonly submitSkill: (command: string, body: string) => boolean | void
  /** Open a local Y/N confirm; `onConfirm` runs on Yes. */
  readonly confirm: (request: ConfirmRequest, onConfirm: () => void) => void
  /** Refuse a session-destructive mutation while a turn/transition is active. */
  readonly guardBusySessionSwitch: (what?: string, requestedOwner?: string) => boolean
  /** Close the current live session and create/adopt a replacement. */
  readonly newSession: (message?: string, title?: string) => void
  /** Branch the current conversation into a newly adopted live session. */
  readonly branchSession?: (name: string) => void
  /** Create/adopt a new live sibling without closing the current session. */
  readonly newLiveSession: (message?: string, title?: string) => void
  /** Adopt the same-SID agent reset returned by `tools.configure`, then refresh
   *  session catalogs asynchronously. */
  readonly resetAfterToolsConfigure: (info: { readonly [key: string]: unknown }) => void
  /** Hold/release the entry transition queue across a live tools reset so
   *  prompts typed while the RPC runs are replayed after adoption, not erased. */
  readonly beginToolsConfigure: () => void
  readonly endToolsConfigure: () => void
  /** Whether the visible transcript contains a user/assistant exchange. */
  readonly hasConversation: () => boolean
  /** Apply a successful live rename immediately; the gateway event remains the
   *  authoritative eventual refresh. */
  readonly setSessionTitle: (title: string) => void
  /** Refresh the active command-name cache after `skills.reload`, removing only
   *  skills the gateway confirmed disappeared. */
  readonly refreshCommandCatalog: (catalog: unknown, removedSkills: readonly string[]) => void
  /** Effect-decoded command catalog cached during post-session setup. */
  readonly commandCatalog: () => CommandsCatalogResponse | undefined
  /** Current retained transcript rows for the local `/history` viewer. */
  readonly historyItems: () => readonly Message[]
  /** Skin-provided title for the categorized help pager. */
  readonly helpHeader: () => string
  /** The single hosted-dashboard contract (`HERMES_TUI_DASHBOARD`). */
  readonly dashboardMode: () => boolean
  /** Copy the n-th newest assistant response to the clipboard; returns whether something was copied. */
  readonly copyResponse: (n: number) => boolean
  /** Copy the active native renderer selection; returns its rendered text when present. */
  readonly copySelection: () => string | undefined
  /** Request cleanup-safe renderer shutdown; code 42 asks the Python wrapper to update. */
  readonly quit: (code?: number) => void
  /** Force a renderer-native full repaint. */
  readonly redraw: () => void
  /** Recent gateway transport log lines for `/logs` (the bounded ring). */
  readonly logTail: (limit: number) => string[]
  /** Open the tabbed resume picker on the given tab (/sessions, bare /resume). */
  readonly openSessionPicker: (tab: SessionTabId) => void
  /** Resume a session directly by id (`/resume <id|name>` — no picker). */
  readonly resumeSession: (sessionId: string) => void
  /** Open a generic picker (model picker, skills hub). */
  readonly openPicker: (picker: PickerState) => void
  readonly openCustomModelSetup?: (setup: CustomModelSetupState) => void
  /** Open the agents dashboard (/agents, /tasks, /replay, /replay-diff). */
  readonly openDashboard: (request?: AgentsDashboardOpenRequest) => void
  /** Store-owned Agents/replay state and decoded mutation callbacks. */
  readonly agentsControl?: AgentsSlashControl
  /** Open the OS background-process panel (/processes). */
  readonly openBackgroundPanel: () => void
  readonly openJourney?: () => void
  readonly openPluginsHub?: () => void
  readonly openPetPicker?: () => void
  /** Open the /topup overlay with a fetched state snapshot + ctx bundle. */
  readonly openBilling: (overlay: BillingOverlayState) => void
  readonly openSubscription: (overlay: SubscriptionOverlayState) => void
  /** Track an in-flight background-prompt task id (`/bg` → prompt.background). */
  readonly addBgTask: (id: string) => void
  /** Commit the authoritative process-global CDP state returned by browser.manage. */
  readonly setBrowserState: (connected: boolean, url?: string) => void
  /** Commit decoded voice mode/TTS/key state returned by voice.toggle. */
  readonly setVoiceMode: (patch: { enabled?: boolean; tts?: boolean; recordKey?: string }) => void
  /** Cached `/model` picker rows (Epic 7 instant open); undefined until prefetched. */
  readonly modelItems: () => PickerItem[] | undefined
  /** Update the cached `/model` picker rows. */
  readonly setModelItems: (items: PickerItem[]) => void
  readonly setCurrentModel: (model: string) => void
  /** Read / set the compact-transcript display flag (/compact — Epic 3). */
  readonly compact: () => boolean
  readonly setCompact: (on: boolean) => void
  /** Read / set the persisted, launch-level status-bar battery indicator. */
  readonly batteryEnabled: () => boolean
  readonly setBatteryEnabled: (on: boolean) => void
  /** Read / set the global tool/reasoning detail mode (/details — Epic 3). */
  readonly details: () => DetailsMode
  readonly setDetails: (mode: DetailsMode, commandOverride?: boolean) => void
  readonly detailSections: () => DetailsSections
  readonly setDetailSection: (section: (typeof DETAILS_SECTIONS)[number], mode: DetailsMode | null) => void
  /** Read / set the show-[HH:MM] display flag (/timestamps — port of upstream 5ff11a689). */
  readonly timestamps: () => boolean
  readonly setTimestamps: (on: boolean) => void
  /** Read / set the expand-all-thinking display flag (/reasoning full|clamp). */
  readonly reasoningFull: () => boolean
  readonly setReasoningFull: (on: boolean) => void
  /** Live busy-input policy + client queue controls. */
  readonly isBusy: () => boolean
  readonly isSessionTransitioning: () => boolean
  /** Serialize history-mutating `/undo` and `/retry` independently of the
   * global reply-flight fence (a later `/status` must not suppress mutation
   * reconciliation). */
  readonly beginHistoryMutation: () => boolean
  readonly endHistoryMutation: () => void
  readonly busyInputMode: () => BusyInputMode
  readonly setBusyInputMode: (mode: BusyInputMode) => void
  readonly queueCount: () => number
  readonly enqueueQueued: (text: string, front?: boolean) => boolean
  readonly clearQueued: () => number
  /** Shared bounded, best-effort session.steer control plane. */
  readonly steer: (
    sessionId: string,
    text: string
  ) => Promise<'fallback' | 'queued' | 'retained' | 'saturated' | 'uncertain'>
  /** Conversation rewind/retry + generic dispatch-prefill capabilities. */
  readonly lastUserMessage: () => string | undefined
  readonly trimLastExchange: () => number
  readonly replaceConversationSnapshot: (
    messages: Message[] | undefined,
    info: object | undefined,
    usage: object | undefined
  ) => void
  readonly setCompressedSessionKey: (sessionKey: string) => void
  readonly prefillComposer: (text: string) => void
  readonly openExternalEditor?: (draft: string) => Promise<void>
  readonly pasteClipboardImage?: () => void
  readonly attachImage?: (input: string) => Promise<void>
  readonly configureTerminal?: (target: string) => Promise<void>
  readonly runExternalSetup?: (args: readonly string[]) => Promise<void>
  /** Mounted-renderable count under the live renderer root (a /mem diagnostic);
   *  undefined when no renderer is reachable (tests). */
  readonly renderableCount: () => number | undefined
}

function readStr(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = (value as { [k: string]: unknown })[key]
  return typeof v === 'string' ? v : undefined
}

const titleCase = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

/** A planned completion query (item 5/13): which RPC + params, and where an
 *  accepted item replaces from if the RPC omits its own `replace_from`. */
export interface CompletionPlan {
  method: 'complete.slash' | 'complete.path'
  params: Record<string, unknown>
  from: number
}

/** The command-name grammar for the lead `/token` (mirrors skillMatch NAME_RE):
 *  starts alphanumeric, then word chars / `.` / `-`. Notably EXCLUDES `/`, so a
 *  path like `/usr/bin` is NEVER a slash command (F2). */
const SLASH_NAME_RE = /^[A-Za-z0-9][\w.-]*$/

/** `@`-mention is the ONLY file/dir completion trigger now (F8b — glitch
 *  2026-06-13: drop `~`/`./`/`/`/bare-path as triggers; the gateway's
 *  complete.path still understands `@file:`/`@folder:`/fuzzy basename). */
function isPathLike(word: string): boolean {
  return word.startsWith('@')
}

/**
 * Decide what to complete for the composer text + cursor offset:
 *   - the text is a slash command — `/` at the very start → `complete.slash
 *     {text}`. A bare `/` opens the full command list immediately (glitch
 *     2026-06-13); `/m`, `/model foo` narrow it. A `/abs/path` whose first token
 *     isn't a valid name (F2) → no slash menu.
 *   - the WORD under the cursor is an `@`-mention → `complete.path {word}` for
 *     file/dir tagging (F8b).
 *   - otherwise nothing.
 *
 * Cursor-aware (F7/F8): completion is computed from the line/token at the cursor,
 * so it keeps working on later lines after Shift+Enter (the old whole-buffer
 * `includes('\n')` bail killed it on every multi-line buffer). `cursor` defaults
 * to the end of `text`. Slash commands stay first-line-only (a `/` mid-buffer is
 * prose, never a command).
 * Returns null when there's no completion to run (so the dropdown clears).
 */
export function planCompletion(text: string, cursor: number = text.length): CompletionPlan | null {
  // Slash command: only when the WHOLE buffer's lead token is a command. A `/`
  // after a newline is prose, so a slash command never spans lines.
  if (text.startsWith('/') && !text.includes('\n')) {
    const body = text.slice(1)
    const space = body.search(/\s/)
    const name = space === -1 ? body : body.slice(0, space)
    // Hydrate on a BARE `/` (body === '', glitch 2026-06-13 — open the full
    // command list on the first slash) or a valid command name. A `/abs/path`
    // (the lead token contains a `/`) is never a command (F2), and a `/ ` with a
    // trailing space past an empty name is not arg-completion on nothing.
    if (body === '' || SLASH_NAME_RE.test(name)) {
      return { from: 0, method: 'complete.slash', params: { text } }
    }
    return null
  }
  // @-mention: the whitespace-delimited token the cursor sits in/just after.
  const pos = Math.max(0, Math.min(cursor, text.length))
  const head = text.slice(0, pos)
  const tokenStart = head.search(/\S+$/)
  if (tokenStart === -1) return null
  const word = head.slice(tokenStart)
  if (isPathLike(word)) {
    return { from: tokenStart, method: 'complete.path', params: { word } }
  }
  return null
}

/** Read a `replace_from` offset off a completion result, falling back to `fallback`. */
export function readReplaceFrom(result: unknown, fallback: number): number {
  if (result && typeof result === 'object') {
    const rf = (result as { replace_from?: unknown }).replace_from
    if (typeof rf === 'number') return rf
  }
  return fallback
}

/** Map a `complete.slash`/`complete.path` result ({items:[{text,display,meta}]}) into candidates. */
export function mapCompletions(result: unknown): CompletionItem[] {
  if (!result || typeof result !== 'object') return []
  const items = (result as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  const out: CompletionItem[] = []
  for (const it of items) {
    const text = readStr(it, 'text')
    if (!text) continue
    out.push({ display: readStr(it, 'display') ?? text, meta: readStr(it, 'meta') ?? '', text })
  }
  return out
}

/** Extract `{text}` items from a `commands.catalog` result for seeding the
 *  composer's slash-highlight catalog. Canonical rows come from `pairs`; aliases
 *  come from `canon` keys. Shape-defensive and de-duplicated. */
export function catalogCommandItems(result: unknown): { text: string }[] {
  if (!result || typeof result !== 'object') return []
  const pairs = (result as { pairs?: unknown }).pairs
  if (!Array.isArray(pairs)) return []
  const out: { text: string }[] = []
  const seen = new Set<string>()
  for (const pair of pairs as unknown[]) {
    const name = Array.isArray(pair) ? (pair as unknown[])[0] : undefined
    if (typeof name === 'string' && name && !seen.has(name)) {
      seen.add(name)
      out.push({ text: name })
    }
  }
  const canon = (result as { canon?: unknown }).canon
  if (canon && typeof canon === 'object' && !Array.isArray(canon)) {
    for (const name of Object.keys(canon)) {
      if (name && !seen.has(name)) {
        seen.add(name)
        out.push({ text: name })
      }
    }
  }
  return out
}

/**
 * A monotonic gate for the per-keystroke completion RPCs (glitch 2026-06-14).
 * The gateway transport does NOT guarantee in-order response delivery and
 * `onType` fires an RPC per keystroke with no debounce, so a slow earlier query
 * (the first bare-`/` `complete.slash`) can resolve AFTER a newer one (an
 * `@`-mention `complete.path`) and clobber the store with stale results — which
 * is what made "a leading /path message breaks @-mentions afterward."
 *
 * `claim()` is called once per keystroke (BEFORE the early-return clear branch,
 * so an intermediate keystroke that fires no RPC still invalidates the older
 * in-flight one) and returns a token; `isCurrent(token)` is true only for the
 * most recently claimed token, so a resolving response applies ONLY when no
 * newer keystroke has superseded it.
 */
export interface CompletionGate {
  claim: () => number
  isCurrent: (token: number) => boolean
}

export function createCompletionGate(): CompletionGate {
  let seq = 0
  return {
    claim: () => ++seq,
    isCurrent: (token: number) => token === seq
  }
}

/** Long output → the pager; short → a system line (Ink: >180 chars or >2 lines). */
function present(ctx: SlashContext, title: string, text: string): void {
  const long = text.length > 180 || text.split('\n').filter(Boolean).length > 2
  if (long) ctx.openPager(title, text)
  else ctx.pushSystem(text)
}

/** Process-diagnostic commands — hidden behind `HERMES_TUI_DIAGNOSTICS`
 *  (logic/env.ts). Regular users never see them; support flows enable them
 *  with one env var. Keep this set in sync with the `(diag)` lines below.
 *  DESIGN ASSUMPTION (review 2026-06-12): these stay CLIENT-ONLY. Completion
 *  is gateway-driven and hides them only because the gateway doesn't know
 *  them — adding a server command with one of these names requires gating it
 *  gateway-side too (the early return below would shadow, not hide, it). */
const DIAGNOSTIC_COMMANDS = new Set(['mem', 'heapdump'])

type ClientHandler = (arg: string, ctx: SlashContext, flight: number) => void | Promise<void>

/** Ink's `slashFlightRef`, kept per injected context so concurrent test/app
 *  instances cannot invalidate each other. Every new slash supersedes older
 *  same-session replies. */
const SLASH_FLIGHTS = new WeakMap<SlashContext, number>()

const claimSlashFlight = (ctx: SlashContext): number => {
  const flight = (SLASH_FLIGHTS.get(ctx) ?? 0) + 1
  SLASH_FLIGHTS.set(ctx, flight)
  return flight
}

const slashFlightIsCurrent = (ctx: SlashContext, flight: number): boolean => SLASH_FLIGHTS.get(ctx) === flight

const currentSessionIs = (ctx: SlashContext, expected: string | undefined, flight: number) =>
  slashFlightIsCurrent(ctx, flight) && ctx.sessionId() === expected

/** Direct cold-session resolution shared by /sessions <id|title> and /resume. */
const directResume = async (needle: string, ctx: SlashContext) => {
  try {
    const { rows } = mapSessionRows(await ctx.request('session.list', { limit: 200 }))
    const hit = resolveSessionArg(rows, needle)
    if (!hit) {
      ctx.pushSystem(`/resume: no session matching “${needle}” — try /sessions`)
      return
    }
    ctx.resumeSession(hit.id)
  } catch (error) {
    ctx.pushSystem(`/resume: ${error instanceof Error ? error.message : 'session.list failed'}`)
  }
}

/** f7 unified orchestrator: bare opens it, `new` keeps the current sibling
 * alive, and any other argument directly cold-resumes by id/title. */
const sessionsCmd: ClientHandler = async (arg, ctx) => {
  const needle = arg.trim()
  if (!needle) {
    ctx.openSessionPicker('recent')
    return
  }
  if (needle.toLowerCase() === 'new') {
    ctx.newLiveSession('new live session started')
    return
  }
  await directResume(needle, ctx)
}

/** `/resume` — bare opens the unified orchestrator; `/resume <id|name>` keeps the DIRECT
 *  path: resolve the arg against `session.list` (exact id → unique id prefix
 *  → exact/unique title) and hydrate without the overlay. */
const resumeCmd: ClientHandler = async (arg, ctx) => {
  const needle = arg.trim()
  if (!needle) {
    ctx.openSessionPicker('recent')
    return
  }
  await directResume(needle, ctx)
}

/**
 * Flatten `model.options` into grouped picker rows (Epic 7; v2.1 availability):
 * group = the provider's display ("lab") name, haystacks = slug + lab name (so
 * `oai`/`copilot`/`anthropic` fuzzy-match the whole group), value = the FULL
 * switch arg `<model> --provider <slug>` so picking a model under a different
 * provider actually switches provider+model (the gateway's
 * `_apply_model_switch` parses `--provider` via parse_model_flags). The current
 * model is flagged, not baked into the label, so the fuzzy scorer never matches
 * the ✓.
 *
 * UNCONFIGURED providers (`authenticated: false` skeleton rows — the gateway
 * sends them via `build_models_payload(include_unconfigured=True,
 * picker_hints=True)`, with `key_env`/`warning` setup hints) become one
 * `unavailable` hint row each (`no API key — set <ENV_VAR>`): hidden by
 * default, revealed dimmed + non-selectable by the picker's Ctrl+U toggle.
 */
export function mapModelOptions(opts: unknown): PickerItem[] {
  if (!opts || typeof opts !== 'object') return []
  const providers = (opts as { providers?: unknown }).providers
  if (!Array.isArray(providers)) return []
  const current = readStr(opts, 'model')
  const currentProvider = readStr(opts, 'provider')
  const items: PickerItem[] = []
  const activeProviderSlugs = new Set(
    providers
      .filter(
        provider =>
          provider && typeof provider === 'object' && (provider as { is_current?: unknown }).is_current === true
      )
      .map(provider => readStr(provider, 'slug'))
      .filter((slug): slug is string => Boolean(slug))
  )
  const appendUsage = (key: 'recent_models' | 'frequent_models', group: string) => {
    const rows = (opts as Record<string, unknown>)[key]
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const model = readStr(row, 'model')
      const provider = readStr(row, 'provider')
      if (!model || !provider) continue
      const providerName = readStr(row, 'provider_name') ?? provider
      const count = Number((row as { activation_count?: unknown }).activation_count)
      const item: PickerItem = {
        description: `${providerName}${Number.isFinite(count) && count > 0 ? ` · ${count} use${count === 1 ? '' : 's'}` : ''}`,
        group,
        haystacks: [provider, providerName, readStr(row, 'base_url') ?? ''].filter(Boolean),
        label: model,
        value: `${model} --provider ${provider}`
      }
      if (model === current && (activeProviderSlugs.has(provider) || currentProvider === provider)) item.current = true
      items.push(item)
    }
  }
  appendUsage('recent_models', 'Recent')
  appendUsage('frequent_models', 'Most used')
  for (const p of providers) {
    if (!p || typeof p !== 'object') continue
    const slug = readStr(p, 'slug') ?? readStr(p, 'name') ?? ''
    const lab = readStr(p, 'name') ?? slug
    if ((p as { authenticated?: unknown }).authenticated === false) {
      // Unconfigured provider → one dimmed hint row under its own group header.
      // Identity (slug + display name) is the haystack so a provider-name query
      // still narrows to the group; the hint text itself is not searched.
      const keyEnv = readStr(p, 'key_env')
      const item: PickerItem = {
        group: lab || slug,
        label: keyEnv ? `no API key — set ${keyEnv}` : (readStr(p, 'warning') ?? 'not configured'),
        unavailable: true,
        value: slug || lab
      }
      const hay = [slug, lab].filter(Boolean)
      if (hay.length) item.haystacks = hay
      items.push(item)
      continue
    }
    if ((p as { authenticated?: unknown }).authenticated !== true) continue
    // The gateway's own normalized "this row is the active provider" flag —
    // more reliable than comparing `provider` to `slug` (the agent's provider
    // string can be the API dialect, e.g. an openai-compatible base_url).
    const rowCurrent = (p as { is_current?: unknown }).is_current === true
    const models = (p as { models?: unknown }).models
    if (!Array.isArray(models)) continue
    for (const m of models) {
      if (typeof m !== 'string') continue
      const item: PickerItem = { label: m, value: slug ? `${m} --provider ${slug}` : m }
      // current = same model id under the active provider (row flag first,
      // then the slug comparison, then "no provider known at all").
      if (m === current && (rowCurrent || currentProvider === slug || !currentProvider)) item.current = true
      if (lab) item.group = lab
      const haystacks = [slug, lab].filter(Boolean)
      if (haystacks.length) item.haystacks = haystacks
      items.push(item)
    }
  }
  // Provider matching failed entirely (string-normalization drift) but the
  // model id is known → flag the first id match so the ✓ never just vanishes.
  if (current && !items.some(i => i.current)) {
    const fallback = items.find(i => i.label === current)
    if (fallback) fallback.current = true
  }
  return items
}

/**
 * Provider tab order for the model picker's chip strip (picker v2.2): each
 * CONFIGURED provider's group (= lab display name) in catalog order, with
 * Nous-identified groups (slug or lab name containing `nous`) hoisted to the
 * front. Unconfigured providers (`unavailable` hint rows) get NO tab — they
 * stay reachable via Ctrl+U under the picker's trailing `All` tab (which the
 * picker appends itself; it is not part of this list).
 */
export function buildModelTabs(items: readonly PickerItem[]): string[] {
  const seen = new Set<string>()
  const ranked: string[] = []
  const nous: string[] = []
  const rest: string[] = []
  for (const it of items) {
    if (it.unavailable || !it.group || seen.has(it.group)) continue
    seen.add(it.group)
    const identity = [it.group, ...(it.haystacks ?? [])].join(' ').toLowerCase()
    if (it.group === 'Recent' || it.group === 'Most used') ranked.push(it.group)
    else (identity.includes('nous') ? nous : rest).push(it.group)
  }
  return [...ranked, ...nous, ...rest]
}

/** Flatten `skills.manage {action:'list'}` ({skills: Record<category, names[]>}) into
 *  grouped picker rows (category = group header; also a fuzzy haystack). */
function mapSkills(result: unknown): PickerItem[] {
  if (!result || typeof result !== 'object') return []
  const skills = (result as { skills?: unknown }).skills
  if (!skills || typeof skills !== 'object') return []
  const items: PickerItem[] = []
  for (const [category, names] of Object.entries(skills as { [k: string]: unknown })) {
    if (!Array.isArray(names)) continue
    for (const n of names) if (typeof n === 'string') items.push({ group: category, label: n, value: n })
  }
  return items
}

/** Lightweight OpenTUI model-options request. The gateway defaults stay fully
 * enriched for desktop/Ink callers; this picker does not consume pricing or
 * capability fields and passive hydration must not probe a live custom endpoint. */
export function modelOptionsParams(sessionId: string | undefined, refresh = false): Record<string, unknown> {
  return {
    capabilities: false,
    pricing: false,
    probe_current_custom_provider: false,
    session_id: sessionId,
    ...(refresh ? { refresh: true } : {})
  }
}

/** Re-fetch `model.options` and update the cached picker rows. Resolves with
 *  the fresh rows (the open picker swaps them in live — Ctrl+R, picker v2.1);
 *  rejections are the CALLER's to handle (background callers fire-and-forget). */
function refreshModelItems(ctx: SlashContext, refresh = false, sessionId = ctx.sessionId()): Promise<PickerItem[]> {
  return ctx.request('model.options', modelOptionsParams(sessionId, refresh)).then(opts => {
    if (ctx.sessionId() !== sessionId) return []
    const items = mapModelOptions(opts)
    if (items.length) ctx.setModelItems(items)
    return items
  })
}

/**
 * The open picker's manual-refresh seam (picker v2.1 Ctrl+R). Whoever opens a
 * picker registers (or clears) the catalog re-fetch here; the mounted Picker
 * triggers it via `runPickerRefresh` and swaps in the resolved rows live. A
 * module slot rather than a Picker prop because the App→Picker prop plumbing
 * carries only the PickerState basics; the seam keeps the overlay generic for
 * the upcoming resume-session picker (register a `session.list` re-fetch).
 */
let activePickerRefresh: ((force?: boolean) => Promise<PickerItem[]>) | undefined

/** Register (or clear, with `undefined`) the open picker's catalog re-fetch. */
export function registerPickerRefresh(fn: ((force?: boolean) => Promise<PickerItem[]>) | undefined): void {
  activePickerRefresh = fn
}

/** Whether a refresh is registered (the picker's footer hint is gated on it). */
export function canRefreshPicker(): boolean {
  return activePickerRefresh !== undefined
}

/** Run the registered catalog re-fetch; undefined when none is registered. */
export function runPickerRefresh(force = true): Promise<PickerItem[]> | undefined {
  return activePickerRefresh?.(force)
}

/**
 * The open picker's tab-strip seam (picker v2.2 provider tabs) — same pattern
 * as the refresh seam above: whoever opens a picker registers (or clears) a
 * tab DERIVATION over the picker's live rows; the mounted Picker re-derives
 * through it whenever the rows swap (Ctrl+R), so fresh providers grow chips
 * without re-opening. `/model` registers `buildModelTabs`; pickers without
 * tabs (skills) clear it and render the classic stripless view.
 */
let activePickerTabs: ((items: readonly PickerItem[]) => string[]) | undefined

/** Register (or clear, with `undefined`) the open picker's tab derivation. */
export function registerPickerTabs(fn: ((items: readonly PickerItem[]) => string[]) | undefined): void {
  activePickerTabs = fn
}

/** Derive the open picker's tabs from its rows; [] when no tabs are registered. */
export function pickerTabs(items: readonly PickerItem[]): string[] {
  return activePickerTabs?.(items) ?? []
}

/**
 * The bootstrap `model.options` prefetch seam (perf: prefetch dedupe). The
 * entry stashes its in-flight prefetch promise here. A cold `/model` mounts
 * its loading shell immediately; mounted hydration then awaits this promise
 * (bounded by `waitMs`) before falling back to one model.options RPC. A hung
 * prefetch delays only row hydration, never the overlay's first frame.
 */
let modelPrefetch: { promise: Promise<unknown>; sessionId: string; waitMs: number } | undefined

/** Clear prefetch ownership whenever the live session is detached or replaced. */
export function clearModelPrefetch(): void {
  modelPrefetch = undefined
}

/** Register an in-flight bootstrap prefetch for exactly one live session. */
export function registerModelPrefetch(sessionId: string, promise: Promise<unknown>, waitMs = 2000): void {
  modelPrefetch = { promise, sessionId, waitMs }
}

/**
 * Start and register bootstrap model hydration without exposing a completion
 * promise to the session-transition Effect. `/model` owns the bounded wait;
 * bootstrap remains interactive while the catalog finishes in the background.
 * This is best-effort hydration, so terminate rejection here instead of leaving
 * a detached promise that Node can promote to an unhandled-rejection crash.
 */
export function startModelPrefetch<T>(
  sessionId: string,
  promise: Promise<T>,
  apply: (value: T) => void,
  waitMs = 2000
): void {
  registerModelPrefetch(
    sessionId,
    promise.then(apply).catch(() => undefined),
    waitMs
  )
}

/** Await only this session's registered prefetch (bounded). */
export function awaitModelPrefetch(sessionId: string | undefined): Promise<void> {
  const pending = modelPrefetch
  if (!pending || pending.sessionId !== sessionId) return Promise.resolve()
  return Promise.race([pending.promise, new Promise(resolve => setTimeout(resolve, pending.waitMs))]).then(
    () => undefined
  )
}

/** Switch the model via the authoritative config RPC (shared by direct input and picker). */
async function switchModel(
  ctx: SlashContext,
  name: string,
  confirmExpensiveModel = false,
  scope: 'direct' | 'once' | 'session' = 'direct'
): Promise<void> {
  if (ctx.guardBusySessionSwitch('change models')) return
  const sid = ctx.sessionId()
  try {
    const raw = await ctx.request('config.set', {
      confirm_expensive_model: confirmExpensiveModel,
      key: 'model',
      session_id: sid,
      value: `${name.trim()}${scope === 'session' ? ' --session' : scope === 'once' ? ' --once' : ''}`
    })
    if (ctx.sessionId() !== sid) return
    const response = decodeModelSwitchResponse(raw)
    if (!response) {
      ctx.pushSystem('error: invalid response: model switch')
      return
    }
    if (response.confirm_required) {
      ctx.confirm(
        {
          cancelLabel: 'Cancel',
          confirmLabel: 'Switch anyway',
          danger: true,
          detail: response.confirm_message || response.warning || 'This model has unusually high known pricing.',
          title: 'Expensive model selection'
        },
        () => void switchModel(ctx, name, true, scope)
      )
      return
    }
    const value = response.value?.trim()
    if (!value) {
      ctx.pushSystem('error: invalid response: model switch')
      return
    }
    ctx.pushSystem(`model → ${value}${response.scope === 'once' ? ' (next turn only)' : ''}`)
    if (response.warning) ctx.pushSystem(`warning: ${response.warning}`)
    ctx.setCurrentModel(value)
    void refreshModelItems(ctx).catch(() => {})
  } catch (error) {
    ctx.pushSystem(`/model ${name}: ${error instanceof Error ? error.message : 'switch failed'}`)
  }
}

/** `/model` — bare opens the model picker; `/model <name>` switches directly.
 *  Opens from the CACHED catalog when present — zero RPCs, same-frame paint
 *  (Epic 7; the catalog is prefetched at bootstrap and refreshed on switch).
 *  An empty cache mounts a loading shell first; its hydration then awaits the
 *  in-flight prefetch (bounded) so an early `/model` never doubles the RPC. */
const modelCmd: ClientHandler = async (arg, ctx) => {
  const setupValue = '__hermes_add_custom_model__'
  const setupItem: PickerItem = {
    description: 'Ollama, llama.cpp, vLLM, LM Studio, SGLang, or any compatible endpoint',
    group: 'Local & custom',
    haystacks: ['ollama', 'llama.cpp', 'vllm', 'lm studio', 'sglang', 'local'],
    label: 'Add a local/custom model…',
    value: setupValue
  }
  const withSetup = (items: PickerItem[]) => [...items, setupItem]
  const open = (items: PickerItem[], initialRefresh = false) => {
    const sessionId = ctx.sessionId()
    registerPickerRefresh(async (force = true) => {
      if (!force) {
        await awaitModelPrefetch(sessionId)
        if (ctx.sessionId() !== sessionId) return []
        const hydrated = ctx.modelItems()
        if (hydrated?.length) return withSetup(hydrated)
      }
      return withSetup(await refreshModelItems(ctx, force, sessionId))
    })
    registerPickerTabs(buildModelTabs)
    ctx.openPicker({
      errorLabel: 'Could not load models',
      initialRefresh,
      initialTab: 'all',
      items: initialRefresh ? [] : withSetup(items),
      loadingLabel: 'Loading models…',
      onPick: name => {
        if (name === setupValue) {
          if (ctx.openCustomModelSetup) {
            ctx.openCustomModelSetup({
              request: ctx.request,
              onSaved: value => void switchModel(ctx, value, false, 'session')
            })
          } else {
            ctx.pushSystem('Custom model setup is unavailable in this TUI host.')
          }
        } else {
          void switchModel(ctx, name, false, 'session')
        }
      },
      title: 'Switch model'
    })
  }
  const requested = arg.trim()
  if (requested === '--refresh') {
    if (ctx.guardBusySessionSwitch('change models')) return
    const items = await refreshModelItems(ctx, true)
    open(items)
    return
  }
  if (requested) {
    const tokens = requested.split(/\s+/)
    const once = tokens.includes('--once')
    const model = tokens.filter(token => token !== '--once').join(' ')
    if (once && !model) {
      ctx.pushSystem('usage: /model <name> --once')
      return
    }
    await switchModel(ctx, model, false, once ? 'once' : 'direct')
    return
  }
  if (ctx.guardBusySessionSwitch('change models')) return
  const cached = ctx.modelItems()
  if (cached?.length) {
    open(cached)
    return
  }
  // Paint the complete picker shell now. Mount-time hydration reuses the
  // in-flight prefetch and only falls back to one model.options RPC.
  open([], true)
}

/** `/skills` — open the skills hub; picking a skill shows its info in the pager. */
const skillsCmd: ClientHandler = async (_arg, ctx) => {
  const items = mapSkills(await ctx.request('skills.manage', { action: 'list' }))
  if (!items.length) {
    ctx.pushSystem('No skills found.')
    return
  }
  registerPickerRefresh(undefined) // no Ctrl+R catalog re-fetch for skills (yet)
  registerPickerTabs(undefined) // no tab strip for skills — classic grouped view
  ctx.openPicker({
    items,
    onPick: name =>
      void ctx
        .request('skills.manage', { action: 'inspect', query: name })
        .then(info => ctx.openPager(`Skill: ${name}`, readStr(info, 'info') || JSON.stringify(info, null, 2)))
        .catch(() => ctx.pushSystem(`/skills: could not inspect ${name}`)),
    title: 'Skills'
  })
}

/** `on`/`off`/`toggle`/bare → the next flag value; null on garbage (Ink flagFromArg). */
function flagFromArg(arg: string, current: boolean): boolean | null {
  const mode = arg.trim().toLowerCase()
  if (!mode || mode === 'toggle') return !current
  if (mode === 'on') return true
  if (mode === 'off') return false
  return null
}

/** `/compact [on|off|toggle]` — compact transcript spacing. The flag flips locally
 *  (the store drives the render); persistence mirrors Ink: a fire-and-forget
 *  `config.set {key:'compact'}` so the Ink TUI + future launches share the pref
 *  (the gateway does NOT send the persisted value to this TUI, so each launch
 *  starts off — see store.ts `compact`). */
const compactCmd: ClientHandler = (arg, ctx) => {
  const next = flagFromArg(arg, ctx.compact())
  if (next === null) {
    ctx.pushSystem('usage: /compact [on|off|toggle]')
    return
  }
  ctx.setCompact(next)
  void ctx.request('config.set', { key: 'compact', value: next ? 'on' : 'off' }).catch(() => {})
  ctx.pushSystem(`compact ${next ? 'on' : 'off'}`)
}

/** `/timestamps [on|off|status]` (alias `/ts`) — toggle the muted `[HH:MM]` shown
 *  next to each message that carries a stored unix `timestamp`. Port of upstream
 *  5ff11a689 ("/timestamps") reproduced natively in the OpenTUI engine.
 *
 *  JUDGMENT CALLS:
 *  - `status` (or `?`) reports `Message timestamps: ON|OFF` WITHOUT toggling.
 *  - Otherwise `flagFromArg` parses on/off/toggle (bare = toggle); garbage → usage.
 *  - Persisted via the same fire-and-forget `config.set` seam as /compact, with
 *    key `timestamps` (matching compactCmd's `key: 'compact'` convention — the
 *    classic CLI's `display.timestamps` is its dotted config path, but this RPC
 *    uses the short flag name, so we mirror compact). The flag flips locally
 *    regardless (the store drives the render); each launch starts OFF (the
 *    persisted pref doesn't reach this TUI via session.info — see store.ts). */
const timestampsCmd: ClientHandler = (arg, ctx) => {
  const mode = arg.trim().toLowerCase()
  if (mode === 'status' || mode === '?') {
    ctx.pushSystem(`Message timestamps: ${ctx.timestamps() ? 'ON' : 'OFF'}`)
    return
  }
  const next = flagFromArg(arg, ctx.timestamps())
  if (next === null) {
    ctx.pushSystem('usage: /timestamps [on|off|status]')
    return
  }
  ctx.setTimestamps(next)
  void ctx.request('config.set', { key: 'timestamps', value: next ? 'on' : 'off' }).catch(() => {})
  ctx.pushSystem(`timestamps ${next ? 'on' : 'off'}`)
}

/**
 * `/details [hidden|collapsed|expanded|cycle]` controls the global mode;
 * `/details <section> <mode|reset>` owns the four Ink-compatible overrides. Bare `/details` reports the
 * persisted mode (`config.get details_mode`) and syncs the local flag to it; a
 * mode set persists via `config.set` (fire-and-forget, Ink parity).
 */
const detailsCmd: ClientHandler = async (arg, ctx) => {
  const trimmed = arg.trim().toLowerCase()
  if (!trimmed) {
    try {
      const r = await ctx.request('config.get', { key: 'details_mode' })
      const mode = parseDetailsMode(readStr(r, 'value')) ?? ctx.details()
      ctx.setDetails(mode, false)
      const overrides = DETAILS_SECTIONS.filter(section => ctx.detailSections()[section])
        .map(section => `${section}=${ctx.detailSections()[section]}`)
        .join(' ')
      ctx.pushSystem(`details: ${mode}${overrides ? `  (${overrides})` : ''}`)
    } catch {
      ctx.pushSystem(`details: ${ctx.details()}`)
    }
    return
  }
  const [first = '', second] = trimmed.split(/\s+/)
  if (second && isDetailsSection(first)) {
    const reset = second === 'reset' || second === 'default' || second === 'inherit'
    const mode = reset ? null : parseDetailsMode(second)
    if (!reset && !mode) {
      ctx.pushSystem(DETAILS_SECTION_USAGE)
      return
    }
    ctx.setDetailSection(first, mode)
    void ctx.request('config.set', { key: `details_mode.${first}`, value: mode ?? '' }).catch(() => {})
    ctx.pushSystem(`details ${first}: ${mode ?? 'reset'}`)
    return
  }
  const next = first === 'cycle' || first === 'toggle' ? nextDetailsMode(ctx.details()) : parseDetailsMode(first)
  if (!next) {
    ctx.pushSystem(DETAILS_USAGE)
    return
  }
  ctx.setDetails(next, true)
  void ctx.request('config.set', { key: 'details_mode', value: next }).catch(() => {})
  ctx.pushSystem(`details: ${next}`)
}

/**
 * `/reasoning [full|clamp]` — expand/collapse ALL thinking ("Thinking"/"Thought")
 * sections, independently of the global /details mode. Mirrors detailsCmd.
 *
 *   - bare `/reasoning`: read this session's effort/visibility plus the
 *     persisted `reasoning_full` boolean, sync the local flag, and report both
 *     the agent setting and OpenTUI's full/clamp transcript-display setting.
 *   - `full` (alias `all`): expand all → local flag on + persist `value:'full'`.
 *   - `clamp` (aliases `collapse`, `short`): collapse all → flag off + `value:'clamp'`.
 *
 * Effort and visibility values use the gateway's session-aware `config.set`
 * contract. Sending them through `slash.exec` runs a separate worker process:
 * it can persist config, but cannot update the live agent or status chrome.
 */
const reasoningCmd: ClientHandler = async (arg, ctx, flight) => {
  const first = arg.trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (!first) {
    const sid = ctx.sessionId()
    try {
      const r = await ctx.request('config.get', { key: 'reasoning', session_id: sid })
      if (!currentSessionIs(ctx, sid, flight)) return
      const full = !!(r && typeof r === 'object' && (r as { [k: string]: unknown }).reasoning_full)
      ctx.setReasoningFull(full)
      const value = readStr(r, 'value')
      const display = readStr(r, 'display')
      ctx.pushSystem(
        value
          ? `reasoning: ${value} · display ${display || 'hide'} · sections ${full ? 'full' : 'clamp'}`
          : `reasoning: ${full ? 'full' : 'clamp'}`
      )
    } catch {
      if (currentSessionIs(ctx, sid, flight)) {
        ctx.pushSystem(`reasoning: ${ctx.reasoningFull() ? 'full' : 'clamp'}`)
      }
    }
    return
  }
  if (first === 'full' || first === 'all') {
    ctx.setReasoningFull(true)
    void ctx.request('config.set', { key: 'reasoning', value: 'full' }).catch(() => {})
    ctx.pushSystem('reasoning: full')
    return
  }
  if (first === 'clamp' || first === 'collapse' || first === 'short') {
    ctx.setReasoningFull(false)
    void ctx.request('config.set', { key: 'reasoning', value: 'clamp' }).catch(() => {})
    ctx.pushSystem('reasoning: clamp')
    return
  }
  // Effort (high/medium/low/etc.) and visibility (show/hide) must update the
  // live session so session.info repaints the footer immediately.
  const sid = ctx.sessionId()
  if (!sid) {
    ctx.pushSystem('reasoning: no active session')
    return
  }
  const parts = arg.trim().split(/\s+/).filter(Boolean)
  let scope: 'global' | 'session' | undefined
  const valueParts: string[] = []
  for (const part of parts) {
    const flag = part.toLowerCase()
    if (flag === '--global') {
      scope = 'global'
    } else if (flag === '--session') {
      // Session is the gateway default. Preserve an explicit flag for parity
      // with /model, while allowing --global to win regardless of order.
      scope ??= 'session'
    } else {
      valueParts.push(part)
    }
  }
  const value = valueParts.join(' ')
  try {
    const r = await ctx.request('config.set', {
      key: 'reasoning',
      value,
      session_id: sid,
      ...(scope ? { scope } : {})
    })
    if (!currentSessionIs(ctx, sid, flight)) return
    ctx.pushSystem(`reasoning: ${readStr(r, 'value') || value}`)
  } catch {
    if (currentSessionIs(ctx, sid, flight)) ctx.pushSystem('reasoning: failed to update')
  }
}

/** `/skin [name]` — switch the active theme skin (Ink parity:
 *  ui-tui/src/app/slash/commands/session.ts). Bare `/skin` reports the persisted
 *  skin (`config.get skin`); `/skin <name>` persists via `config.set` which makes
 *  the gateway emit `skin.changed` → the store re-themes the running UI LIVE (no
 *  relaunch). Skin-name arg completion comes from the gateway's `complete.slash`
 *  for free. Fire-and-forget with a guarded notice, matching compact/details. */
const skinCmd: ClientHandler = async (arg, ctx) => {
  const name = arg.trim()
  if (!name) {
    try {
      const r = await ctx.request('config.get', { key: 'skin' })
      ctx.pushSystem(`skin: ${readStr(r, 'value') || 'default'}`)
    } catch {
      ctx.pushSystem('skin: default')
    }
    return
  }
  try {
    const r = await ctx.request('config.set', { key: 'skin', value: name })
    ctx.pushSystem(`skin → ${readStr(r, 'value') || name}`)
  } catch (error) {
    ctx.pushSystem(`/skin: ${error instanceof Error ? error.message : 'config.set failed'}`)
  }
}

/** `/theme [auto|light|dark]` stays client-owned so it persists through the
 * config RPC instead of falling through to the slash-worker subprocess. */
const themeCmd: ClientHandler = async (arg, ctx) => {
  const value = arg.trim().toLowerCase()
  if (!value) {
    try {
      const response = decodeConfigValueResponse(await ctx.request('config.get', { key: 'theme' }))
      ctx.pushSystem(`theme: ${response?.value || 'auto'}`)
    } catch {
      ctx.pushSystem('theme: auto')
    }
    return
  }
  if (value !== 'auto' && value !== 'light' && value !== 'dark') {
    ctx.pushSystem('usage: /theme [auto|light|dark]')
    return
  }
  try {
    const response = decodeConfigValueResponse(await ctx.request('config.set', { key: 'theme', value }))
    if (!response) {
      ctx.pushSystem('/theme: invalid config.set response')
      return
    }
    ctx.pushSystem(`theme → ${response.value || value}`)
  } catch (error) {
    ctx.pushSystem(`/theme: ${error instanceof Error ? error.message : 'config.set failed'}`)
  }
}

/** `/battery [on|off|status]` owns both persistence and the native poller.
 * Bare/toggle parity with the classic CLI is retained. */
const batteryCmd: ClientHandler = async (arg, ctx, flight) => {
  const mode = arg.trim().toLowerCase()
  const sid = ctx.sessionId()
  if (mode === 'status' || mode === 'show') {
    const state = ctx.batteryEnabled() ? 'on' : 'off'
    try {
      const raw = await ctx.request('system.battery', {})
      if (!currentSessionIs(ctx, sid, flight)) return
      const reading = batteryInfoFromResponse(raw)
      ctx.pushSystem(
        reading?.available
          ? `battery indicator ${state} — currently ${batteryLabel(reading)}`
          : `battery indicator ${state} — no battery detected on this machine`
      )
    } catch {
      if (currentSessionIs(ctx, sid, flight)) ctx.pushSystem(`battery indicator ${state}`)
    }
    return
  }

  const next = flagFromArg(arg, ctx.batteryEnabled())
  if (next === null) {
    ctx.pushSystem('usage: /battery [on|off|status]')
    return
  }
  try {
    const response = decodeConfigValueResponse(
      await ctx.request('config.set', { key: 'battery', value: next ? 'on' : 'off' })
    )
    if (!currentSessionIs(ctx, sid, flight)) return
    if (!response) {
      ctx.pushSystem('/battery: invalid config.set response')
      return
    }
    const enabled = response.value === 'on'
    ctx.setBatteryEnabled(enabled)
    ctx.pushSystem(`battery indicator ${enabled ? 'on' : 'off'}`)
  } catch (error) {
    if (currentSessionIs(ctx, sid, flight)) {
      ctx.pushSystem(`/battery: ${error instanceof Error ? error.message : 'config.set failed'}`)
    }
  }
}

const EMPTY_DELEGATION: DelegationState = Object.freeze({
  maxConcurrentChildren: null,
  maxSpawnDepth: null,
  paused: false,
  updatedAtMs: null
})

/** `/agents [pause|resume|unpause|status]` (alias `/tasks`). Bare and unknown
 * subcommands open the native dashboard, matching Ink's interactive fallback. */
const agentsCmd: ClientHandler = async (arg, ctx, flight) => {
  const sub = arg.trim().toLowerCase()

  if (sub === 'pause' || sub === 'resume' || sub === 'unpause') {
    const sid = ctx.sessionId()
    const raw = await ctx.request('delegation.pause', { paused: sub === 'pause' })
    const decoded = decodeDelegationPauseResponse(raw)
    if (Option.isNone(decoded)) {
      if (currentSessionIs(ctx, sid, flight)) ctx.pushSystem('/agents: invalid delegation.pause response')
      return
    }
    if (ctx.agentsControl?.applyPauseResponse(raw) === false) {
      if (currentSessionIs(ctx, sid, flight)) ctx.pushSystem('/agents: invalid delegation.pause response')
      return
    }
    // Delegation pause is process-global. Always reconcile successful gateway
    // state even when a newer slash/session supersedes this command; only its
    // transcript feedback is flight-scoped.
    if (!currentSessionIs(ctx, sid, flight)) return
    ctx.pushSystem(`delegation · ${decoded.value.paused ? 'paused' : 'resumed'}`)
    return
  }

  if (sub === 'status') {
    ctx.pushSystem(delegationStatusText(ctx.agentsControl?.delegation() ?? EMPTY_DELEGATION))
    return
  }

  ctx.openDashboard()
}

/** Fetch + map the session's archived spawn trees (`spawn_tree.list`). */
async function listSpawnTrees(ctx: SlashContext) {
  const r = await ctx.request('spawn_tree.list', { limit: 30, session_id: ctx.sessionId() ?? 'default' })
  return readSpawnTreeEntries(r)
}

/**
 * `/replay [n|path]` — spawn-tree inspector through the pager (Ink renders these
 * in its agents overlay; the flow + RPCs are the same): bare lists the archived
 * trees with indices, `<n>` loads the n-th listed tree, anything else is treated
 * as a snapshot path on disk (`load <path>` accepted for Ink muscle memory).
 */
const legacyReplayCmd: ClientHandler = async (arg, ctx) => {
  const raw = arg.trim()
  const lower = raw.toLowerCase()
  try {
    if (!raw || lower === 'list' || lower === 'ls') {
      const entries = await listSpawnTrees(ctx)
      if (!entries.length) {
        ctx.pushSystem('no archived spawn trees for this session — completed delegations are archived automatically')
        return
      }
      ctx.openPager('Spawn trees', formatSpawnTreeList(entries))
      return
    }
    if (/^\d+$/.test(raw)) {
      const n = Number.parseInt(raw, 10)
      const entries = await listSpawnTrees(ctx)
      const entry = entries[n - 1]
      if (!entry) {
        ctx.pushSystem(
          entries.length
            ? `replay: index out of range 1..${entries.length} — /replay to list`
            : 'no archived spawn trees for this session'
        )
        return
      }
      const tree = await ctx.request('spawn_tree.load', { path: entry.path })
      ctx.openPager(`Replay ${n}`, formatSpawnTree(tree))
      return
    }
    const path = lower.startsWith('load ') ? raw.slice(5).trim() : raw
    const tree = await ctx.request('spawn_tree.load', { path })
    ctx.openPager('Replay', formatSpawnTree(tree))
  } catch (error) {
    ctx.pushSystem(`/replay: ${error instanceof Error ? error.message : 'failed'}`)
  }
}

function formatArchivedSpawnTrees(
  entries: readonly { count: number; finished_at?: number; label?: string; path: string }[]
) {
  return entries
    .map(entry => {
      const when = entry.finished_at ? new Date(entry.finished_at * 1000).toLocaleString() : '?'
      const label = entry.label || `${String(entry.count)} subagents`
      return `${when} · ${String(entry.count)}×\n${label}\n  ${entry.path}`
    })
    .join('\n\n')
}

/** `/replay [N|last|list|load <path>]` — in-memory history is the primary
 * same-process path. Disk access is explicit and a loaded snapshot is inserted
 * into the same bounded history before the dashboard opens at index 1. */
const replayCmd: ClientHandler = async (arg, ctx, flight) => {
  const control = ctx.agentsControl
  if (!control) {
    // Compatibility for embedders that have not yet adopted the Agents store
    // bundle. The shipping entry supplies it, so production follows Ink below.
    await legacyReplayCmd(arg, ctx, flight)
    return
  }

  const raw = arg.trim()
  const lower = raw.toLowerCase()
  const sid = ctx.sessionId()

  if (lower === 'list' || lower === 'ls') {
    const result = await ctx.request('spawn_tree.list', {
      limit: 30,
      session_id: sid ?? 'default'
    })
    if (!currentSessionIs(ctx, sid, flight)) return
    const decoded = decodeSpawnTreeListResponse(result)
    if (Option.isNone(decoded)) {
      ctx.pushSystem('/replay: invalid spawn_tree.list response')
      return
    }
    if (!decoded.value.entries.length) {
      ctx.pushSystem('no archived spawn trees on disk for this session')
      return
    }
    ctx.openPager('Archived spawn trees', formatArchivedSpawnTrees(decoded.value.entries))
    return
  }

  if (lower === 'load') {
    ctx.pushSystem('usage: /replay load <path>')
    return
  }
  if (lower.startsWith('load ')) {
    const path = raw.slice(5).trim()
    if (!path) {
      ctx.pushSystem('usage: /replay load <path>')
      return
    }
    const result = await ctx.request('spawn_tree.load', { path })
    if (!currentSessionIs(ctx, sid, flight)) return
    if (!control.loadSnapshot(result, path)) {
      ctx.pushSystem('snapshot empty or unreadable')
      return
    }
    ctx.openDashboard({ initialHistoryIndex: 1 })
    return
  }

  const history = control.history().snapshots
  if (!history.length) {
    ctx.pushSystem('no completed spawn trees this session · try /replay list')
    return
  }

  let index = 1
  if (raw && lower !== 'last') {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isNaN(parsed) || parsed < 1 || parsed > history.length) {
      ctx.pushSystem(`replay: index out of range 1..${String(history.length)} · use /replay list for disk`)
      return
    }
    index = parsed
  }
  ctx.openDashboard({ initialHistoryIndex: index })
}
const usageCmd: ClientHandler = async (_arg, ctx, flight) => {
  const sid = ctx.sessionId()
  const response = decodeSessionUsageResponse(await ctx.request('session.usage', { session_id: sid }))
  if (!currentSessionIs(ctx, sid, flight)) return
  if (!response) return ctx.pushSystem('error: invalid response: session.usage')
  const credits = response.credits_lines ?? []
  const model = response.usage
  const bars: string[] = []
  if (model?.plan_bar) {
    const b = model.plan_bar
    const filled = Math.max(0, Math.min(10, Math.round(b.fill_fraction * 10)))
    bars.push(
      `${model.plan_name ?? 'plan'} [${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${b.remaining_display} left of ${b.total_display}${b.pct_used == null ? '' : ` · ${String(b.pct_used)}% used`}`
    )
  }
  if (model?.topup_bar) bars.push(`top-up [${'█'.repeat(10)}] ${model.topup_bar.remaining_display} · never expires`)
  if (model?.total_spendable_display && model.has_topup) bars.push(`Total spendable: ${model.total_spendable_display}`)
  const hasBalance = Boolean((model?.available && (bars.length || model.status === 'free')) || credits.length)
  if (!(response.calls ?? 0) && !hasBalance) ctx.pushSystem('no API calls yet')
  const lines = model?.available
    ? [
        `Plan: ${model.plan_name ?? (model.status === 'free' ? 'Free' : '')}${model.renews_display ? ` · renews ${model.renews_display}` : ''}`,
        ...bars,
        ...(model.status === 'free' ? ['> Free · free models only. Run /subscription to reach paid models.'] : []),
        ...(model.status === 'low'
          ? [`! Low balance · ${model.total_spendable_display ?? 'under $5'} left. Run /topup or /subscription.`]
          : []),
        ''
      ]
    : credits.length
      ? ['Nous balance', ...credits, '']
      : []
  if ((response.calls ?? 0) > 0) {
    const f = (value: number | undefined) => (value ?? 0).toLocaleString()
    lines.push(
      'Usage',
      `Model: ${response.model ?? ''}`,
      `Input tokens: ${f(response.input)}`,
      `Output tokens: ${f(response.output)}`,
      `Total tokens: ${f(response.total)}`,
      `API calls: ${f(response.calls)}`
    )
    if (response.context_max)
      lines.push(
        `Context: ${f(response.context_used)} / ${f(response.context_max)} (${String(response.context_percent ?? 0)}%)`
      )
    if (response.compressions) lines.push(`Compressions: ${String(response.compressions)}`)
  }
  if (lines.length) ctx.openPager('Usage', lines.join('\n').trim())
  ctx.pushSystem('Run /subscription to change plan · /topup to add to your balance')
}

const personalityCmd: ClientHandler = async (arg, ctx, flight) => {
  const value = arg.trim()
  if (!value) return
  const sid = ctx.sessionId()
  const response = decodePersonalityResponse(
    await ctx.request('config.set', { key: 'personality', session_id: sid, value })
  )
  if (!currentSessionIs(ctx, sid, flight)) return
  if (!response) return ctx.pushSystem('error: invalid response: personality')
  if (response.history_reset) ctx.replaceConversationSnapshot([], response.info ?? undefined, undefined)
  ctx.pushSystem(`personality: ${response.value || 'default'}${response.history_reset ? ' · transcript cleared' : ''}`)
}

const rollbackCmd: ClientHandler = async (arg, ctx, flight) => {
  const sid = ctx.sessionId()
  if (!sid) return ctx.pushSystem('no active session — nothing to rollback')
  const parts = arg.trim().split(/\s+/).filter(Boolean)
  const first = parts[0] ?? ''
  const lower = first.toLowerCase()
  if (!first || lower === 'list' || lower === 'ls') {
    const response = decodeRollbackListResponse(await ctx.request('rollback.list', { session_id: sid }))
    if (!currentSessionIs(ctx, sid, flight)) return
    if (!response) return ctx.pushSystem('error: invalid response: rollback.list')
    if (!response.enabled) return ctx.pushSystem('checkpoints are not enabled')
    if (!response.checkpoints.length) return ctx.pushSystem('no checkpoints found')
    ctx.openPager(
      'Rollback checkpoints',
      response.checkpoints
        .map(
          (item, index) =>
            `${String(index + 1)}. ${item.hash.slice(0, 10)}  ${[item.timestamp, item.message].filter(Boolean).join(' · ') || '(no metadata)'}`
        )
        .join('\n')
    )
    return
  }
  if (lower === 'diff') {
    const hash = parts[1]
    if (!hash) return ctx.pushSystem('usage: /rollback diff <checkpoint>')
    const response = decodeRollbackDiffResponse(await ctx.request('rollback.diff', { hash, session_id: sid }))
    if (!currentSessionIs(ctx, sid, flight)) return
    if (!response) return ctx.pushSystem('error: invalid response: rollback.diff')
    const body = (response.rendered || response.diff || '').trim()
    if (!body && !response.stat) return ctx.pushSystem('no changes since this checkpoint')
    ctx.openPager('Rollback diff', [response.stat || '', body].filter(Boolean).join('\n\n'))
    return
  }
  const filePath = parts.slice(1).join(' ')
  const response = decodeRollbackRestoreResponse(
    await ctx.request('rollback.restore', {
      hash: first,
      session_id: sid,
      ...(filePath ? { file_path: filePath } : {})
    })
  )
  if (!currentSessionIs(ctx, sid, flight)) return
  if (!response) return ctx.pushSystem('error: invalid response: rollback.restore')
  if (!response.success)
    return ctx.pushSystem(`rollback failed: ${response.error || response.message || 'unknown error'}`)
  ctx.pushSystem(
    `rollback restored ${filePath || 'workspace'}: ${response.reason || response.message || response.restored_to || 'restored'}`
  )
  if ((response.history_removed ?? 0) > 0) ctx.trimLastExchange()
}

const pluginsCmd: ClientHandler = async (arg, ctx, flight) => {
  const command = arg.trim()
  if (!command) {
    ctx.openPluginsHub?.()
    return
  }
  const sid = ctx.sessionId()
  const raw = await ctx.request('slash.exec', { command: `plugins ${command}`, session_id: sid })
  if (!currentSessionIs(ctx, sid, flight)) return
  const output = readStr(raw, 'output') || '/plugins: no output'
  const warning = readStr(raw, 'warning')
  const text = warning ? `warning: ${warning}\n${output}` : output
  if (text.length > 180 || text.split('\n').filter(Boolean).length > 2) ctx.openPager('Plugins', text)
  else ctx.pushSystem(text)
}

const petCmd: ClientHandler = async (arg, ctx, flight) => {
  const command = arg.trim()
  if (command.toLowerCase() === 'list') {
    ctx.openPetPicker?.()
    return
  }
  const sid = ctx.sessionId()
  const raw = await ctx.request('slash.exec', { command: `pet${command ? ` ${command}` : ''}`, session_id: sid })
  if (!currentSessionIs(ctx, sid, flight)) return
  const output = readStr(raw, 'output') || '/pet: no output'
  const warning = readStr(raw, 'warning')
  ctx.pushSystem(warning ? `warning: ${warning}\n${output}` : output)
}

const fastCmd: ClientHandler = async (arg, ctx, flight) => {
  const mode = arg.trim().toLowerCase()
  if (!['', 'status', 'normal', 'fast', 'on', 'off', 'toggle'].includes(mode)) {
    ctx.pushSystem('usage: /fast [normal|fast|status|on|off|toggle]')
    return
  }
  const sid = ctx.sessionId()
  if (!sid && mode !== '' && mode !== 'status') {
    ctx.pushSystem('fast mode: no active session')
    return
  }
  const response = decodeConfigValueResponse(
    await ctx.request(mode === '' || mode === 'status' ? 'config.get' : 'config.set', {
      key: 'fast',
      session_id: sid,
      ...(mode === '' || mode === 'status' ? {} : { value: mode })
    })
  )
  if (!currentSessionIs(ctx, sid, flight)) return
  if (!response) return ctx.pushSystem('error: invalid response: fast mode')
  ctx.pushSystem(`fast mode: ${response.value === 'fast' ? 'fast' : 'normal'}`)
}

const yoloCmd: ClientHandler = async (_arg, ctx, flight) => {
  const sid = ctx.sessionId()
  const response = decodeConfigValueResponse(await ctx.request('config.set', { key: 'yolo', session_id: sid }))
  if (!currentSessionIs(ctx, sid, flight)) return
  if (!response) return ctx.pushSystem('error: invalid response: yolo')
  ctx.pushSystem(`yolo ${response.value === '1' ? 'on' : 'off'}`)
}

const reloadMcpCmd: ClientHandler = async (arg, ctx, flight) => {
  const action = arg.trim().toLowerCase()
  const sid = ctx.sessionId()
  const confirm = ['now', 'approve', 'once', 'yes', 'always'].includes(action)
  const response = decodeReloadMcpResponse(
    await ctx.request('reload.mcp', {
      session_id: sid ?? null,
      ...(confirm ? { confirm: true } : {}),
      ...(action === 'always' ? { always: true } : {})
    })
  )
  if (!currentSessionIs(ctx, sid, flight)) return
  if (!response) return ctx.pushSystem('error: invalid response: reload.mcp')
  if (response.status === 'confirm_required') {
    ctx.pushSystem(response.message || '/reload-mcp requires confirmation')
    return
  }
  ctx.pushSystem(
    action === 'always'
      ? 'MCP servers reloaded · future /reload-mcp will run without confirmation'
      : 'MCP servers reloaded · live agent tools refreshed'
  )
}

/** `/verbose [off|new|all|verbose]` — cycle or set live tool-progress detail. */
const verboseCmd: ClientHandler = async (arg, ctx, flight) => {
  const sid = ctx.sessionId()
  const response = await ctx.request('config.set', {
    key: 'verbose',
    session_id: sid,
    value: arg.trim() || 'cycle'
  })
  if (!currentSessionIs(ctx, sid, flight)) return
  const value = readStr(response, 'value')
  if (value) ctx.pushSystem(`verbose: ${value}`)
}

/** `/replay-diff <baseline> <candidate>` — resolve newest-first in-memory
 * indexes and let the native dashboard render the semantic diff. */
const replayDiffCmd: ClientHandler = (arg, ctx) => {
  const parts = arg.trim().split(/\s+/).filter(Boolean)
  if (parts.length !== 2) {
    ctx.pushSystem('usage: /replay-diff <a> <b>  (e.g. /replay-diff 1 2 for last two)')
    return
  }

  const history = ctx.agentsControl?.history().snapshots ?? []
  const resolve = (token: string | undefined): SpawnSnapshot | undefined => {
    if (token === undefined) return undefined
    const index = Number.parseInt(token, 10)
    return Number.isFinite(index) && index >= 1 && index <= history.length ? history[index - 1] : undefined
  }
  const baseline = resolve(parts[0])
  const candidate = resolve(parts[1])
  if (!baseline || !candidate) {
    ctx.pushSystem(`replay-diff: could not resolve indices · history has ${String(history.length)} entries`)
    return
  }

  ctx.openDashboard({ diffPair: { baseline, candidate }, initialHistoryIndex: 0 })
}

/** `/stop` — stop OS background processes in the live gateway directly. This
 * must not rely on the detached slash worker's process registry. */
const stopCmd: ClientHandler = async (_arg, ctx, flight) => {
  const sid = ctx.sessionId()
  const result = await ctx.request('process.stop', {})
  if (!currentSessionIs(ctx, sid, flight)) return
  const decoded = decodeProcessStopResponse(result)
  if (Option.isNone(decoded)) {
    ctx.pushSystem('/stop: invalid process.stop response')
    return
  }
  const killed = decoded.value.killed
  ctx.pushSystem(`stopped ${String(killed)} background ${killed === 1 ? 'process' : 'processes'}`)
}

/** `/heapdump` — write a V8 heap snapshot to `$HERMES_HOME|~/.hermes/logs/` and
 *  report the path + heap/rss before vs after (Ink ref debug.ts /heapdump). */
const heapdumpCmd: ClientHandler = (_arg, ctx) => {
  const pre = process.memoryUsage()
  ctx.pushSystem(`writing heap dump (heap ${formatBytes(pre.heapUsed)} · rss ${formatBytes(pre.rss)})…`)
  try {
    const { after, before, path } = performHeapdump()
    ctx.pushSystem(
      `heapdump: ${path}\n` +
        `heap ${formatBytes(before.heapUsed)} → ${formatBytes(after.heapUsed)} · ` +
        `rss ${formatBytes(before.rss)} → ${formatBytes(after.rss)}`
    )
  } catch (error) {
    ctx.pushSystem(`heapdump failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** `/mem` — live V8 heap/rss numbers + uptime + the mounted-renderable count
 *  (the store-cap diagnostic) as one system block (Ink ref debug.ts /mem). */
const memCmd: ClientHandler = (_arg, ctx) => {
  ctx.pushSystem(memReport(process.memoryUsage(), process.uptime(), ctx.renderableCount()))
}

/** `/status` — the detached slash worker cannot observe the live agent, so use
 *  the session-scoped RPC and always page the authoritative snapshot (Ink
 *  `core.ts` parity). */
const statusCmd: ClientHandler = async (_arg, ctx, flight) => {
  const sid = ctx.sessionId()
  if (!sid) {
    ctx.pushSystem('no active session')
    return
  }

  try {
    const raw = await ctx.request('session.status', { session_id: sid })
    if (!currentSessionIs(ctx, sid, flight)) return
    const response = decodeSessionStatusResponse(raw)
    if (!response) {
      ctx.pushSystem('/status: invalid session.status response')
      return
    }
    ctx.openPager('Status', response.output || '(no status)')
  } catch (error) {
    if (currentSessionIs(ctx, sid, flight)) {
      ctx.pushSystem(`/status: ${error instanceof Error ? error.message : 'session.status failed'}`)
    }
  }
}

/** `/title [name]` — query/rename the active DB session directly, SID-fenced so
 *  a late response cannot rename successor chrome. */
const titleCmd: ClientHandler = async (arg, ctx, flight) => {
  const sid = ctx.sessionId()
  if (!sid) {
    ctx.pushSystem('no active session')
    return
  }

  const title = arg.trim()
  try {
    const raw = await ctx.request('session.title', title ? { session_id: sid, title } : { session_id: sid })
    if (!currentSessionIs(ctx, sid, flight)) return
    const response = decodeSessionTitleResponse(raw)
    if (!response) {
      ctx.pushSystem('/title: invalid session.title response')
      return
    }

    const resolved = response.title.trim()
    if (!title) {
      ctx.pushSystem(resolved ? `title: ${resolved}` : 'no title set')
      return
    }

    const next = resolved || title
    ctx.setSessionTitle(next)
    ctx.pushSystem(`session title set: ${next}${response.pending ? ' (queued while session initializes)' : ''}`)
  } catch (error) {
    if (currentSessionIs(ctx, sid, flight)) {
      ctx.pushSystem(`/title: ${error instanceof Error ? error.message : 'session.title failed'}`)
    }
  }
}

/** `/save` — export the live gateway history rather than the view's capped
 *  transcript. The local check preserves Ink's no-empty-export UX. */
const saveCmd: ClientHandler = async (_arg, ctx, flight) => {
  if (!ctx.hasConversation()) {
    ctx.pushSystem('no conversation yet')
    return
  }

  const sid = ctx.sessionId()
  if (!sid) {
    ctx.pushSystem('no active session — nothing to save')
    return
  }

  try {
    const raw = await ctx.request('session.save', { session_id: sid })
    if (!currentSessionIs(ctx, sid, flight)) return
    const response = decodeSessionSaveResponse(raw)
    if (!response) {
      ctx.pushSystem('/save: invalid session.save response')
      return
    }
    ctx.pushSystem(response.file ? `conversation saved to: ${response.file}` : 'failed to save')
  } catch (error) {
    if (currentSessionIs(ctx, sid, flight)) {
      ctx.pushSystem(`/save: ${error instanceof Error ? error.message : 'session.save failed'}`)
    }
  }
}

/** `/reload` — reload credentials in THIS gateway process, not the detached
 *  slash worker. */
const reloadCmd: ClientHandler = async (_arg, ctx, flight) => {
  const expectedSid = ctx.sessionId()
  try {
    const raw = await ctx.request('reload.env', {})
    if (!currentSessionIs(ctx, expectedSid, flight)) return
    const response = decodeReloadEnvResponse(raw)
    if (!response || !Number.isSafeInteger(response.updated) || response.updated < 0) {
      ctx.pushSystem('/reload: invalid reload.env response')
      return
    }
    ctx.pushSystem(`reloaded .env (${response.updated} ${response.updated === 1 ? 'var' : 'vars'} updated)`)
  } catch (error) {
    if (currentSessionIs(ctx, expectedSid, flight)) {
      ctx.pushSystem(`/reload: ${error instanceof Error ? error.message : 'reload.env failed'}`)
    }
  }
}

/** `/reload-skills` — re-scan in the live gateway, remove confirmed-deleted
 *  skill names immediately, then hydrate aliases/canonical names without
 *  dropping dynamically learned plugin commands. */
const reloadSkillsCmd: ClientHandler = async (_arg, ctx, flight) => {
  const expectedSid = ctx.sessionId()
  try {
    const raw = await ctx.request('skills.reload', {})
    if (!currentSessionIs(ctx, expectedSid, flight)) return
    const response = decodeSkillsReloadResponse(raw)
    if (!response) {
      ctx.pushSystem('/reload-skills: invalid skills.reload response')
      return
    }
    ctx.openPager('Reload Skills', response.output || 'skills reloaded')
    const removedSkills = (response.result.removed ?? []).map(skill => skill.name)
    // Removal is authoritative as soon as skills.reload succeeds. Do not leave
    // deleted commands highlighted merely because the follow-up catalog refresh
    // fails; the second call below only adds the refreshed catalog.
    ctx.refreshCommandCatalog(undefined, removedSkills)

    try {
      const catalogRaw = await ctx.request('commands.catalog', {})
      if (!currentSessionIs(ctx, expectedSid, flight)) return
      const catalog = decodeCommandsCatalogResponse(catalogRaw)
      if (!catalog) {
        ctx.pushSystem('warning: skills reloaded, but the command catalog response was invalid')
        return
      }
      ctx.refreshCommandCatalog(catalog, [])
      const warning = catalog.warning?.trim()
      if (warning) ctx.pushSystem(`command catalog warning: ${warning}`)
    } catch (error) {
      if (currentSessionIs(ctx, expectedSid, flight)) {
        ctx.pushSystem(
          `warning: skills reloaded, but command catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  } catch (error) {
    if (currentSessionIs(ctx, expectedSid, flight)) {
      ctx.pushSystem(`/reload-skills: ${error instanceof Error ? error.message : 'skills.reload failed'}`)
    }
  }
}

/**
 * `/tools` — list/status stays on the slash worker; enable/disable must hit the
 * live gateway directly because it resets the active agent. The returned info
 * replaces the same-SID visible session so old history/tool state cannot imply
 * the prior tool configuration is still in force.
 */
const toolsCmd: ClientHandler = async (arg, ctx) => {
  const [subcommand, ...names] = arg.trim().split(/\s+/).filter(Boolean)
  if (subcommand === 'enable' || subcommand === 'disable') {
    if (!names.length) {
      ctx.pushSystem(`usage: /tools ${subcommand} <name> [name ...]`)
      ctx.pushSystem(`built-in toolset: /tools ${subcommand} web`)
      ctx.pushSystem(`MCP tool: /tools ${subcommand} github:create_issue`)
      return
    }

    if (ctx.guardBusySessionSwitch('change tools', `tools:${ctx.sessionOwnerId() ?? 'detached'}`)) return

    ctx.beginToolsConfigure()
    const expectedSid = ctx.sessionId()
    try {
      const raw = await ctx.request('tools.configure', { action: subcommand, names, session_id: expectedSid })
      // Match Ink's guarded promise: a response from the prior session cannot
      // reset or print into a successor session.
      if (ctx.sessionId() !== expectedSid) return
      const response = decodeToolsConfigureResponse(raw)
      if (!response) {
        ctx.pushSystem('/tools: invalid tools.configure response')
        return
      }

      if (response.info && expectedSid) ctx.resetAfterToolsConfigure(response.info)
      if (response.changed?.length) {
        ctx.pushSystem(`${subcommand === 'disable' ? 'disabled' : 'enabled'}: ${response.changed.join(', ')}`)
      }
      if (response.unknown?.length) ctx.pushSystem(`unknown toolsets: ${response.unknown.join(', ')}`)
      if (response.missing_servers?.length) {
        ctx.pushSystem(`missing MCP servers: ${response.missing_servers.join(', ')}`)
      }
      if (response.reset) ctx.pushSystem('session reset. new tool configuration is active.')
    } catch (error) {
      if (ctx.sessionId() === expectedSid) {
        ctx.pushSystem(`/tools: ${error instanceof Error ? error.message : 'failed'}`)
      }
    } finally {
      ctx.endToolsConfigure()
    }
    return
  }

  const command = arg.trim() ? `tools ${arg.trim()}` : 'tools'
  try {
    const r = await ctx.request('slash.exec', { command, session_id: ctx.sessionId() })
    const output = readStr(r, 'output') || '/tools: no output'
    const warning = readStr(r, 'warning')
    present(ctx, 'Tools', warning ? `warning: ${warning}\n${output}` : output)
  } catch (error) {
    ctx.pushSystem(`/tools: ${error instanceof Error ? error.message : 'failed'}`)
  }
}

/** `/topup` — fetch the gateway billing state and open the interactive overlay
 *  (buy credits / auto-reload / monthly limit). ZERO sub-commands (CLI/TUI
 *  parity): any arg is ignored. All RPC + error mapping lives in logic/billing.ts
 *  (`buildBillingCtx`); this handler just fetches state and opens. */
const topupCmd: ClientHandler = async (_arg, ctx, flight) => {
  const expectedSid = ctx.sessionId()
  const pushInitialSystem = (text: string) => {
    if (currentSessionIs(ctx, expectedSid, flight)) ctx.pushSystem(text)
  }
  // Billing actions outlive the slash-command flight: charge settlement is
  // polled after the overlay closes. Keep those outcomes session-scoped so a
  // later same-session slash command cannot suppress success/failure copy.
  const pushSessionSystem = (text: string) => {
    if (ctx.sessionId() === expectedSid) ctx.pushSystem(text)
  }
  try {
    const s = (await ctx.request('billing.state', {})) as BillingStateResponse
    if (!currentSessionIs(ctx, expectedSid, flight)) return
    if (!s.logged_in) {
      pushInitialSystem('💳 Not logged into Nous Portal — run /portal to log in, then /topup.')
      return
    }
    const billingHost = {
      request: ctx.request,
      pushSystem: pushSessionSystem,
      confirm: ctx.confirm,
      sessionId: () => expectedSid
    }
    ctx.openBilling({
      ctx: buildBillingCtx(billingHost, s),
      pendingCharge: null,
      screen: 'overview',
      state: s
    })
  } catch (error) {
    if (currentSessionIs(ctx, expectedSid, flight)) {
      pushInitialSystem(`/topup: ${error instanceof Error ? error.message : 'billing.state failed'}`)
    }
  }
}

const subscriptionCmd: ClientHandler = async (_arg, ctx, flight) => {
  const expectedSid = ctx.sessionId()
  const pushInitialSystem = (text: string) => {
    if (currentSessionIs(ctx, expectedSid, flight)) ctx.pushSystem(text)
  }
  const pushSessionSystem = (text: string) => {
    if (ctx.sessionId() === expectedSid) ctx.pushSystem(text)
  }
  try {
    const state = (await ctx.request('subscription.state', {})) as SubscriptionStateResponse
    if (!currentSessionIs(ctx, expectedSid, flight)) return
    if (!state.logged_in) {
      pushInitialSystem('Not logged into Nous Portal — run /portal to log in, then /subscription.')
      return
    }
    const openPortal = (url: string) => {
      const opened = openExternalUrl(url)
      pushSessionSystem(opened ? `Opening portal: ${url}` : `Could not open browser — visit ${url}`)
    }
    ctx.openSubscription({
      ctx: {
        fetchCard: () =>
          ctx
            .request('billing.state', {})
            .then(raw => (raw as BillingStateResponse).card ?? null)
            .catch(() => null),
        openManageLink: (tierId?: string) => {
          const url = buildManageSubscriptionUrl(state, tierId)
          if (!url) {
            pushSessionSystem('Could not build manage URL — is your portal configured?')
            return Promise.resolve(false)
          }
          const opened = openExternalUrl(url)
          pushSessionSystem(
            opened
              ? 'Opening your subscription page in the browser — finish there, then re-run /subscription.'
              : `Could not open browser — visit ${url}`
          )
          return Promise.resolve(opened)
        },
        openPortal,
        preview: tierId =>
          ctx
            .request('subscription.preview', { subscription_type_id: tierId })
            .then(raw => raw as SubscriptionPreviewResponse)
            .catch(() => null),
        refreshState: () =>
          ctx
            .request('subscription.state', {})
            .then(raw => raw as SubscriptionStateResponse)
            .catch(() => null),
        requestRemoteSpending: () =>
          ctx
            .request('billing.step_up', { session_id: expectedSid })
            .then(raw => {
              const r = raw as BillingMutationResponse
              return {
                ...(r.error ? { error: r.error } : {}),
                granted: Boolean(r.ok && r.granted),
                ...(r.message ? { message: r.message } : {})
              }
            })
            .catch(() => ({ granted: false, message: 'Could not reach the billing service.' })),
        resume: () =>
          ctx
            .request('subscription.resume', {})
            .then(raw => raw as BillingMutationResponse)
            .catch(() => null),
        scheduleCancellation: () =>
          ctx
            .request('subscription.change', { cancel: true })
            .then(raw => raw as BillingMutationResponse)
            .catch(() => null),
        scheduleChange: tierId =>
          ctx
            .request('subscription.change', { subscription_type_id: tierId })
            .then(raw => raw as BillingMutationResponse)
            .catch(() => null),
        sys: pushSessionSystem,
        upgrade: (tierId, idempotencyKey) =>
          ctx
            .request('subscription.upgrade', {
              subscription_type_id: tierId,
              ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
            })
            .then(raw => raw as SubscriptionUpgradeResponse)
            .catch(() => null)
      },
      screen: 'overview',
      state
    })
  } catch (error) {
    if (currentSessionIs(ctx, expectedSid, flight)) {
      pushInitialSystem(`/subscription: ${error instanceof Error ? error.message : 'subscription.state failed'}`)
    }
  }
}

/** `/bg <prompt>` (aliases /background, /btw) — launch a background PROMPT via
 *  `prompt.background` (Ink parity): echo "bg <id> started" and track the task so
 *  the `bg: N` badge counts it until `background.complete` clears it. NOT the OS
 *  process panel (that's /processes). */
const backgroundCmd: ClientHandler = async (arg, ctx) => {
  const text = arg.trim()
  if (!text) {
    ctx.pushSystem('/bg <prompt> — launch a background prompt')
    return
  }
  try {
    const r = await ctx.request('prompt.background', { session_id: ctx.sessionId(), text })
    const taskId = readStr(r, 'task_id')
    if (taskId) {
      ctx.addBgTask(taskId)
      ctx.pushSystem(`bg ${taskId} started`)
    } else {
      ctx.pushSystem('/bg: no task id returned')
    }
  } catch (error) {
    ctx.pushSystem(`/bg: ${error instanceof Error ? error.message : 'failed'}`)
  }
}

export const BUSY_QUEUE_FULL_MESSAGE =
  'queue full (100 messages / 4M characters) — send or delete a queued message first'

const enqueueForLater = (ctx: SlashContext, text: string, front = false): boolean => {
  if (ctx.isSessionTransitioning()) {
    ctx.pushSystem('session switch in progress — retry the queue command when it finishes')
    return false
  }
  const accepted = ctx.enqueueQueued(text, front)
  if (!accepted) ctx.pushSystem(BUSY_QUEUE_FULL_MESSAGE)
  return accepted
}

/** `/queue [prompt]` (alias `/q`) — local queue inspection/enqueue. */
const queueCmd: ClientHandler = (arg, ctx) => {
  const text = arg.trim()
  if (!text) {
    ctx.pushSystem(`${ctx.queueCount()} queued message(s)`)
    return
  }
  if (text === '--clear') {
    const count = ctx.queueCount()
    if (count === 0) {
      ctx.pushSystem('queue already empty')
      return
    }
    ctx.confirm(
      {
        cancelLabel: 'Keep queued messages',
        confirmLabel: `Discard ${count} queued message(s)`,
        danger: true,
        detail: 'Queued input is not in the conversation history and cannot be recovered after discard.',
        title: 'Clear the pending queue?'
      },
      () => ctx.pushSystem(`discarded ${ctx.clearQueued()} queued message(s)`)
    )
    return
  }
  if (!enqueueForLater(ctx, text)) {
    ctx.prefillComposer(`/queue ${text}`)
    return
  }
  ctx.pushSystem(`queued: "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`)
}

/** `/steer <prompt>` — direct injection while busy; idle preserves the text in
 * the local queue rather than starting a surprise turn. */
const preserveDirectSteer = (ctx: SlashContext, text: string, note: string): void => {
  if (enqueueForLater(ctx, text)) ctx.pushSystem(note)
  else {
    ctx.prefillComposer(`/steer ${text}`)
    ctx.pushSystem('steer could not be queued — command restored to composer')
  }
}

const steerCmd: ClientHandler = async (arg, ctx) => {
  const text = arg.trim()
  if (!text) {
    ctx.pushSystem('usage: /steer <prompt>')
    return
  }
  if (ctx.isSessionTransitioning()) {
    ctx.pushSystem('session switch in progress — retry /steer when it finishes')
    ctx.prefillComposer(`/steer ${text}`)
    return
  }
  const sid = ctx.sessionId()
  if (!ctx.isBusy() || !sid) {
    if (enqueueForLater(ctx, text)) {
      ctx.pushSystem(`no active turn — queued for next: "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`)
    } else {
      ctx.prefillComposer(`/steer ${text}`)
    }
    return
  }
  try {
    const status = await ctx.steer(sid, text)
    if (status === 'uncertain') {
      ctx.pushSystem('steer delivery uncertain — message retained; send it explicitly to retry')
      return
    }
    if (status === 'fallback') {
      ctx.pushSystem('steer rejected — message queued for next turn')
      return
    }
    if (status === 'saturated') {
      if (enqueueForLater(ctx, text)) {
        ctx.pushSystem('steer backlog full — message queued for next turn')
      } else {
        ctx.prefillComposer(`/steer ${text}`)
        ctx.pushSystem('steer backlog and queue full — message restored to composer')
      }
      return
    }
    if (status === 'retained') {
      ctx.prefillComposer(`/steer ${text}`)
      ctx.pushSystem('steer fallback queue is full — command restored to composer')
      return
    }
    // The host creates a correlation-backed transient notice on admission;
    // it disappears only when the gateway proves this steer was consumed.
    if (ctx.sessionId() !== sid) return
  } catch (error) {
    if (ctx.sessionId() === sid) {
      const detail = error instanceof Error ? error.message : 'session.steer failed'
      preserveDirectSteer(ctx, text, `/steer: ${detail} — message queued for next turn`)
    }
  }
}

/** `/busy [queue|steer|interrupt|status]` — persist and immediately apply the
 * active full-screen TUI policy. */
const busyCmd: ClientHandler = async (arg, ctx, flight) => {
  const requested = arg.trim().toLowerCase()
  if (!['', 'status', 'queue', 'steer', 'interrupt'].includes(requested)) {
    ctx.pushSystem('usage: /busy [queue|steer|interrupt|status]')
    return
  }
  if (!requested || requested === 'status') {
    const sid = ctx.sessionId()
    try {
      const response = decodeConfigValueResponse(await ctx.request('config.get', { key: 'busy' }))
      if (!currentSessionIs(ctx, sid, flight)) return
      ctx.pushSystem(`busy input mode: ${response ? normalizeBusyInputMode(response.value) : 'interrupt'}`)
    } catch (error) {
      if (currentSessionIs(ctx, sid, flight))
        ctx.pushSystem(`/busy: ${error instanceof Error ? error.message : 'config request failed'}`)
    }
    return
  }
  const sid = ctx.sessionId()
  try {
    const raw = await ctx.request('config.set', {
      key: 'busy',
      value: requested
    })
    if (!currentSessionIs(ctx, sid, flight)) return
    const response = decodeConfigValueResponse(raw)
    if (!response) {
      ctx.pushSystem('/busy: invalid config response')
      return
    }
    const next = normalizeBusyInputMode(response.value)
    ctx.setBusyInputMode(next)
    ctx.pushSystem(`busy input mode: ${next}`)
  } catch (error) {
    if (currentSessionIs(ctx, sid, flight)) {
      ctx.pushSystem(`/busy: ${error instanceof Error ? error.message : 'config request failed'}`)
    }
  }
}

const COMPACT_NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, notation: 'compact' })
const compactTokens = (value: number) => COMPACT_NUMBER.format(value).replace(/[KMBT]$/, suffix => suffix.toLowerCase())

const compressCmd: ClientHandler = async (arg, ctx) => {
  const sid = ctx.sessionId()
  if (!sid) {
    ctx.pushSystem('no active session — nothing to compress')
    return
  }
  if (ctx.isSessionTransitioning()) {
    ctx.pushSystem('session switch in progress — retry /compress when it finishes')
    return
  }
  if (ctx.isBusy()) {
    ctx.pushSystem('session busy — /interrupt the current turn before /compress')
    return
  }
  if (!ctx.beginHistoryMutation()) {
    ctx.pushSystem('history update already in progress — wait before /compress')
    return
  }
  try {
    const focus = arg.trim()
    const raw = await ctx.request('session.compress', {
      session_id: sid,
      ...(focus ? { focus_topic: focus } : {})
    })
    if (ctx.sessionId() !== sid) return
    const response = decodeSessionCompressResponse(raw)
    if (!response) {
      ctx.pushSystem('/compress: invalid session.compress response')
      return
    }
    const snapshot = response.messages === undefined ? undefined : mapResumeHistory(response.messages)
    if (snapshot !== undefined || response.info !== undefined || response.usage !== undefined) {
      ctx.replaceConversationSnapshot(snapshot, response.info, response.usage)
    }
    const sessionKey = response.session_key?.trim()
    if (sessionKey) ctx.setCompressedSessionKey(sessionKey)
    if (response.summary?.headline) {
      ctx.pushSystem((response.summary.noop ? '' : '✓ ') + response.summary.headline)
      if (response.summary.token_line) ctx.pushSystem('  ' + response.summary.token_line)
      if (response.summary.note) ctx.pushSystem('  ' + response.summary.note)
    } else if ((response.removed ?? 0) <= 0) {
      ctx.pushSystem('nothing to compress')
    } else {
      const tokenSuffix = response.usage?.total ? ` · ${compactTokens(response.usage.total)} tok` : ''
      ctx.pushSystem('compressed ' + response.removed + ' messages' + tokenSuffix)
    }
  } catch (error) {
    if (ctx.sessionId() === sid) {
      ctx.pushSystem('/compress: ' + (error instanceof Error ? error.message : 'session.compress failed'))
    }
  } finally {
    ctx.endHistoryMutation()
  }
}

const requestRewind = async (
  ctx: SlashContext,
  sid: string,
  command: '/retry' | '/undo'
): Promise<SessionUndoResponse | undefined> => {
  const raw = await ctx.request('session.undo', { session_id: sid })
  if (ctx.sessionId() !== sid) return undefined
  const response = decodeSessionUndoResponse(raw)
  if (!response || !Number.isSafeInteger(response.removed) || response.removed < 0) {
    ctx.pushSystem(`${command}: invalid session.undo response`)
    return undefined
  }
  return response
}

/** `/undo` — rewind the gateway and the retained visible exchange together. */
const undoCmd: ClientHandler = async (_arg, ctx) => {
  const sid = ctx.sessionId()
  if (!sid) {
    ctx.pushSystem('nothing to undo')
    return
  }
  if (ctx.isSessionTransitioning()) {
    ctx.pushSystem('session switch in progress — retry /undo when it finishes')
    return
  }
  if (ctx.isBusy()) {
    ctx.pushSystem('session busy — /interrupt the current turn before /undo')
    return
  }
  if (!ctx.beginHistoryMutation()) {
    ctx.pushSystem('history update already in progress — wait before /undo')
    return
  }
  try {
    const response = await requestRewind(ctx, sid, '/undo')
    if (response === undefined) return
    if (response.removed <= 0) {
      ctx.pushSystem('nothing to undo')
      return
    }
    ctx.trimLastExchange()
    ctx.pushSystem(`undid ${response.removed} messages`)
  } catch (error) {
    if (ctx.sessionId() === sid) {
      ctx.pushSystem(`/undo: ${error instanceof Error ? error.message : 'session.undo failed'}`)
    }
  } finally {
    ctx.endHistoryMutation()
  }
}

/** `/retry` — capture the last user body, rewind, then resubmit exactly once. */
const retryCmd: ClientHandler = async (_arg, ctx) => {
  const visibleFallback = ctx.lastUserMessage()
  if (ctx.isSessionTransitioning()) {
    ctx.pushSystem('session switch in progress — retry /retry when it finishes')
    return
  }
  if (!visibleFallback) {
    ctx.pushSystem('nothing to retry')
    return
  }
  const sid = ctx.sessionId()
  if (!sid) {
    if (ctx.submit(visibleFallback) === false) {
      ctx.prefillComposer(visibleFallback)
      ctx.pushSystem('retry could not submit — message restored to composer')
    }
    return
  }
  if (ctx.isBusy()) {
    ctx.pushSystem('session busy — /interrupt the current turn before /retry')
    return
  }
  if (!ctx.beginHistoryMutation()) {
    ctx.pushSystem('history update already in progress — wait before /retry')
    return
  }
  let mutationHeld = true
  try {
    const response = await requestRewind(ctx, sid, '/retry')
    if (response === undefined) return
    if (response.removed <= 0) {
      ctx.pushSystem('nothing to retry')
      return
    }
    ctx.trimLastExchange()
    // Release the mutation barrier before resubmitting; otherwise the entry
    // correctly queues behind its own lock and a full queue can strand the
    // already-rewound retry body.
    ctx.endHistoryMutation()
    mutationHeld = false
    if (ctx.submit(visibleFallback) === false) {
      ctx.prefillComposer(visibleFallback)
      ctx.pushSystem('retry could not submit — message restored to composer')
    }
  } catch (error) {
    if (ctx.sessionId() === sid) {
      ctx.pushSystem(`/retry: ${error instanceof Error ? error.message : 'session.undo failed'}`)
    }
  } finally {
    if (mutationHeld) ctx.endHistoryMutation()
  }
}

const freshSessionCmd =
  (isNew: boolean): ClientHandler =>
  (arg, ctx) => {
    if (ctx.guardBusySessionSwitch('switch sessions', 'new')) return
    const requestedTitle = isNew ? arg.trim() : ''
    ctx.confirm(
      {
        cancelLabel: 'No, keep going',
        confirmLabel: isNew ? 'Yes, start a new session' : 'Yes, clear the session',
        danger: true,
        detail: 'This ends the current conversation and clears the transcript.',
        title: isNew ? 'Start a new session?' : 'Clear the current session?'
      },
      () => ctx.newSession(isNew ? 'new session started' : undefined, requestedTitle || undefined)
    )
  }

export const DASHBOARD_EXIT_DISABLED_MESSAGE =
  'exit is disabled in hosted dashboard chat — use /new to start a fresh session'

export const DASHBOARD_UPDATE_DISABLED_MESSAGE =
  'update is disabled in hosted dashboard chat — the hosted environment is managed separately'

const promptCmd: ClientHandler = async (arg, ctx) => {
  const draft = arg.trim() || ''
  if (draft) ctx.prefillComposer(draft)
  if (!ctx.openExternalEditor) return ctx.pushSystem('external editor unavailable')
  await ctx.openExternalEditor(draft)
}

const pasteCmd: ClientHandler = (arg, ctx) => {
  if (arg.trim()) return ctx.pushSystem('usage: /paste')
  ctx.pasteClipboardImage?.()
}

const imageCmd: ClientHandler = async (arg, ctx) => {
  if (!arg.trim()) return ctx.pushSystem('usage: /image <path>')
  if (!ctx.attachImage) return ctx.pushSystem('image attachment unavailable')
  await ctx.attachImage(arg)
}

const terminalSetupCmd: ClientHandler = async (arg, ctx) => {
  const target = arg.trim().toLowerCase()
  if (target && !['auto', 'cursor', 'vscode', 'windsurf'].includes(target)) {
    return ctx.pushSystem('usage: /terminal-setup [auto|vscode|cursor|windsurf]')
  }
  if (!ctx.configureTerminal) return ctx.pushSystem('terminal setup unavailable')
  await ctx.configureTerminal(target || 'auto')
}

const setupCmd: ClientHandler = async (arg, ctx) => {
  if (!ctx.runExternalSetup) return ctx.pushSystem('setup unavailable')
  await ctx.runExternalSetup(['setup', ...arg.split(/\s+/).filter(Boolean)])
}

const branchCmd: ClientHandler = (arg, ctx) => ctx.branchSession?.(arg.trim())

const quitCmd: ClientHandler = (_arg, ctx) => {
  if (ctx.dashboardMode()) {
    ctx.pushSystem(DASHBOARD_EXIT_DISABLED_MESSAGE)
    return
  }
  ctx.quit(0)
}

const updateCmd: ClientHandler = (_arg, ctx) => {
  if (ctx.dashboardMode()) {
    ctx.pushSystem(DASHBOARD_UPDATE_DISABLED_MESSAGE)
    return
  }
  ctx.pushSystem('exiting TUI to run update...')
  // Give the notice one frame before cleanup-safe renderer destruction. Exit
  // code 42 is interpreted by the existing Python launcher after finalizers.
  setTimeout(() => ctx.quit(42), 100)
}

const redrawCmd: ClientHandler = (_arg, ctx) => {
  ctx.redraw()
  ctx.pushSystem('ui redrawn')
}

const fortuneCmd: ClientHandler = (arg, ctx) => {
  const key = arg.trim().toLowerCase()
  if (!arg || key === 'random') {
    ctx.pushSystem(randomFortune())
    return
  }
  if (key === 'daily' || key === 'stable' || key === 'today') {
    ctx.pushSystem(dailyFortune(ctx.sessionId()))
    return
  }
  ctx.pushSystem('usage: /fortune [random|daily]')
}

/** Ink keeps at most 800 transcript rows (`config/limits.ts::MAX_HISTORY`).
 * OpenTUI retains up to 3,000 rows for windowed scrolling, so `/history` must
 * apply the Ink ceiling explicitly instead of building one giant pager buffer. */
export const HISTORY_MAX_MESSAGES = 800
export const HISTORY_DEFAULT_PREVIEW = 400
export const HISTORY_MIN_PREVIEW = 80
/** A user may ask for a larger preview, but a per-row ceiling prevents one
 * pathological message/ordered-parts array from dominating the pager. */
export const HISTORY_MAX_PREVIEW = 4_000
/** One native TextBuffer owns the pager body. Keep its source below 512 Ki
 * UTF-16 code units (roughly 1 MiB of JS string storage, before native layout). */
export const HISTORY_MAX_PAGER_CHARS = 512 * 1_024
const HISTORY_NOTE_RESERVE = 512

interface BoundedMessageText {
  readonly text: string
  readonly truncated: boolean
}

/** Find the first non-whitespace code unit without slicing the potentially huge
 * source string. The regexp's `lastIndex` lets V8 scan in place. */
function firstNonWhitespace(text: string, from = 0): number {
  const nonWhitespace = /\S/gu
  nonWhitespace.lastIndex = from
  return nonWhitespace.exec(text)?.index ?? -1
}

/** Extract at most `limit` characters from the answer-bearing text parts.
 * Unlike `messageText()`, this never joins the full ordered-parts payload before
 * clipping. Leading/trailing whitespace matches Ink's `m.text.trim()` behavior,
 * including the edge case where an omitted suffix contains only whitespace. */
function boundedHistoryMessageText(message: Message, limit: number): BoundedMessageText {
  const parts = message.parts?.length ? message.parts : undefined
  const sourceCount = parts?.length ?? 1
  const sourceAt = (index: number): string | undefined => {
    if (!parts) return index === 0 ? message.text : undefined
    const part = parts[index]
    return part?.type === 'text' ? part.text : undefined
  }
  const chunks: string[] = []
  let remaining = limit
  let started = false
  let truncated = false

  for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex++) {
    const source = sourceAt(sourceIndex)
    if (source === undefined) continue
    let offset = 0
    if (!started) {
      offset = firstNonWhitespace(source)
      if (offset < 0) continue
      started = true
    }

    if (remaining > 0) {
      let take = Math.min(remaining, source.length - offset)
      let splitSurrogate = false
      const end = offset + take
      if (
        take > 0 &&
        end < source.length &&
        source.charCodeAt(end - 1) >= 0xd800 &&
        source.charCodeAt(end - 1) <= 0xdbff &&
        source.charCodeAt(end) >= 0xdc00 &&
        source.charCodeAt(end) <= 0xdfff
      ) {
        take--
        splitSurrogate = true
      }
      if (take > 0) {
        chunks.push(source.slice(offset, offset + take))
        remaining -= take
        offset += take
      }
      if (splitSurrogate) {
        truncated = true
        break
      }
    }

    // Reaching the budget is truncation only when the omitted suffix (or a
    // later text part) contains visible content. Whitespace-only tails vanish
    // under Ink's trim and must not manufacture an ellipsis.
    if (remaining === 0) {
      truncated = firstNonWhitespace(source, offset) >= 0
      for (let rest = sourceIndex + 1; !truncated && rest < sourceCount; rest++) {
        const later = sourceAt(rest)
        if (later !== undefined && firstNonWhitespace(later) >= 0) truncated = true
      }
      break
    }
  }

  return { text: chunks.join('').trimEnd(), truncated }
}

function requestedHistoryPreview(arg: string): { readonly limited: boolean; readonly preview: number } {
  const requested = Math.max(HISTORY_MIN_PREVIEW, Number.parseInt(arg, 10) || HISTORY_DEFAULT_PREVIEW)
  return { limited: requested > HISTORY_MAX_PREVIEW, preview: Math.min(requested, HISTORY_MAX_PREVIEW) }
}

function historyRow(message: Message, index: number, preview: number): string {
  const tag = message.role === 'user' ? `You #${index + 1}` : `Hermes #${index + 1}`
  let toolCount = 0
  for (const part of message.parts ?? []) if (part.type === 'tool') toolCount++
  const extracted = boundedHistoryMessageText(message, preview)
  const body = extracted.text || (toolCount ? `(${toolCount} tool calls)` : '(empty)')
  return `[${tag}]\n${body}${extracted.truncated ? '…' : ''}`
}

/** Format the current local transcript for `/history` under deterministic row,
 * per-message, and total-buffer ceilings. Newest rows win when the total pager
 * budget binds; output remains chronological and carries explicit omission
 * notes. `undefined` means there is no committed conversation yet. */
export function formatHistory(messages: readonly Message[], arg: string): string | undefined {
  // Ink's live assistant is outside `historyItems`, so remove OpenTUI's in-store
  // streaming row before applying the shared 800-row retained-history ceiling.
  const committed = messages.filter(message => message.role !== 'assistant' || message.streaming !== true)
  const conversation = committed.filter(message => message.role === 'user' || message.role === 'assistant')
  if (conversation.length === 0) return undefined

  // Ink caps the WHOLE transcript before `/history` filters user/assistant
  // rows, so system/notification rows inside the latest 800 consume slots too.
  const retained = committed
    .slice(-HISTORY_MAX_MESSAGES)
    .filter(message => message.role === 'user' || message.role === 'assistant')
  if (retained.length === 0) return undefined
  const { limited: previewLimited, preview } = requestedHistoryPreview(arg)
  const contentBudget = HISTORY_MAX_PAGER_CHARS - HISTORY_NOTE_RESERVE
  const rowsNewestFirst: string[] = []
  let used = 0

  for (let index = retained.length - 1; index >= 0; index--) {
    const message = retained[index]
    if (!message) continue
    const row = historyRow(message, index, preview)
    const separator = rowsNewestFirst.length === 0 ? 0 : 2
    if (used + separator + row.length > contentBudget) break
    rowsNewestFirst.push(row)
    used += separator + row.length
  }

  const notes: string[] = []
  if (conversation.length > retained.length) {
    notes.push(`history truncated: showing latest ${retained.length} of ${conversation.length} messages`)
  }
  if (previewLimited) notes.push(`preview limited to ${HISTORY_MAX_PREVIEW} characters per message`)
  if (rowsNewestFirst.length < retained.length) {
    notes.push(
      `pager limit: showing latest ${rowsNewestFirst.length} of ${retained.length} retained messages ` +
        `(${HISTORY_MAX_PAGER_CHARS} characters maximum)`
    )
  }

  const header = notes.map(note => `[${note}]`).join('\n')
  const rows = rowsNewestFirst.reverse().join('\n\n')
  return header ? `${header}\n\n${rows}` : rows
}

const historyCmd: ClientHandler = (arg, ctx) => {
  const text = formatHistory(ctx.historyItems(), arg)
  if (!text) {
    ctx.pushSystem('no conversation yet')
    return
  }
  ctx.openPager('History', text)
}

const logsCmd: ClientHandler = (arg, ctx) => {
  const limit = Math.min(80, Math.max(1, Number.parseInt(arg, 10) || 20))
  const text = ctx.logTail(limit).join('\n')
  if (text) ctx.openPager('Logs', text)
  else ctx.pushSystem('no gateway logs')
}

const helpCmd: ClientHandler = async (_arg, ctx, flight) => {
  const show = (catalog: CommandsCatalogResponse | undefined) => ctx.openPager(ctx.helpHeader(), formatHelp(catalog))
  const cached = ctx.commandCatalog()
  if (cached) {
    show(cached)
    return
  }

  const sid = ctx.sessionId()
  try {
    const raw = await ctx.request('commands.catalog', {})
    if (!currentSessionIs(ctx, sid, flight)) return
    const catalog = decodeCommandsCatalogResponse(raw)
    if (catalog) ctx.refreshCommandCatalog(catalog, [])
    show(catalog)
  } catch {
    if (currentSessionIs(ctx, sid, flight)) show(undefined)
  }
}

async function voiceCmd(arg: string, ctx: SlashContext, flight: number): Promise<void> {
  const rawAction = arg.trim().toLowerCase()
  const action = rawAction === 'on' || rawAction === 'off' || rawAction === 'tts' ? rawAction : 'status'
  const sid = ctx.sessionId()
  const raw = await ctx.request('voice.toggle', { action })
  if (!currentSessionIs(ctx, sid, flight)) return
  const response = decodeVoiceToggleResponse(raw)
  if (!response) {
    ctx.pushSystem('error: invalid response: voice.toggle')
    return
  }
  const enabled = response.enabled === true
  const tts = response.tts === true
  const recordKey = response.record_key
  ctx.setVoiceMode({ enabled, tts, ...(recordKey ? { recordKey } : {}) })
  const keyLabel = formatVoiceRecordKey(recordKey ?? 'ctrl+b')

  if (action === 'status') {
    const lines = [
      'Voice Mode Status',
      `  Mode: ${enabled ? 'ON' : 'OFF'}`,
      `  TTS: ${tts ? 'ON' : 'OFF'}`,
      `  Record key: ${keyLabel}`
    ]
    const details = response.details?.trim()
    if (details) lines.push('', 'Requirements', ...details.split('\n').map(line => `  ${line}`))
    ctx.pushSystem(lines.join('\n'))
    return
  }
  if (action === 'tts') {
    ctx.pushSystem(`Voice TTS ${tts ? 'enabled' : 'disabled'}.`)
    return
  }
  if (!enabled) {
    ctx.pushSystem('Voice mode disabled.')
    return
  }
  ctx.pushSystem(`Voice mode enabled${tts ? ' (TTS enabled)' : ''}`)
  ctx.pushSystem(`  Press ${keyLabel} to start/stop recording`)
  ctx.pushSystem('  /voice tts  to toggle speech output')
  ctx.pushSystem('  /voice off  to disable voice mode')
}

async function browserCmd(arg: string, ctx: SlashContext, flight: number): Promise<void> {
  const [rawAction = 'status', ...rest] = arg.trim().split(/\s+/).filter(Boolean)
  const action = rawAction.toLowerCase()
  if (action !== 'connect' && action !== 'disconnect' && action !== 'status') {
    ctx.pushSystem('usage: /browser [connect|disconnect|status] [url] · persistent: set browser.cdp_url in config.yaml')
    return
  }

  const sid = ctx.sessionId()
  const url = action === 'connect' ? rest.join(' ').trim() || 'http://127.0.0.1:9222' : undefined
  if (url) ctx.pushSystem(`checking Chromium-family browser remote debugging at ${url}...`)

  const raw = await ctx.request('browser.manage', {
    action,
    session_id: sid ?? null,
    ...(url ? { url } : {})
  })
  if (!currentSessionIs(ctx, sid, flight)) return
  const response = decodeBrowserManageResponse(raw)
  if (!response) {
    ctx.pushSystem('error: invalid response: browser.manage')
    return
  }

  ctx.setBrowserState(response.connected, response.url)
  if (!sid) response.messages?.forEach(message => ctx.pushSystem(message))

  if (action === 'status') {
    ctx.pushSystem(
      response.connected
        ? `browser connected: ${response.url || '(url unavailable)'}`
        : 'browser not connected (try /browser connect <url> or set browser.cdp_url in config.yaml)'
    )
    return
  }
  if (action === 'disconnect') {
    ctx.pushSystem('browser disconnected')
    return
  }
  if (!response.connected) return
  ctx.pushSystem('Browser connected to live Chromium-family browser via CDP')
  ctx.pushSystem(`Endpoint: ${response.url || '(url unavailable)'}`)
  ctx.pushSystem('next browser tool call will use this CDP endpoint')
}

/** The TUI-only client commands (run in-process, never hit the gateway). */
const CLIENT: Record<string, ClientHandler> = {
  agents: agentsCmd,
  background: backgroundCmd,
  battery: batteryCmd,
  bg: backgroundCmd,
  subscription: subscriptionCmd,
  upgrade: subscriptionCmd,
  browser: browserCmd,
  busy: busyCmd,
  btw: backgroundCmd,
  clear: freshSessionCmd(false),
  compact: compactCmd,
  compress: compressCmd,
  branch: branchCmd,
  fork: branchCmd,
  copy: (arg, ctx) => {
    if (!arg) {
      const selected = ctx.copySelection()
      if (selected) {
        ctx.pushSystem('copied ' + selected.length + ' characters')
        return
      }
    }
    if (arg && Number.isNaN(Number.parseInt(arg, 10))) {
      ctx.pushSystem('usage: /copy [number]')
      return
    }
    const n = Math.max(1, Number.parseInt(arg, 10) || 1)
    if (!ctx.copyResponse(n)) ctx.pushSystem('Nothing to copy yet.')
  },
  detail: detailsCmd,
  details: detailsCmd,
  exit: quitCmd,
  fortune: fortuneCmd,
  fast: fastCmd,
  heapdump: heapdumpCmd,
  mem: memCmd,
  journey: (_arg, ctx) => ctx.openJourney?.(),
  learning: (_arg, ctx) => ctx.openJourney?.(),
  'memory-graph': (_arg, ctx) => ctx.openJourney?.(),
  plugins: pluginsCmd,
  processes: (_arg, ctx) => ctx.openBackgroundPanel(),
  procs: (_arg, ctx) => ctx.openBackgroundPanel(),
  model: modelCmd,
  image: imageCmd,
  paste: pasteCmd,
  personality: personalityCmd,
  pet: petCmd,
  prompt: promptCmd,
  compose: promptCmd,
  reasoning: reasoningCmd,
  reload: reloadCmd,
  'reload-mcp': reloadMcpCmd,
  reload_mcp: reloadMcpCmd,
  'reload-skills': reloadSkillsCmd,
  reload_skills: reloadSkillsCmd,
  rollback: rollbackCmd,
  replay: replayCmd,
  'replay-diff': replayDiffCmd,
  resume: resumeCmd,
  save: saveCmd,
  session: sessionsCmd,
  sessions: sessionsCmd,
  skills: skillsCmd,
  skin: skinCmd,
  switch: sessionsCmd,
  stop: stopCmd,
  tasks: agentsCmd,
  theme: themeCmd,
  timestamps: timestampsCmd,
  topup: topupCmd,
  title: titleCmd,
  ts: timestampsCmd,
  tools: toolsCmd,
  verbose: verboseCmd,
  voice: voiceCmd,
  yolo: yoloCmd,
  status: statusCmd,
  setup: setupCmd,
  'terminal-setup': terminalSetupCmd,
  help: helpCmd,
  history: historyCmd,
  logs: logsCmd,
  new: freshSessionCmd(true),
  quit: quitCmd,
  q: queueCmd,
  queue: queueCmd,
  redraw: redrawCmd,
  retry: retryCmd,
  steer: steerCmd,
  undo: undoCmd,
  usage: usageCmd,
  update: updateCmd
}

/** The registered client-command names (catalog introspection — tests/menus). */
export function clientCommandNames(): string[] {
  const names = Object.keys(CLIENT)
  return (diagnosticsEnabled() ? names : names.filter(n => !DIAGNOSTIC_COMMANDS.has(n))).sort()
}

function handleDispatchResult(parsed: ParsedSlash, raw: unknown, ctx: SlashContext): void {
  const type = readStr(raw, 'type')
  const argTail = parsed.arg ? ` ${parsed.arg}` : ''
  switch (type) {
    case 'exec':
    case 'plugin':
      ctx.pushSystem(readStr(raw, 'output') || '(no output)')
      return
    case 'alias': {
      const target = readStr(raw, 'target')
      if (target) {
        void dispatchSlash(`/${target}${argTail}`, ctx).catch(error => {
          ctx.pushSystem(`/${target}: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      return
    }
    case 'skill': {
      // A skill slash command (e.g. /dogfood): the FULL skill body goes to the
      // model, but render a COLLAPSED `▶ /name · N lines` row instead of dumping
      // the whole body into the transcript (glitch 2026-06-23). The command is
      // the slash invocation as typed, incl. args (`/triage-nous since yesterday`).
      const notice = readStr(raw, 'notice')
      if (notice) ctx.pushSystem(notice)
      const message = readStr(raw, 'message')
      if (message?.trim()) {
        const skillName = readStr(raw, 'name') || parsed.name
        const command = `/${skillName}${argTail}`
        if (ctx.submitSkill(command, message) === false) {
          ctx.prefillComposer(command)
          ctx.pushSystem('skill submission could not be queued — command restored to composer')
        }
      } else ctx.pushSystem(`/${parsed.name}: empty message`)
      return
    }
    case 'send': {
      const notice = readStr(raw, 'notice')
      if (notice) ctx.pushSystem(notice)
      const message = readStr(raw, 'message')
      if (message?.trim()) {
        if (ctx.submit(message) === false) {
          ctx.prefillComposer(message)
          ctx.pushSystem('generated prompt could not be queued — message restored to composer')
        }
      } else ctx.pushSystem(`/${parsed.name}: empty message`)
      return
    }
    case 'prefill': {
      // `/undo N` and extension commands can return editable composer content.
      const notice = readStr(raw, 'notice')
      if (notice) ctx.pushSystem(notice)
      const message = readStr(raw, 'message')
      if (message) ctx.prefillComposer(message)
      else ctx.pushSystem(`/${parsed.name}: nothing to prefill`)
      return
    }
    default:
      ctx.pushSystem(`error: invalid response: command.dispatch`)
  }
}

/** Dispatch a `/command` through the ladder. Returns once the (async) work settles. */
export async function dispatchSlash(input: string, ctx: SlashContext): Promise<void> {
  const parsed = parseSlash(input)
  if (!parsed) return
  const flight = claimSlashFlight(ctx)
  const sid = ctx.sessionId()

  if (DIAGNOSTIC_COMMANDS.has(parsed.name) && !diagnosticsEnabled()) {
    // Not a secret — an enable switch. Tell the user exactly how to get it.
    ctx.pushSystem(`/${parsed.name} is a diagnostic command — relaunch with HERMES_TUI_DIAGNOSTICS=1 to enable it.`)
    return
  }

  // Bare /skills owns the native picker. Explicit subcommands must keep using
  // the persistent slash worker so the picker cannot swallow their output.
  const client = parsed.name === 'skills' && parsed.arg ? undefined : CLIENT[parsed.name]
  if (client) {
    try {
      await client(parsed.arg, ctx, flight)
    } catch (error) {
      if (currentSessionIs(ctx, sid, flight)) {
        ctx.pushSystem(`/${parsed.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return
  }

  try {
    const result = await ctx.request('slash.exec', { command: input.slice(1), session_id: sid })
    if (!currentSessionIs(ctx, sid, flight)) return
    // The server's slash.exec routes _PENDING_INPUT_COMMANDS (goal/queue/steer/
    // retry/plan/undo — server.py:10483) to command.dispatch and returns its
    // result DIRECTLY: a {type: 'send'|'exec'|'prefill'|'alias'|...} payload, NOT
    // a {output} payload. Detect that shape and render it through the same
    // dispatch handler as the command.dispatch fallback (so /goal shows its
    // "Goal set" notice + submits the kickoff, instead of "/goal: no output").
    // readStr → undefined for a normal {output} result (no `type`), so that path
    // is unchanged.
    if (readStr(result, 'type') !== undefined) {
      handleDispatchResult(parsed, result, ctx)
      return
    }
    const output = readStr(result, 'output') || `/${parsed.name}: no output`
    const warning = readStr(result, 'warning')
    const text = warning ? `warning: ${warning}\n${output}` : output
    // Long output → pager (Ink: >180 chars or >2 non-empty lines), else a system line.
    present(ctx, titleCase(parsed.name), text)
  } catch {
    if (!currentSessionIs(ctx, sid, flight)) return
    try {
      const raw = await ctx.request('command.dispatch', { arg: parsed.arg, name: parsed.name, session_id: sid })
      if (!currentSessionIs(ctx, sid, flight)) return
      handleDispatchResult(parsed, raw, ctx)
    } catch (error) {
      if (currentSessionIs(ctx, sid, flight)) {
        ctx.pushSystem(`error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
