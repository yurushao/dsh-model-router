import Schema from '@deepseek-ai/schemastery'

/** One Jev policy snapshot; the key is resolved separately per request. */
export interface Config {
  enabled: boolean
  /** Legacy inline key, retained for existing installations. */
  apiKey?: string
  apiKeyEnv: string
  endpoint: string
  jevModel: string
  timeoutMs: number
  maxRoutingBytes: number
  historyMessages: number
  includeSubagents: boolean
}

/** Cordis exposes volatile fields to the Host settings editor. */
export interface PluginConfig {
  enabled: boolean
  apiKey?: string
  apiKeyEnv: { get(): string }
  endpoint: { get(): string }
  jevModel: { get(): string }
  timeoutMs: { get(): number }
  maxRoutingBytes: { get(): number }
  historyMessages: { get(): number }
  includeSubagents: { get(): boolean }
}

export function resolveConfig(config: PluginConfig): Config {
  return {
    enabled: config.enabled, ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    apiKeyEnv: config.apiKeyEnv.get(), endpoint: config.endpoint.get(), jevModel: config.jevModel.get(),
    timeoutMs: config.timeoutMs.get(), maxRoutingBytes: config.maxRoutingBytes.get(),
    historyMessages: config.historyMessages.get(), includeSubagents: config.includeSubagents.get(),
  }
}

export const Config: Schema<Record<string, unknown>, PluginConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  apiKey: Schema.string().role('secret'),
  apiKeyEnv: Schema.string().default('OPENROUTER_API_KEY').volatile(),
  endpoint: Schema.string().default('https://openrouter.ai/api/alpha/decisions').volatile(),
  jevModel: Schema.string().default('typesafe/jev-1.13').volatile(),
  timeoutMs: Schema.number().min(1).max(60000).step(1).default(3000).volatile(),
  maxRoutingBytes: Schema.number().min(1024).max(24000).step(1).default(16000).volatile(),
  historyMessages: Schema.number().min(0).max(100).step(1).default(0).volatile(),
  includeSubagents: Schema.boolean().default(true).volatile(),
})

export function validateConfig(config: Config): void {
  if (!config.apiKey?.trim() && !config.apiKeyEnv.trim()) throw new Error('jev-router: apiKey or apiKeyEnv is required')
  if (config.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) throw new Error('jev-router: invalid apiKeyEnv credential reference')
  if (!config.jevModel.trim()) throw new Error('jev-router: jevModel must not be blank')
  const url = new URL(config.endpoint)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('jev-router: endpoint must be an HTTP(S) URL without credentials')
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('jev-router: remote endpoints must use HTTPS')
  }
}
