import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { AUTO } from '../src/mode.js'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.js'
import { Config, resolveConfig } from '../src/config.js'

export function config(overrides: Record<string, unknown> = {}): Config {
  const resolved = resolveConfig(Config({
    apiKey: 'test-only',
    ...overrides,
  }))
  return resolved
}

export function decision(economy: number, newTask = 0.05) {
  return { answers: {
    model: { type: 'choice', choice: economy > 0.5 ? 'model_0' : 'model_1', probabilities: { model_0: economy, model_1: 1 - economy } },
    taskRelation: { type: 'choice', choice: newTask > 0.5 ? 'new-task' : 'continuation', probabilities: { 'new-task': newTask, continuation: 1 - newTask } },
  }, usage: { cost: 0.00001, input_tokens: 100 } }
}

export function textResponse(text = 'done'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export function toolResponse(): StreamChunk[] {
  const id = ToolCallId('call-one')
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'echo', argumentsDelta: '{"text":"hello"}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'echo', arguments: '{"text":"hello"}' } },
    { type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

export class RecordingAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  script: StreamChunk[][] = []
  override listModels(provider: string) {
    return Promise.resolve([
      { provider, id: 'small', name: 'Small model' },
      { provider, id: 'large', name: 'Large model' },
    ])
  }
  override async resolveModel(provider: string, model: string) {
    return {
      provider, id: model, name: model,
      ...(model === 'large' ? { reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } } : {}),
    }
  }
  async *stream(options: GenerateOptions) {
    this.requests.push(options)
    yield* this.script.shift() ?? textResponse()
  }
}

export async function harness(configuration: Config) {
  const ctx = new Context()
  const storageRoot = await mkdtemp(join(tmpdir(), 'jev-test-'))
  ctx.effect(() => () => rm(storageRoot, { recursive: true, force: true }))
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: storageRoot })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const fiber = ctx.plugin(plugin, { ...configuration })
  await fiber
  const records: plugin.RoutingRecord[] = []
  ctx.on('jev-router/decision', ({ decision }) => { records.push(decision) })
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  let number = 0
  async function createAgent(baseline: string | { provider: string; model: string } = 'large', automatic = true): Promise<Agent> {
    const route = typeof baseline === 'string' ? { provider: 'mock', model: baseline } : baseline
    const agent = await ctx.agentLoop.create(SessionId(`agent-${++number}`), route)
    const selection: ModelSelectionRef = { current: route, assembled: undefined }
    installModelSelection(agent.ctx, selection)
    if (automatic) agent.session.append('model/selection', AUTO)
    return agent
  }
  return { ctx, adapter, fiber, records, errors, createAgent }
}

export async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}
