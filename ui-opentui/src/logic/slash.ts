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
import { diagnosticsEnabled } from './env.ts'
import { DETAILS_SECTIONS, DETAILS_USAGE, type DetailsMode, nextDetailsMode, parseDetailsMode } from './details.ts'
import { formatBytes, memReport, performHeapdump } from './diagnostics.ts'
import { formatSpawnTree, formatSpawnTreeList, readSpawnTreeEntries } from './replay.ts'
import { mapSessionRows, parseSessionTabArg, resolveSessionArg, type SessionTabId } from './sessionPicker.ts'
import type { CompletionItem, ConfirmRequest, PickerItem, PickerState } from './store.ts'
import type { BillingOverlayState, BillingStateResponse } from '../boundary/billing.ts'
import {
  type CommandsCatalogResponse,
  type SessionUndoResponse,
  decodeConfigValueResponse,
  decodeCommandsCatalogResponse,
  decodeReloadEnvResponse,
  decodeSessionSaveResponse,
  decodeSessionStatusResponse,
  decodeSessionTitleResponse,
  decodeSessionUndoResponse,
  decodeSkillsReloadResponse
} from '../boundary/schema/SessionCommandResponses.ts'
import { decodeToolsConfigureResponse } from '../boundary/schema/ToolsConfigureResponse.ts'
import { buildBillingCtx } from './billing.ts'
import { dailyFortune, randomFortune } from './fortunes.ts'
import { formatHelp } from './help.ts'
import type { Message } from './store.ts'
import { normalizeBusyInputMode, type BusyInputMode } from './busyQueue.ts'

