import Schema from '@deepseek-ai/schemastery'

/** Model tiers are policy choices, independent of provider-specific model IDs. */
export type Tier = 'economy' | 'frontier'

/** A route already supported by an installed Harness model adapter. */
export interface ModelRoute {
  provider: string
  model: string
  description: string
  reasoningEffort?: string
  supportsTools: boolean
  supportsImages: boolean
  /** Optional operator limit on serialized input characters, not a token estimate. */
  maxInputChars?: number
}

/** Resolved plugin configuration. Credentials are passed through Cordis config. */
export interface Config {
  enabled: boolean
  apiKey: string
  endpoint: string
  jevModel: string
  models: Record<Tier, ModelRoute>
  economyThreshold: number
  newTaskThreshold: number
  timeoutMs: number
  maxRoutingBytes: number
  historyMessages: number
  fallbackTier: Tier
  includeSubagents: boolean
}

const route: Schema<ModelRoute> = Schema.object({
  provider: Schema.string().required(),
  model: Schema.string().required(),
  description: Schema.string().default(''),
  reasoningEffort: Schema.string(),
  supportsTools: Schema.boolean().default(true),
  supportsImages: Schema.boolean().default(false),
  maxInputChars: Schema.number().min(1).step(1),
})

/** Cordis validates and fills defaults before mounting the plugin. */
export const Config: Schema<Record<string, unknown>, Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  apiKey: Schema.string().role('secret').required(),
  endpoint: Schema.string().default('https://openrouter.ai/api/alpha/decisions'),
  jevModel: Schema.string().default('typesafe/jev-1.13'),
  models: Schema.object({ economy: route.required(), frontier: route.required() }).required(),
  economyThreshold: Schema.number().min(0.5).max(1).default(0.8),
  newTaskThreshold: Schema.number().min(0.5).max(1).default(0.9),
  timeoutMs: Schema.number().min(1).max(60000).step(1).default(3000),
  maxRoutingBytes: Schema.number().min(1024).max(24000).step(1).default(16000),
  historyMessages: Schema.number().min(0).max(100).step(1).default(0),
  fallbackTier: Schema.union(['economy', 'frontier']).default('frontier'),
  includeSubagents: Schema.boolean().default(true),
})

/** Reject ambiguous or invalid deployment settings before accepting any turns. */
export function validateConfig(config: Config): void {
  if (!config.apiKey.trim()) throw new Error('jev-router: apiKey must not be blank')
  if (!config.jevModel.trim()) throw new Error('jev-router: jevModel must not be blank')
  const url = new URL(config.endpoint)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('jev-router: endpoint must be an HTTP(S) URL without credentials')
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('jev-router: remote endpoints must use HTTPS')
  }
  for (const [tier, model] of Object.entries(config.models)) {
    if (!model.provider.trim() || !model.model.trim()) throw new Error(`jev-router: ${tier} needs provider and model`)
    if (model.description.length > 2000) throw new Error(`jev-router: ${tier} description exceeds 2000 characters`)
    if (model.reasoningEffort !== undefined && !model.reasoningEffort.trim()) throw new Error('jev-router: reasoningEffort must not be blank')
  }
}
