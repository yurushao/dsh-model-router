import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
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
const storageRoot = await mkdtemp(join(tmpdir(), 'jev-install-storage-'))
const requests = []
const decisions = []
ctx.on('jev-router/decision', ({ decision }) => decisions.push(decision))
let calls = 0
const server = createServer((request, response) => {
  assert.equal(request.headers.authorization, 'Bearer keyless-test')
  const [choice, newTask] = [['model_0', 0.99], ['model_1', 0.99], ['model_1', 0.01]][calls++] ?? []
  request.resume()
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ answers: {
    model: { type: 'choice', choice },
    taskRelation: { type: 'choice', choice: newTask > 0.5 ? 'new-task' : 'continuation', probabilities: { 'new-task': newTask, continuation: 1 - newTask } },
  } }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  for (const service of [LlmRuntime, SessionStore, SessionProjectionRegistry, ToolRuntime, AgentRegistry]) await ctx.plugin(service)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(AgentLoop, { agents: [] })
  class Adapter extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'small', name: 'Small' }, { provider, id: 'large', name: 'Large' }] }
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
  await ctx.plugin(plugin, { apiKey: 'keyless-test', endpoint: `http://127.0.0.1:${server.address().port}/decisions` })
  const errors = []
  ctx.on('agent/error', ({ error }) => errors.push(error))
  const agent = await ctx.agentLoop.create(SessionId('installed-smoke'), { provider: 'test', model: 'large' })
  agent.session.append('model/selection', { provider: 'jev-router', model: 'auto' })
  const selection = { current: { provider: 'test', model: 'large' }, assembled: undefined }
  installModelSelection(agent.ctx, selection)
  for (const prompt of ['Translate hello', 'Design a recovery protocol', 'Explain it briefly']) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  selection.current = { provider: 'test', model: 'small' }
  agent.session.append('model/selection', selection.current)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Manual request' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  assert.deepEqual(errors, [])
  assert.equal(calls, 3, 'manual mode must bypass Jev')
  assert.deepEqual(requests.map(r => r.model), ['small', 'large', 'large', 'small'])
  const events = JSON.parse(JSON.stringify(agent.session.snapshotEvents()))
  const routeEvents = events.filter(e => e.type === 'jev-router/routing')
  assert.equal(routeEvents.length, 0, 'plugin must not append external session event types')
  const restored = Session.create(agent.id, events)
  assert.deepEqual(restored.deriveMessages(), agent.session.deriveMessages())
  assert.equal(decisions.at(-1).reason, 'jev')
  const sidecar = await readFile(join(storageRoot, 'jev_router.json'), 'utf8')
  assert.ok(sidecar.includes('installed-smoke') && sidecar.includes('taskStartTurn'))
  console.log('Packed plugin: Host catalog choice, model switching, manual bypass and JSON session replay passed without external requests.')
} finally {
  await ctx.fiber.dispose()
  await rm(storageRoot, { recursive: true, force: true })
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
