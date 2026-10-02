/**
 * PromptOverlay — renders the active blocking prompt and answers the backend→client
 * request that opened it (result shapes per tui_gateway/contracts/server_requests.py):
 *   clarify {answers} · approval {choice} · sudo / secret / vault.unlock_prompt {value};
 *   a single-question clarify answers `{answers: {[qid]: text | null}}` (null = skipped); a
 *   batch clarify locks one answer at a time through the `clarify.lock` RPC.
 * Idle Esc/Ctrl+C sends the deny/empty reply. While delivery is pending or
 * uncertain, `r` deliberately retries that exact response while Esc/Ctrl+C
 * dismisses locally without claiming it was received.
 *
 * `onRespond` is the entry-wired boundary callback (JSON-RPC response or clarify.lock); the
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
  type PromptReply,
  type PromptResponseDisposition
} from '../../boundary/promptResponses.ts'
import type { PromptAnswer } from '../../boundary/gateway/serverRequests.ts'
import { useCloseLayer, usePromptRetryLayer } from '../keymap.tsx'
import { ApprovalPrompt } from './approvalPrompt.tsx'
import { ClarifyPrompt } from './clarifyPrompt.tsx'
import { ConfirmPrompt } from './confirmPrompt.tsx'
import { MaskedPrompt } from './maskedPrompt.tsx'

export interface PromptOverlayProps {
  readonly store: SessionStore
  readonly onRespond: (reply: PromptReply) => Promise<PromptResponseDisposition>
}

type ResponseIntent = 'answer' | 'cancel'
interface ResponseAttempt {
  readonly expected: ActivePrompt
  readonly intent: ResponseIntent
  readonly onAccepted: (() => boolean) | undefined
  readonly reply: PromptReply
  readonly sessionId: string | undefined
  readonly token: number
}
type ResponsePhase =
  | { readonly kind: 'idle' }
  | { readonly attempt: ResponseAttempt; readonly kind: 'sending'; readonly manualRetry: boolean }
  | { readonly attempt: ResponseAttempt; readonly kind: 'uncertain'; readonly message: string }
  | { readonly afterUncertain: boolean; readonly kind: 'terminal'; readonly reason: 'expired' | 'obsolete' }
  | { readonly kind: 'dismissing' }

type GatewayPrompt = Exclude<ActivePrompt, { kind: 'confirm' }>
type GatewayPromptKind = GatewayPrompt['kind']
type GatewayPromptOf<K extends GatewayPromptKind> = Extract<GatewayPrompt, { kind: K }>

/**
 * Masked (single hidden value) prompt kinds share one answer shape, `{value}`
 * (ValueResult), with `''` as the cancellation. Each kind is one row here — the
 * card copy is declared once, so submit, cancel and keyboard focus cannot drift apart.
 */
type MaskedKind = 'sudo' | 'secret' | 'vaultUnlock'
interface MaskedCard<K extends MaskedKind> {
  readonly icon: string
  readonly label: (prompt: GatewayPromptOf<K>) => string
  /** Secondary line; `''` renders nothing. */
  readonly sub: (prompt: GatewayPromptOf<K>) => string
}
const MASKED_CARDS = {
  sudo: { icon: '🔐', label: () => 'sudo password', sub: () => '' },
  secret: {
    icon: '🔑',
    label: prompt => `Secret: ${prompt.envVar}`,
    sub: prompt => prompt.prompt
  },
  vaultUnlock: {
    icon: '🔐',
    label: prompt => `Unlock ${prompt.displayName} for this session`,
    sub: () => 'master password · goes to the manager CLI only · Esc keeps it locked'
  }
} satisfies { [K in MaskedKind]: MaskedCard<K> }

const isMasked = (prompt: ActivePrompt): prompt is GatewayPromptOf<MaskedKind> => prompt.kind in MASKED_CARDS

const answer = (prompt: GatewayPrompt, result: PromptAnswer): PromptReply => ({
  kind: 'answer',
  requestId: prompt.requestId,
  result
})

/** A single-question clarify's ClarifyResult: its answer keyed by qid, a blank one a skip (null). */
const clarifyAnswers = (prompt: GatewayPromptOf<'clarify'>, text: string): PromptAnswer => ({
  answers: prompt.qid === undefined ? {} : { [prompt.qid]: text.trim() ? text : null }
})

/** Esc/Ctrl+C answer per kind: deny for approval, empty for the rest (a clarify
 *  response without `answers` cancels every question, single or batch). */
const CANCEL_RESULTS = {
  approval: { choice: 'deny' },
  clarify: {},
  secret: { value: '' },
  sudo: { value: '' },
  vaultUnlock: { value: '' }
} as const satisfies Record<GatewayPromptKind, PromptAnswer>

