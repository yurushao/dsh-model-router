import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

export const AUTO = { provider: 'jev-router', model: 'auto' } as const

const routingSchema = z.object({
  mode: z.enum(['auto', 'manual']),
  status: z.enum(['idle', 'selecting', 'selected', 'failed']),
  turn: z.number(),
  provider: z.string(),
  model: z.string(),
  reason: z.string(),
  taskStartTurn: z.number().int().positive().optional(),
  economyProbability: z.number().min(0).max(1).optional(),
  taskRelation: z.enum(['continuation', 'new-task']).optional(),
  newTaskProbability: z.number().min(0).max(1).optional(),
})
export type RoutingView = z.infer<typeof routingSchema>

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'jev-router/routing': RoutingView
  }
}
declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap { jevRouting: RoutingView }
  interface SessionProjectionMap { jevRouting: RoutingView }
}

export function appendRouting(session: Session, data: RoutingView): void {
  // The local Harness append extension accepts explicit informational metadata.
  const append: (type: 'jev-router/routing', data: RoutingView, opts: { ignorable: true }) => SessionEvent<'jev-router/routing'> = session.append.bind(session)
  append('jev-router/routing', data, { ignorable: true })
}

export function initialRouting(): RoutingView {
  return { mode: 'auto', status: 'idle', turn: 0, provider: '', model: '', reason: '' }
}

function selection(event: SessionEvent): { provider: string; model: string } | undefined {
  const candidate: { type: string; data: unknown } = event
  if (candidate.type !== 'model/selection' || candidate.data === null || typeof candidate.data !== 'object') return
  if (!('provider' in candidate.data) || !('model' in candidate.data)) return
  const { provider, model } = candidate.data
  if (typeof provider === 'string' && typeof model === 'string') return { provider, model }
}

export function applyRouting(state: RoutingView, event: SessionEvent): RoutingView {
  const chosen = selection(event)
  if (chosen !== undefined) return {
    ...state, mode: chosen.provider === AUTO.provider && chosen.model === AUTO.model ? 'auto' : 'manual',
    status: 'idle',
    reason: '',
  }
  if (event.type === 'jev-router/routing') return { ...event.data, mode: state.mode }
  if (event.type === 'turn/end' && state.status === 'selecting') return { ...state, status: 'idle' }
  return state
}

export function sessionRouting(session: Session): RoutingView {
  return session.snapshotEvents().reduce(applyRouting, initialRouting())
}

/** Recover the initiating user request from durable history without generating another summary. */
export function taskContext(session: Session): { turn: number; text: string | null } | undefined {
  let anchor: number | undefined
  let turn = 0
  const requests = new Map<number, string[]>()
  for (const event of session.snapshotEvents()) {
    const chosen = selection(event)
    if (chosen !== undefined) {
      anchor = undefined
      requests.clear()
    }
    if (event.type === 'jev-router/routing' && event.data.status === 'selected') {
      anchor = event.data.taskStartTurn ?? event.data.turn
    }
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const texts = event.data.content.filter(block => block.type === 'text').map(block => block.text)
      requests.set(turn, [...requests.get(turn) ?? [], ...texts])
    }
  }
  anchor ??= [...requests.keys()].at(-1)
  return anchor === undefined ? undefined : { turn: anchor, text: requests.get(anchor)?.join('\n') ?? null }
}

class AutoAdapter extends LlmAdapter {
  override providerInfo(provider: string) { return { id: provider, name: 'Auto' } }
  override listModels(provider: string) { return Promise.resolve([{ provider, id: AUTO.model, name: 'Auto · Jev' }]) }
  override resolveModel(provider: string, model: string) {
    if (provider !== AUTO.provider || model !== AUTO.model) throw new Error('jev-router: unknown automatic route')
    return Promise.resolve({ provider, id: model, name: 'Auto · Jev' })
  }
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('jev-router: Auto requires an active user turn; choose a model for direct requests')
  }
}

/** Publish selectable Auto mode and prompt-free, durable routing status. */
export function installMode(ctx: Context): void {
  // Reject an unpatched host before writing routing records into any user session.
  const probe = Session.create(SessionId('jev-router-compatibility-check'))
  appendRouting(probe, initialRouting())
  if (probe.snapshotEvents()[0]?.ignorable !== true) {
    throw new Error('jev-router: incompatible Harness Session API; prepare the pinned compatible host with scripts/prepare-harness.mjs (see README Compatibility)')
  }
  ctx.effect(() => ctx.llm.registerAdapter([AUTO.provider], new AutoAdapter()))
  const projection = {
    key: 'jevRouting', stateSchema: routingSchema, stateVersion: 1,
    init: initialRouting, apply: applyRouting,
    wire: { viewSchema: routingSchema, view: state => state },
  } satisfies ProjectionDefinition<'jevRouting'>
  ctx.inject(['sessionProjections'], child => { child.sessionProjections.register(projection) })
}
