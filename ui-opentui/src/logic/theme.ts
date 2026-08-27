/**
 * Theme / skin engine (SOLID side, pure TS — spec v4 §7.5). A faithful 1:1 port
 * of Ink's `ui-tui/src/theme.ts` so EXISTING Hermes skins work UNCHANGED: same
 * `Theme`/`ThemeColors`/`ThemeBrand` shapes, same `DARK_THEME`/`LIGHT_THEME`
 * defaults, same `detectLightMode`, same Apple-Terminal ANSI-256 normalization,
 * and the same `fromSkin(colors, branding, …)` mapping + fallback chains.
 *
 * The view never hardcodes colors — it reads `theme.color.*` / `theme.brand.*`
 * via the ThemeProvider context (view/theme.tsx). The boundary feeds skins in
 * through `gateway.ready{payload.skin}` / `skin.changed` → fromSkin → the theme
 * signal.
 *
 * Source of truth for the contract: ui-tui/src/theme.ts (+ GatewaySkin in
 * ui-tui/src/gatewayTypes.ts). Keep this port in sync if that contract changes.
 *
 * INTENTIONAL divergences from the Ink port (visual-hierarchy design pass):
 *   - `muted` is a true NEUTRAL grey (not a darker gold) and no longer borrows
 *     the skin's `banner_dim` (a banner-gold shade in the stock skin); skins
 *     override it via the dedicated `ui_muted` key instead.
 *   - a `bg` token paints the root canvas (true black/white; `ui_bg` override).
 */

import { FALSE_RE, TRUE_RE } from './env.ts'

export interface ThemeColors {
  primary: string
  accent: string
  border: string
  text: string
  muted: string
  /** Root canvas background. DEFAULT IS `transparent` — the terminal's own
   *  background shows through (glitch rejected a painted "default dark" canvas;
   *  the dark room is the user's terminal, not ours). Skins may opt into a
   *  painted canvas via `ui_bg`. */
  bg: string
  completionBg: string
  completionCurrentBg: string
  completionMetaBg: string
  completionMetaCurrentBg: string

  label: string
  ok: string
  error: string
  warn: string

  /** Tool-call markers (running ⚡ / tool spinner heat). Defaults to `accent`
   *  (theme-sdk `ui_tool`); settled machinery stays `shellDollar` by design. */
  tool: string
  /** Reasoning/thinking body text. Defaults to `muted` (theme-sdk `ui_thinking`). */
  thinking: string

  /** Code-syntax tokens (theme-sdk `syntax_*`). Default to the brand tokens the
   *  native highlighter already used (string→label, number/keyword→accent,
   *  comment→muted) so a skin without them paints unchanged. */
  syntaxString: string
  syntaxNumber: string
  syntaxKeyword: string
  syntaxComment: string

  prompt: string
  sessionLabel: string
  sessionBorder: string

  statusBg: string
  statusFg: string
  statusGood: string
  statusWarn: string
  statusBad: string
  statusCritical: string
  selectionBg: string

  diffAdded: string
  diffRemoved: string
  diffAddedWord: string
  diffRemovedWord: string
  // Line backgrounds for the NATIVE `<diff>` renderable (file-tool renderer).
  // Separate from the Ink-parity diffAdded/diffRemoved pair above: those are
  // `rgb(…)` strings (Ink parses them; OpenTUI's parseColor only takes hex /
  // CSS names / "transparent"), and they're pastel full-line fills tuned for
  // Ink's fg-on-bg rendering — the native diff wants darker hex backgrounds.
  diffAddedBg: string
  diffRemovedBg: string

  shellDollar: string
}

export interface ThemeBrand {
  name: string
  icon: string
  prompt: string
  /** The composer glyph while in `!`-shell mode (defaults to `$`); skin-overridable. */
  shellPrompt?: string
  welcome: string
  goodbye: string
  tool: string
  helpHeader: string
}

export interface Theme {
  color: ThemeColors
  brand: ThemeBrand
  bannerLogo: string
  bannerHero: string
  /** Spinner animation config from the skin (empty = engine defaults). */
  spinner: SpinnerConfig
  /** Per-tool glyph overrides from the skin (tool name → glyph); {} = registry defaults. */
  toolEmojis: Record<string, string>
}

