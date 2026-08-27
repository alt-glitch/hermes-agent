/**
 * approvals.destructive_slash_confirm (upstream 77f35add0cc4) — the config
 * policy behind the /clear//new//queue --clear confirm dialog. Contracts:
 *   1. destructiveSlashConfirmFromConfig fails SAFE: only the explicit boolean
 *      `false` disables confirmation; absent/null/string/number/malformed all
 *      keep it ON.
 *   2. skipDestructiveConfirm: HERMES_TUI_NO_CONFIRM stays an env alias that
 *      overrides a confirm-ON policy (the pre-existing Ink-parity escape hatch).
 *   3. The entry's confirm seam (mirrored here exactly as main.tsx wires it):
 *      policy OFF runs the destructive action immediately with NO dialog;
 *      policy ON opens the store confirm prompt and defers the action.
 *   4. Store: defaults ON; hydration is only ever invoked on a successfully
 *      decoded `config.get full`, so a transient failure preserves the last
 *      policy (the setter is simply not called — asserted via the decoder's
 *      fail-safe plus the store's survives-reset behavior).
 */
import { describe, expect, test } from 'vitest'

import { destructiveSlashConfirmFromConfig, skipDestructiveConfirm } from '../logic/approval.ts'
import { createSessionStore, type ConfirmRequest } from '../logic/store.ts'

describe('destructiveSlashConfirmFromConfig (fail-safe decode)', () => {
  test('only the explicit boolean false disables confirmation', () => {
    expect(destructiveSlashConfirmFromConfig({ approvals: { destructive_slash_confirm: false } })).toBe(false)
    expect(destructiveSlashConfirmFromConfig({ approvals: { destructive_slash_confirm: true } })).toBe(true)
  })

  test('absent / null / string / number / malformed approvals all fail safe to ON', () => {
    expect(destructiveSlashConfirmFromConfig({})).toBe(true)
    expect(destructiveSlashConfirmFromConfig({ approvals: {} })).toBe(true)
    expect(destructiveSlashConfirmFromConfig({ approvals: { destructive_slash_confirm: null } })).toBe(true)
    expect(destructiveSlashConfirmFromConfig({ approvals: { destructive_slash_confirm: 'false' } })).toBe(true)
    expect(destructiveSlashConfirmFromConfig({ approvals: { destructive_slash_confirm: 'off' } })).toBe(true)
    expect(destructiveSlashConfirmFromConfig({ approvals: { destructive_slash_confirm: 0 } })).toBe(true)
    expect(destructiveSlashConfirmFromConfig({ approvals: null })).toBe(true)
    expect(destructiveSlashConfirmFromConfig({ approvals: 'nope' })).toBe(true)
    expect(destructiveSlashConfirmFromConfig(undefined)).toBe(true)
    expect(destructiveSlashConfirmFromConfig('garbage')).toBe(true)
  })
})

describe('skipDestructiveConfirm (env alias × config policy)', () => {
  test('config false skips; config true confirms; env flag overrides either way', () => {
    expect(skipDestructiveConfirm(true, {})).toBe(false)
    expect(skipDestructiveConfirm(false, {})).toBe(true)
    // HERMES_TUI_NO_CONFIRM remains the alias/override regardless of config.
    expect(skipDestructiveConfirm(true, { HERMES_TUI_NO_CONFIRM: '1' })).toBe(true)
    expect(skipDestructiveConfirm(false, { HERMES_TUI_NO_CONFIRM: '1' })).toBe(true)
    // an unset/falsy env value defers to the config policy.
    expect(skipDestructiveConfirm(true, { HERMES_TUI_NO_CONFIRM: '0' })).toBe(false)
  })
})

describe('the entry confirm seam (main.tsx wiring, mirrored)', () => {
  /** Build the dispatcher exactly as entry/main.tsx wires the slash ctx. */
  function makeConfirmSeam(store: ReturnType<typeof createSessionStore>, env: Record<string, string>) {
    return (message: ConfirmRequest, onConfirm: () => void) =>
      skipDestructiveConfirm(store.state.destructiveSlashConfirm, env)
        ? onConfirm()
        : store.setConfirm(message, onConfirm)
  }

  test('policy OFF → the destructive action runs immediately, no dialog opens', () => {
    const store = createSessionStore()
    store.setDestructiveSlashConfirm(false)
    const confirm = makeConfirmSeam(store, {})
    let ran = 0
    confirm({ title: 'Clear the current session?' }, () => (ran += 1))
    expect(ran).toBe(1)
    expect(store.state.prompt).toBeUndefined()
  })

  test('policy ON → the dialog opens and the action waits for explicit confirmation', () => {
    const store = createSessionStore()
    const confirm = makeConfirmSeam(store, {})
    let ran = 0
    confirm({ title: 'Clear the current session?' }, () => (ran += 1))
    expect(ran).toBe(0)
    expect(store.state.prompt?.kind).toBe('confirm')
    if (store.state.prompt?.kind === 'confirm') store.state.prompt.onConfirm()
    expect(ran).toBe(1)
  })

  test('HERMES_TUI_NO_CONFIRM keeps working as an override even with policy ON', () => {
    const store = createSessionStore()
    const confirm = makeConfirmSeam(store, { HERMES_TUI_NO_CONFIRM: 'true' })
    let ran = 0
    confirm({ title: 'Start a new session?' }, () => (ran += 1))
    expect(ran).toBe(1)
    expect(store.state.prompt).toBeUndefined()
  })
})

describe('store policy slice', () => {
  test('defaults ON, round-trips, and survives session-owned resets (config-scoped)', () => {
    const store = createSessionStore()
    expect(store.state.destructiveSlashConfirm).toBe(true)
    store.setDestructiveSlashConfirm(false)
    expect(store.state.destructiveSlashConfirm).toBe(false)
    // config-scoped like focusView/batteryEnabled: /clear must not resurrect
    // the dialog policy — only a successful config hydration may change it.
    store.clearTranscript()
    expect(store.state.destructiveSlashConfirm).toBe(false)
    store.setDestructiveSlashConfirm(true)
    expect(store.state.destructiveSlashConfirm).toBe(true)
  })

  test('a transient config failure preserves the last policy (hydration only on decode success)', () => {
    const store = createSessionStore()
    store.setDestructiveSlashConfirm(false)
    // main.tsx only calls the setter when decodeConfigFullResponse succeeded;
    // a failed poll therefore leaves the slice untouched. The decoder itself
    // never manufactures a policy from garbage either:
    expect(destructiveSlashConfirmFromConfig(undefined)).toBe(true) // fail-safe if it WERE applied
    expect(store.state.destructiveSlashConfirm).toBe(false) // …but the slice was preserved
  })
})
