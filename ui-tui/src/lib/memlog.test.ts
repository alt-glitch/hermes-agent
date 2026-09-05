import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startMemlog } from './memlog.js'

const ENV_KEYS = ['HERMES_TUI_MEMLOG', 'HERMES_TUI_DIAGNOSTICS', 'HERMES_HOME'] as const

const memwatch = (home: string) => join(home, 'logs', 'memwatch')

describe('startMemlog (Ink 1Hz memory trace, OpenTUI-compatible)', () => {
  let saved: Record<string, string | undefined>
  let home: string

  beforeEach(() => {
    saved = {}

    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }

    home = mkdtempSync(join(tmpdir(), 'hermes-memlog-test-'))
    process.env.HERMES_HOME = home
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()

    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = saved[k]
      }
    }

    rmSync(home, { force: true, recursive: true })
  })

  it('is a no-op (writes nothing) when neither flag is set', () => {
    const stop = startMemlog()
    vi.advanceTimersByTime(3000)
    stop()
    // dir is never even created
    expect(() => readdirSync(memwatch(home))).toThrow()
  })

  it('writes a 1Hz trace when HERMES_TUI_MEMLOG=1', () => {
    process.env.HERMES_TUI_MEMLOG = '1'
    const stop = startMemlog()
    vi.advanceTimersByTime(3000)
    stop()

    const files = readdirSync(memwatch(home)).filter(f => f.endsWith('.jsonl'))
    expect(files.length).toBe(1)
    // filename scheme: <boot15>-<pid>.jsonl, identical to OpenTUI's
    // (new Date().toISOString() with :/. stripped, sliced to 15 chars →
    //  "2026-06-15T0914"), so memwatch-report.mjs reads both engines.
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{4}-\d+\.jsonl$/)

    const lines = readFileSync(join(memwatch(home), files[0]), 'utf8')
      .trim()
      .split('\n')

    expect(lines.length).toBe(3) // one per second
  })

  it('emits the OpenTUI-compatible rss/heap/external schema (no mounted on Ink)', () => {
    process.env.HERMES_TUI_MEMLOG = '1'
    const stop = startMemlog()
    vi.advanceTimersByTime(1000)
    stop()

    const files = readdirSync(memwatch(home)).filter(f => f.endsWith('.jsonl'))
    const sample = JSON.parse(readFileSync(join(memwatch(home), files[0]), 'utf8').trim())
    expect(sample).toHaveProperty('t')
    expect(sample).toHaveProperty('rss_kb')
    expect(sample).toHaveProperty('heap_used_kb')
    expect(sample).toHaveProperty('external_kb')
    expect(typeof sample.rss_kb).toBe('number')
    // Ink has no windowing — these OpenTUI-only fields must NOT appear
    expect(sample).not.toHaveProperty('mounted')
    expect(sample).not.toHaveProperty('peak_mounted')
  })

  it('defaults to the HERMES_TUI_DIAGNOSTICS master switch', () => {
    process.env.HERMES_TUI_DIAGNOSTICS = '1'
    const stop = startMemlog()
    vi.advanceTimersByTime(1000)
    stop()
    expect(readdirSync(memwatch(home)).filter(f => f.endsWith('.jsonl')).length).toBe(1)
  })

  it('lets HERMES_TUI_MEMLOG=0 override the master switch (off)', () => {
    process.env.HERMES_TUI_DIAGNOSTICS = '1'
    process.env.HERMES_TUI_MEMLOG = '0'
    const stop = startMemlog()
    vi.advanceTimersByTime(2000)
    stop()
    expect(() => readdirSync(memwatch(home))).toThrow()
  })

  it('prunes traces older than 14 days at start (keeps recent)', () => {
    const dir = memwatch(home)
    // seed an old + a fresh trace before enabling
    process.env.HERMES_TUI_MEMLOG = '1'
    // create the dir via a first run, then stop
    const warm = startMemlog()
    vi.advanceTimersByTime(1000)
    warm()

    const old = join(dir, '20000101T000000-99999.jsonl')
    const fresh = join(dir, '20991231T235959-88888.jsonl')
    writeFileSync(old, '{}\n')
    writeFileSync(fresh, '{}\n')
    const ancient = Date.now() / 1000 - 30 * 24 * 3600
    utimesSync(old, ancient, ancient)

    // a fresh start triggers pruneOld()
    const stop = startMemlog()
    vi.advanceTimersByTime(1000)
    stop()

    const remaining = readdirSync(dir)
    expect(remaining).not.toContain('20000101T000000-99999.jsonl')
    expect(remaining).toContain('20991231T235959-88888.jsonl')
  })

  it('silently disables on a write failure (never throws, never retries forever)', () => {
    process.env.HERMES_TUI_MEMLOG = '1'
    const stop = startMemlog()
    // first sample writes fine
    vi.advanceTimersByTime(1000)
    // now make appendFileSync blow up — the collector must clearInterval, not throw
    const fs = require('node:fs')

    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw new Error('disk full')
    })

    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    // interval cleared: further ticks do nothing even after restoring fs
    spy.mockRestore()
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
    stop()
  })
})
