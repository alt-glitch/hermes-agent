/** Transaction coordinator for the Sessions `+ new` prompt row. */
export interface PromptLiveSessionOptions {
  readonly create: () => Promise<string | undefined>
  readonly modelArg?: string
  readonly onModelSwitched?: (value: string) => void
  readonly owns: (sessionId: string) => boolean
  readonly prompt: string
  readonly restore: (prompt: string, notice: string) => void
  readonly submit: (prompt: string) => boolean
  readonly switchModel: (sessionId: string, modelArg: string) => Promise<string>
  readonly notify: (message: string) => void
}

export type PromptLiveSessionResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'created'; readonly sessionId: string }
  | { readonly kind: 'restored'; readonly reason: 'create' | 'model' | 'ownership' | 'submit' }

/** Do not consume authored input until session creation, optional model switch,
 * ownership validation, and synchronous prompt admission have all succeeded. */
export async function coordinatePromptLiveSession(options: PromptLiveSessionOptions): Promise<PromptLiveSessionResult> {
  const prompt = options.prompt.trim()
  if (!prompt) return { kind: 'empty' }

  const restore = (reason: PromptLiveSessionResult & { readonly kind: 'restored' }, notice: string) => {
    options.restore(prompt, notice)
    return reason
  }

  const sessionId = await options.create()
  if (!sessionId) {
    return restore(
      { kind: 'restored', reason: 'create' },
      'new session could not be created — prompt restored to composer'
    )
  }

  const requestedModel = options.modelArg?.trim()
  if (requestedModel) {
    try {
      const value = (await options.switchModel(sessionId, requestedModel)).trim()
      if (!value) {
        return restore(
          { kind: 'restored', reason: 'model' },
          'new-session model switch returned an invalid response — prompt restored to composer'
        )
      }
      if (!options.owns(sessionId)) {
        return restore(
          { kind: 'restored', reason: 'ownership' },
          'new-session ownership changed before submit — prompt restored to composer'
        )
      }
      options.notify(`model → ${value}`)
      options.onModelSwitched?.(value)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return restore(
        { kind: 'restored', reason: 'model' },
        `new-session model switch failed: ${detail} — prompt restored to composer`
      )
    }
  }

  if (!options.owns(sessionId)) {
    return restore(
      { kind: 'restored', reason: 'ownership' },
      'new-session ownership changed before submit — prompt restored to composer'
    )
  }
  if (!options.submit(prompt)) {
    return restore(
      { kind: 'restored', reason: 'submit' },
      'new session could not accept the prompt — prompt restored to composer'
    )
  }
  return { kind: 'created', sessionId }
}
