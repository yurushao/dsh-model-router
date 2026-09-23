import { describe, expect, test } from 'vitest'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { validateConfig } from '../src/config.js'
import { chooseTier, eligibleTiers, routingState, stickyTier } from '../src/routing.js'
import { parseDecision } from '../src/jev.js'
import { config, decision } from './helpers.js'

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const input = { messages: [user('Translate 你好 into English')], history: [], toolsAvailable: false, systemChars: 0 }

describe('routing policy', () => {
  test('excludes injected user-role notices from classifier history and truncation accounting', () => {
    const notice = createUserMessage({ content: [{ type: 'text', text: 'internal context '.repeat(2000) }],
      source: { kind: 'jev-router', form: 'notice', summary: boundContextSummary('test notice') } })
    const state = routingState(config({ historyMessages: 2 }), { ...input, history: [user('actual task'), notice] })!
    expect(state.recentHistory).toEqual([{ role: 'user', text: 'actual task' }])
    expect(state.historyTruncated).toBe(false)
  })
  test('requires both economy and new-task thresholds before downgrading', () => {
    expect(stickyTier(config(), parseDecision(decision(0.99, 0.89)), 'frontier')).toBe('frontier')
    expect(stickyTier(config(), parseDecision(decision(0.99, 0.9)), 'frontier')).toBe('economy')
    expect(stickyTier(config(), parseDecision(decision(0.79, 0.99)), 'frontier')).toBe('frontier')
    expect(stickyTier(config(), parseDecision(decision(0.1)), 'economy')).toBe('frontier')
    expect(stickyTier(config({ newTaskThreshold: 0.95 }), parseDecision(decision(0.99, 0.9)), 'frontier')).toBe('frontier')
  })
  test('only sufficiently strong economy decisions choose economy', () => {
    expect(chooseTier(config(), parseDecision(decision(0.95)))).toBe('economy')
    expect(chooseTier(config(), parseDecision(decision(0.65)))).toBe('frontier')
    expect(chooseTier(config(), parseDecision(decision(0.1)))).toBe('frontier')
  })
  test('rejects malformed and non-normalized API answers', () => {
    for (const answer of [null, {}, { answers: { tier: { type: 'choice', choice: 'made-up' } } },
      { answers: { tier: { type: 'choice', choice: 'economy', probabilities: { economy: 0.9, frontier: 0.9 } } } }]) {
      expect(() => parseDecision(answer)).toThrow()
    }
  })
  test('filters capabilities and full input budgets before classification', () => {
    const c = config()
    c.models.economy.supportsTools = false
    expect(eligibleTiers(c, { ...input, toolsAvailable: true })).toEqual(['frontier'])
    c.models.frontier.maxInputChars = 1
    expect(eligibleTiers(c, { ...input, toolsAvailable: true })).toEqual([])
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
  test('defaults to the task anchor and never interprets zero history count as all history', () => {
    const state = routingState(config(), { ...input, currentTask: 'Design a recovery protocol', history: [user('old request')] })!
    expect(state.currentTask).toBe('Design a recovery protocol')
    expect(state.currentMessages[0]?.text).toBe('Translate 你好 into English')
    expect(state.recentHistory).toEqual([])
    expect(state.historyTruncated).toBe(true)
    expect(routingState(config({ historyMessages: 0 }), { ...input, history: [user('secret-old-text')] })?.recentHistory).toEqual([])
  })
  test('rejects empty routes and insecure remote endpoints', () => {
    expect(() => validateConfig(config({ endpoint: 'http://example.com/decisions' }))).toThrow()
    const c = config()
    c.models.economy.model = ' '
    expect(() => validateConfig(c)).toThrow()
  })
})
