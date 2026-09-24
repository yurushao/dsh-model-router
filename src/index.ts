import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { Config, resolveConfig, validateConfig, type PluginConfig } from './config.js'
import { decide } from './jev.js'
import { AUTO, installMode, openRoutingStore, routingIntent, taskContext } from './mode.js'
import { eligibleModels, routingState, type RoutingRecord, type Selection } from './routing.js'

export { Config } from './config.js'
export type { ModelRoute } from './routing.js'
export type { RoutingRecord } from './routing.js'

export const name = 'jev-router'
export const inject = ['agents', 'llm', 'systemPrompt', 'storageDomain']

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'jev-router': { kind: 'jev-router' } & ContextFormed
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Process-local routing telemetry. It contains no conversation text. @mode emit */
    'jev-router/decision'(payload: { agent: Agent; decision: RoutingRecord }): void
  }
}

interface TurnState {
  turn: number
  automatic: boolean | undefined
  selectionSeq?: number
  messages: UserMessage[]
  selection?: Selection
  pending?: Promise<Selection>
}

/** Install per-turn routing through public Harness events; never replace adapters or the loop. */
export async function apply(ctx: Context, liveConfig: PluginConfig): Promise<void> {
  if (!liveConfig.enabled) return
  validateConfig(resolveConfig(liveConfig))
  const routing = await openRoutingStore(ctx)
  const turns = new WeakMap<Agent, TurnState>()
  const lifetime = new AbortController()
  const pending = new Set<Promise<Selection>>()
  let disposeNotice = () => {}
  ctx.effect(() => async () => {
    lifetime.abort(new Error('jev-router: plugin unloaded'))
    await Promise.allSettled([...pending])
    await routing.close()
  })
  installMode(ctx)

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (!resolveConfig(liveConfig).includeSubagents && agent.session.header.origin === 'subagent') return
    let state = turns.get(agent)
    if (state === undefined || state.turn !== turn) {
      const intent = routingIntent(agent.session)
      state = { turn, automatic: intent === undefined ? undefined : intent.mode === 'auto',
        ...(intent === undefined || intent.seq < 0 ? {} : { selectionSeq: intent.seq }), messages: [] }
      turns.set(agent, state)
    }
    // Steering and tool continuations cannot change an already selected route.
    if (state.selection === undefined && state.pending === undefined) state.messages.push(message)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') turns.delete(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => { turns.delete(agent) })

  async function select(agent: Agent, state: TurnState, assembly: PromptAssembly, signal: AbortSignal): Promise<Selection> {
    const config = resolveConfig(liveConfig)
    validateConfig(config)
    const started = performance.now()
    const previous = agent.session.requestHeader()?.config
    const providers = agent.ctx.llm.listProviders().filter(provider => provider.id !== 'jev-router')
    const catalog = (await Promise.all(providers.map(provider => agent.ctx.llm.listModels(provider.id)))).flat()
    const inputMessages = { messages: state.messages, history: agent.session.deriveMessages(),
      toolsAvailable: assembly.tools.length > 0, systemChars: JSON.stringify([assembly.sections, assembly.contexts, assembly.tools]).length }
    const candidates = eligibleModels(catalog, inputMessages)
    if (candidates.length === 0) throw new Error('jev-router: no available models in Harness Settings → Models')
    const current = candidates.find(route => route.provider === previous?.provider && route.model === previous.model)
    const task = taskContext(agent.session, routing.read(agent.session))
    const input = {
      ...inputMessages,
      currentModel: current === undefined ? null : { provider: current.provider, model: current.model },
      currentTask: task?.text ?? null,
    }
    let route = current ?? candidates[0]!
    let reason: RoutingRecord['reason'] = 'single-model'
    let answer: Awaited<ReturnType<typeof decide>> | undefined
    if (candidates.length > 1) {
      const facts = routingState(config, input)
      if (facts === undefined) {
        reason = 'input-not-classifiable'
      } else {
        try {
          const credentials = ctx.get('credentials') as { resolve(ref: string): Promise<{ value: string } | undefined> } | undefined
          const apiKey = (await credentials?.resolve(config.apiKeyEnv))?.value ?? config.apiKey ?? process.env[config.apiKeyEnv]
          if (!apiKey?.trim()) throw new Error('jev-router: Jev credential is not configured')
          answer = await decide(config, apiKey, facts, candidates, signal)
          route = candidates[answer.choice]!
          reason = 'jev'
        } catch (error: unknown) {
          signal.throwIfAborted()
          // External messages are intentionally excluded from telemetry.
          reason = current === undefined ? 'jev-unavailable' : 'jev-unavailable-retained'
          ctx.logger.warn('jev-router: Jev unavailable or returned invalid data; retaining an eligible current model or using the first available model')
        }
      }
    }
    signal.throwIfAborted()
    await agent.ctx.llm.resolveModelInfo(route.provider, route.model, signal)
    signal.throwIfAborted()
    const record: RoutingRecord = {
      turn: state.turn, provider: route.provider, model: route.model, reason,
      taskStartTurn: current === undefined || (answer?.taskRelation === 'new-task' && answer.newTaskProbability >= 0.9)
        ? state.turn : task?.turn ?? state.turn,
      switched: previous !== undefined && (previous.provider !== route.provider || previous.model !== route.model),
      ...(previous === undefined ? {} : { previousModel: `${previous.provider}/${previous.model}` }),
      latencyMs: Math.round(performance.now() - started),
      ...(answer === undefined ? {} : { taskRelation: answer.taskRelation, newTaskProbability: answer.newTaskProbability }),
      ...(answer?.cost === undefined ? {} : { jevCost: answer.cost }),
      ...(answer?.inputTokens === undefined ? {} : { jevInputTokens: answer.inputTokens }),
    }
    return { route, record }
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const agent = context.agent
    const state = agent === undefined ? undefined : turns.get(agent)
    // UI previews do not select a model or spend Jev credits.
    if (agent === undefined || state === undefined || context.signal === undefined) return assembly
    state.automatic ??= assembly.variables.provider === AUTO.provider && assembly.variables.model === AUTO.model
    if (!state.automatic) return assembly
    const signal = AbortSignal.any([context.signal, lifetime.signal])
    signal.throwIfAborted()
    if (state.selectionSeq === undefined) state.selectionSeq = agent.session.append('model/selection', AUTO).seq
    if (state.selection === undefined) {
      if (state.pending === undefined) {
        const work = select(agent, state, assembly, signal)
        state.pending = work
        pending.add(work)
      }
      try {
        const selected = await state.pending
        signal.throwIfAborted()
        if (state.selection === undefined) {
          await routing.write(agent.session, { mode: 'auto', status: 'selected', turn: state.turn,
            provider: selected.route.provider, model: selected.route.model, reason: selected.record.reason,
            taskStartTurn: selected.record.taskStartTurn,
            ...(selected.record.taskRelation === undefined ? {} : { taskRelation: selected.record.taskRelation }),
            ...(selected.record.newTaskProbability === undefined ? {} : { newTaskProbability: selected.record.newTaskProbability }) }, state.selectionSeq)
          signal.throwIfAborted()
          state.selection = selected
          ctx.logger.info(`jev-router: ${JSON.stringify({ agentId: agent.id, ...selected.record })}`)
          // Optional observers must not turn a completed routing decision into a failed turn.
          try { ctx.emit('jev-router/decision', { agent, decision: { ...selected.record } }) }
          catch (_error: unknown) { ctx.logger.warn('jev-router: routing observer failed') }
        }
      } finally {
        pending.delete(state.pending)
      }
    }
    const route = state.selection.route
    // Entry points can install their selector after this plugin loads. Place
    // notice normalization outside those listeners before admitting the step.
    installNotice()
    return { ...assembly, variables: { ...assembly.variables, provider: route.provider, model: route.model } }
  }, { prepend: true })

  function installNotice(): void {
    disposeNotice()
    disposeNotice = ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
      const decision = await next()
      const state = turns.get(agent)
      if (decision.kind === 'reject' || signal.aborted || state?.turn !== turn || state.selection === undefined) return decision
      const route = state.selection.route
      // Replace the ordinary selector's notice: that selector may still hold a
      // manually chosen baseline while this plugin owns the effective route.
      const messages = decision.messages.filter(message => message.source.kind !== 'model-selection')
      const previous = agent.session.requestHeader()?.config
      if (messages.length > 0 && previous !== undefined && (previous.provider !== route.provider || previous.model !== route.model)) {
        messages.push(createUserMessage({
          content: [{ type: 'text', text: `[model changed: previous assistant messages used ${previous.provider}/${previous.model}; this turn uses ${route.provider}/${route.model}]` }],
          source: { kind: 'jev-router', form: 'notice', summary: boundContextSummary(`${previous.model} → ${route.model}`) },
        }))
      }
      return { ...decision, messages }
    }, { prepend: true })
  }

  ctx.on('agent/request', async ({ agent, turn, signal }, next) => {
    const resolved = await next()
    signal.throwIfAborted()
    const state = turns.get(agent)
    if (state?.turn !== turn || state.selection === undefined) return resolved
    lifetime.signal.throwIfAborted()
    const route = state.selection.route
    const { reasoningEffort: _previousEffort, ...rest } = resolved
    return {
      ...rest, provider: route.provider, model: route.model,
    }
  }, { prepend: true })
}
