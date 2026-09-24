import { afterEach, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { Session } from '@deepseek-ai/dsh-session'
import { config, decision, harness, send, toolResponse } from './helpers.js'
import { AUTO, openRoutingStore, sessionRouting, taskContext } from '../src/mode.js'
import * as plugin from '../src/index.js'


const contexts: Context[] = []
const servers: Server[] = []

test('a credential reference supplies the Jev request key without inline config', async () => {
  const name = 'JEV_ROUTER_TEST_KEY'
  const previous = process.env[name]
  process.env[name] = 'key-from-reference'
  try {
    const headers: string[] = []
    const h = await setup(endpoint(request => {
      headers.push(request.headers.get('authorization') ?? '')
      return Response.json(decision(0.95))
    }), { apiKey: undefined, apiKeyEnv: name })
    await send(await h.createAgent(), 'Translate hello')
    expect(headers).toEqual(['Bearer key-from-reference'])
    expect(h.errors).toEqual([])
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
})

test('returning from manual to Auto starts with no stale task anchor', async () => {
  const inputs: { state: { currentTask: string | null } }[] = []
  const h = await setup(endpoint(async request => {
    inputs.push(await request.json() as typeof inputs[number])
    return Response.json(decision(0.99, 0.99))
  }))
  const agent = await h.createAgent()
  await send(agent, 'Translate hello')
  agent.session.append('model/selection', { provider: 'mock', model: 'small' })
  await send(agent, 'Manual task')
  agent.session.append('model/selection', AUTO)
  await send(agent, 'A fresh automatic task')
  expect(inputs.map(i => i.state.currentTask)).toEqual([null, null])
  expect(h.records.at(-1)?.taskStartTurn).toBe(3)
  const restored = Session.create(agent.id, agent.session.snapshotEvents())
  expect(taskContext(restored)).toEqual({ turn: 3, text: 'A fresh automatic task' })
  await h.fiber.dispose()
  const store = await openRoutingStore(h.ctx)
  try { expect(store.read(restored)).toMatchObject({ taskRelation: 'new-task', newTaskProbability: 0.99 }) }
  finally { await store.close() }
})

test('plugin reload recovers the task anchor from its storage domain', async () => {
  let calls = 0
  const url = await endpoint(() => Response.json(decision(++calls === 1 ? 0.05 : 0.99)))
  const h = await setup(url)
  const agent = await h.createAgent()
  await send(agent, 'Design a database recovery protocol')
  await h.fiber.dispose()
  await h.ctx.plugin(plugin, { ...config({ endpoint: url }) })
  await send(agent, 'Summarize that briefly')
  expect(h.errors).toEqual([])
  expect(h.adapter.requests.map(request => request.model)).toEqual(['large', 'small'])
  expect(h.records[1]).toMatchObject({ reason: 'jev', taskStartTurn: 1 })
})

test('Jev selects directly from Host models on every new turn', async () => {
  const replies = [decision(0.95), decision(0.05), decision(0.99), decision(0.99, 0.7), decision(0.99, 0.98)]
  const inputs: { state: { currentModel: { model: string } | null; currentTask: string | null } }[] = []
  const h = await setup(endpoint(async request => {
    inputs.push(await request.json() as typeof inputs[number])
    return Response.json(replies.shift())
  }))
  const agent = await h.createAgent()
  for (const prompt of ['Translate this document', 'Resolve its ambiguous legal terminology', 'Explain that briefly', 'Maybe translate another part', 'New task: extract names from this list']) await send(agent, prompt)
  expect(h.errors).toEqual([])
  expect(h.adapter.requests.map(r => r.model)).toEqual(['small', 'large', 'small', 'small', 'small'])
  expect(inputs[0]!.state.currentModel).toBeNull()
  expect(inputs[2]!.state).toMatchObject({ currentModel: { model: 'large' }, currentTask: 'Translate this document' })
  expect(h.records.map(r => r.taskStartTurn)).toEqual([1, 1, 1, 1, 5])
  expect(h.records.map(r => r.switched)).toEqual([false, true, true, false, false])
  expect(h.records[2]!.reason).toBe('jev')
  const restored = Session.create(agent.id, agent.session.snapshotEvents())
  expect(taskContext(restored)).toEqual({ turn: 5, text: 'New task: extract names from this list' })
  expect(restored.requestHeader()?.config.model).toBe('small')
  expect(new Set(h.adapter.requests.map(r => r.sessionId))).toEqual(new Set([agent.id]))
})

test.each(['http', 'malformed', 'timeout'])('Jev %s failure retains the existing model', async failure => {
  let calls = 0
  const h = await setup(endpoint(() => {
    if (++calls === 1) return Response.json(decision(0.99))
    if (failure === 'timeout') return new Promise(() => {})
    return failure === 'http' ? new Response('', { status: 503 }) : Response.json({ answers: {} })
  }), { timeoutMs: 50 })
  const agent = await h.createAgent()
  await send(agent, 'Translate this')
  await send(agent, 'Continue')
  expect(h.errors).toEqual([])
  expect(h.adapter.requests.map(r => r.model)).toEqual(['small', 'small'])
  expect(h.records[1]).toMatchObject({ reason: 'jev-unavailable-retained', taskStartTurn: 1, switched: false })
})

test('oversized classifier input preserves an eligible incumbent without a Jev request', async () => {
  let calls = 0
  const h = await setup(endpoint(() => { calls++; return Response.json(decision(0.99)) }), { maxRoutingBytes: 1024 })
  const agent = await h.createAgent()
  await send(agent, 'Translate this')
  await send(agent, 'x'.repeat(2000))
  expect(h.adapter.requests.map(r => r.model)).toEqual(['small', 'small'])
  expect(calls).toBe(1)
})

test('manual selection bypasses Jev and Auto restores routing with durable intent', async () => {
  let calls = 0
  const h = await setup(endpoint(() => { calls++; return Response.json(decision(0.05)) }))
  const agent = await h.createAgent('small')
  agent.session.append('model/selection', { provider: 'mock', model: 'small' })
  await send(agent, 'Complex systems design')
  expect(calls).toBe(0)
  expect(h.adapter.requests.at(-1)?.model).toBe('small')
  agent.session.append('model/selection', AUTO)
  await send(agent, 'Complex systems design')
  expect(calls).toBe(1)
  expect(h.adapter.requests.at(-1)?.model).toBe('large')
  const routingEvents = agent.session.snapshotEvents().filter(event => event.type === 'jev-router/routing')
  expect(routingEvents).toEqual([])
  const restored = Session.create(agent.id, agent.session.snapshotEvents())
  expect(sessionRouting(restored)).toMatchObject({ mode: 'auto', status: 'selected', model: 'large' })
  expect(h.ctx.sessionProjections.snapshot(agent.session).values.jevRouting).toMatchObject({ mode: 'auto', model: 'large' })
  expect(h.errors).toEqual([])
})

test('a manual selection during an automatic turn applies to the next turn only', async () => {
  let calls = 0
  const h = await setup(endpoint(() => { calls++; return Response.json(decision(0.95)) }))
  h.adapter.script.push(toolResponse())
  const agent = await h.createAgent('large')
  h.ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'Echo', parameters: { text: { type: 'string', required: true } },
    execute: async () => {
      agent.session.append('model/selection', { provider: 'mock', model: 'large' })
      return [{ type: 'text', text: 'done' }]
    },
  }))
  await send(agent, 'Run echo')
  expect(h.adapter.requests.map(request => request.model)).toEqual(['small', 'small'])
  await send(agent, 'Continue manually')
  expect(h.adapter.requests.at(-1)?.model).toBe('large')
  expect(calls).toBe(1)
  expect(h.errors).toEqual([])
})
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function endpoint(handler: (request: Request) => Response | Promise<Response>) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const result = await handler(new Request(`http://127.0.0.1${request.url}`, {
      method: 'POST', headers: request.headers as Record<string, string>, body: Buffer.concat(chunks),
    }))
    response.writeHead(result.status, Object.fromEntries(result.headers))
    response.end(Buffer.from(await result.arrayBuffer()))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Test server did not bind TCP')
  return `http://127.0.0.1:${address.port}/api/alpha/decisions`
}

