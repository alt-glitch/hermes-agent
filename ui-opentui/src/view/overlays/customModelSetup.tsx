/** Staged custom/local model setup for `/model`.
 * Secrets use MaskedPrompt's non-renderable buffer; a failed `/models` probe
 * deliberately falls through to manual model entry.
 */
import { useKeyboard } from '@opentui/solid'
import { createSignal, For, Match, Show, Switch } from 'solid-js'

import { deferClose } from '../../logic/defer.ts'
import type { CustomModelSetupState } from '../../logic/store.ts'
import { MaskedPrompt } from '../prompts/maskedPrompt.tsx'
import { useTheme } from '../theme.tsx'

type Stage = 'endpoint' | 'protocol' | 'key' | 'probing' | 'models' | 'manual' | 'name' | 'saving'

interface ProbeResult {
  models: string[]
  reachable: boolean
  resolvedBaseUrl: string
  suggestedBaseUrl?: string
}

export function readCustomModelProbe(value: unknown, fallbackUrl: string): ProbeResult {
  if (!value || typeof value !== 'object') return { models: [], reachable: false, resolvedBaseUrl: fallbackUrl }
  const row = value as Record<string, unknown>
  return {
    models: Array.isArray(row.models) ? row.models.filter((model): model is string => typeof model === 'string') : [],
    reachable: row.reachable === true,
    resolvedBaseUrl: typeof row.resolved_base_url === 'string' ? row.resolved_base_url : fallbackUrl,
    ...(typeof row.suggested_base_url === 'string' ? { suggestedBaseUrl: row.suggested_base_url } : {})
  }
}

function TextStep(props: {
  title: string
  help: string
  initialValue?: string
  placeholder?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const theme = useTheme()
  const [value, setValue] = createSignal(props.initialValue ?? '')
  useKeyboard(key => {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) props.onCancel()
  })
  return (
    <box
      border
      style={{ borderColor: theme().color.border, flexDirection: 'column', flexShrink: 0, marginTop: 1, padding: 1 }}
    >
      <text fg={theme().color.accent}>
        <b>{props.title}</b>
      </text>
      <text fg={theme().color.muted}>{props.help}</text>
      <box style={{ flexDirection: 'row' }}>
        <text fg={theme().color.label}>{'> '}</text>
        <input
          focused
          value={value()}
          placeholder={props.placeholder ?? ''}
          placeholderColor={theme().color.muted}
          textColor={theme().color.text}
          cursorColor={theme().color.accent}
          style={{ flexGrow: 1, minWidth: 0 }}
          onInput={setValue}
          onSubmit={() => props.onSubmit(value().trim())}
        />
      </box>
      <text fg={theme().color.muted}>Enter continue · Esc cancel</text>
    </box>
  )
}

function ChoiceStep(props: {
  title: string
  help: string
  choices: readonly { label: string; description: string; value: string }[]
  onPick: (value: string) => void
  onCancel: () => void
}) {
  const theme = useTheme()
  const [selected, setSelected] = createSignal(0)
  useKeyboard(key => {
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return props.onCancel()
    if (key.name === 'up') {
      key.preventDefault()
      setSelected(index => (index - 1 + props.choices.length) % props.choices.length)
    } else if (key.name === 'down') {
      key.preventDefault()
      setSelected(index => (index + 1) % props.choices.length)
    } else if (key.name === 'return') {
      key.preventDefault()
      const choice = props.choices[selected()]
      if (choice) props.onPick(choice.value)
    }
  })
  return (
    <box
      border
      style={{ borderColor: theme().color.border, flexDirection: 'column', flexShrink: 0, marginTop: 1, padding: 1 }}
    >
      <text fg={theme().color.accent}>
        <b>{props.title}</b>
      </text>
      <text fg={theme().color.muted}>{props.help}</text>
      <For each={props.choices}>
        {(choice, index) => (
          <box
            style={{
              backgroundColor: index() === selected() ? theme().color.selectionBg : 'transparent',
              flexDirection: 'column',
              paddingLeft: 1,
              paddingRight: 1
            }}
          >
            <text fg={index() === selected() ? theme().color.accent : theme().color.text}>
              {index() === selected() ? '› ' : '  '}
              {choice.label}
            </text>
            <text fg={theme().color.muted}> {choice.description}</text>
          </box>
        )}
      </For>
      <text fg={theme().color.muted}>↑↓ select · Enter continue · Esc cancel</text>
    </box>
  )
}