/** The skin payload as emitted by the gateway (mirror ui-tui/src/gatewayTypes.ts GatewaySkin). */
export interface GatewaySkin {
  banner_hero?: string
  banner_logo?: string
  branding?: Record<string, string>
  colors?: Record<string, string>
  /** Paired polarity palettes (theme-sdk): hand-tuned OVERLAYS applied on top of
   *  `colors` when the terminal's detected polarity matches — `light_colors` on
   *  light terminals, `dark_colors` on dark ones (mirror Ink's `themeForSkin`). */
  light_colors?: Record<string, string>
  dark_colors?: Record<string, string>
  help_header?: string
  tool_prefix?: string
  /** Spinner animation data (faces/verbs/wings) — loose; SpinnerConfig narrows it. */
  spinner?: Record<string, unknown>
  /** Per-tool glyph overrides (tool name → emoji/char). */
  tool_emojis?: Record<string, string>
}

/** Normalized spinner animation config the busy indicator consumes. Empty arrays
 *  mean "use the engine defaults" (a skin that ships no spinner block). */
export interface SpinnerConfig {
  waitingFaces: string[]
  thinkingFaces: string[]
  thinkingVerbs: string[]
  /** [left, right] decoration pairs. */
  wings: [string, string][]
}

const EMPTY_SPINNER: SpinnerConfig = { waitingFaces: [], thinkingFaces: [], thinkingVerbs: [], wings: [] }

/** Parse the loose gateway `spinner` record into a typed SpinnerConfig (defensive:
 *  any malformed field → empty, so a bad skin never crashes the spinner). */
export function parseSpinner(raw: Record<string, unknown> | undefined): SpinnerConfig {
  if (!raw || typeof raw !== 'object') return EMPTY_SPINNER
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const wings: [string, string][] = []
  const rawWings = (raw as { wings?: unknown }).wings
  if (Array.isArray(rawWings)) {
    for (const pair of rawWings) {
      if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
        wings.push([pair[0], pair[1]])
      }
    }
  }
  return {
    waitingFaces: strArr((raw as { waiting_faces?: unknown }).waiting_faces),
    thinkingFaces: strArr((raw as { thinking_faces?: unknown }).thinking_faces),
    thinkingVerbs: strArr((raw as { thinking_verbs?: unknown }).thinking_verbs),
    wings
  }
}

// ── Color math ───────────────────────────────────────────────────────

