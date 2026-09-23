import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(root, 'compatibility/harness.json'), 'utf8'))
const { values } = parseArgs({ options: {
  dir: { type: 'string', default: '.cache/harness' }, build: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} })
if (values.help) {
  console.log('node scripts/prepare-harness.mjs [--dir PATH] [--build]\nFetches the pinned public Harness revision and applies the bundled compatibility patch.\n--build also installs pinned pnpm dependencies and builds the supported web/host artifacts.')
  process.exit(0)
}
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24 (tested with 24.15.0)')
const target = resolve(values.dir)
const patch = resolve(root, 'compatibility', manifest.patch)
const bytes = readFileSync(patch)
if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('Compatibility patch checksum mismatch')
const env = { ...process.env, CI: '1' }
// An injected macOS SDK include path causes upstream -Werror native builds to fail.
if (process.platform === 'darwin' && env.CPATH) {
  console.log('Clearing CPATH for this child build so clang selects its own SDK headers.')
  delete env.CPATH
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: target, env, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
  return result.stdout?.toString().trim()
}
if (!existsSync(target)) {
  mkdirSync(dirname(target), { recursive: true })
  run('git', ['init', target], { cwd: root })
  run('git', ['remote', 'add', 'origin', manifest.repository])
  run('git', ['fetch', '--depth', '1', 'origin', manifest.commit])
  run('git', ['checkout', '--detach', 'FETCH_HEAD'])
}
if (run('git', ['rev-parse', 'HEAD'], { stdio: 'pipe' }) !== manifest.commit) {
  throw new Error(`Target must be at ${manifest.commit}; choose a new empty directory`)
}
const changes = run('git', ['diff', '--binary', '--full-index', 'HEAD'], { stdio: 'pipe' })
if (changes !== bytes.toString().trim()) {
  if (run('git', ['status', '--porcelain', '--untracked-files=no'], { stdio: 'pipe' })) {
    throw new Error('Refusing to alter a checkout with unrelated tracked changes; choose a new directory')
  }
  run('git', ['apply', '--check', patch])
  run('git', ['apply', patch])
}
console.log(`Prepared compatible Harness ${manifest.version} at ${target}`)
if (values.build) {
  // Build only the pinned upstream scripts; do not copy artifacts from another checkout.
  run('npx', ['--yes', `pnpm@${manifest.pnpm}`, 'install', '--frozen-lockfile'])
  run('npx', ['--yes', `pnpm@${manifest.pnpm}`, 'run', 'build'])
  console.log('Build complete. Run the profile installer with:')
  console.log(`cd ${JSON.stringify(target)} && npx --yes pnpm@${manifest.pnpm} dsh plugin --profile web add /absolute/path/to/plugin.tgz`)
}