export interface ParsedSlash {
  name: string
  arg: string
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
  /** Open the agents dashboard (/agents, /tasks). */
  readonly openDashboard: () => void
  /** Open the OS background-process panel (/processes). */
  readonly openBackgroundPanel: () => void
  /** Open the /billing overlay with a fetched state snapshot + ctx bundle. */
  readonly openBilling: (overlay: BillingOverlayState) => void
  /** Track an in-flight background-prompt task id (`/bg` → prompt.background). */
  readonly addBgTask: (id: string) => void
  /** Cached `/model` picker rows (Epic 7 instant open); undefined until prefetched. */
  readonly modelItems: () => PickerItem[] | undefined
  /** Update the cached `/model` picker rows. */
  readonly setModelItems: (items: PickerItem[]) => void
  /** Read / set the compact-transcript display flag (/compact — Epic 3). */
  readonly compact: () => boolean
  readonly setCompact: (on: boolean) => void
  /** Read / set the global tool/reasoning detail mode (/details — Epic 3). */
  readonly details: () => DetailsMode
  readonly setDetails: (mode: DetailsMode) => void
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
  readonly prefillComposer: (text: string) => void
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

/** `/sessions [recent|cron|gateways|all]` — open the tabbed resume picker,
 *  pre-selecting the named tab (shared by /sessions, /switch, /session). */
const sessionsCmd: ClientHandler = (arg, ctx) => {
  const tab = parseSessionTabArg(arg)
  if (!tab) {
    ctx.pushSystem('usage: /sessions [recent|cron|gateways|all]')
    return
  }
  ctx.openSessionPicker(tab)
}

/** `/resume` — bare opens the picker; `/resume <id|name>` keeps the DIRECT
 *  path: resolve the arg against `session.list` (exact id → unique id prefix
 *  → exact/unique title) and hydrate without the overlay. */
const resumeCmd: ClientHandler = async (arg, ctx) => {
  const needle = arg.trim()
  if (!needle) {
    ctx.openSessionPicker('recent')
    return
  }
  try {
    // One bounded page over ALL sources (the gateway deny-lists `tool`) — the
    // direct path targets a known session, not a browse.
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
  const nous: string[] = []
  const rest: string[] = []
  for (const it of items) {
    if (it.unavailable || !it.group || seen.has(it.group)) continue
    seen.add(it.group)
    const identity = [it.group, ...(it.haystacks ?? [])].join(' ').toLowerCase()
    ;(identity.includes('nous') ? nous : rest).push(it.group)
  }
  return [...nous, ...rest]
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

/** Re-fetch `model.options` and update the cached picker rows. Resolves with
 *  the fresh rows (the open picker swaps them in live — Ctrl+R, picker v2.1);
 *  rejections are the CALLER's to handle (background callers fire-and-forget). */
function refreshModelItems(ctx: SlashContext): Promise<PickerItem[]> {
  return ctx.request('model.options', { session_id: ctx.sessionId() }).then(opts => {
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
let activePickerRefresh: (() => Promise<PickerItem[]>) | undefined

/** Register (or clear, with `undefined`) the open picker's catalog re-fetch. */
export function registerPickerRefresh(fn: (() => Promise<PickerItem[]>) | undefined): void {
  activePickerRefresh = fn
}

/** Whether a refresh is registered (the picker's footer hint is gated on it). */
export function canRefreshPicker(): boolean {
  return activePickerRefresh !== undefined
}

/** Run the registered catalog re-fetch; undefined when none is registered. */
export function runPickerRefresh(): Promise<PickerItem[]> | undefined {
  return activePickerRefresh?.()
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
 * entry stashes its in-flight prefetch promise here; a bare `/model` that
 * finds the cache empty AWAITS it (bounded by `waitMs`) and re-checks the
 * cache instead of issuing a second concurrent `model.options` RPC. A hung
 * prefetch only delays the picker by the bound — `/model` then opens via its
 * own fetch as before.
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
function awaitModelPrefetch(sessionId: string | undefined): Promise<void> {
  const pending = modelPrefetch
  if (!pending || pending.sessionId !== sessionId) return Promise.resolve()
  return Promise.race([pending.promise, new Promise(resolve => setTimeout(resolve, pending.waitMs))]).then(
    () => undefined
  )
}

/** Switch the model via the server (shared by `/model <name>` and the picker pick).
 *  A successful switch refreshes the cached rows in the background (fresh ✓). */
async function switchModel(ctx: SlashContext, name: string): Promise<void> {
  try {
    const r = await ctx.request('slash.exec', { command: `model ${name}`, session_id: ctx.sessionId() })
    ctx.pushSystem(readStr(r, 'output') || `→ ${name}`)
    void refreshModelItems(ctx).catch(() => {})
  } catch (error) {
    ctx.pushSystem(`/model ${name}: ${error instanceof Error ? error.message : 'switch failed'}`)
  }
}

/** `/model` — bare opens the model picker; `/model <name>` switches directly.
 *  Opens from the CACHED catalog when present — zero RPCs, same-frame paint
 *  (Epic 7; the catalog is prefetched at bootstrap and refreshed on switch).
 *  An empty cache first awaits the in-flight bootstrap prefetch (bounded) so
 *  an early `/model` never doubles the slow `model.options` RPC. */
const modelCmd: ClientHandler = async (arg, ctx) => {
  if (arg.trim()) {
    await switchModel(ctx, arg.trim())
    return
  }
  const open = (items: PickerItem[]) => {
    // Ctrl+R in the open picker re-fetches the catalog (and re-syncs the cache).
    registerPickerRefresh(() => refreshModelItems(ctx))
    // Provider chip strip (picker v2.2): Nous-first configured-provider tabs.
    registerPickerTabs(buildModelTabs)
    ctx.openPicker({ items, onPick: name => void switchModel(ctx, name), title: 'Switch model' })
  }
  const cached = ctx.modelItems()
  if (cached?.length) {
    open(cached)
    return
  }
  // Cache empty but the bootstrap prefetch may be in flight — await it
  // (bounded) and re-check instead of racing a SECOND model.options RPC.
  await awaitModelPrefetch(ctx.sessionId())
  const prefetched = ctx.modelItems()
  if (prefetched?.length) {
    open(prefetched)
    return
  }
  const items = mapModelOptions(await ctx.request('model.options', { session_id: ctx.sessionId() }))
  // Unavailable hint rows alone are not a usable catalog — keep the notice.
  if (!items.some(i => !i.unavailable)) {
    ctx.pushSystem('No models available (no authenticated providers).')
    return
  }
  ctx.setModelItems(items)
  open(items)
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
 * `/details [hidden|collapsed|expanded|cycle]` — GLOBAL detail mode (per-section
 * overrides deferred; the gateway's arg completion also suggests section names,
 * so those get an honest "not supported yet" notice). Bare `/details` reports the
 * persisted mode (`config.get details_mode`) and syncs the local flag to it; a
 * mode set persists via `config.set` (fire-and-forget, Ink parity).
 */
const detailsCmd: ClientHandler = async (arg, ctx) => {
  const first = arg.trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (!first) {
    try {
      const r = await ctx.request('config.get', { key: 'details_mode' })
      const mode = parseDetailsMode(readStr(r, 'value')) ?? ctx.details()
      ctx.setDetails(mode)
      ctx.pushSystem(`details: ${mode}`)
    } catch {
      ctx.pushSystem(`details: ${ctx.details()}`)
    }
    return
  }
  if ((DETAILS_SECTIONS as readonly string[]).includes(first)) {
    ctx.pushSystem(`per-section detail overrides are not supported in the native engine yet — ${DETAILS_USAGE}`)
    return
  }
  const next = first === 'cycle' || first === 'toggle' ? nextDetailsMode(ctx.details()) : parseDetailsMode(first)
  if (!next) {
    ctx.pushSystem(DETAILS_USAGE)
    return
  }
  ctx.setDetails(next)
  void ctx.request('config.set', { key: 'details_mode', value: next }).catch(() => {})
  ctx.pushSystem(`details: ${next}`)
}

/**
 * `/reasoning [full|clamp]` — expand/collapse ALL thinking ("Thinking"/"Thought")
 * sections, independently of the global /details mode. Mirrors detailsCmd.
 *
 *   - bare `/reasoning`: `config.get {key:'reasoning'}` → read the persisted
 *     `reasoning_full` boolean (added server-side), sync the local flag, and
 *     report `reasoning: full|clamp`. On error, report the current local flag.
 *   - `full` (alias `all`): expand all → local flag on + persist `value:'full'`.
 *   - `clamp` (aliases `collapse`, `short`): collapse all → flag off + `value:'clamp'`.
 *
 * ROUTING DECISION (non-handled args): the server-side `/reasoning` ALSO accepts a
 * reasoning EFFORT (`high`/`medium`/`low`) and visibility (`show`/`hide`). Those are
 * NOT display-expansion concerns, so we do NOT reimplement them here — for any arg
 * other than bare/full/all/clamp/collapse/short we re-dispatch through the gateway
 * via `slash.exec` and surface its `output`. This keeps the client handler tiny
 * while still letting the full server-side `/reasoning` surface work from the TUI.
 */
const reasoningCmd: ClientHandler = async (arg, ctx) => {
  const first = arg.trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (!first) {
    try {
      const r = await ctx.request('config.get', { key: 'reasoning' })
      const full = !!(r && typeof r === 'object' && (r as { [k: string]: unknown }).reasoning_full)
      ctx.setReasoningFull(full)
      ctx.pushSystem(`reasoning: ${full ? 'full' : 'clamp'}`)
    } catch {
      ctx.pushSystem(`reasoning: ${ctx.reasoningFull() ? 'full' : 'clamp'}`)
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
  // Non-handled arg (effort like high/medium/low, or show/hide): re-dispatch to
  // the gateway's full `/reasoning` surface and surface its output.
  try {
    const r = await ctx.request('slash.exec', { command: `reasoning ${first}`, session_id: ctx.sessionId() })
    ctx.pushSystem(readStr(r, 'output') || 'reasoning updated')
  } catch {
    ctx.pushSystem('reasoning: failed to update')
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
const replayCmd: ClientHandler = async (arg, ctx) => {
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

/** `/billing` — fetch the gateway billing state and open the interactive overlay
 *  (buy credits / auto-reload / monthly limit). ZERO sub-commands (CLI/TUI
 *  parity): any arg is ignored. All RPC + error mapping lives in logic/billing.ts
 *  (`buildBillingCtx`); this handler just fetches state and opens. */
const billingCmd: ClientHandler = async (_arg, ctx) => {
  try {
    const s = (await ctx.request('billing.state', {})) as BillingStateResponse
    if (!s.logged_in) {
      ctx.pushSystem('💳 Not logged into Nous Portal — run /portal to log in, then /billing.')
      return
    }
    const billingHost = {
      request: ctx.request,
      pushSystem: ctx.pushSystem,
      confirm: ctx.confirm,
      sessionId: ctx.sessionId
    }
    ctx.openBilling({
      ctx: buildBillingCtx(billingHost, s),
      pendingCharge: null,
      screen: 'overview',
      state: s
    })
  } catch (error) {
    ctx.pushSystem(`/billing: ${error instanceof Error ? error.message : 'billing.state failed'}`)
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
    if (ctx.sessionId() !== sid) return
    ctx.pushSystem(`steer queued — arrives after next tool call: "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`)
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
    ctx.pushSystem(`busy input mode: ${ctx.busyInputMode()}`)
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

/** The TUI-only client commands (run in-process, never hit the gateway). */
const CLIENT: Record<string, ClientHandler> = {
  agents: (_arg, ctx) => ctx.openDashboard(),
  background: backgroundCmd,
  bg: backgroundCmd,
  billing: billingCmd,
  busy: busyCmd,
  btw: backgroundCmd,
  clear: freshSessionCmd(false),
  compact: compactCmd,
  copy: (arg, ctx) => {
    const n = Math.max(1, Number.parseInt(arg, 10) || 1)
    if (!ctx.copyResponse(n)) ctx.pushSystem('Nothing to copy yet.')
  },
  detail: detailsCmd,
  details: detailsCmd,
  exit: quitCmd,
  fortune: fortuneCmd,
  heapdump: heapdumpCmd,
  mem: memCmd,
  processes: (_arg, ctx) => ctx.openBackgroundPanel(),
  procs: (_arg, ctx) => ctx.openBackgroundPanel(),
  model: modelCmd,
  reasoning: reasoningCmd,
  reload: reloadCmd,
  'reload-skills': reloadSkillsCmd,
  reload_skills: reloadSkillsCmd,
  replay: replayCmd,
  resume: resumeCmd,
  save: saveCmd,
  session: sessionsCmd,
  sessions: sessionsCmd,
  skills: skillsCmd,
  skin: skinCmd,
  switch: sessionsCmd,
  tasks: (_arg, ctx) => ctx.openDashboard(),
  timestamps: timestampsCmd,
  title: titleCmd,
  ts: timestampsCmd,
  tools: toolsCmd,
  status: statusCmd,
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

  const client = CLIENT[parsed.name]
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