async function setup(url: string | Promise<string>, overrides: Record<string, unknown> = {}) {
  const h = await harness(config({ endpoint: await url, ...overrides }))
  contexts.push(h.ctx)
  return h
}

test('routes two turns, preserves history and persists the actual model in replay', async () => {
  type Body = { model: string; state: { recentHistory: unknown[] }; questions: { model: { type: string; criteria: Record<string, string> } } }
  const calls: Body[] = []
  const h = await setup(endpoint(async request => {
    expect(new URL(request.url).pathname).toBe('/api/alpha/decisions')
    expect(request.headers.get('authorization')).toBe('Bearer test-only')
    calls.push(await request.json() as Body)
    return Response.json(decision(calls.length === 1 ? 0.95 : 0.05))
  }), { historyMessages: 6 })
  const agent = await h.createAgent()
  h.ctx.on('llm/stream', (request, next) => {
    const replay = Session.create(agent.id, agent.session.snapshotEvents())
    expect(replay.deriveMessages()).toEqual(request.messages)
    expect(replay.requestHeader()?.config.model).toBe(request.model)
    return next()
  })
  h.ctx.systemPrompt.section({ name: 'identity', order: 0, text: 'Selected model: {{model}}' })
  await send(agent, 'Translate 你好 into English')
  await send(agent, 'Now debug a distributed deadlock across these services')
  expect(h.errors).toEqual([])
  expect(h.adapter.requests.map(r => r.model)).toEqual(['small', 'large'])
  expect(calls).toHaveLength(2)
  expect(calls[1]!.state.recentHistory.length).toBeGreaterThan(0)
  expect(calls[0]!.model).toBe('typesafe/jev-1.13')
  expect(calls[0]!.questions.model.type).toBe('choice')
  expect(calls[0]!.questions.model.criteria.model_0).toContain('small')
  expect(JSON.stringify(h.adapter.requests[0]!.messages)).toContain('Selected model: small')
  expect(JSON.stringify(h.adapter.requests[1]!.messages)).toContain('Selected model: large')
  const notices = h.adapter.requests[1]!.messages.filter(message => message.source?.kind === 'jev-router')
  expect(notices).toHaveLength(1)
  expect(notices[0]!.source).toMatchObject({ kind: 'jev-router', form: 'notice', summary: 'small → large' })
  expect(h.adapter.requests[1]!.messages.some(message => String(message.source?.kind) === 'plugin')).toBe(false)
  const replay = Session.create(agent.id, agent.session.snapshotEvents())
  expect(replay.requestHeader()?.config.model).toBe('large')
  expect(h.records.map(r => r.model)).toEqual(['small', 'large'])
})

