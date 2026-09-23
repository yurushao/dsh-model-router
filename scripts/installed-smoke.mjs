import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '@yurushao/dsh-model-router'

const ctx = new Context()
const requests = []
let calls = 0
const server = createServer((request, response) => {
  assert.equal(request.headers.authorization, 'Bearer keyless-test')
  const [economy, newTask] = [[0.99, 0.99], [0.01, 0.99], [0.99, 0.01]][calls++] ?? []
  request.resume()
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ answers: {
    tier: { type: 'choice', choice: economy > 0.5 ? 'economy' : 'frontier', probabilities: { economy, frontier: 1 - economy } },
    taskRelation: { type: 'choice', choice: newTask > 0.5 ? 'new-task' : 'continuation', probabilities: { 'new-task': newTask, continuation: 1 - newTask } },
  } }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  for (const service of [LlmRuntime, SessionStore, SessionProjectionRegistry, ToolRuntime, AgentRegistry]) await ctx.plugin(service)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(AgentLoop, { agents: [] })
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'OK' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'OK' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['test'], new Adapter())
  await ctx.plugin(plugin, plugin.Config({ apiKey: 'keyless-test', endpoint: `http://127.0.0.1:${server.address().port}/decisions`,
    models: { economy: { provider: 'test', model: 'small' }, frontier: { provider: 'test', model: 'large' } } }))
  const errors = []
  ctx.on('agent/error', ({ error }) => errors.push(error))
  const agent = await ctx.agentLoop.create(SessionId('installed-smoke'), { provider: 'test', model: 'large' })
  installModelSelection(agent.ctx, { current: { provider: 'test', model: 'large' }, assembled: undefined })
  for (const prompt of ['Translate hello', 'Design a recovery protocol', 'Explain it briefly']) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  agent.session.append('model/selection', { provider: 'test', model: 'small' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Manual request' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  assert.deepEqual(errors, [])
  assert.equal(calls, 3, 'manual mode must bypass Jev')
  // Effective manual route comes from the normal selector; route state is checked separately.
  assert.deepEqual(requests.slice(0, 3).map(r => r.model), ['small', 'large', 'large'])
  const events = JSON.parse(JSON.stringify(agent.session.snapshotEvents()))
  const routeEvents = events.filter(e => e.type === 'jev-router/routing')
  assert.ok(routeEvents.length > 0 && routeEvents.every(e => e.ignorable === true))
  const restored = Session.create(agent.id, events)
  assert.deepEqual(restored.deriveMessages(), agent.session.deriveMessages())
  assert.equal(routeEvents.at(-1).data.reason, 'session-sticky')
  console.log('Packed plugin: economy, upgrade, sticky follow-up, manual bypass and JSON session replay passed without external requests.')
} finally {
  await ctx.fiber.dispose()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
