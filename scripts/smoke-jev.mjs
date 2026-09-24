import { Config, resolveConfig } from '../dist/config.js'
import { decide } from '../dist/jev.js'

if (!process.env.OPENROUTER_API_KEY) {
  console.log('SKIP: OPENROUTER_API_KEY is not set; no live Jev request was made.')
  process.exit(0)
}
const config = resolveConfig(Config({}))
const candidates = [
  { provider: 'evaluation', model: 'small', name: 'Small economy model' },
  { provider: 'evaluation', model: 'large', name: 'Large frontier model' },
]
const result = await decide(config, process.env.OPENROUTER_API_KEY, {
  currentMessages: [{ role: 'user', text: 'Translate the Chinese greeting 你好 into English.' }],
  recentHistory: [], historyTruncated: false, toolsAvailable: false,
  currentModel: null, currentTask: null,
}, candidates, new AbortController().signal)
console.log(JSON.stringify({ ...result, chosenModel: candidates[result.choice].model }, null, 2))
