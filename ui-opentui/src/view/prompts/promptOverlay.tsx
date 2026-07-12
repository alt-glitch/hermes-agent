/**
 * PromptOverlay — renders the active blocking prompt and binds each answer/cancel
 * to the matching `*.respond` RPC (spec §4 reply contract; §8 #6 deadlock fix):
 *   clarify.respond {answer, request_id} · approval.respond {choice, session_id} ·
 *   sudo.respond {password, request_id} · secret.respond {value, request_id}.
 * Every cancel path (Esc/Ctrl+C) sends the deny/empty reply so the agent unblocks.
 *
 * `onRespond` is the entry-wired boundary callback (fires `gateway.request`); the
 * overlay also clears the store prompt so the composer returns. Narrowing is done
 * with reactive `as*()` accessors so each sub-prompt gets its typed payload.
 */
import { createEffect, createSignal, Match, Show, Switch } from 'solid-js'

import { secureApprovalChoice } from '../../logic/approval.ts'
import { deferClose } from '../../logic/defer.ts'
import type { ActivePrompt, SessionStore } from '../../logic/store.ts'
import type { PromptResponseMethod } from '../../boundary/promptResponses.ts'
import { ApprovalPrompt } from './approvalPrompt.tsx'
import { ClarifyPrompt } from './clarifyPrompt.tsx'
import { ConfirmPrompt } from './confirmPrompt.tsx'
import { MaskedPrompt } from './maskedPrompt.tsx'

export interface PromptOverlayProps {
  readonly store: SessionStore
  readonly onRespond: (method: PromptResponseMethod, params: Record<string, unknown>) => Promise<boolean>
  readonly sessionId: () => string | undefined
}

export function PromptOverlay(props: PromptOverlayProps) {
  const prompt = () => props.store.state.prompt
  const clearSoon = () => deferClose(() => props.store.clearPrompt())
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  let generation = 0

  // A newer gateway prompt supersedes every pending response continuation.
  createEffect(() => {
    prompt()
    generation += 1
    setBusy(false)
    setError('')
  })

  // Keep prompt ownership until the exact RPC acknowledgement arrives. Deferring
  // the clear prevents the answering key from leaking into the remounted composer.
  const respond = (method: PromptResponseMethod, params: Record<string, unknown>) => {
    if (busy()) return
    const expected = prompt()
    const token = generation
    setBusy(true)
    setError('')
    void props
      .onRespond(method, params)
      .then(acknowledged => {
        if (token !== generation || props.store.state.prompt !== expected) return
        if (!acknowledged) {
          setBusy(false)
          setError('response was not acknowledged — retry or cancel')
          return
        }
        deferClose(() => {
          if (token === generation && props.store.state.prompt === expected) props.store.clearPrompt()
          setBusy(false)
        })
      })
      .catch(cause => {
        if (token !== generation || props.store.state.prompt !== expected) return
        setBusy(false)
        setError(cause instanceof Error ? cause.message : 'response failed — retry or cancel')
      })
  }

  // Reactive accessor that narrows the active-prompt union to one `kind`, giving
  // each <Match> branch its precise typed payload (undefined when not that kind).
  function narrow<K extends ActivePrompt['kind']>(kind: K): () => Extract<ActivePrompt, { kind: K }> | undefined {
    const matches = (p: ActivePrompt): p is Extract<ActivePrompt, { kind: K }> => p.kind === kind
    return () => {
      const p = prompt()
      return p && matches(p) ? p : undefined
    }
  }
  const asApproval = narrow('approval')
  const asClarify = narrow('clarify')
  const asSudo = narrow('sudo')
  const asSecret = narrow('secret')
  const asConfirm = narrow('confirm')

  return (
    <>
      <Show when={!busy()}>
        <Switch>
          <Match when={asApproval()}>
            {p => (
              <ApprovalPrompt
                allowPermanent={p().allowPermanent}
                command={p().command}
                description={p().description}
                onChoose={choice =>
                  respond('approval.respond', {
                    choice: secureApprovalChoice(choice, p().allowPermanent),
                    session_id: props.sessionId()
                  })
                }
                onCancel={() => respond('approval.respond', { choice: 'deny', session_id: props.sessionId() })}
              />
            )}
          </Match>
          <Match when={asClarify()}>
            {p => (
              <ClarifyPrompt
                question={p().question}
                choices={p().choices}
                onAnswer={answer => respond('clarify.respond', { answer, request_id: p().requestId })}
                onCancel={() => respond('clarify.respond', { answer: '', request_id: p().requestId })}
              />
            )}
          </Match>
          <Match when={asSudo()}>
            {p => (
              <MaskedPrompt
                icon="🔐"
                label="sudo password"
                onSubmit={value => respond('sudo.respond', { password: value, request_id: p().requestId })}
                onCancel={() => respond('sudo.respond', { password: '', request_id: p().requestId })}
              />
            )}
          </Match>
          <Match when={asSecret()}>
            {p => (
              <MaskedPrompt
                icon="🔑"
                label={`Secret: ${p().envVar}`}
                sub={p().prompt}
                onSubmit={value => respond('secret.respond', { request_id: p().requestId, value })}
                onCancel={() => respond('secret.respond', { request_id: p().requestId, value: '' })}
              />
            )}
          </Match>
          <Match when={asConfirm()}>
            {p => (
              <ConfirmPrompt
                spec={p().spec}
                onYes={() => {
                  p().onConfirm()
                  clearSoon()
                }}
                onNo={clearSoon}
              />
            )}
          </Match>
        </Switch>
      </Show>
      <Show when={busy()}>
        <text fg={props.store.state.theme.color.muted}>sending response… (wait to cancel)</text>
      </Show>
      <Show when={error()}>
        {message => <text fg={props.store.state.theme.color.error}>{'error: ' + message()}</text>}
      </Show>
    </>
  )
}
