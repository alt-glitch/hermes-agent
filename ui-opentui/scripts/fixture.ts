/**
 * DEV BENCH FIXTURE — NOT a test, NOT production code. A deterministic generator
 * for a REALISTIC heavy session, consumed by `scripts/mem-bench.tsx`. Excluded
 * from the vitest run (not a *.test.ts) and lint-clean.
 *
 * The old synthetic bench pushed tiny 3-delta turns (~5.5 mounted nodes each) —
 * an unrealistic per-message cost. Real transcripts are LUMPY: an assistant turn
 * is ONE `message` but a fat node subtree (markdown blocks + a reasoning block +
 * several tool headers, each a multi-line result). That makes message-count a
 * LOOSE proxy for memory, which is exactly what we're trying to quantify before
 * picking a `HERMES_TUI_MAX_MESSAGES` default.
 *
 * Design: a turn is modeled as a small typed `TurnAction` union (user / system /
 * gateway-event). The driver maps user→`pushUser`, system→`pushSystem`, and every
 * gateway event through the SAME `apply()` reducer real usage takes — so the
 * mounted result is identical to a live session. The same action stream also
 * materializes a settled `Message[]` (via `materialize`) for the resume-path check
 * (`commitSnapshot`). Everything is seeded by index (no `Math.random` —
 * unavailable here), so a given `total` reproduces byte-for-byte.
 */
import type { GatewayEvent } from '../src/boundary/schema/GatewayEvent.ts'
import { createSessionStore, type Message } from '../src/logic/store.ts'

/** One scripted action in a turn: a composer push or a decoded gateway event. */
type TurnAction =
  | { kind: 'user'; text: string }
  | { kind: 'system'; text: string }
  | { kind: 'event'; event: GatewayEvent }

/** A pool of lorem-ipsum words — varied content is selected by index from here. */
const WORDS = [
  'lorem',
  'ipsum',
  'dolor',
  'sit',
  'amet',
  'consectetur',
  'adipiscing',
  'elit',
  'sed',
  'eiusmod',
  'tempor',
  'incididunt',
  'labore',
  'magna',
  'aliqua',
  'enim',
  'minim',
  'veniam',
  'quis',
  'nostrud',
  'exercitation',
  'ullamco',
  'laboris',
  'aliquip',
  'commodo',
  'consequat',
  'duis',
  'aute',
  'irure',
  'reprehenderit',
  'voluptate',
  'velit',
  'esse',
  'cillum',
  'fugiat',
  'nulla',
  'pariatur',
  'excepteur',
  'occaecat',
  'cupidatat',
  'proident',
  'sunt',
  'culpa',
  'officia',
  'deserunt',
  'mollit',
  'anim'
] as const

/** Deterministic pseudo-word stream: pick from WORDS by a seeded index. */
function word(seed: number, k: number): string {
  return WORDS[(seed * 31 + k * 7) % WORDS.length] ?? 'lorem'
}

/** A lorem sentence of `n` words, capitalized + terminated. */
function sentence(seed: number, n: number): string {
  const parts: string[] = []
  for (let k = 0; k < n; k++) parts.push(word(seed + k, k))
  const text = parts.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1) + '.'
}

/** A paragraph of `s` sentences (varying length by index). */
function paragraph(seed: number, s: number): string {
  const out: string[] = []
  for (let i = 0; i < s; i++) out.push(sentence(seed + i * 13, 6 + ((seed + i) % 9)))
  return out.join(' ')
}

/** N lorem-ipsum lines (for tool result bodies), each varying in length. */
function lines(seed: number, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(sentence(seed + i * 5, 4 + ((seed + i) % 11)))
  return out.join('\n')
}

