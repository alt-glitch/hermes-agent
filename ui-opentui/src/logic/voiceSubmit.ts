/** `voice.submit_mode` (upstream f1c45f5727 + 0ca78e5f32): what the client does
 * with a committed ordinary voice transcript — submit it as a turn (direct,
 * the historical behavior) or land it in the composer as an editable draft. */

export type VoiceSubmitMode = 'direct' | 'draft'

/** Normalize the raw `voice.submit_mode` value from `config.get full`. The
 * value is raw yaml — possibly non-string if hand-edited — so only an exact
 * (trimmed, case-insensitive) "draft" opts in; anything else (missing,
 * non-string, unknown) keeps the established direct-submit behavior. */
export function voiceSubmitModeFromConfig(config: unknown): VoiceSubmitMode {
  if (!config || typeof config !== 'object') return 'direct'
  const voice = (config as { voice?: unknown }).voice
  if (!voice || typeof voice !== 'object') return 'direct'
  const raw = (voice as { submit_mode?: unknown }).submit_mode
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'draft' ? 'draft' : 'direct'
}

/** The composer surface the transcript delivery needs (satisfied by SessionStore). */
interface VoiceTranscriptComposer {
  readonly state: { readonly voice: { readonly submitMode: VoiceSubmitMode } }
  clearComposerDraft(): void
  insertComposerDraft(text: string): void
}

/** Deliver a COMMITTED `voice.transcript` event to the composer.
 *
 * A bare stop phrase (spoken or typed) is user intent to END the voice chat
 * (upstream ba13132298) — the store reducer prints the "voice chat ended"
 * notice; it MUST NOT submit as an agent turn (nor become a draft). The
 * no-speech cutoff notice likewise carries no submittable text.
 *
 * Direct mode is CLI parity: clear the composer, then submit exactly once —
 * deferred a microtask so the cleared draft is committed before submit runs.
 * Draft mode leaves the transcript editable instead (upstream f1c45f5727),
 * preserving any in-progress draft (upstream 0ca78e5f32). */
export function deliverVoiceTranscript(
  store: VoiceTranscriptComposer,
  payload:
    | {
        readonly no_speech_limit?: boolean | undefined
        readonly stop_phrase?: boolean | undefined
        readonly text?: string | undefined
      }
    | undefined,
  submit: (text: string) => void
): void {
  if (payload?.no_speech_limit || payload?.stop_phrase) return
  const text = payload?.text?.trim()
  if (!text) return
  if (store.state.voice.submitMode === 'draft') {
    store.insertComposerDraft(text)
    return
  }
  store.clearComposerDraft()
  queueMicrotask(() => submit(text))
}
