import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'dsh-router-install-'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: '1' } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}); inspection directory: ${dir}`)
}
try {
  run('bun', ['pm', 'pack', '--destination', dir], root)
  const tarball = readdirSync(dir).find(file => file.endsWith('.tgz'))
  if (!tarball) throw new Error('No tarball was produced')
  cpSync(join(root, 'patches'), join(dir, 'patches'), { recursive: true })
  cpSync(join(root, 'scripts/installed-smoke.mjs'), join(dir, 'smoke.mjs'))
  const dependencies = { [pkg.name]: `file:${join(dir, tarball)}`, ...pkg.peerDependencies,
    '@deepseek-ai/dsh-agent-loop': '0.1.7-alpha.1', '@deepseek-ai/dsh-tools': '0.1.7-alpha.1' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies,
    patchedDependencies: pkg.patchedDependencies }, null, 2))
  run('bun', ['install', '--ignore-scripts'], dir)
  run(process.execPath, ['smoke.mjs'], dir)
  console.log('Clean packed-install verification passed.')
  rmSync(dir, { recursive: true, force: true })
} catch (error) {
  console.error(`Install verification artifacts retained at ${dir}`)
  throw error
}