/** A markdown assistant body: paragraphs + a list + a fenced code block. */
function assistantMarkdown(seed: number): string {
  const lead = paragraph(seed, 1 + (seed % 3))
  const bullets = [`- ${sentence(seed + 1, 5)}`, `- ${sentence(seed + 2, 7)}`, `- ${sentence(seed + 3, 4)}`].join('\n')
  const code = [
    '```ts',
    `const x${seed % 7} = ${seed % 100}`,
    `function f${seed % 5}() {`,
    '  return x',
    '}',
    '```'
  ].join('\n')
  const tail = paragraph(seed + 17, 1 + ((seed + 1) % 2))
  return `${lead}\n\n${bullets}\n\n${code}\n\n${tail}`
}

/** Tool names cycled by index (mirrors a real tool mix). */
const TOOL_NAMES = ['terminal', 'read_file', 'edit_file', 'grep', 'web_search', 'write_file'] as const

/** A tool.start + tool.complete pair for tool `t` in turn `seed`. */
function toolEvents(seed: number, t: number): GatewayEvent[] {
  const id = `tool-${seed}-${t}`
  const name = TOOL_NAMES[(seed + t) % TOOL_NAMES.length] ?? 'terminal'
  const variant = (seed + t) % 3
  // short / capped-16-line / medium result bodies, mixing the render-cost cases.
  // BENCH KNOB: HERMES_BENCH_TOOL_BODY_LINES overrides the body size to N lines
  // for ALL tools — the "fat tool output" fixture (e.g. a `find /` dump) used to
  // make W3's retention win measurable. UNSET = the original tiny bodies (so the
  // default fixture stays byte-identical; existing benches are unaffected).
  const fatLines = Number.parseInt(process.env.HERMES_BENCH_TOOL_BODY_LINES ?? '', 10)
  const bodyLines = Number.isFinite(fatLines) && fatLines > 0 ? fatLines : variant === 0 ? 2 : variant === 1 ? 18 : 7
  const resultText = lines(seed + t * 3, bodyLines)
  const context = sentence(seed + t, 4)
  // ~half the tools carry a multi-line args block (the expanded-view cost).
  const withArgs = (seed + t) % 2 === 0
  const start: GatewayEvent = {
    type: 'tool.start',
    payload: withArgs ? { tool_id: id, name, context, args_text: lines(seed + t, 5) } : { tool_id: id, name, context }
  }
  const complete: GatewayEvent = {
    type: 'tool.complete',
    payload: {
      tool_id: id,
      name,
      result_text: resultText,
      duration_s: 0.1 + ((seed + t) % 40) / 10,
      args: { command: context, index: seed + t }
    }
  }
  return [start, complete]
}

/** One USER message (1–4 lorem paragraphs; some very short, some RFC-sized). */
function userText(seed: number): string {
  const shape = seed % 7
  if (shape === 0) return 'yes do that'
  if (shape === 1) return 'ok'
  if (shape === 6) {
    // an RFC-sized pasted block: many paragraphs.
    const out: string[] = []
    for (let p = 0; p < 8; p++) out.push(paragraph(seed + p * 23, 4 + (p % 3)))
    return out.join('\n\n')
  }
  const n = 1 + (seed % 4)
  const out: string[] = []
  for (let p = 0; p < n; p++) out.push(paragraph(seed + p * 11, 1 + ((seed + p) % 3)))
  return out.join('\n\n')
}

/**
 * Build the scripted actions for ONE turn. Most turns are a plain user+assistant
 * exchange; a deterministic subset are tool-heavy (1–15 tool calls) or a system
 * slash-output line. Returns the actions for the whole turn in order.
 */
