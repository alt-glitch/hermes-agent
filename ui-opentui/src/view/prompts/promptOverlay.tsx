/**
 * PromptOverlay — renders the active blocking prompt and binds each answer/cancel
 * to the matching `*.respond` RPC (spec §4 reply contract; §8 #6 deadlock fix):
 *   clarify.respond {answer, request_id} · approval.respond {choice, request_id, session_id} ·
 *   sudo.respond {password, request_id} · secret.respond {value, request_id}.
 * Idle Esc/Ctrl+C sends the deny/empty reply. While delivery is pending or
 * uncertain, the same keys can dismiss locally without claiming it was received.
 *
 * `onRespond` is the entry-wired boundary callback (fires `gateway.request`); the
 * overlay also clears the store prompt so the composer returns. Narrowing is done
 * with reactive `as*()` accessors so each sub-prompt gets its typed payload.
 */
import type { BoxRenderable } from '@opentui/core'
import { createEffect, createSignal, Match, onMount, Show, Switch } from 'solid-js'

import { secureApprovalChoice } from '../../logic/approval.ts'
import { deferClose } from '../../logic/defer.ts'
import type { ActivePrompt, PromptSettlement, SessionStore } from '../../logic/store.ts'
import {
  promptTransportUncertain,
  type PromptResponseDisposition,
  type PromptResponseMethod
} from '../../boundary/promptResponses.ts'
import { useCloseLayer } from '../keymap.tsx'
import { ApprovalPrompt } from './approvalPrompt.tsx'
import { ClarifyPrompt } from './clarifyPrompt.tsx'
import { ConfirmPrompt } from './confirmPrompt.tsx'
import { MaskedPrompt } from './maskedPrompt.tsx'

export interface PromptOverlayProps {
  readonly store: SessionStore
  readonly onRespond: (
    method: PromptResponseMethod,
    params: Record<string, unknown>
  ) => Promise<PromptResponseDisposition>
}

type ResponseIntent = 'answer' | 'cancel'
type ResponsePhase =
  | { readonly kind: 'idle' }
  | { readonly intent: ResponseIntent; readonly kind: 'sending' }
  | { readonly intent: ResponseIntent; readonly kind: 'uncertain'; readonly message: string }
  | { readonly kind: 'terminal'; readonly reason: 'expired' | 'obsolete' }
  | { readonly kind: 'dismissing' }

type GatewayPrompt = Exclude<ActivePrompt, { kind: 'confirm' }>
type GatewayPromptKind = GatewayPrompt['kind']
type GatewayPromptOf<K extends GatewayPromptKind> = Extract<GatewayPrompt, { kind: K }>
interface CancelRequest {
  readonly method: PromptResponseMethod
  readonly params: Record<string, unknown>
}

const CANCEL_REQUEST_BUILDERS = {
  approval: (prompt: GatewayPromptOf<'approval'>): CancelRequest => ({
    method: 'approval.respond',
    params: { choice: 'deny', request_id: prompt.requestId, session_id: prompt.sessionId }
  }),
  clarify: (prompt: GatewayPromptOf<'clarify'>): CancelRequest => ({
    method: 'clarify.respond',
    params: { answer: '', request_id: prompt.requestId }
  }),
  secret: (prompt: GatewayPromptOf<'secret'>): CancelRequest => ({
    method: 'secret.respond',
    params: { request_id: prompt.requestId, value: '' }
  }),
  sudo: (prompt: GatewayPromptOf<'sudo'>): CancelRequest => ({
    method: 'sudo.respond',
    params: { password: '', request_id: prompt.requestId }
  })
} satisfies { [K in GatewayPromptKind]: (prompt: GatewayPromptOf<K>) => CancelRequest }

function cancelRequestFor<K extends GatewayPromptKind>(prompt: GatewayPromptOf<K>): CancelRequest {
  // TypeScript cannot retain the correlation between a union's discriminant
  // and an indexed mapped-table callback; the table's `satisfies` constraint
  // proves that correlation once at declaration time.
  const builder = CANCEL_REQUEST_BUILDERS[prompt.kind] as (value: GatewayPromptOf<K>) => CancelRequest
  return builder(prompt)
}

