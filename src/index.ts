import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage, ReasoningEffortId, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { Config, validateConfig, type Tier } from './config.js'
import { decide } from './jev.js'
import { appendRouting, installMode, sessionRouting, taskContext } from './mode.js'
import { chooseTier, eligibleTiers, fallbackTier, routingState, startsNewTask, stickyTier, type RoutingRecord, type Selection } from './routing.js'

export { Config } from './config.js'
export type { ModelRoute, Tier } from './config.js'
export type { RoutingRecord } from './routing.js'

export const name = 'jev-router'
export const inject = ['agents', 'llm', 'systemPrompt']

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
  automatic: boolean
  messages: UserMessage[]
  selection?: Selection
  pending?: Promise<Selection>
}

/** Install per-turn routing through public Harness events; never replace adapters or the loop. */
export function apply(ctx: Context, config: Config): void {
  validateConfig(config)
  if (!config.enabled) return
  installMode(ctx)
  const turns = new WeakMap<Agent, TurnState>()
  const lifetime = new AbortController()
  const pending = new Set<Promise<Selection>>()
  let disposeNotice = () => {}
  ctx.effect(() => async () => {
    lifetime.abort(new Error('jev-router: plugin unloaded'))
    await Promise.allSettled([...pending])
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    if (!config.includeSubagents && agent.session.header.origin === 'subagent') return
    let state = turns.get(agent)
    if (state === undefined || state.turn !== turn) {
      state = { turn, automatic: sessionRouting(agent.session).mode === 'auto', messages: [] }
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
    const started = performance.now()
    const previous = agent.session.requestHeader()?.config
    const current = (['economy', 'frontier'] as const).find(tier =>
      config.models[tier].provider === previous?.provider && config.models[tier].model === previous.model)
    const task = taskContext(agent.session)
    const input = {
      messages: state.messages,
      history: agent.session.deriveMessages(),
      toolsAvailable: assembly.tools.length > 0,
      systemChars: JSON.stringify([assembly.sections, assembly.contexts, assembly.tools]).length,
      currentModel: current === undefined ? null : { tier: current, provider: config.models[current].provider, model: config.models[current].model },
      currentTask: task?.text ?? null,
    }
    const eligible = eligibleTiers(config, input)
    const incumbent: Tier | undefined = current !== undefined && eligible.includes(current) ? current : undefined
    let tier = incumbent ?? fallbackTier(config, eligible)
    let reason: RoutingRecord['reason'] = 'capability'
    let answer: Awaited<ReturnType<typeof decide>> | undefined
    if (eligible.length > 1) {
      const facts = routingState(config, input)
      if (facts === undefined) {
        tier = incumbent ?? 'frontier'
        reason = 'input-not-classifiable'
      } else {
        try {
          answer = await decide(config, facts, signal)
          tier = stickyTier(config, answer, incumbent)
          reason = tier !== chooseTier(config, answer) ? 'session-sticky'
            : answer.choice === tier ? 'jev' : 'uncertain'
        } catch (error: unknown) {
          signal.throwIfAborted()
          // External messages are intentionally excluded from telemetry.
          reason = incumbent === undefined ? 'jev-unavailable' : 'jev-unavailable-retained'
          ctx.logger.warn('jev-router: Jev unavailable or returned invalid data; retaining an eligible current route or using the configured fallback')
        }
      }
    }
    signal.throwIfAborted()
    const route = config.models[tier]
    // Missing adapters and unsupported explicit efforts are deployment errors,
    // not evidence that the prompt should be silently sent to another provider.
    const info = await agent.ctx.llm.resolveModelInfo(route.provider, route.model, signal)
    if (route.reasoningEffort !== undefined && !info.reasoning?.efforts.some(effort => effort.id === route.reasoningEffort)) {
      throw new Error(`jev-router: unsupported reasoning effort for ${tier}`)
    }
    signal.throwIfAborted()
    const record: RoutingRecord = {
      turn: state.turn, tier, provider: route.provider, model: route.model, reason,
      taskStartTurn: current === undefined || (answer !== undefined && startsNewTask(config, answer))
        ? state.turn : task?.turn ?? state.turn,
      switched: previous !== undefined && (previous.provider !== route.provider || previous.model !== route.model),
      ...(previous === undefined ? {} : { previousModel: `${previous.provider}/${previous.model}` }),
      latencyMs: Math.round(performance.now() - started),
      ...(answer === undefined ? {} : { economyProbability: answer.economyProbability }),
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
    if (agent === undefined || state === undefined || !state.automatic || context.signal === undefined) return assembly
    const signal = AbortSignal.any([context.signal, lifetime.signal])
    signal.throwIfAborted()
    if (state.selection === undefined) {
      if (state.pending === undefined) {
        appendRouting(agent.session, { mode: 'auto', status: 'selecting', turn: state.turn,
          provider: '', model: '', reason: '' })
        const work = select(agent, state, assembly, signal)
        state.pending = work
        pending.add(work)
      }
      try {
        const selected = await state.pending
        signal.throwIfAborted()
        if (state.selection === undefined) {
          state.selection = selected
          appendRouting(agent.session, { mode: 'auto', status: 'selected', turn: state.turn,
            provider: selected.route.provider, model: selected.route.model, reason: selected.record.reason,
            taskStartTurn: selected.record.taskStartTurn,
            ...(selected.record.economyProbability === undefined ? {} : { economyProbability: selected.record.economyProbability }),
            ...(selected.record.taskRelation === undefined ? {} : { taskRelation: selected.record.taskRelation }),
            ...(selected.record.newTaskProbability === undefined ? {} : { newTaskProbability: selected.record.newTaskProbability }) })
          ctx.logger.info(`jev-router: ${JSON.stringify({ agentId: agent.id, ...selected.record })}`)
          // Optional observers must not turn a completed routing decision into a failed turn.
          try { ctx.emit('jev-router/decision', { agent, decision: { ...selected.record } }) }
          catch (_error: unknown) { ctx.logger.warn('jev-router: routing observer failed') }
        }
      } catch (error) {
        if (!signal.aborted) appendRouting(agent.session, { mode: 'auto', status: 'failed',
          turn: state.turn, provider: '', model: '', reason: 'routing-failed' })
        throw error
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
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
    }
  }, { prepend: true })
}