export function CustomModelSetup(props: { setup: CustomModelSetupState; onClose: () => void }) {
  const theme = useTheme()
  const [stage, setStage] = createSignal<Stage>('endpoint')
  const [baseUrl, setBaseUrl] = createSignal('')
  const [apiMode, setApiMode] = createSignal('chat_completions')
  const [apiKey, setApiKey] = createSignal('')
  const [models, setModels] = createSignal<string[]>([])
  const [model, setModel] = createSignal('')
  const [providerName, setProviderName] = createSignal('')
  const [notice, setNotice] = createSignal('')
  const [error, setError] = createSignal('')
  const close = () => deferClose(props.onClose)
  useKeyboard(key => {
    if ((stage() === 'probing' || stage() === 'saving') && (key.name === 'escape' || (key.ctrl && key.name === 'c'))) {
      close()
    }
  })

  const probe = (key: string) => {
    setApiKey(key)
    setStage('probing')
    setError('')
    void props.setup
      .request('model.custom.probe', { api_key: key, api_mode: apiMode(), base_url: baseUrl() })
      .then(raw => {
        const result = readCustomModelProbe(raw, baseUrl())
        setBaseUrl(result.resolvedBaseUrl)
        setModels(result.models)
        if (result.models.length) {
          setStage('models')
          return
        }
        setNotice(
          result.reachable
            ? 'The endpoint returned no models; enter the model id manually.'
            : `Could not read /models; manual setup is still available.${result.suggestedBaseUrl ? ` Try ${result.suggestedBaseUrl}.` : ''}`
        )
        setStage('manual')
      })
      .catch(cause => {
        setNotice(
          `Probe failed; manual setup is still available (${cause instanceof Error ? cause.message : 'unknown error'}).`
        )
        setStage('manual')
      })
  }

  const save = (displayName: string) => {
    setStage('saving')
    setError('')
    void props.setup
      .request('model.custom.save', {
        api_key: apiKey(),
        api_mode: apiMode(),
        base_url: baseUrl(),
        discover_models: true,
        display_name: displayName,
        model: model()
      })
      .then(raw => {
        const value =
          raw && typeof raw === 'object' && typeof (raw as { switch_value?: unknown }).switch_value === 'string'
            ? (raw as { switch_value: string }).switch_value
            : ''
        if (!value) throw new Error('save returned no model switch value')
        props.setup.onSaved(value)
        close()
      })
      .catch(cause => {
        setError(cause instanceof Error ? cause.message : 'save failed')
        setStage('name')
      })
  }

  const modelChoices = () => [
    ...models().map(value => ({ description: 'Discovered from the endpoint', label: value, value })),
    { description: 'Use a model id that /models does not advertise', label: 'Enter a model id manually…', value: '' }
  ]

  return (
    <box style={{ flexDirection: 'column', flexShrink: 0 }}>
      <Switch>
        <Match when={stage() === 'endpoint'}>
          <TextStep
            title="Add local/custom model · 1/5"
            help="OpenAI-compatible endpoint (Ollama, llama.cpp, vLLM, LM Studio, SGLang…)"
            placeholder="http://localhost:11434/v1"
            onCancel={close}
            onSubmit={value => {
              if (!value) {
                setError('Endpoint URL is required')
                return
              }
              setError('')
              setBaseUrl(value)
              setStage('protocol')
            }}
          />
        </Match>
        <Match when={stage() === 'protocol'}>
          <ChoiceStep
            title="Wire protocol · 2/5"
            help="Most local servers use OpenAI-compatible chat completions."
            choices={[
              {
                label: 'OpenAI compatible',
                description: 'Ollama, llama.cpp, vLLM, LM Studio, SGLang',
                value: 'chat_completions'
              },
              {
                label: 'Anthropic native',
                description: 'Native /v1/messages endpoint and x-api-key auth',
                value: 'anthropic_messages'
              }
            ]}
            onCancel={close}
            onPick={value => {
              setApiMode(value)
              setStage('key')
            }}
          />
        </Match>
        <Match when={stage() === 'key'}>
          <MaskedPrompt
            icon="🔑"
            label="API key (optional) · 3/5"
            sub="Press Enter empty for a keyless server. The key is saved only in ~/.hermes/.env."
            onCancel={close}
            onSubmit={probe}
          />
        </Match>
        <Match when={stage() === 'probing' || stage() === 'saving'}>
          <box
            border
            style={{
              borderColor: theme().color.border,
              flexDirection: 'column',
              flexShrink: 0,
              marginTop: 1,
              padding: 1
            }}
          >
            <text fg={theme().color.accent}>{stage() === 'probing' ? 'Probing /models…' : 'Saving provider…'}</text>
            <text fg={theme().color.muted}>The gateway remains responsive.</text>
          </box>
        </Match>
        <Match when={stage() === 'models'}>
          <ChoiceStep
            title="Choose model · 4/5"
            help={`${models().length} model${models().length === 1 ? '' : 's'} discovered`}
            choices={modelChoices()}
            onCancel={close}
            onPick={value => {
              if (!value) {
                setStage('manual')
                return
              }
              setModel(value)
              setStage('name')
            }}
          />
        </Match>
        <Match when={stage() === 'manual'}>
          <TextStep
            title="Model id · 4/5"
            help={notice() || 'Enter the exact model id accepted by the endpoint.'}
            placeholder="qwen3.5:27b"
            onCancel={close}
            onSubmit={value => {
              if (!value) {
                setError('Model id is required')
                return
              }
              setError('')
              setModel(value)
              setStage('name')
            }}
          />
        </Match>
        <Match when={stage() === 'name'}>
          <TextStep
            title="Provider name · 5/5"
            help="Leave blank for an automatic local name."
            initialValue={providerName()}
            placeholder="Local Ollama"
            onCancel={close}
            onSubmit={value => {
              setProviderName(value)
              save(value)
            }}
          />
        </Match>
      </Switch>
      <Show when={error()}>
        <text fg={theme().color.error}>{error()}</text>
      </Show>
    </box>
  )
}
