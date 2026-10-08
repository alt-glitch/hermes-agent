/**
 * VaultSaveLoginPrompt — `vault.save_login` (Ink `maskedPrompt.tsx` VaultSaveLoginPrompt): the
 * identifier as typed, then the masked password, both on the shared MaskedPrompt editor. An empty
 * identifier or password declines (`onReady('', '')` / `onReady(identifier, '')`); the pair goes
 * only to the encrypted vault — the password is never placed in a renderable.
 */
import { createSignal, Show } from 'solid-js'

import { MaskedPrompt } from './maskedPrompt.tsx'

export function VaultSaveLoginPrompt(props: {
  site: string
  onReady: (identifier: string, password: string) => void
  statusHint?: string | undefined
}) {
  const [identifier, setIdentifier] = createSignal('')
  return (
    <Show
      when={identifier()}
      keyed
      fallback={
        <MaskedPrompt
          icon="🔑"
          label={`Save your ${props.site} login`}
          sub="email or username · password comes next · Esc or empty skips saving"
          reveal
          statusHint={props.statusHint}
          onSubmit={value => (value.trim() ? setIdentifier(value.trim()) : props.onReady('', ''))}
        />
      }
    >
      {id => (
        <MaskedPrompt
          icon="🔑"
          label={`Password for ${id}`}
          sub={`hidden · encrypted on this machine for ${props.site} · never shown to the model`}
          statusHint={props.statusHint}
          onSubmit={password => props.onReady(id, password)}
        />
      )}
    </Show>
  )
}