test('one Jev call covers tool continuations and produces no incorrect baseline switch notice', async () => {
  let calls = 0
  const h = await setup(endpoint(() => { calls++; return Response.json(decision(0.95)) }))
  h.adapter.script.push(toolResponse())
  const agent = await h.createAgent('large')
  let executions = 0
  h.ctx.tools.register(defineContentToolFixture({
    name: 'echo', description: 'Echo a string', parameters: { text: { type: 'string', required: true } },
    async execute({ text }) {
      executions++
      agent.steer(createUserMessage({ content: [{ type: 'text', text: 'Also explain the result' }], source: { kind: 'user' } }))
      return [{ type: 'text', text }]
    },
  }))
  await send(agent, 'Run echo then report the result')
  expect(h.errors).toEqual([])
  expect(calls).toBe(1)
  expect(executions).toBe(1)
  expect(h.adapter.requests.map(r => r.model)).toEqual(['small', 'small'])
  expect(JSON.stringify(h.adapter.requests[1]!.messages)).not.toContain('continues with large')
  expect(h.records).toHaveLength(1)
})

test('concurrent agents keep separate decisions', async () => {
  const h = await setup(endpoint(async request => {
    const body = await request.json() as { state: { currentMessages: { text: string }[] } }
    return Response.json(decision(body.state.currentMessages[0]!.text === 'easy' ? 0.95 : 0.05))
  }))
  const [a, b] = await Promise.all([h.createAgent(), h.createAgent()])
  await Promise.all([send(a, 'easy'), send(b, 'hard')])
  expect(h.errors).toEqual([])
  expect(a.session.requestHeader()?.config.model).toBe('small')
  expect(b.session.requestHeader()?.config.model).toBe('large')
})

test('UI prompt previews never call Jev', async () => {
  let calls = 0
  const h = await setup(endpoint(() => { calls++; return Response.json(decision(0.9)) }))
  const agent = await h.createAgent()
  await h.ctx.systemPrompt.assemble(assembleContextFor(agent))
  expect(calls).toBe(0)
  expect(h.adapter.requests).toHaveLength(0)
})

test.each([['HTTP failure', () => new Response('private-provider-error', { status: 503 })],
  ['invalid answer', () => Response.json({ answers: {} })]] as const)('%s falls back once for the whole turn', async (_label, respond) => {
  let calls = 0
  const h = await setup(endpoint(() => { calls++; return respond() }))
  h.adapter.script.push(toolResponse())
  await send(await h.createAgent(), 'Translate 你好')
  expect(h.errors).toEqual([])
  expect(calls).toBe(1)
  expect(h.adapter.requests.map(r => r.model)).toEqual(['small', 'small'])
  expect(h.records[0]!.reason).toBe('jev-unavailable')
})