export function PromptOverlay(props: PromptOverlayProps) {
  const prompt = () => props.store.state.prompt
  const clearSoon = (expected: ActivePrompt | undefined = prompt()): void => {
    if (expected) deferClose(() => props.store.clearPrompt(expected))
  }
  const [phase, setPhase] = createSignal<ResponsePhase>({ kind: 'idle' })
  let generation = 0
  let rootRef: BoxRenderable | undefined

  // Keyboard-only cards (no pointer target) take focus on the overlay root so
  // Enter/Esc reach them; approval and confirm own their own focus handling.
  const focusKeyboardOnlyPrompt = (current: ActivePrompt | undefined): void => {
    if (current && (current.kind === 'clarify' || isMasked(current))) rootRef?.focus()
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

  const attemptIsCurrent = (attempt: ResponseAttempt): boolean =>
    attempt.token === generation &&
    props.store.state.prompt === attempt.expected &&
    props.store.state.sessionId === attempt.sessionId

  // Keep prompt ownership until the exact decoded disposition arrives. A
  // terminal response closes obsolete UI; an uncertain response retains the
  // immutable attempt for an explicit user retry and is never replayed itself.
  const dispatchAttempt = (attempt: ResponseAttempt, manualRetry = false): void => {
    if (!attemptIsCurrent(attempt)) return
    setPhase({ attempt, kind: 'sending', manualRetry })
    void props
      .onRespond(attempt.reply)
      .then(disposition => {
        if (!attemptIsCurrent(attempt)) return
        if (disposition.kind === 'uncertain') {
          setPhase({ attempt, kind: 'uncertain', message: disposition.message })
          return
        }
        if (disposition.kind === 'terminal') {
          setPhase({ afterUncertain: manualRetry, kind: 'terminal', reason: disposition.reason })
          settleSoon(attempt.expected, attempt.token, manualRetry ? 'terminal-unconfirmed' : disposition.reason)
          return
        }
        if (attempt.onAccepted && !attempt.onAccepted()) {
          setPhase({ kind: 'idle' })
          return
        }
        settleSoon(attempt.expected, attempt.token, attempt.intent === 'cancel' ? 'cancelled' : 'accepted')
      })
      .catch(cause => {
        if (!attemptIsCurrent(attempt)) return
        const disposition = promptTransportUncertain(cause)
        setPhase({ attempt, kind: 'uncertain', message: disposition.message })
      })
  }

  const respond = (reply: PromptReply, intent: ResponseIntent = 'answer', onAccepted?: () => boolean): void => {
    if (phase().kind !== 'idle') return
    const expected = prompt()
    if (!expected) return
    dispatchAttempt({
      expected,
      intent,
      onAccepted,
      reply,
      sessionId: props.store.state.sessionId,
      token: generation
    })
  }

  const retryUncertain = (): void => {
    const current = phase()
    if (current.kind !== 'uncertain') return
    dispatchAttempt(current.attempt, true)
  }

  const cancelCurrent = (current: ActivePrompt): void => {
    if (current.kind === 'confirm') {
      clearSoon()
      return
    }
    respond(answer(current, CANCEL_RESULTS[current.kind]), 'cancel')
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
  usePromptRetryLayer(
    () => rootRef,
    () => phase().kind === 'uncertain',
    retryUncertain
  )

  const responseHint = (): string | undefined => {
    const current = phase()
    if (current.kind === 'sending') {
      if (current.manualRetry) {
        return 'retrying same response… · Esc/Ctrl+C dismiss locally (delivery not confirmed)'
      }
      return `sending ${current.attempt.intent === 'cancel' ? 'cancellation' : 'response'}… · Esc/Ctrl+C dismiss locally (delivery not confirmed)`
    }
    if (current.kind === 'uncertain') {
      return `delivery not confirmed · r retry same ${current.attempt.intent === 'cancel' ? 'cancellation' : 'response'} · Esc/Ctrl+C dismiss locally · no automatic resend`
    }
    if (current.kind === 'terminal') {
      if (current.afterUncertain) {
        return 'request no longer pending · earlier delivery remains unconfirmed · closing…'
      }
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
  const asConfirm = narrow('confirm')
  const asMasked = (): GatewayPromptOf<MaskedKind> | undefined => {
    const p = prompt()
    return p && isMasked(p) ? p : undefined
  }

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
              onChoose={choice => respond(answer(p(), { choice: secureApprovalChoice(choice, p().allowPermanent) }))}
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
              onAnswer={text => respond(answer(p(), clarifyAnswers(p(), text)))}
              onQuestionAnswer={(qid, text) =>
                // Per-question lock: the prompt stays open until no questions
                // remain. Only an accepted clarify.lock updates the local mirror.
                respond(
                  { kind: 'lock', requestId: p().requestId, questionId: qid, answer: text },
                  'answer',
                  () => props.store.recordClarifyAnswer(qid, text) === 0
                )
              }
            />
          )}
        </Match>
        <Match when={asMasked()}>
          {p => {
            // `p().kind` is a MaskedKind; the table row carries the card copy
            // and the wire encoding for both submit and cancellation.
            const card = () => MASKED_CARDS[p().kind] as MaskedCard<MaskedKind>
            return (
              <MaskedPrompt
                icon={card().icon}
                label={card().label(p())}
                sub={card().sub(p())}
                statusHint={responseHint()}
                onSubmit={value => respond(answer(p(), { value }))}
              />
            )
          }}
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
