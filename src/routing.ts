import type { ContentBlock, Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Config, ModelRoute, Tier } from './config.js'
import type { JevDecision, RoutingState } from './jev.js'

/** Input facts collected before the first model request in a turn. */
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
      // Do not send hidden reasoning or binary attachment data to the classifier.
      case 'reasoning': return ''
      default: return `[${block.type} content omitted]`
    }
  }).join('\n')
}

function hasNonText(blocks: readonly ContentBlock[]): boolean {
  return blocks.some(block => block.type === 'image' || block.type === 'file')
}

function hasImages(blocks: readonly ContentBlock[]): boolean {
  return blocks.some(block => block.type === 'image')
}

/** Filter declared capabilities and operator input limits before asking Jev. */
export function eligibleTiers(config: Config, input: RoutingInput): Tier[] {
  const messages = [...input.history, ...input.messages]
  const imagesPresent = messages.some(message => hasImages(message.content))
  const inputChars = input.systemChars + messages.reduce((sum, message) => sum + JSON.stringify(message.content).length, 0)
  return (['economy', 'frontier'] as const).filter(tier => {
    const route = config.models[tier]
    return (!input.toolsAvailable || route.supportsTools)
      && (!imagesPresent || route.supportsImages)
      && (route.maxInputChars === undefined || inputChars <= route.maxInputChars)
  })
}

/** Jev is text-only; omit binary content and bound the serialized routing state. */
export function routingState(config: Config, input: RoutingInput): RoutingState | undefined {
  if ([...input.history, ...input.messages].some(message => hasNonText(message.content))) return undefined
  const state: RoutingState = {
    currentMessages: input.messages.map(message => ({ role: message.role, text: textOf(message.content) })),
    recentHistory: [],
    historyTruncated: false,
    toolsAvailable: input.toolsAvailable,
    currentModel: input.currentModel ?? null,
    currentTask: input.currentTask ?? null,
  }
  // Never truncate the current request and pretend the classifier saw all of it.
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > config.maxRoutingBytes) return undefined
  const history = input.history.filter(message => message.role !== 'system'
    && (message.role !== 'user' || message.source.kind === 'user'))
  const recent = config.historyMessages === 0 ? [] : history.slice(-config.historyMessages)
  state.historyTruncated = recent.length < history.length
  for (const message of recent.toReversed()) {
    state.recentHistory.unshift({ role: message.role, text: textOf(message.content) })
    if (Buffer.byteLength(JSON.stringify(state), 'utf8') > config.maxRoutingBytes) {
      state.recentHistory.shift()
      state.historyTruncated = true
      break
    }
  }
  return state
}

/** The threshold is a tunable policy, not a guarantee of task quality. */
export function chooseTier(config: Config, decision: JevDecision): Tier {
  return decision.choice === 'economy' && decision.economyProbability >= config.economyThreshold ? 'economy' : 'frontier'
}

/** Classifier probabilities are policy signals, not calibrated success rates. */
export function startsNewTask(config: Config, decision: JevDecision): boolean {
  return decision.taskRelation === 'new-task' && decision.newTaskProbability >= config.newTaskThreshold
}

/** Retain a frontier route on follow-ups; quality-driven upgrades remain immediate. */
export function stickyTier(config: Config, decision: JevDecision, current?: Tier): Tier {
  const candidate = chooseTier(config, decision)
  return current === 'frontier' && candidate === 'economy' && !startsNewTask(config, decision)
    ? current : candidate
}

/** Select only from eligible routes; unavailable capabilities never fall through. */
export function fallbackTier(config: Config, eligible: Tier[]): Tier {
  const tier = eligible.includes(config.fallbackTier) ? config.fallbackTier : eligible[0]
  if (tier === undefined) throw new Error('jev-router: no configured model can handle this turn')
  return tier
}

/** Stable policy metadata, without input text or provider credentials. */
export interface RoutingRecord {
  turn: number
  tier: Tier
  provider: string
  model: string
  reason: 'jev' | 'uncertain' | 'capability' | 'input-not-classifiable' | 'jev-unavailable' | 'session-sticky' | 'jev-unavailable-retained'
  taskStartTurn: number
  switched: boolean
  previousModel?: string
  taskRelation?: JevDecision['taskRelation']
  newTaskProbability?: number
  latencyMs: number
  economyProbability?: number
  jevCost?: number
  jevInputTokens?: number
}

/** A decision pinned for the remainder of one turn. */
export interface Selection {
  route: ModelRoute
  record: RoutingRecord
}