test('timeout falls back without waiting for a hanging Jev response', async () => {
  const h = await setup(endpoint(() => new Promise(() => {})), { timeoutMs: 30 })
  await send(await h.createAgent(), 'Translate this')
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]!.model).toBe('small')
  expect(h.records[0]!.reason).toBe('jev-unavailable')
})

test('user cancellation during Jev does not invoke a fallback model', async () => {
  const entered = Promise.withResolvers<void>()
  const h = await setup(endpoint(() => { entered.resolve(); return new Promise(() => {}) }))
  const agent = await h.createAgent()
  const sent = send(agent, 'Cancel this')
  await entered.promise
  agent.cancel({ kind: 'user' })
  await sent
  expect(h.adapter.requests).toHaveLength(0)
  expect(h.records).toHaveLength(0)
})

test('plugin unload cancels its Jev call and removes routing listeners', async () => {
  const entered = Promise.withResolvers<void>()
  const h = await setup(endpoint(() => { entered.resolve(); return new Promise(() => {}) }))
  const agent = await h.createAgent()
  const sent = send(agent, 'Pending task')
  await entered.promise
  await h.fiber.dispose()
  await sent
  expect(h.adapter.requests).toHaveLength(0)
  await send(agent, 'Normal baseline after unload')
  expect(h.adapter.requests[0]!.model).toBe('large')
})

test('routing clears an inherited effort that the Jev-chosen model may not honor', async () => {
  const h = await setup(endpoint(() => Response.json(decision(0.95))))
  h.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), reasoningEffort: ReasoningEffortId('high') }))
  await send(await h.createAgent(), 'Translate this')
  expect(h.errors).toEqual([])
  expect(h.adapter.requests[0]!.reasoningEffort).toBeUndefined()
})

test('disabled plugin leaves the existing model selection intact', async () => {
  let calls = 0
  const h = await setup(endpoint(() => { calls++; return Response.json(decision(0.95)) }), { enabled: false })
  await send(await h.createAgent(), 'Translate this')
  expect(calls).toBe(0)
  expect(h.adapter.requests[0]!.model).toBe('large')
})

test('no Host model fails before making paid requests', async () => {
  let calls = 0
  const h = await setup(endpoint(() => { calls++; return Response.json(decision(0.95)) }))
  h.adapter.listModels = () => Promise.resolve([])
  await send(await h.createAgent(), 'Translate this')
  expect(calls).toBe(0)
  expect(h.adapter.requests).toHaveLength(0)
  expect(String(h.errors[0])).toContain('no available models')
})

test('loading the plugin does not take over a concrete default without an Auto selection', async () => {
  let calls = 0
  const h = await setup(endpoint(() => { calls++; return Response.json(decision(0.95)) }))
  const agent = await h.createAgent('large', false)
  await send(agent, 'Keep my existing model')
  expect(calls).toBe(0)
  expect(h.adapter.requests[0]?.model).toBe('large')
  expect(agent.session.snapshotEvents().some(event => event.type === 'jev-router/routing')).toBe(false)
})

test('unloading removes Auto and permits reopening the plugin storage domain', async () => {
  const h = await setup(endpoint(() => Response.json(decision(0.95))))
  const agent = await h.createAgent()
  await send(agent, 'Translate hello')
  await h.fiber.dispose()
  expect(h.ctx.llm.listProviders().some(provider => provider.id === AUTO.provider)).toBe(false)
  const store = await openRoutingStore(h.ctx)
  try {
    expect(store.read(agent.session)).toMatchObject({ provider: 'mock', model: 'small', taskStartTurn: 1 })
  } finally { await store.close() }
})


test('default Auto preserves the initiating task when recording its standard selection', async () => {
  const tasks: unknown[] = []
  const h = await setup(endpoint(async request => {
    const body = await request.json() as { state: { currentTask: unknown } }
    tasks.push(body.state.currentTask)
    return Response.json(decision(0.95))
  }))
  const agent = await h.createAgent(AUTO, false)
  await send(agent, 'Translate hello')
  await send(agent, 'Make it shorter')
  expect(h.errors).toEqual([])
  expect(tasks[1]).toBe('Translate hello')
  expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
})