function turnActions(turn: number): TurnAction[] {
  const actions: TurnAction[] = []
  // Occasional system slash-output line (≈ every 9th turn) instead of a user line.
  if (turn % 9 === 4) {
    actions.push({ kind: 'system', text: sentence(turn, 8) })
    return actions
  }

  actions.push({ kind: 'user', text: userText(turn) })
  actions.push({ kind: 'event', event: { type: 'message.start' } })

  // Reasoning on ≈ every 3rd assistant turn.
  if (turn % 3 === 0) {
    actions.push({
      kind: 'event',
      event: {
        type: 'reasoning.delta',
        payload: { text: `**${sentence(turn, 3).replace(/\.$/, '')}**\n\n${paragraph(turn + 5, 2)}` }
      }
    })
  }

  // Leading text part.
  actions.push({ kind: 'event', event: { type: 'message.delta', payload: { text: assistantMarkdown(turn) } } })

  // Tool-heavy turns: ≈ every 4th assistant turn carries several tool calls,
  // interleaved with a follow-up text part (the fat-turn stress case).
  if (turn % 4 === 0) {
    const toolCount = 1 + (turn % 15) // 1..15 tools
    for (let t = 0; t < toolCount; t++) {
      for (const ev of toolEvents(turn, t)) actions.push({ kind: 'event', event: ev })
    }
    actions.push({ kind: 'event', event: { type: 'message.delta', payload: { text: paragraph(turn + 31, 2) } } })
  }

  actions.push({ kind: 'event', event: { type: 'message.complete' } })
  return actions
}

/** How many transcript ROWS a turn produces (user/system + at most one assistant). */
export function rowsPerTurn(turn: number): number {
  return turn % 9 === 4 ? 1 : 2
}

/** Apply ONE turn's actions to a store via the same paths real usage takes. */
export function applyTurn(store: ReturnType<typeof createSessionStore>, turn: number): void {
  for (const action of turnActions(turn)) {
    if (action.kind === 'user') store.pushUser(action.text)
    else if (action.kind === 'system') store.pushSystem(action.text)
    else store.apply(action.event)
  }
}

/**
 * Drive at least `total` MESSAGES into the live store, calling `onSample(pushes)`
 * each time the cumulative produced-row count crosses a `sampleEvery` boundary.
 * `pushes` counts MESSAGES (rows produced, pre-cap), so the matrix samples on a
 * raw message cadence regardless of the rolling cap.
 */
export function drive(
  store: ReturnType<typeof createSessionStore>,
  total: number,
  sampleEvery: number,
  onSample: (pushes: number) => void
): number {
  let pushed = 0
  let nextSample = sampleEvery
  let turn = 0
  while (pushed < total) {
    applyTurn(store, turn)
    pushed += rowsPerTurn(turn)
    turn++
    while (pushed >= nextSample && nextSample <= total) {
      onSample(Math.min(pushed, total))
      nextSample += sampleEvery
    }
  }
  return turn
}

/**
 * Materialize the FULL settled `Message[]` for the resume path: replay the same
 * action stream into a FRESH, EFFECTIVELY-UNCAPPED store and snapshot its rows.
 * This guarantees the resume fixture is byte-identical to what the live push
 * path produces (minus the rolling cap), so `commitSnapshot` mounts the real shape.
 * `turnOffset` creates a deterministic but distinct session for warm-switch
 * measurements, avoiding an unrealistically identical old/new transcript.
 */
export function materialize(total: number, turnOffset = 0): Message[] {
  // `uncappedFixture` bypasses the store's handle-safe cap CLAMP (an env value
  // can no longer raise the cap past logic/store.ts HANDLE_SAFE_MAX_ROWS — the
  // old env=MAX_SAFE_INTEGER trick would now silently truncate to 1000 rows).
  // This store is never mounted into a renderer, so no native handles are at stake.
  const store = createSessionStore({ uncappedFixture: true })
  store.apply({ type: 'gateway.ready' })
  let pushed = 0
  let turn = 0
  while (pushed < total) {
    const fixtureTurn = turn + turnOffset
    applyTurn(store, fixtureTurn)
    pushed += rowsPerTurn(fixtureTurn)
    turn++
  }
  // Deep-copy out of the solid store proxy into plain objects (the resume path
  // takes a plain Message[]).
  return store.state.messages.slice(0, total).map(cloneMessage)
}

/** Plain deep copy of a store Message (drop the solid proxy + streaming flag). */
function cloneMessage(m: Message): Message {
  const copy: Message = { role: m.role, text: m.text }
  if (m.parts) copy.parts = m.parts.map(p => ({ ...p }))
  return copy
}
