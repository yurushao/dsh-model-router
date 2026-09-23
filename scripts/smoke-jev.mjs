import { Config } from '../dist/config.js'
import { decide } from '../dist/jev.js'

if (!process.env.OPENROUTER_API_KEY) {
  console.log('SKIP: OPENROUTER_API_KEY is not set; no live Jev request was made.')
  process.exit(0)
}

const config = Config({
  apiKey: process.env.OPENROUTER_API_KEY,
  models: {
    economy: { provider: 'smoke-only', model: 'economy' },
    frontier: { provider: 'smoke-only', model: 'frontier' },
  },
})
const result = await decide(config, {
  currentMessages: [{ role: 'user', text: 'Translate the Chinese greeting 你好 into English.' }],
  recentHistory: [], historyTruncated: false, toolsAvailable: false,
  currentModel: null, currentTask: null,
}, new AbortController().signal)
console.log(JSON.stringify(result, null, 2))