export function PromptOverlay(props: PromptOverlayProps) {
  const prompt = () => props.store.state.prompt
  const clearSoon = (expected: ActivePrompt | undefined = prompt()): void => {
    if (expected) deferClose(() => props.store.clearPrompt(expected))
  }
  const [phase, setPhase] = createSignal<ResponsePhase>({ kind: 'idle' })
  let generation = 0
  let rootRef: BoxRenderable | undefined

  const focusKeyboardOnlyPrompt = (current: ActivePrompt | undefined): void => {
    if (current?.kind === 'clarify' || current?.kind === 'sudo' || current?.kind === 'secret') rootRef?.focus()
  }

  onMount(() => focusKeyboardOnlyPrompt(prompt()))

  // A newer gateway prompt supersedes every pending response continuation.
  createEffect(() => {
    const current = prompt()
    generation += 1
    setPhase({ kind: 'idle' })
    focusKeyboardOnlyPrompt(current)
  })

  const settleSoon = (expected: ActivePrompt, token: number, settlement: PromptSettlement): void => {
    deferClose(() => {
      if (token === generation && props.store.state.prompt === expected) {
        props.store.settlePrompt(expected, settlement)
      }
    })
  }

  // Keep prompt ownership until the exact decoded disposition arrives. A
  // terminal response closes obsolete UI; an uncertain response remains local
  // until the user dismisses it, and is never replayed automatically.
  const respond = (
    method: PromptResponseMethod,
    params: Record<string, unknown>,
    intent: ResponseIntent = 'answer',
    onAccepted?: () => boolean
  ) => {
    if (phase().kind !== 'idle') return
    const expected = prompt()
    if (!expected) return
    const token = generation
    setPhase({ kind: 'sending', intent })
    void props
      .onRespond(method, params)
      .then(disposition => {
        if (token !== generation || props.store.state.prompt !== expected) return
        if (disposition.kind === 'uncertain') {
          setPhase({ kind: 'uncertain', intent, message: disposition.message })
          return
        }
        if (disposition.kind === 'terminal') {
          setPhase({ kind: 'terminal', reason: disposition.reason })
          settleSoon(expected, token, disposition.reason)
          return
        }
        if (onAccepted && !onAccepted()) {
          setPhase({ kind: 'idle' })
          return
        }
        settleSoon(expected, token, intent === 'cancel' ? 'cancelled' : 'accepted')
      })
      .catch(cause => {
        if (token !== generation || props.store.state.prompt !== expected) return
        const disposition = promptTransportUncertain(cause)
        setPhase({ kind: 'uncertain', intent, message: disposition.message })
      })
  }

  const cancelCurrent = (current: ActivePrompt): void => {
    if (current.kind === 'confirm') {
      clearSoon()
      return
    }
    const request = cancelRequestFor(current)
    respond(request.method, request.params, 'cancel')
  }

  const closeOrCancel = (): void => {
    const expected = prompt()
    if (!expected) return
    const currentPhase = phase()
    if (currentPhase.kind === 'idle') {
      cancelCurrent(expected)
      return
    }
    if (currentPhase.kind === 'dismissing') return
    if (currentPhase.kind === 'terminal') {
      settleSoon(expected, generation, currentPhase.reason)
      return
    }
    // Esc/Ctrl+C while sending, or after an uncertain result, dismisses only
    // this local card. Invalidate the old continuation
    // before deferring the clear so it cannot touch a replacement prompt.
    generation += 1
    setPhase({ kind: 'dismissing' })
    deferClose(() => props.store.settlePrompt(expected, 'dismissed-unconfirmed'))
  }

  useCloseLayer(
    () => rootRef,
    () => closeOrCancel()
  )

  const responseHint = (): string | undefined => {
    const current = phase()
    if (current.kind === 'sending') {
      return `sending ${current.intent === 'cancel' ? 'cancellation' : 'response'}… · Esc/Ctrl+C dismiss locally (delivery not confirmed)`
    }
    if (current.kind === 'uncertain') {
      return 'delivery not confirmed · Esc/Ctrl+C dismiss locally · no automatic resend'
    }
    if (current.kind === 'terminal') {
      return `${current.reason === 'expired' ? 'request expired' : 'request no longer pending'} · closing…`
    }
    if (current.kind === 'dismissing') return 'dismissing locally…'
    return undefined
  }
  const uncertainMessage = (): string | undefined => {
    const current = phase()
    return current.kind === 'uncertain' ? current.message : undefined
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
    <box ref={el => (rootRef = el)} focusable style={{ flexDirection: 'column', flexShrink: 0 }}>
      <Switch>
        <Match when={asApproval()}>
          {p => (
            <ApprovalPrompt
              allowPermanent={p().allowPermanent}
              command={p().command}
              description={p().description}
              statusHint={responseHint()}
              onChoose={choice =>
                respond('approval.respond', {
                  choice: secureApprovalChoice(choice, p().allowPermanent),
                  request_id: p().requestId,
                  session_id: p().sessionId
                })
              }
            />
          )}
        </Match>
        <Match when={asClarify()}>
          {p => (
            <ClarifyPrompt
              question={p().question}
              choices={p().choices}
              questions={p().questions}
              answers={p().answers}
              statusHint={responseHint()}
              onAnswer={answer => respond('clarify.respond', { answer, request_id: p().requestId })}
              onQuestionAnswer={(qid, answer) =>
                // Per-question lock: the prompt stays open until no questions
                // remain. Only an accepted exact RPC updates the local mirror.
                respond(
                  'clarify.respond',
                  { answer, question_id: qid, request_id: p().requestId },
                  'answer',
                  () => props.store.recordClarifyAnswer(qid, answer) === 0
                )
              }
            />
          )}
        </Match>
        <Match when={asSudo()}>
          {p => (
            <MaskedPrompt
              icon="🔐"
              label="sudo password"
              statusHint={responseHint()}
              onSubmit={value => respond('sudo.respond', { password: value, request_id: p().requestId })}
            />
          )}
        </Match>
        <Match when={asSecret()}>
          {p => (
            <MaskedPrompt
              icon="🔑"
              label={`Secret: ${p().envVar}`}
              sub={p().prompt}
              statusHint={responseHint()}
              onSubmit={value => respond('secret.respond', { request_id: p().requestId, value })}
            />
          )}
        </Match>
        <Match when={asConfirm()}>
          {p => (
            <ConfirmPrompt
              spec={p().spec}
              onYes={() => {
                p().onConfirm()
                clearSoon(p())
              }}
              onNo={clearSoon}
            />
          )}
        </Match>
      </Switch>
      <Show when={uncertainMessage()}>
        {message => <text fg={props.store.state.theme.color.error}>{'error: ' + message()}</text>}
      </Show>
    </box>
  )
}
