import { createElement as h, useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'

type Settings = { apiKeyEnv: string; endpoint: string; jevModel: string; timeoutMs: number; maxRoutingBytes: number; historyMessages: number; includeSubagents: boolean }
type State = { value?: unknown; revision?: number; writable: boolean; status: string }
type Op = { op: 'set'; path: string[]; value: string | number | boolean }
type Form = { state: State; mutate(ops: Op[], revision?: number): Promise<boolean> }
type Remote = { credentials: {
  describe(refs: string[]): Promise<{ ok: boolean; value?: Record<string, { configured: boolean; writable: boolean }> }>
  set(ref: string, value: string): Promise<{ ok: boolean }>
} }
type BrowserContext = Context & {
  locale: { register(ns: string, dictionaries: Record<string, Record<string, string>>): () => void; bind(ns: string): (key: string) => string }
  slots: { inject(name: string, register: () => unknown): () => void; register<P>(options: Record<string, unknown>, render: (props: P) => ReactNode): () => void }
  remote: Remote
  sessions: { binding(id: string): { session: { projections: { faceOf(key: string): RoutingSource } } } | undefined }
}
type RoutingSource = { subscribe(listener: () => void): () => void; getSnapshot(): unknown }
function RoutingLabel({ routing }: { routing: RoutingSource }): ReactNode {
  const state = object(useSyncExternalStore(routing.subscribe, routing.getSnapshot))
  if (state.mode !== 'auto') return null
  return h('span', { style: { fontSize: 12, opacity: 0.75 } }, `Auto · Jev${typeof state.model === 'string' && state.model ? ` · ${state.model}` : ''}`)
}
type PageProps = { view: 'summary' | 'page'; form?: Form }

const defaults: Settings = {
  apiKeyEnv: 'OPENROUTER_API_KEY', endpoint: 'https://openrouter.ai/api/alpha/decisions',
  jevModel: 'typesafe/jev-1.13', timeoutMs: 3000, maxRoutingBytes: 16000,
  historyMessages: 0, includeSubagents: true,
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function read(value: unknown): Settings {
  const data = object(value)
  return {
    apiKeyEnv: typeof data.apiKeyEnv === 'string' ? data.apiKeyEnv : defaults.apiKeyEnv,
    endpoint: typeof data.endpoint === 'string' ? data.endpoint : defaults.endpoint,
    jevModel: typeof data.jevModel === 'string' ? data.jevModel : defaults.jevModel,
    timeoutMs: typeof data.timeoutMs === 'number' ? data.timeoutMs : defaults.timeoutMs,
    maxRoutingBytes: typeof data.maxRoutingBytes === 'number' ? data.maxRoutingBytes : defaults.maxRoutingBytes,
    historyMessages: typeof data.historyMessages === 'number' ? data.historyMessages : defaults.historyMessages,
    includeSubagents: typeof data.includeSubagents === 'boolean' ? data.includeSubagents : defaults.includeSubagents,
  }
}
const en: Record<string, string> = {
  summary: 'Configure the Jev Decisions API. Candidate models come from Settings → Models.',
  heading: 'Jev API', modelsHint: 'Jev chooses among models already available in Settings → Models using their names and IDs.',
  endpoint: 'Decisions endpoint', jevModel: 'Jev model', apiKeyEnv: 'Credential reference', apiKey: 'API key',
  keySet: 'Key stored in Harness credentials', keyMissing: 'No key in Harness credentials (a legacy key may still be active)',
  keyHint: 'Stored in Harness credentials; leave blank to keep the current key.',
  timeoutMs: 'Timeout (ms)', maxRoutingBytes: 'Maximum Jev input (bytes)', historyMessages: 'Recent history messages',
  includeSubagents: 'Route subagents', save: 'Save', saving: 'Saving…', saved: 'Saved',
  error: 'Save failed. Check the fields and try again.', invalid: 'Check the URL, credential reference and numeric limits.',
  unavailable: 'Configuration is unavailable.', readOnly: 'This profile is read-only.',
}
const zh: Record<string, string> = {
  summary: '配置 Jev Decisions API；候选模型来自「设置 → 模型」。',
  heading: 'Jev API', modelsHint: 'Jev 根据「设置 → 模型」中已有模型的名称和 ID 选择模型。',
  endpoint: 'Decisions 接口地址', jevModel: 'Jev 模型', apiKeyEnv: '凭据引用名', apiKey: 'API Key',
  keySet: 'Harness 凭据存储中已有 Key', keyMissing: '凭据存储中无 Key（旧配置的 Key 可能仍有效）',
  keyHint: '保存在 Harness 凭据存储中；留空则保持现有 Key。',
  timeoutMs: '超时（毫秒）', maxRoutingBytes: 'Jev 输入上限（字节）', historyMessages: '最近历史消息数',
  includeSubagents: '路由子代理', save: '保存', saving: '保存中…', saved: '已保存',
  error: '保存失败，请检查字段后重试。', invalid: '请检查地址、凭据引用名和数值范围。',
  unavailable: '配置暂不可用。', readOnly: '此配置为只读。',
}
const field: CSSProperties = { display: 'grid', gap: 5, minWidth: 0 }
const input: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6, border: '1px solid #999', background: 'transparent', color: 'inherit' }
function valid(settings: Settings): boolean {
  try {
    const url = new URL(settings.endpoint)
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return false
  } catch { return false }
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(settings.apiKeyEnv) && !!settings.jevModel.trim()
    && Number.isInteger(settings.timeoutMs) && settings.timeoutMs >= 1 && settings.timeoutMs <= 60000
    && Number.isInteger(settings.maxRoutingBytes) && settings.maxRoutingBytes >= 1024 && settings.maxRoutingBytes <= 24000
    && Number.isInteger(settings.historyMessages) && settings.historyMessages >= 0 && settings.historyMessages <= 100
}
function RouterPage({ form, remote, t }: { form: Form | undefined; remote: Remote; t: (key: string) => string }): ReactNode {
  const revision = form?.state.revision
  const [draft, setDraft] = useState<Settings>(() => read(form?.state.value))
  const [key, setKey] = useState('')
  const [keyState, setKeyState] = useState<{ configured: boolean; writable: boolean }>({ configured: false, writable: true })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => { setDraft(read(form?.state.value)); setKey(''); setNotice('') }, [revision])
  useEffect(() => {
    let active = true
    setKeyState({ configured: false, writable: true })
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.apiKeyEnv)) return () => { active = false }
    void remote.credentials.describe([draft.apiKeyEnv]).then(result => {
      if (!active || !result.ok) return
      const found = result.value?.[draft.apiKeyEnv]
      setKeyState({ configured: found?.configured ?? false, writable: found?.writable ?? true })
    }).catch(() => {})
    return () => { active = false }
  }, [remote, draft.apiKeyEnv, revision])
  if (!form || form.state.status === 'unavailable') return h('p', null, t('unavailable'))
  const writable = form.state.writable && !busy
  const edit = <K extends keyof Settings>(name: K, value: Settings[K]): void => setDraft(current => ({ ...current, [name]: value }))
  const textField = (id: keyof Settings, label: string, value: string, type = 'text'): ReactNode =>
    h('label', { key: id, style: field, htmlFor: id }, label,
      h('input', { id, style: input, type, value, disabled: !writable, onChange: (event: { target: { value: string } }) => edit(id, event.target.value as never) }))
  const numberField = (id: 'timeoutMs' | 'maxRoutingBytes' | 'historyMessages', min: number, max: number): ReactNode =>
    h('label', { style: field, htmlFor: id }, t(id),
      h('input', { id, style: input, type: 'number', step: 1, min, max, value: draft[id], disabled: !writable,
        onChange: (event: { target: { value: string } }) => edit(id, Number(event.target.value)) }))
  async function save(): Promise<void> {
    if (!valid(draft)) { setNotice(t('invalid')); return }
    setBusy(true); setNotice('')
    try {
      const ops: Op[] = (Object.keys(draft) as (keyof Settings)[]).map(name => ({ op: 'set', path: [name], value: draft[name] }))
      if (!await form!.mutate(ops, revision)) { setNotice(t('error')); return }
      if (key.trim()) {
        const result = await remote.credentials.set(draft.apiKeyEnv, key.trim())
        if (!result.ok) { setNotice(t('error')); return }
        setKey(''); setKeyState({ configured: true, writable: keyState.writable })
      }
      setNotice(t('saved'))
    } catch { setNotice(t('error')) }
    finally { setBusy(false) }
  }
  return h('div', { style: { display: 'grid', gap: 12, maxWidth: 640 } },
    h('h3', null, t('heading')), h('p', null, t('modelsHint')),
    textField('endpoint', t('endpoint'), draft.endpoint), textField('jevModel', t('jevModel'), draft.jevModel),
    textField('apiKeyEnv', t('apiKeyEnv'), draft.apiKeyEnv),
    h('label', { style: field, htmlFor: 'jev-key' }, `${t('apiKey')} · ${t(keyState.configured ? 'keySet' : 'keyMissing')}`,
      h('input', { id: 'jev-key', style: input, type: 'password', autoComplete: 'new-password', value: key,
        disabled: !keyState.writable || busy, onChange: (event: { target: { value: string } }) => setKey(event.target.value) }),
      h('small', null, t('keyHint'))),
    numberField('timeoutMs', 1, 60000), numberField('maxRoutingBytes', 1024, 24000), numberField('historyMessages', 0, 100),
    h('label', { style: { display: 'flex', gap: 8, alignItems: 'center' }, htmlFor: 'includeSubagents' },
      h('input', { id: 'includeSubagents', type: 'checkbox', checked: draft.includeSubagents, disabled: !writable,
        onChange: (event: { target: { checked: boolean } }) => edit('includeSubagents', event.target.checked) }), t('includeSubagents')),
    !form.state.writable ? h('p', null, t('readOnly')) : null,
    h('button', { type: 'button', disabled: !writable, onClick: () => { void save() }, style: { justifySelf: 'start', padding: '8px 16px' } }, t(busy ? 'saving' : 'save')),
    notice ? h('p', { role: 'status' }, notice) : null)
}

export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'sessions']
export function apply(ctx: Context): void {
  const browser = ctx as BrowserContext
  ctx.effect(() => browser.slots.inject('conversation.session.header.actions', () => browser.slots.register({
    name: 'conversation.session.header.actions', id: 'jev-router-status', order: 40,
    inject: (sessionId: string) => ({ routing: browser.sessions.binding(sessionId)!.session.projections.faceOf('jevRouting') }),
  }, RoutingLabel)), 'jev-router: session status')
  const ns = 'jevRouterSettings'
  const t = browser.locale.bind(ns)
  ctx.effect(() => browser.locale.register(ns, { en, zh }), 'jev-router: settings locales')
  ctx.effect(() => browser.slots.inject('plugins.row.config', () => browser.slots.register({
    name: 'plugins.row.config', key: '@yurushao/dsh-model-router#jev-router', locale: ns,
  }, (props: PageProps) => props.view === 'summary' ? t('summary') : h(RouterPage, { form: props.form, remote: browser.remote, t }))), 'jev-router: configuration page')
}
