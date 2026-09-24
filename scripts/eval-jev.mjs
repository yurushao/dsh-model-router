import { readFileSync } from 'node:fs'
import { Config, resolveConfig } from '../dist/config.js'
import { decide } from '../dist/jev.js'

if (!process.env.OPENROUTER_API_KEY) throw new Error('Set OPENROUTER_API_KEY for the paid live regression checks')
const config = resolveConfig(Config({ timeoutMs: 10000 }))
const candidates = [
  { provider: 'evaluation', model: 'small', name: 'Small economy model', description: 'Translation, extraction, routine tasks' },
  { provider: 'evaluation', model: 'large', name: 'Large frontier model', description: 'Complex coding, architecture and research' },
]
const cases = [
  ['complex-short', '设计跨分片事务协调器在网络分区和崩溃后的安全协议。', null, 'large'],
  ['new-translation', '之前的协议审查已结束。新任务：将“苹果”翻译成英文。', '审查跨分片事务协议', 'small'],
  ['followup', '继续刚才的协议审查：概括核心漏洞。', '审查跨分片事务协议', 'large'],
  ['short-en', 'Design a crash-safe distributed transaction protocol in under 100 words.', 'Translate hello', 'large'],
  ['easy', '将“谢谢”翻译成英文。', null, 'small'],
]
let failed = 0
for (const [id, text, task, expected] of cases) {
  const state = { currentMessages: [{ role: 'user', text }], recentHistory: [], historyTruncated: !!task,
    toolsAvailable: true, currentTask: task, currentModel: null }
  const answer = await decide(config, process.env.OPENROUTER_API_KEY, state, candidates, new AbortController().signal)
  const selected = candidates[answer.choice].model
  const pass = selected === expected
  if (!pass) failed++
  console.log(JSON.stringify({ id, ...answer, selected, pass }))
}
const desktopState = JSON.parse(readFileSync(new URL('./desktop-routing-state.json', import.meta.url), 'utf8'))
desktopState.currentModel = desktopState.currentModel === null ? null
  : { provider: desktopState.currentModel.provider, model: desktopState.currentModel.model }
desktopState.recentHistory = config.historyMessages === 0 ? [] : desktopState.recentHistory.slice(-config.historyMessages)
const replay = await decide(config, process.env.OPENROUTER_API_KEY, desktopState, candidates, new AbortController().signal)
console.log(JSON.stringify({ id: 'desktop-history', ...replay, selected: candidates[replay.choice].model }))
if (failed) process.exitCode = 1
