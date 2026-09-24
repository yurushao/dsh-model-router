import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Context } from '@deepseek-ai/cordis'
import { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

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

const routingDomain = defineDomain({
  name: 'jev_router', version: 1,
  tables: { sessions: domainTable(z.object({ selectionSeq: z.number().int(), state: routingSchema })) },
})

/** Persist plugin-owned diagnostics through the public storage-domain service. */
export async function openRoutingStore(ctx: Context) {
  const domain = await ctx.storageDomain.open(routingDomain)
  const sessions = domain.table('sessions')
  return {
    read(session: Session): RoutingView {
      const saved = sessions.get(session.id)
      const intent = routingIntent(session)
      return saved && saved.selectionSeq === intent?.seq ? { ...saved.state, mode: intent.mode } : sessionRouting(session)
    },
    write(session: Session, state: RoutingView, selectionSeq: number): Promise<void> {
      return sessions.put(session.id, { selectionSeq, state })
    },
    close: () => domain.close(),
  }
}

export function routingIntent(session: Session): { mode: 'auto' | 'manual'; seq: number } | undefined {
  for (const event of session.snapshotEvents().toReversed()) {
    const chosen = selection(event)
    if (chosen) return { mode: chosen.provider === AUTO.provider && chosen.model === AUTO.model ? 'auto' : 'manual', seq: event.seq }
  }
  // Older releases stored Auto intent in ignorable router records. Read them
  // once; the next automatic turn writes the standard model/selection event.
  const legacy = session.snapshotEvents().findLast(event => event.type === 'jev-router/routing')
  if (legacy?.type === 'jev-router/routing') return { mode: legacy.data.mode, seq: -1 }
  return undefined
}

export function initialRouting(): RoutingView {
  return { mode: 'manual', status: 'idle', turn: 0, provider: '', model: '', reason: '' }
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
  if (event.type === 'turn/start') return { ...state, turn: event.data.turn }
  if (event.type === 'request/header') return { ...state, status: 'selected', provider: event.data.header.config.provider, model: event.data.header.config.model }
  if (event.type === 'turn/end' && state.status === 'selecting') return { ...state, status: 'idle' }
  return state
}

export function sessionRouting(session: Session): RoutingView {
  const state = session.snapshotEvents().reduce(applyRouting, initialRouting())
  return { ...state, mode: routingIntent(session)?.mode ?? 'manual' }
}

/** Recover the initiating user request from durable history without generating another summary. */
export function taskContext(session: Session, saved?: RoutingView): { turn: number; text: string | null } | undefined {
  let anchor: number | undefined
  let turn = 0
  let turnOpen = false
  const requests = new Map<number, string[]>()
  for (const event of session.snapshotEvents()) {
    const chosen = selection(event)
    if (chosen !== undefined) {
      anchor = undefined
      const current = turnOpen ? requests.get(turn) : undefined
      requests.clear()
      if (current !== undefined) requests.set(turn, current)
    }
    if (event.type === 'jev-router/routing' && event.data.status === 'selected') {
      anchor = event.data.taskStartTurn ?? event.data.turn
    }
    if (event.type === 'turn/start') { turn = event.data.turn; turnOpen = true }
    if (event.type === 'turn/end') turnOpen = false
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const texts = event.data.content.filter(block => block.type === 'text').map(block => block.text)
      requests.set(turn, [...requests.get(turn) ?? [], ...texts])
    }
  }
  anchor = saved?.taskStartTurn ?? anchor ?? [...requests.keys()].at(-1)
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

/** Publish Auto and a read-only projection of standard session events. */
export function installMode(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter([AUTO.provider], new AutoAdapter()))
  const projection = {
    key: 'jevRouting', stateSchema: routingSchema, stateVersion: 2,
    init: initialRouting, apply: applyRouting,
    wire: { viewSchema: routingSchema, view: state => state },
  } satisfies ProjectionDefinition<'jevRouting'>
  ctx.inject(['sessionProjections'], child => { child.sessionProjections.register(projection) })
}
