import { describe, expect, test } from 'vitest'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Config, resolveConfig, validateConfig } from '../src/config.js'
import { eligibleModels, routingState } from '../src/routing.js'
import { parseDecision } from '../src/jev.js'
import { config, decision } from './helpers.js'

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const input = { messages: [user('Translate 你好 into English')], history: [], toolsAvailable: false, systemChars: 0 }

describe('routing policy', () => {
  test('accepts only exact candidate choices returned by Jev', () => {
    expect(parseDecision(decision(0.95), 2).choice).toBe(0)
    expect(parseDecision(decision(0.05), 2).choice).toBe(1)
    expect(() => parseDecision(decision(0.05), 1)).toThrow('invalid model answer')
    expect(() => parseDecision({ answers: { model: { type: 'choice', choice: 'model_99' } } }, 2)).toThrow()
  })
  test('excludes injected user-role notices from classifier history', () => {
    const notice = createUserMessage({ content: [{ type: 'text', text: 'internal context '.repeat(2000) }],
      source: { kind: 'jev-router', form: 'notice', summary: boundContextSummary('test notice') } })
    const state = routingState(config({ historyMessages: 2 }), { ...input, history: [user('actual task'), notice] })!
    expect(state.recentHistory).toEqual([{ role: 'user', text: 'actual task' }])
    expect(state.historyTruncated).toBe(false)
  })
  test('uses Host model metadata and filters explicit image incompatibility', () => {
    const models = [
      { provider: 'mock', id: 'small', name: 'Small', inputModalities: ['text' as const] },
      { provider: 'mock', id: 'large', name: 'Large', description: 'Complex tasks', inputModalities: ['text' as const, 'image' as const] },
    ]
    expect(eligibleModels(models, input).map(m => m.model)).toEqual(['small', 'large'])
    const image = createUserMessage({ content: [{ type: 'image', attachment: {} as never }], source: { kind: 'user' } })
    expect(eligibleModels(models, { ...input, messages: [image] }).map(m => m.model)).toEqual(['large'])
  })
  test('bounds JSON payloads without truncating the current request', () => {
    const c = config({ maxRoutingBytes: 1024, historyMessages: 2 })
    expect(routingState(c, { ...input, messages: [user('中'.repeat(1100))] })).toBeUndefined()
    expect(routingState(c, { ...input, messages: [user('中'.repeat(400))] })).toBeUndefined()
    const state = routingState(c, { ...input, history: [user('old'), user('x'.repeat(2000)), user('recent context')] })!
    expect(Buffer.byteLength(JSON.stringify(state), 'utf8')).toBeLessThanOrEqual(1024)
    expect(state.historyTruncated).toBe(true)
    expect(state.recentHistory).toEqual([{ role: 'user', text: 'recent context' }])
  })
  test('defaults to task anchor and omits history when configured to zero', () => {
    const state = routingState(config(), { ...input, currentTask: 'Design a recovery protocol', history: [user('old request')] })!
    expect(state.currentTask).toBe('Design a recovery protocol')
    expect(state.recentHistory).toEqual([])
    expect(state.historyTruncated).toBe(true)
  })
  test('validates Jev settings without requiring per-model routes', () => {
    const initial = resolveConfig(Config({}))
    expect(initial.apiKeyEnv).toBe('OPENROUTER_API_KEY')
    expect(() => validateConfig(initial)).not.toThrow()
    expect(() => validateConfig(config({ endpoint: 'http://example.com/decisions' }))).toThrow()
    expect(() => validateConfig(config({ apiKeyEnv: 'bad-ref!' }))).toThrow()
  })
})