function parseHex(h: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(h)
  const hex = m?.[1]
  if (!hex) return null
  const n = parseInt(hex, 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function mix(a: string, b: string, t: number) {
  const pa = parseHex(a)
  const pb = parseHex(b)
  if (!pa || !pb) return a
  const lerp = (i: 0 | 1 | 2) => Math.round(pa[i] + (pb[i] - pa[i]) * t)
  return '#' + ((1 << 24) | (lerp(0) << 16) | (lerp(1) << 8) | lerp(2)).toString(16).slice(1)
}

const XTERM_6_LEVELS = [0, 95, 135, 175, 215, 255] as const
const ANSI_LIGHT_MAX_LUMINANCE = 0.72
const ANSI_LIGHT_TARGET_LUMINANCE = 0.34
const ANSI_LIGHT_MIN_SATURATION = 0.22
const ANSI_MUTED_BUCKET = 245

const ANSI_NORMALIZED_FOREGROUNDS: readonly (keyof ThemeColors)[] = [
  'text',
  'label',
  'ok',
  'error',
  'warn',
  'prompt',
  'statusFg',
  'statusGood',
  'statusWarn',
  'statusBad',
  'statusCritical',
  'shellDollar',
  'tool'
]

const ANSI_MUTED_FOREGROUNDS: readonly (keyof ThemeColors)[] = ['muted', 'sessionLabel', 'sessionBorder', 'thinking']

function xtermEightBitRgb(colorNumber: number): [number, number, number] {
  if (colorNumber >= 232) {
    const value = 8 + (colorNumber - 232) * 10
    return [value, value, value]
  }
  if (colorNumber >= 16) {
    const offset = colorNumber - 16
    // Indices are `% 6`, always within XTERM_6_LEVELS' bounds; `?? 0` only
    // satisfies noUncheckedIndexedAccess and is never actually reached.
    return [
      XTERM_6_LEVELS[Math.floor(offset / 36) % 6] ?? 0,
      XTERM_6_LEVELS[Math.floor(offset / 6) % 6] ?? 0,
      XTERM_6_LEVELS[offset % 6] ?? 0
    ]
  }
  return [0, 0, 0]
}

function channelLuminance(value: number): number {
  const normalized = value / 255
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(red: number, green: number, blue: number): number {
  return 0.2126 * channelLuminance(red) + 0.7152 * channelLuminance(green) + 0.0722 * channelLuminance(blue)
}

function rgbToHsl(red: number, green: number, blue: number): [number, number, number] {
  const rn = red / 255
  const gn = green / 255
  const bn = blue / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const lightness = (max + min) / 2
  if (max === min) return [0, 0, lightness]
  const delta = max - min
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  const hue =
    max === rn ? (gn - bn) / delta + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / delta + 2 : (rn - gn) / delta + 4
  return [hue / 6, saturation, lightness]
}

function circularDistance(a: number, b: number): number {
  const distance = Math.abs(a - b)
  return Math.min(distance, 1 - distance)
}

// Mirrors @hermes/ink's colorize.ts (kept local, like the Ink app copy).
function richEightBitColorNumber(red: number, green: number, blue: number): number {
  const [, saturation, lightness] = rgbToHsl(red, green, blue)
  if (saturation < 0.15) {
    const gray = Math.round(lightness * 25)
    return gray === 0 ? 16 : gray === 25 ? 231 : 231 + gray
  }
  const sixRed = red < 95 ? red / 95 : 1 + (red - 95) / 40
  const sixGreen = green < 95 ? green / 95 : 1 + (green - 95) / 40
  const sixBlue = blue < 95 ? blue / 95 : 1 + (blue - 95) / 40
  return 16 + 36 * Math.round(sixRed) + 6 * Math.round(sixGreen) + Math.round(sixBlue)
}

function bestReadableAnsiColor(red: number, green: number, blue: number): number {
  const [hue, saturation, lightness] = rgbToHsl(red, green, blue)
  let bestColor = richEightBitColorNumber(red, green, blue)
  let bestScore = Number.POSITIVE_INFINITY
  for (let colorNumber = 16; colorNumber <= 255; colorNumber += 1) {
    const [candidateRed, candidateGreen, candidateBlue] = xtermEightBitRgb(colorNumber)
    const candidateLuminance = relativeLuminance(candidateRed, candidateGreen, candidateBlue)
    if (candidateLuminance > ANSI_LIGHT_MAX_LUMINANCE) continue
    const [candidateHue, candidateSaturation, candidateLightness] = rgbToHsl(
      candidateRed,
      candidateGreen,
      candidateBlue
    )
    const saturationFloorPenalty =
      candidateSaturation < ANSI_LIGHT_MIN_SATURATION ? (ANSI_LIGHT_MIN_SATURATION - candidateSaturation) * 3 : 0
    const score =
      circularDistance(candidateHue, hue) * 4 +
      Math.abs(candidateSaturation - Math.max(ANSI_LIGHT_MIN_SATURATION, saturation)) * 0.8 +
      Math.abs(candidateLightness - Math.min(lightness, ANSI_LIGHT_TARGET_LUMINANCE)) * 2 +
      saturationFloorPenalty
    if (score < bestScore) {
      bestColor = colorNumber
      bestScore = score
    }
  }
  return bestColor
}

function normalizeAnsiForeground(color: string): string {
  const rgb = parseHex(color)
  if (!rgb) return color
  const richAnsi = richEightBitColorNumber(rgb[0], rgb[1], rgb[2])
  const richRgb = xtermEightBitRgb(richAnsi)
  const ansi =
    relativeLuminance(richRgb[0], richRgb[1], richRgb[2]) > ANSI_LIGHT_MAX_LUMINANCE
      ? bestReadableAnsiColor(rgb[0], rgb[1], rgb[2])
      : richAnsi
  return `ansi256(${ansi})`
}

// ── Defaults ─────────────────────────────────────────────────────────

const BRAND: ThemeBrand = {
  name: 'Hermes Agent',
  icon: '⚕',
  prompt: '❯',
  shellPrompt: '$',
  welcome: 'Type your message or /help for commands.',
  goodbye: 'Goodbye! ⚕',
  tool: '┊',
  helpHeader: '(^_^)? Commands'
}

const cleanPromptSymbol = (s: string | undefined, fallback: string) => {
  const cleaned = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}

export const DARK_THEME: Theme = {
  color: {
    primary: '#FFD700',
    accent: '#FFBF00',
    border: '#CD7F32',
    text: '#FFF8DC',
    // TRUE NEUTRAL (design pass precondition): muted was `#CC9B1F` — itself
    // gold — so "dim" read as "darker gold" and the hero color was the
    // wallpaper. Re-pointed to the statusFg `#C0C0C0` (silver) family's darker
    // step, CSS `gray` — no invented hexes. Grey = everything that merely
    // happened; gold stays earned.
    muted: '#808080',
    bg: 'transparent',
    completionBg: '#1a1a2e',
    completionCurrentBg: '#333355',
    completionMetaBg: '#1a1a2e',
    completionMetaCurrentBg: '#333355',

    label: '#DAA520',
    ok: '#4caf50',
    error: '#ef5350',
    warn: '#ffa726',

    // Element tokens default to their semantic parents (tool→accent,
    // thinking→muted); independently settable via ui_tool/ui_thinking.
    tool: '#FFBF00',
    thinking: '#808080',

    // Code-syntax tokens default to what the highlighter already painted
    // (string→label, number/keyword→accent, comment→muted) — see markdown.tsx.
    syntaxString: '#DAA520',
    syntaxNumber: '#FFBF00',
    syntaxKeyword: '#FFBF00',
    syntaxComment: '#808080',

    prompt: '#FFF8DC',
    // session chrome rides the same neutral muted family (was gold #CC9B1F).
    sessionLabel: '#808080',
    sessionBorder: '#808080',

    statusBg: '#1a1a2e',
    statusFg: '#C0C0C0',
    statusGood: '#8FBC8F',
    statusWarn: '#FFD700',
    statusBad: '#FF8C00',
    statusCritical: '#FF6B6B',
    selectionBg: '#3a3a55',

    diffAdded: 'rgb(220,255,220)',
    diffRemoved: 'rgb(255,220,220)',
    diffAddedWord: 'rgb(36,138,61)',
    diffRemovedWord: 'rgb(207,34,46)',
    diffAddedBg: '#1a4d1a',
    diffRemovedBg: '#4d1a1a',
    shellDollar: '#4dabf7'
  },
  brand: BRAND,
  bannerLogo: '',
  bannerHero: '',
  spinner: EMPTY_SPINNER,
  toolEmojis: {}
}

export const LIGHT_THEME: Theme = {
  color: {
    primary: '#8B6914',
    accent: '#A0651C',
    border: '#7A4F1F',
    text: '#3D2F13',
    // same disease as dark: muted was `#7A5A0F` (gold-brown). True neutral —
    // the statusFg `#333333` family's lighter step, CSS `dimgray`.
    muted: '#696969',
    bg: 'transparent',
    completionBg: '#F5F5F5',
    completionCurrentBg: mix('#F5F5F5', '#A0651C', 0.25),
    completionMetaBg: '#F5F5F5',
    completionMetaCurrentBg: mix('#F5F5F5', '#A0651C', 0.25),

    label: '#7A5A0F',
    ok: '#2E7D32',
    error: '#C62828',
    warn: '#E65100',

    tool: '#A0651C',
    thinking: '#696969',

    syntaxString: '#7A5A0F',
    syntaxNumber: '#A0651C',
    syntaxKeyword: '#A0651C',
    syntaxComment: '#696969',

    prompt: '#2B2014',
    sessionLabel: '#696969',
    sessionBorder: '#696969',

    statusBg: '#F5F5F5',
    statusFg: '#333333',
    statusGood: '#2E7D32',
    statusWarn: '#8B6914',
    statusBad: '#D84315',
    statusCritical: '#B71C1C',
    selectionBg: '#D4E4F7',

    diffAdded: 'rgb(200,240,200)',
    diffRemoved: 'rgb(240,200,200)',
    diffAddedWord: 'rgb(27,94,32)',
    diffRemovedWord: 'rgb(183,28,28)',
    diffAddedBg: '#c8f0c8',
    diffRemovedBg: '#f0c8c8',
    shellDollar: '#1565C0'
  },
  brand: BRAND,
  bannerLogo: '',
  bannerHero: '',
  spinner: EMPTY_SPINNER,
  toolEmojis: {}
}

const LIGHT_DEFAULT_TERM_PROGRAMS = new Set<string>(['Apple_Terminal'])

const LUMA_LIGHT_THRESHOLD = 0.6
const HEX_3_RE = /^[0-9a-f]{3}$/
const HEX_6_RE = /^[0-9a-f]{6}$/

function backgroundLuminance(raw: string): null | number {
  const v = raw.trim().toLowerCase()
  if (!v) return null
  const hex = v.startsWith('#') ? v.slice(1) : v
  let rgb: [number, number, number] | null = null
  if (HEX_6_RE.test(hex)) {
    rgb = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
  } else if (HEX_3_RE.test(hex)) {
    // `charAt` always returns a string (vs index access, which is `string |
    // undefined` under noUncheckedIndexedAccess); the regex guarantees 3 chars.
    const r = hex.charAt(0)
    const g = hex.charAt(1)
    const b = hex.charAt(2)
    rgb = [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)]
  }
  if (!rgb) return null
  const [r, g, b] = rgb
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/** Pick light vs dark with ordered, explainable env signals (mirror Ink). */
export function detectLightMode(
  env: Record<string, string | undefined> = process.env,
  lightDefaultTermPrograms: ReadonlySet<string> = LIGHT_DEFAULT_TERM_PROGRAMS
): boolean {
  const lightFlag = (env.HERMES_TUI_LIGHT ?? '').trim().toLowerCase()
  if (TRUE_RE.test(lightFlag)) return true
  if (FALSE_RE.test(lightFlag)) return false

  const themeFlag = (env.HERMES_TUI_THEME ?? '').trim().toLowerCase()
  if (themeFlag === 'light') return true
  if (themeFlag === 'dark') return false

  const bgHint = backgroundLuminance(env.HERMES_TUI_BACKGROUND ?? '')
  if (bgHint !== null) return bgHint >= LUMA_LIGHT_THRESHOLD

  const colorfgbg = (env.COLORFGBG ?? '').trim()
  if (colorfgbg) {
    const lastField = colorfgbg.split(';').at(-1) ?? ''
    if (/^\d+$/.test(lastField)) {
      const bg = Number(lastField)
      if (bg === 7 || bg === 15) return true
      if (bg >= 0 && bg < 16) return false
    }
  }

  const termProgram = (env.TERM_PROGRAM ?? '').trim()
  return lightDefaultTermPrograms.has(termProgram)
}

function shouldNormalizeAnsiLightTheme(
  env: Record<string, string | undefined> = process.env,
  isLight = detectLightMode(env)
): boolean {
  const colorTerm = (env.COLORTERM ?? '').trim().toLowerCase()
  const termProgram = (env.TERM_PROGRAM ?? '').trim()
  return termProgram === 'Apple_Terminal' && colorTerm !== 'truecolor' && colorTerm !== '24bit' && isLight
}

export function normalizeThemeForAnsiLightTerminal(
  theme: Theme,
  env: Record<string, string | undefined> = process.env,
  isLight = detectLightMode(env)
): Theme {
  if (!shouldNormalizeAnsiLightTheme(env, isLight)) return theme
  const color = { ...theme.color }
  for (const key of ANSI_NORMALIZED_FOREGROUNDS) color[key] = normalizeAnsiForeground(color[key])
  for (const key of ANSI_MUTED_FOREGROUNDS) color[key] = `ansi256(${ANSI_MUTED_BUCKET})`
  return { ...theme, color }
}

const DEFAULT_LIGHT_MODE = detectLightMode()

export const DEFAULT_THEME: Theme = normalizeThemeForAnsiLightTerminal(
  DEFAULT_LIGHT_MODE ? LIGHT_THEME : DARK_THEME,
  process.env,
  DEFAULT_LIGHT_MODE
)

// ── Skin → Theme ─────────────────────────────────────────────────────

/**
 * A skin that authors a background owns its polarity (upstream e762ea174):
 * the engine paints the root canvas with it, so paired-palette selection,
 * default fallbacks, and Apple-Terminal ANSI normalization must all follow
 * that canvas rather than the host profile it covers. Host detection still
 * governs skins without a parseable background.
 *
 * This uses the same precedence as the painted `bg` token below: OpenTUI's
 * `ui_bg` is more specific than theme-sdk's cross-surface `background`.
 */
export function skinIsLight(
  colors: Record<string, string>,
  env: Record<string, string | undefined> = process.env
): boolean {
  const authored = backgroundLuminance(colors['ui_bg'] ?? colors['background'] ?? '')

  return authored === null ? detectLightMode(env) : authored >= LUMA_LIGHT_THRESHOLD
}

export function fromSkin(
  colors: Record<string, string>,
  branding: Record<string, string>,
  bannerLogo = '',
  bannerHero = '',
  toolPrefix = '',
  helpHeader = '',
  spinner: Record<string, unknown> | undefined = undefined,
  toolEmojis: Record<string, string> | undefined = undefined
): Theme {
  // Resolve this on every skin application so live skin changes cannot retain
  // either the host's module-load polarity or the previous skin's polarity.
  const isLight = skinIsLight(colors)
  const d = isLight ? LIGHT_THEME : DARK_THEME
  const c = (k: string) => colors[k]
  const hasSkinColors = Object.keys(colors).length > 0

  const accent = c('ui_accent') ?? c('banner_accent') ?? d.color.accent
  const label = c('ui_label') ?? d.color.label
  const bannerAccent = c('banner_accent') ?? c('banner_title') ?? d.color.accent
  // Design pass (Appendix C precondition): `muted` is the transcript's "merely
  // happened" NEUTRAL — it must NOT borrow `banner_dim` (the stock skin's dim
  // GOLD banner shade; the Ink engine still uses it for its banner-tinted dim).
  // Borrowing it re-golded every dim surface in the live app and made the hero
  // color the wallpaper. Skins that want a custom transcript dim ship the
  // dedicated `ui_muted` key; everything else gets the theme's true neutral.
  const muted = c('ui_muted') ?? d.color.muted
  const completionBg = c('completion_menu_bg') ?? d.color.completionBg

  const completionCurrentBg =
    c('completion_menu_current_bg') ??
    (hasSkinColors ? mix(completionBg, bannerAccent, 0.25) : d.color.completionCurrentBg)

  const completionMetaBg = c('completion_menu_meta_bg') ?? completionBg
  const completionMetaCurrentBg = c('completion_menu_meta_current_bg') ?? completionCurrentBg

  return normalizeThemeForAnsiLightTerminal(
    {
      color: {
        primary: c('ui_primary') ?? c('banner_title') ?? d.color.primary,
        accent,
        border: c('ui_border') ?? c('banner_border') ?? d.color.border,
        text: c('ui_text') ?? c('banner_text') ?? d.color.text,
        muted,
        // root canvas — skins may override; the engine's `ui_bg` stays the more
        // specific key, with theme-sdk's cross-surface `background` as the alias
        // (the seed the Ink TUI/desktop paint their canvas from). Default stays
        // `transparent` (the terminal's own background shows through).
        bg: c('ui_bg') ?? c('background') ?? d.color.bg,
        completionBg,
        completionCurrentBg,
        completionMetaBg,
        completionMetaCurrentBg,

        label,
        ok: c('ui_ok') ?? d.color.ok,
        error: c('ui_error') ?? d.color.error,
        warn: c('ui_warn') ?? d.color.warn,

        // Element tokens (theme-sdk): overridable, else their semantic parents.
        // `thinking` tracks the EFFECTIVE muted (ui_muted override included) so
        // recoloring muted carries the reasoning body with it. It deliberately
        // does NOT borrow `banner_dim` (see the muted divergence note above).
        tool: c('ui_tool') ?? accent,
        thinking: c('ui_thinking') ?? muted,

        // Code-syntax tokens (theme-sdk): overridable, else the brand tokens the
        // native highlighter already used — a skin without them paints unchanged.
        syntaxString: c('syntax_string') ?? label,
        syntaxNumber: c('syntax_number') ?? accent,
        syntaxKeyword: c('syntax_keyword') ?? accent,
        syntaxComment: c('syntax_comment') ?? muted,

        prompt: c('prompt') ?? c('banner_text') ?? d.color.prompt,
        sessionLabel: c('session_label') ?? muted,
        sessionBorder: c('session_border') ?? muted,

        statusBg: c('status_bar_bg') ?? d.color.statusBg,
        statusFg: c('status_bar_text') ?? d.color.statusFg,
        statusGood: c('status_bar_good') ?? c('ui_ok') ?? d.color.statusGood,
        statusWarn: c('status_bar_warn') ?? c('ui_warn') ?? d.color.statusWarn,
        statusBad: c('status_bar_bad') ?? d.color.statusBad,
        statusCritical: c('status_bar_critical') ?? d.color.statusCritical,
        selectionBg:
          c('selection_bg') ??
          c('completion_menu_current_bg') ??
          (hasSkinColors ? completionCurrentBg : d.color.selectionBg),

        // Skinnable diffs (theme-sdk `diff_*`): the cross-surface keys land on
        // the Ink-parity tokens AND alias onto the native `<diff>` line
        // backgrounds, where the engine-specific `diff_*_bg` keys stay the more
        // specific override. Word-level foregrounds have no native `<diff>` seam
        // in @opentui/core 0.4.x — carried on the theme for the seams that do.
        diffAdded: c('diff_added') ?? d.color.diffAdded,
        diffRemoved: c('diff_removed') ?? d.color.diffRemoved,
        diffAddedWord: c('diff_added_word') ?? d.color.diffAddedWord,
        diffRemovedWord: c('diff_removed_word') ?? d.color.diffRemovedWord,
        diffAddedBg: c('diff_added_bg') ?? c('diff_added') ?? d.color.diffAddedBg,
        diffRemovedBg: c('diff_removed_bg') ?? c('diff_removed') ?? d.color.diffRemovedBg,
        shellDollar: c('shell_dollar') ?? d.color.shellDollar
      },

      brand: {
        name: branding.agent_name ?? d.brand.name,
        icon: d.brand.icon,
        prompt: cleanPromptSymbol(branding.prompt_symbol, d.brand.prompt),
        welcome: branding.welcome ?? d.brand.welcome,
        goodbye: branding.goodbye ?? d.brand.goodbye,
        tool: toolPrefix || d.brand.tool,
        helpHeader: branding.help_header ?? (helpHeader || d.brand.helpHeader)
      },

      bannerLogo,
      bannerHero,
      spinner: parseSpinner(spinner),
      toolEmojis: toolEmojis ?? {}
    },
    process.env,
    isLight
  )
}

/**
 * Polarity overlay (theme-sdk paired palettes; mirrors Ink's `themeForSkin`):
 * the matching hand-tuned block OVERLAYS the base palette, it doesn't replace
 * it — a skin can ship a fills-only `light_colors` while its foregrounds keep
 * coming from `colors`. A full paired block still works — it just overrides
 * every key it lists. Pure so the selection rule is unit-testable.
 */
export function skinColorsForPolarity(skin: GatewaySkin, isLight: boolean): Record<string, string> {
  const base = skin.colors ?? {}
  const paired = isLight ? skin.light_colors : skin.dark_colors
  return paired && Object.keys(paired).length > 0 ? { ...base, ...paired } : base
}

/** Convenience: map a GatewaySkin payload straight to a Theme (defaults if empty). */
export function themeFromSkin(skin: GatewaySkin | undefined): Theme {
  if (!skin) return DEFAULT_THEME
  // Resolve polarity from the base palette before choosing its paired overlay;
  // an authored canvas wins, while a background-less skin keeps host behavior.
  return fromSkin(
    skinColorsForPolarity(skin, skinIsLight(skin.colors ?? {})),
    skin.branding ?? {},
    skin.banner_logo ?? '',
    skin.banner_hero ?? '',
    skin.tool_prefix ?? '',
    skin.help_header ?? '',
    skin.spinner,
    skin.tool_emojis
  )
}
