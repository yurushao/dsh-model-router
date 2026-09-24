import type { ContentBlock, Message, UserMessage, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { Config } from './config.js'
import type { RoutingState } from './jev.js'

export interface ModelRoute {
  provider: string
  model: string
  name: string
  description?: string
}

export interface RoutingInput {
  messages: readonly UserMessage[]
  history: readonly Message[]
  toolsAvailable: boolean
  systemChars: number
  currentModel?: RoutingState['currentModel']
  currentTask?: string | null
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => {
    switch (block.type) {
      case 'text': return block.text
      case 'tool-call': return `[tool: ${block.name}] ${block.arguments}`
      case 'reasoning': return ''
      default: return `[${block.type} content omitted]`
    }
  }).join('\n')
}

function hasNonText(blocks: readonly ContentBlock[]): boolean {
  return blocks.some(block => block.type === 'image' || block.type === 'file')
}

/** Only exclude a model when the Host explicitly says it lacks image input. */
export function eligibleModels(models: readonly LlmModelInfo[], input: RoutingInput): ModelRoute[] {
  const imagesPresent = [...input.history, ...input.messages].some(message =>
    message.content.some(block => block.type === 'image'))
  return models.filter(model => !imagesPresent || model.inputModalities === undefined || model.inputModalities.includes('image'))
    .map(model => ({ provider: model.provider, model: model.id, name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }) }))
}

/** Jev is text-only; omit binary content and bound the serialized routing state. */
export function routingState(config: Config, input: RoutingInput): RoutingState | undefined {
  if ([...input.history, ...input.messages].some(message => hasNonText(message.content))) return undefined
  const state: RoutingState = {
    currentMessages: input.messages.map(message => ({ role: message.role, text: textOf(message.content) })),
    recentHistory: [], historyTruncated: false, toolsAvailable: input.toolsAvailable,
    currentModel: input.currentModel ?? null, currentTask: input.currentTask ?? null,
  }
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > config.maxRoutingBytes) return undefined
  const history = input.history.filter(message => message.role !== 'system'
    && (message.role !== 'user' || message.source.kind === 'user'))
  const recent = config.historyMessages === 0 ? [] : history.slice(-config.historyMessages)
  state.historyTruncated = recent.length < history.length
  for (const message of recent.toReversed()) {
    state.recentHistory.unshift({ role: message.role, text: textOf(message.content) })
    if (Buffer.byteLength(JSON.stringify(state), 'utf8') > config.maxRoutingBytes) {
      state.recentHistory.shift(); state.historyTruncated = true; break
    }
  }
  return state
}

export interface RoutingRecord {
  turn: number
  provider: string
  model: string
  reason: 'jev' | 'single-model' | 'input-not-classifiable' | 'jev-unavailable-retained' | 'jev-unavailable'
  taskStartTurn: number
  switched: boolean
  previousModel?: string
  taskRelation?: 'continuation' | 'new-task'
  newTaskProbability?: number
  latencyMs: number
  jevCost?: number
  jevInputTokens?: number
}

export interface Selection { route: ModelRoute; record: RoutingRecord }
