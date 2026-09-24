import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { createServer } from 'node:http'

const hostImport = path => import(pathToFileURL(join(process.env.JEV_TEST_HOST, path)).href)
const { LlmAdapter, createUserMessage } = await hostImport('packages/llm/llm/lib/index.js')
const { installModelSelection } = await hostImport('packages/core/agent/lib/index.js')
const { Session, SessionId } = await hostImport('packages/core/session/lib/index.js')
export const inject = ['llm', 'agentLoop', 'sessionProjections', 'sessionController', 'workspaceRegistry']
export async function apply(ctx) {
  const requests = []
  const errors = []
  const decisions = []
  class Adapter extends LlmAdapter {
    async listModels(provider) { return ['small', 'large'].map(id => ({ provider, id, name: `Smoke ${id}` })) }
    async resolveModel(provider, model) { return { provider, id: model, name: `Smoke ${model}` } }
    async *stream(options) {
      requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Local fixture response' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Local fixture response' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['router-smoke'], new Adapter()))
  ctx.on('agent/error', ({ error }) => errors.push(error))
  ctx.on('jev-router/decision', ({ decision }) => decisions.push(decision))
  let started = false
  async function verify() {
    if (started || !ctx.llm.listProviders().some(provider => provider.id === 'jev-router')) return
    started = true
    try {
      const auto = { provider: 'jev-router', model: 'auto' }
      const agent = await ctx.agentLoop.create(SessionId('stock-router-smoke'), auto, { cwd: process.env.JEV_TEST_HOST })
      const selection = { current: auto, assembled: undefined }
      installModelSelection(agent.ctx, selection)
      for (const [index, text] of ['Translate hello', 'Design a recovery protocol'].entries()) {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await agent.whenIdle()
        assert.deepEqual(errors, [])
        assert.equal(decisions.at(-1)?.reason, 'jev', JSON.stringify(decisions))
        assert.equal(agent.session.requestHeader()?.config.model, index === 0 ? 'small' : 'large')
        const view = ctx.sessionProjections.snapshot(agent.session).values
        assert.deepEqual(view.modelSelection.next, auto, 'stock picker must retain Auto')
        assert.equal(view.modelSelection.lastUsed.model, index === 0 ? 'small' : 'large')
        assert.equal(view.jevRouting.mode, 'auto')
        assert.equal(view.jevRouting.model, index === 0 ? 'small' : 'large')
      }
      assert.ok(requests.some(request => request.model === 'small'))
      assert.ok(requests.some(request => request.model === 'large'))
      selection.current = { provider: 'router-smoke', model: 'small' }
      agent.session.append('model/selection', selection.current)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Manual choice' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      assert.deepEqual(errors, [])
      assert.equal(agent.session.requestHeader()?.config.model, 'small')
      assert.equal(decisions.length, 2, 'manual mode must bypass Jev')
      const events = JSON.parse(JSON.stringify(agent.session.snapshotEvents()))
      assert.ok(!events.some(event => event.type === 'jev-router/routing'))
      assert.deepEqual(Session.create(agent.id, events).deriveMessages(), agent.session.deriveMessages())
      // Leave the persisted fixture in Auto for the optional browser check.
      agent.session.append('model/selection', auto)
      const workspace = await ctx.workspaceRegistry.create(process.env.JEV_TEST_HOST, 'Router smoke test')
      await workspace.attachSession(agent.id)
      process.stdout.write('DSH_ROUTER_HOST_READY\n')
    } catch (error) {
      console.error('DSH_ROUTER_HOST_FAILED', error)
    }
  }
  const server = createServer(async (_request, response) => {
    if (!ctx.llm.listProviders().some(provider => provider.id === 'jev-router')) {
      response.statusCode = 503; response.end('waiting for router'); return
    }
    await verify()
    response.end('done')
  })
  ctx.effect(() => () => { server.closeAllConnections(); server.close() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  process.stdout.write(`DSH_ROUTER_PROBE=http://127.0.0.1:${server.address().port}\n`)
}
