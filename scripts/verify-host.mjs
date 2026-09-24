import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const { values } = parseArgs({ options: { dir: { type: 'string', default: '.cache/harness-stock' }, hold: { type: 'boolean', default: false } } })
const host = resolve(values.dir)
const temp = mkdtempSync(join(tmpdir(), 'dsh-router-host-'))
const manifest = JSON.parse(readFileSync(join(root, 'compatibility/harness.json'), 'utf8'))
const pnpm = ['--yes', `pnpm@${manifest.pnpm}`]
const env = { ...process.env, CI: '1', DSH_HOME: join(temp, 'home'),
  JEV_TEST_HOST: host, JEV_TEST_KEY: 'keyless-host-test' }
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
let calls = 0
const fixture = createHttpServer(async (request, response) => {
  try {
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = JSON.parse(body)
    if (calls === 1) assert.equal(parsed.state.currentTask, 'Translate hello')
    const criteria = parsed.questions.model.criteria
    const desired = calls++ === 0 ? 'small' : 'large'
    const choice = Object.entries(criteria).find(([, value]) => value.includes(`provider: router-smoke; model ID: ${desired}`))?.[0]
    assert.ok(choice, 'fixture candidates must be available')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ answers: { model: { type: 'choice', choice }, taskRelation: {
      type: 'choice', choice: 'new-task', probabilities: { 'new-task': 0.99, continuation: 0.01 },
    } } }))
  } catch { response.statusCode = 500; response.end('Invalid fixture request') }
})
try {
  assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: host, encoding: 'utf8' }).stdout.trim(), manifest.commit)
  assert.equal(spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: host, encoding: 'utf8' }).stdout.trim(), '', 'Host source must be unmodified')
  run('bun', ['pm', 'pack', '--destination', temp], root)
  const tarball = readdirSync(temp).find(file => file.endsWith('.tgz'))
  assert.ok(tarball)
  run('npx', [...pnpm, 'dsh', 'plugin', '--profile', 'web', 'add', join(temp, tarball)], host)
  cpSync(join(root, 'scripts/host-probe.mjs'), join(temp, 'probe.mjs'))
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  writeFileSync(join(env.DSH_HOME, 'profiles/web/cordis.patch.yml'), `- id: jev-router
  disabled: false
  config:
    apiKeyEnv: JEV_TEST_KEY
    endpoint: http://127.0.0.1:${fixture.address().port}/decisions
    maxRoutingBytes: 24000
`)
  writeFileSync(join(temp, 'probe.yml'), `- insert:
    - name: ./probe.mjs
`)
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  child = spawn('npx', [...pnpm, 'dsh', '--profile', 'web',
    '--patch', join(temp, 'probe.yml'),
    '--no-open', '--port', String(port)], { cwd: host, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.on('error', error => { logs += String(error); closed = true })
  child.on('close', () => { closed = true })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk.toString()).slice(-100_000); writeFileSync(join(temp, 'host.log'), logs) })
  const deadline = Date.now() + 90_000
  let ready = false
  let probed = false
  while (Date.now() < deadline && !closed) {
    if (!probed && logs.includes(`http://127.0.0.1:${port}/?token=`)) {
      const probe = [...logs.matchAll(/DSH_ROUTER_PROBE=(http:\/\/127\.0\.0\.1:\d+)/g)].at(-1)?.[1]
      if (probe) {
        try { probed = (await fetch(probe, { signal: AbortSignal.timeout(30000) })).ok }
        catch { /* A startup dependency update may replace the probe instance. */ }
      }
    }
    if (logs.includes('DSH_ROUTER_HOST_FAILED')) throw new Error('Stock Host routing assertions failed')
    if (logs.includes('DSH_ROUTER_HOST_READY')) {
      try {
        const base = `http://127.0.0.1:${port}`
        const match = logs.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))
        if (!match) { await wait(200); continue }
        const login = await fetch(match[0], { redirect: 'manual', signal: AbortSignal.timeout(2000) })
        const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
        const response = login.status === 200 ? login : await fetch(base + '/', { headers: { cookie }, signal: AbortSignal.timeout(2000) })
        const html = await response.text()
        if (response.ok && /<html/i.test(html)) {
          writeFileSync(join(temp, 'browser.json'), JSON.stringify({ url: match[0], port }))
          ready = true; break
        }
      } catch { /* The HTTP listener may not yet be ready after plugin startup. */ }
    }
    await wait(200)
  }
  assert.ok(ready, 'Compatible host must boot the installed plugin, resolve Auto and serve the web client')
  assert.equal(calls, 2, 'two automatic turns should call the local Jev fixture')
  passed = true
  console.log('Stock Host passed: plugin install, automatic model switching, native Auto persistence, manual bypass, session replay and web boot (local fixtures only).')
  if (values.hold) {
    console.log(`Browser verification artifacts: ${temp}`)
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
  }
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
  fixture.closeAllConnections()
  await new Promise(resolve => fixture.close(resolve))
  if (passed) rmSync(temp, { recursive: true, force: true })
}
