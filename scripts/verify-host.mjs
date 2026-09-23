import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const { values } = parseArgs({ options: { dir: { type: 'string', default: '.cache/harness' }, 'skip-tests': { type: 'boolean', default: false } } })
const host = resolve(values.dir)
const temp = mkdtempSync(join(tmpdir(), 'dsh-router-host-'))
const manifest = JSON.parse(readFileSync(join(root, 'compatibility/harness.json'), 'utf8'))
const pnpm = ['--yes', `pnpm@${manifest.pnpm}`]
const env = { ...process.env, CI: '1', DSH_HOME: join(temp, 'home'),
  OPENROUTER_API_KEY: 'keyless-host-test', JEV_ECONOMY_MODEL: 'test/economy', JEV_FRONTIER_MODEL: 'test/frontier' }
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let child
let logs = ''
let closed = false
let passed = false
try {
  if (!values['skip-tests']) run('npx', [...pnpm, 'exec', 'vitest', 'run',
    'packages/llm/llm-pi-ai/tests/adapter.spec.ts',
    'packages/session/session-persistence/tests/storage-contract.spec.ts',
    'packages/client/ui-model-selection/tests/model-select.client.spec.tsx',
    'packages/client/ui-chat/tests/turn-usage-panel.client.spec.tsx'], host)
  run('bun', ['pm', 'pack', '--destination', temp], root)
  const tarball = readdirSync(temp).find(file => file.endsWith('.tgz'))
  assert.ok(tarball)
  run('npx', [...pnpm, 'dsh', 'plugin', '--profile', 'web', 'add', join(temp, tarball)], host)
  // This probe resolves the installed Auto adapter without calling a paid model.
  writeFileSync(join(temp, 'probe.mjs'), `export const inject = ['llm', 'sessionProjections'];
export async function apply(ctx) {
  async function verify() {
    if (!ctx.llm.listProviders().some(provider => provider.id === 'jev-router')) return;
    const model = await ctx.llm.resolveModelInfo('jev-router', 'auto');
    if (model.id !== 'auto') throw new Error('Auto adapter did not resolve');
    process.stdout.write('DSH_ROUTER_HOST_READY\\n');
  }
  ctx.on('llm/adapters-updated', verify);
  await verify();
}
`)
  writeFileSync(join(temp, 'probe.yml'), '- insert:\n    - name: ./probe.mjs\n')
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  child = spawn('npx', [...pnpm, 'dsh', '--profile', 'web',
    '--patch', join(root, 'examples/openrouter.patch.yml'), '--patch', join(temp, 'probe.yml'),
    '--no-open', '--port', String(port)], { cwd: host, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.on('error', error => { logs += String(error); closed = true })
  child.on('close', () => { closed = true })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk.toString()).slice(-100_000) })
  const deadline = Date.now() + 90_000
  let ready = false
  while (Date.now() < deadline && !closed) {
    if (logs.includes('DSH_ROUTER_HOST_READY')) {
      try {
        const base = `http://127.0.0.1:${port}`
        const match = logs.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))
        if (!match) { await wait(200); continue }
        const login = await fetch(match[0], { redirect: 'manual', signal: AbortSignal.timeout(2000) })
        const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
        const response = login.status === 200 ? login : await fetch(base + '/', { headers: { cookie }, signal: AbortSignal.timeout(2000) })
        const html = await response.text()
        if (response.ok && /<html/i.test(html)) { ready = true; break }
      } catch { /* The HTTP listener may not yet be ready after plugin startup. */ }
    }
    await wait(200)
  }
  assert.ok(ready, 'Compatible host must boot the installed plugin, resolve Auto and serve the web client')
  passed = true
  console.log('Host integration passed: public plugin install, enabled Auto adapter and web boot (no paid calls).')
} catch (error) {
  console.error(logs.replace(/([?&]token=)[^&\s]+/g, '$1[REDACTED]'))
  console.error(`Host verification artifacts retained at ${temp}`)
  throw error
} finally {
  if (child?.pid && !closed) {
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    for (let attempt = 0; attempt < 50 && !closed; attempt++) await wait(100)
    if (!closed) { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
  }
  if (passed) rmSync(temp, { recursive: true, force: true })
}
