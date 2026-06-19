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
import type { CompletionItem, PickerItem, PickerState } from './store.ts'
import type { BillingOverlayState, BillingStateResponse } from '../boundary/billing.ts'
import { buildBillingCtx } from './billing.ts'

export interface ParsedSlash {
  name: string
  arg: string
}

/** Parse `/name rest…` → {name, arg}; null if not a slash command. */
export function parseSlash(input: string): ParsedSlash | null {
  if (!input.startsWith('/')) return null
  const body = input.slice(1).trimStart()
  if (!body) return null
  const sp = body.indexOf(' ')
  return sp === -1 ? { arg: '', name: body } : { arg: body.slice(sp + 1).trim(), name: body.slice(0, sp) }
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
  readonly pushSystem: (text: string) => void
  /** Open the full-screen pager (long output: /status, /logs, …). */
  readonly openPager: (title: string, text: string) => void
  /** Submit a user turn (skill/send dispatch results). */
  readonly submit: (text: string) => void
  /** Open a local Y/N confirm; `onConfirm` runs on Yes. */
  readonly confirm: (message: string, onConfirm: () => void) => void
  readonly clearTranscript: () => void
  /** Copy the n-th newest assistant response to the clipboard; returns whether something was copied. */
  readonly copyResponse: (n: number) => boolean
  readonly quit: () => void
  /** Recent log lines for `/logs` (the ring buffer). */
  readonly logTail: () => string[]
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

/** Extract `{text}` items from a `commands.catalog` result ({pairs:[["/name",
 *  "desc"],…]}) for seeding the composer's slash-highlight catalog at boot
 *  (glitch 2026-06-14). Each pair's first element is the `/name`; non-string or
 *  empty entries are skipped. Shape-defensive — any junk → []. */
export function catalogCommandItems(result: unknown): { text: string }[] {
  if (!result || typeof result !== 'object') return []
  const pairs = (result as { pairs?: unknown }).pairs
  if (!Array.isArray(pairs)) return []
  const out: { text: string }[] = []
  for (const pair of pairs as unknown[]) {
    const name = Array.isArray(pair) ? (pair as unknown[])[0] : undefined
    if (typeof name === 'string' && name) out.push({ text: name })
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

const CLIENT_HELP_LINES = [
  '/help — list commands',
  '/model [name] — switch model (picker if bare)',
  '/copy [n] — copy the last (or n-th) response',
  '/skills — browse skills',
  '/skin [name] — switch theme skin (live)',
  '/sessions [cron|gateways|all] — browse/resume sessions (tabbed picker)',
  '/resume [id|name] — resume directly, or open the picker',
  '/clear, /new — clear the transcript (confirm)',
  '/compact [on|off|toggle] — compact transcript spacing',
  '/details [hidden|collapsed|expanded|cycle] — tool/reasoning detail',
  '/bg <prompt> — launch a background prompt',
  '/processes — OS background processes (list + stop all)',
  '/replay [n|path] — inspect an archived spawn tree',
  '/mem — live memory stats (diag)',
  '/heapdump — write a V8 heap snapshot (diag)',
  '/logs — recent engine log lines',
  '/quit, /exit — quit',
  '(other /commands run on the gateway)'
]

function clientHelp(): string {
  const lines = diagnosticsEnabled() ? CLIENT_HELP_LINES : CLIENT_HELP_LINES.filter(l => !l.includes('(diag)'))
  return lines.join('\n')
}

type ClientHandler = (arg: string, ctx: SlashContext) => void | Promise<void>

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
let modelPrefetch: { promise: Promise<unknown>; waitMs: number } | undefined

/** Register (or clear, with `undefined`) the in-flight bootstrap prefetch. */
export function registerModelPrefetch(promise: Promise<unknown> | undefined, waitMs = 2000): void {
  modelPrefetch = promise ? { promise, waitMs } : undefined
}

/** Await the registered prefetch (bounded); resolves immediately when none. */
function awaitModelPrefetch(): Promise<void> {
  const pending = modelPrefetch
  if (!pending) return Promise.resolve()
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
  await awaitModelPrefetch()
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

/** `/tools` — fetch the tool roster from the gateway and show it in the pager (navigable). */
const toolsCmd: ClientHandler = async (arg, ctx) => {
  const command = arg.trim() ? `tools ${arg.trim()}` : 'tools'
  try {
    const r = await ctx.request('slash.exec', { command, session_id: ctx.sessionId() })
    ctx.openPager('Tools', readStr(r, 'output') || '(no tool info)')
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

/** The TUI-only client commands (run in-process, never hit the gateway). */
const CLIENT: Record<string, ClientHandler> = {
  agents: (_arg, ctx) => ctx.openDashboard(),
  background: backgroundCmd,
  bg: backgroundCmd,
  billing: billingCmd,
  btw: backgroundCmd,
  clear: (_arg, ctx) => ctx.confirm('Clear the transcript?', ctx.clearTranscript),
  compact: compactCmd,
  copy: (arg, ctx) => {
    const n = Math.max(1, Number.parseInt(arg, 10) || 1)
    if (!ctx.copyResponse(n)) ctx.pushSystem('Nothing to copy yet.')
  },
  detail: detailsCmd,
  details: detailsCmd,
  exit: (_arg, ctx) => ctx.quit(),
  heapdump: heapdumpCmd,
  mem: memCmd,
  processes: (_arg, ctx) => ctx.openBackgroundPanel(),
  procs: (_arg, ctx) => ctx.openBackgroundPanel(),
  model: modelCmd,
  replay: replayCmd,
  resume: resumeCmd,
  session: sessionsCmd,
  sessions: sessionsCmd,
  skills: skillsCmd,
  skin: skinCmd,
  switch: sessionsCmd,
  tasks: (_arg, ctx) => ctx.openDashboard(),
  tools: toolsCmd,
  help: async (_arg, ctx) => {
    // Prefer the live catalog; fall back to the client list if it's unavailable.
    try {
      const cat = await ctx.request('commands.catalog', {})
      ctx.pushSystem(renderCatalog(cat) || clientHelp())
    } catch {
      ctx.pushSystem(clientHelp())
    }
  },
  logs: (_arg, ctx) => ctx.openPager('Logs', ctx.logTail().join('\n') || '(log empty)'),
  new: (_arg, ctx) => ctx.confirm('Start fresh? (clears the transcript)', ctx.clearTranscript),
  quit: (_arg, ctx) => ctx.quit()
}

/** The registered client-command names (catalog introspection — tests/menus). */
export function clientCommandNames(): string[] {
  const names = Object.keys(CLIENT)
  return (diagnosticsEnabled() ? names : names.filter(n => !DIAGNOSTIC_COMMANDS.has(n))).sort()
}

/** Render the gateway `commands.catalog` into a help block (loose-typed read).
 *  The TUI catalog shape is `{ pairs: [["/name","desc"], …], canon, categories }`
 *  (tui_gateway/server.py `commands.catalog`). */
function renderCatalog(cat: unknown): string {
  if (!cat || typeof cat !== 'object') return ''
  const pairs = (cat as { pairs?: unknown }).pairs
  if (!Array.isArray(pairs)) return ''
  const lines = pairs
    .map(pair => {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string') return null
      const desc = typeof pair[1] === 'string' ? pair[1] : ''
      return desc ? `${pair[0]} — ${desc}` : pair[0]
    })
    .filter((l): l is string => l !== null)
  return lines.length ? lines.join('\n') : ''
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
      if (target) void dispatchSlash(`/${target}${argTail}`, ctx)
      return
    }
    case 'skill':
    case 'send': {
      const notice = readStr(raw, 'notice')
      if (notice) ctx.pushSystem(notice)
      const message = readStr(raw, 'message')
      if (message?.trim()) ctx.submit(message)
      else ctx.pushSystem(`/${parsed.name}: empty message`)
      return
    }
    case 'prefill': {
      // /undo etc. — composer prefill lands with the composer-ref plumbing; show it for now.
      const message = readStr(raw, 'message')
      ctx.pushSystem(message ? `(edit & resubmit) ${message}` : `/${parsed.name}: nothing to prefill`)
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

  if (DIAGNOSTIC_COMMANDS.has(parsed.name) && !diagnosticsEnabled()) {
    // Not a secret — an enable switch. Tell the user exactly how to get it.
    ctx.pushSystem(`/${parsed.name} is a diagnostic command — relaunch with HERMES_TUI_DIAGNOSTICS=1 to enable it.`)
    return
  }

  const client = CLIENT[parsed.name]
  if (client) {
    await client(parsed.arg, ctx)
    return
  }

  const sid = ctx.sessionId()
  try {
    const result = await ctx.request('slash.exec', { command: input.slice(1), session_id: sid })
    const output = readStr(result, 'output') || `/${parsed.name}: no output`
    const warning = readStr(result, 'warning')
    const text = warning ? `warning: ${warning}\n${output}` : output
    // Long output → pager (Ink: >180 chars or >2 non-empty lines), else a system line.
    present(ctx, titleCase(parsed.name), text)
  } catch {
    try {
      const raw = await ctx.request('command.dispatch', { arg: parsed.arg, name: parsed.name, session_id: sid })
      handleDispatchResult(parsed, raw, ctx)
    } catch (error) {
      ctx.pushSystem(`error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
