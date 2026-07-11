/** Local `/fortune` content and selection — a direct port of Ink's tiny,
 * dependency-free content module. */
const FORTUNES = [
  'you are one clean refactor away from clarity',
  'a tiny rename today prevents a huge bug tomorrow',
  'your next commit message will be immaculate',
  'the edge case you are ignoring is already solved in your head',
  'minimal diff, maximal calm',
  'today favors bold deletions over new abstractions',
  'the right helper is already in your codebase',
  'you will ship before overthinking catches up',
  'tests are about to save your future self',
  'your instincts are correctly suspicious of that one branch'
] as const

const LEGENDARY = [
  'legendary drop: one-line fix, first try',
  'legendary drop: every flaky test passes cleanly',
  'legendary drop: your diff teaches by itself'
] as const

const hash = (text: string): number =>
  [...text].reduce((value, char) => Math.imul(value ^ char.charCodeAt(0), 16777619), 2166136261) >>> 0

export function fortuneFromScore(score: number): string {
  const rare = score % 20 === 0
  const bag = rare ? LEGENDARY : FORTUNES
  return `${rare ? '🌟' : '🔮'} ${bag[score % bag.length]}`
}

export const randomFortune = (): string => fortuneFromScore(Math.floor(Math.random() * 0x7fffffff))

export const dailyFortune = (sessionId: string | undefined, today = new Date()): string =>
  fortuneFromScore(hash(`${sessionId || 'anon'}|${today.toDateString()}`))
