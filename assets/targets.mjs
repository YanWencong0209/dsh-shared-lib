/** Shared target catalog and argv-based installation planner. No shell interpolation. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve, join, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const all = ['linux', 'darwin', 'win32']
const definitions = [
  ['npm', 'npm', 'package', all, ['shared']],
  ['pnpm', 'pnpm', 'package', all, ['shared']],
  ['bun', 'bun', 'package', all, ['shared']],
  ['uv-tool', 'uv', 'package', all, ['shared']],
  ['pipx', 'pipx', 'package', all, ['shared']],
  ['cargo', 'cargo', 'package', all, ['shared']],
  ['go', 'go', 'package', all, ['shared']],
  ['conda', 'conda', 'environment', all, ['shared']],
  ['mise', 'mise', 'runtime', all, ['shared', 'project']],
].map(([id, executable, kind, platforms, scopes]) => ({ id, executable, kind, platforms, scopes }))

export const memoryTargets = ['meow-memory', 'mnemon-native', 'openviking', 'honcho', 'mem0', 'hindsight', 'holographic', 'retaindb', 'byterover', 'supermemory'].map(id => ({
  id, kind: 'memory', integration: id === 'meow-memory' ? 'meow-memory' : 'dsh-mnemon',
  state: 'requires-host-configuration', activationVerified: false,
}))
export const sources = [
  { id: 'npm', target: 'npm', status: 'planned-execution' },
  { id: 'pypi', target: 'uv-tool', status: 'planned-execution' },
  { id: 'crates', target: 'cargo', status: 'planned-execution' },
  { id: 'go-module', target: 'go', status: 'planned-execution' },
  { id: 'github-release', target: 'mise', status: 'upstream-backend', example: 'github:BurntSushi/ripgrep@15' },
  { id: 'aqua', target: 'mise', status: 'upstream-backend', example: 'aqua:cli/cli@2' },
  { id: 'http-file', target: 'legacy-get', status: 'legacy-bash' },
  { id: 'archive', status: 'not-implemented' },
  { id: 'source-build', status: 'not-implemented' },
  { id: 'container', status: 'not-implemented' },
]

export function catalog(platform = process.platform) {
  return { schema: 1, platform, managers: definitions.map(d => ({ ...d, supported: d.platforms.includes(platform) })), memory: memoryTargets, sources,
    boundaries: { legacyCli: 'Bash required; Linux verified', targetsCli: 'Node native; Linux contract-tested, macOS unverified, Windows execution blocked', remoteHosts: 'not-implemented' } }
}

/** Windows resolves package CLIs through .cmd/.exe shims; macOS/Linux use the bare name. */
export function commandCandidates(executable, platform = process.platform) {
  return platform === 'win32' ? [`${executable}.cmd`, `${executable}.exe`, executable] : [executable]
}

export function planInstall({ target, spec, scope = 'shared', root = process.env.DSH_SHARED_ROOT || join(homedir(), '.local/share/dsh-shared'), cwd = process.cwd(), platform = process.platform }) {
  const d = definitions.find(x => x.id === target)
  if (!d) throw new Error(`Unknown target: ${target}`)
  if (!d.platforms.includes(platform)) throw new Error(`Unsupported platform: ${platform}`)
  if (!d.scopes.includes(scope)) throw new Error(`${target} does not support scope ${scope}`)
  if (typeof spec !== 'string' || !spec || spec.startsWith('-') || /[\s\x00-\x1f]/u.test(spec)) throw new Error('spec must be one non-option package/runtime identifier')
  root = resolve(root); cwd = resolve(cwd)
  const bin = join(root, 'bin'), env = {}, dirs = [bin]
  let args
  switch (target) {
    case 'npm': args = ['install', '--global', '--prefix', join(root, 'env/npm'), spec]; env.NPM_CONFIG_CACHE = join(root, 'cache/npm'); break
    case 'pnpm':
      // Pin the store inside the shared root: pnpm otherwise derives it from cwd/PNPM_HOME and
      // an inconsistent store makes both add and remove fail (observed 2026-11-14).
      args = ['add', '--global', '--global-dir', join(root, 'env/pnpm'), '--global-bin-dir', bin, '--store-dir', join(root, 'env/pnpm/store'), spec]
      env.PNPM_HOME = bin
      break
    case 'bun': args = ['add', '--global', spec]; env.BUN_INSTALL = join(root, 'env/bun'); env.BUN_INSTALL_BIN = bin; break
    case 'uv-tool': args = ['tool', 'install', spec]; env.UV_TOOL_DIR = join(root, 'env/uv-tools'); env.UV_TOOL_BIN_DIR = bin; env.UV_CACHE_DIR = join(root, 'cache/uv'); break
    case 'pipx': args = ['install', spec]; env.PIPX_HOME = join(root, 'env/pipx'); env.PIPX_BIN_DIR = bin; break
    case 'cargo': args = ['install', '--root', join(root, 'env/cargo'), spec]; break
    case 'go': if (!spec.includes('@')) throw new Error('go requires module@version'); args = ['install', spec]; env.GOBIN = bin; break
    case 'conda': args = ['create', '--yes', '--prefix', join(root, 'env/conda'), spec]; break
    case 'mise':
      args = scope === 'project' ? ['use', spec] : ['install', spec]
      env.MISE_DATA_DIR = join(root, 'env/mise'); env.MISE_CACHE_DIR = join(root, 'cache/mise'); break
  }
  const pathEntries = [bin, join(root, 'env/npm/bin'), join(root, 'env/cargo/bin'), join(root, 'env/bun/bin'), join(root, 'env/mise/shims')]
  const candidates = commandCandidates(d.executable, platform)
  return { schema: 1, action: 'install', target, spec, scope, platform, root, cwd, command: candidates[0], commandCandidates: candidates, args, env, directories: dirs, pathEntries,
    effects: scope === 'project' ? ['Writes mise.toml in the selected workspace', 'May download tools and run upstream installation hooks'] : ['Installs into the selected shared root', 'May download packages and run upstream installation hooks'],
    activation: target === 'mise' && scope === 'shared' ? 'Use mise exec <spec> -- <command> with this plan environment; install alone does not select an active version' : 'Use the reported pathEntries; no system PATH links are changed',
  }
}


/** Package name without version/selector, e.g. @scope/pkg@1.2 -> @scope/pkg */
export function packageOf(spec) {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  return at > 0 ? spec.slice(0, at) : spec
}

/**
 * Conservative presence probe. Reports only what the filesystem proves:
 * present, absent, or unverifiable when the manager's layout is not known here.
 */
export function verifyDeclared(root, { platform = process.platform, readInstallHistory } = {}) {
  root = resolve(root)
  const records = (readInstallHistory ? readInstallHistory() : readRunRecords(root))
    .filter(r => r.state === 'succeeded' || r.state === 'uninstalled')
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
  // Latest successful install wins; a later uninstall removes the declaration entirely.
  const latest = new Map()
  for (const r of records) {
    // Identity is target+spec; both records store `spec`, so install and uninstall keys agree.
    const key = `${r.target}\u0000${r.spec ?? r.args?.filter(a => !String(a).startsWith('-')).at(-1) ?? ''}`
    if (r.state === 'uninstalled') latest.delete(key)
    else latest.set(key, r)
  }
  const items = [...latest.values()].map(r => ({ target: r.target, spec: r.spec ?? r.args?.filter(a => !String(a).startsWith('-')).at(-1) ?? '', ...probe(root, r, platform) }))
  return { schema: 1, root, platform, items,
    absent: items.filter(i => i.state === 'absent').length,
    unverifiable: items.filter(i => i.state === 'unverifiable').length }
}

function readRunRecords(root) {
  const dir = join(root, 'state', 'target-runs')
  let names = []
  try { names = readdirSync(dir) } catch (e) { if (e.code !== 'ENOENT') throw e }
  return names.filter(n => n.endsWith('.json')).map(n => { try { return JSON.parse(readFileSync(join(dir, n), 'utf8')) } catch { return null } }).filter(Boolean)
}

const has = p => { try { return existsSync(p) } catch { return false } }

function probe(root, record, platform) {
  const pkg = packageOf(record.args?.at(-1) ?? '')
  if (!pkg) return { state: 'unverifiable', reason: 'no package identifier in install record' }
  switch (record.target) {
    case 'npm': {
      const candidates = [join(root, 'env/npm/lib/node_modules', pkg, 'package.json'), join(root, 'env/npm/node_modules', pkg, 'package.json')]
      const hit = candidates.find(has)
      return hit ? { state: 'present', evidence: hit } : { state: 'absent', evidence: candidates[0] }
    }
    case 'pnpm': {
      // pnpm nests a global dir per pnpm major version: env/pnpm/<major>/node_modules/<pkg>.
      let majors = []
      try { majors = readdirSync(join(root, 'env/pnpm'), { withFileTypes: true }).filter(e => e.isDirectory() && /^\d+$/.test(e.name)).map(e => e.name) } catch {}
      for (const major of majors) {
        const p = join(root, 'env/pnpm', major, 'node_modules', pkg, 'package.json')
        if (has(p)) return { state: 'present', evidence: p }
      }
      return { state: 'absent', evidence: join(root, 'env/pnpm/<major>/node_modules', pkg, 'package.json') }
    }
    case 'uv-tool': {
      const p = join(root, 'env/uv-tools', pkg)
      return has(p) ? { state: 'present', evidence: p } : { state: 'absent', evidence: p }
    }
    case 'pipx': {
      const p = join(root, 'env/pipx/venvs', pkg, 'pyvenv.cfg')
      return has(p) ? { state: 'present', evidence: p } : { state: 'absent', evidence: p }
    }
    case 'cargo': {
      let names = []
      try { names = readdirSync(join(root, 'env/cargo/bin')) } catch {}
      const want = pkg.replace(/-/g, '_')
      const hit = names.find(n => n === pkg || n === want)
      return hit ? { state: 'present', evidence: join(root, 'env/cargo/bin', hit) } : { state: 'absent', evidence: join(root, 'env/cargo/bin', pkg) }
    }
    case 'go': {
      const base = record.args?.at(-1)?.split('@')[0]?.split('/').pop() ?? ''
      const p = join(root, pkg.includes('/') ? 'bin' : 'bin', base)
      return existsSync(p) ? { state: 'present', evidence: p } : { state: 'absent', evidence: p }
    }
    default:
      return { state: 'unverifiable', reason: `${record.target} layout not probed in this version` }
  }
}

/** argv to remove one previously installed target. Go has no uninstall verb. */
export function planUninstall({ target, spec, root = process.env.DSH_SHARED_ROOT || join(homedir(), '.local/share/dsh-shared'), platform = process.platform }) {
  const d = definitions.find(x => x.id === target)
  if (!d) throw new Error(`Unknown target: ${target}`)
  if (!d.platforms.includes(platform)) throw new Error(`Unsupported platform: ${platform}`)
  if (typeof spec !== 'string' || !spec || spec.startsWith('-') || /[\s\x00-\x1f]/u.test(spec)) throw new Error('spec must be one non-option package/runtime identifier')
  root = resolve(root)
  const pkg = packageOf(spec)
  let args
  switch (target) {
    case 'npm': args = ['uninstall', '--global', '--prefix', join(root, 'env/npm'), pkg]; break
    case 'pnpm':
      // pnpm remove refuses to run unless its global bin dir is on PATH; executePlan prepends pathEntries.
      // remove has no --store-dir flag; the config form reaches the same pinned store.
      args = ['remove', '--global', '--global-dir', join(root, 'env/pnpm'), `--config.store-dir=${join(root, 'env/pnpm/store')}`, pkg]; break
    case 'bun': args = ['remove', '--global', pkg]; break
    case 'uv-tool': args = ['tool', 'uninstall', pkg]; break
    case 'pipx': args = ['uninstall', pkg]; break
    case 'cargo': args = ['uninstall', '--root', join(root, 'env/cargo'), pkg]; break
    case 'conda': args = ['env', 'remove', '--yes', '--prefix', join(root, 'env/conda')]; break
    case 'mise': args = ['uninstall', spec]; break
    case 'go':
      return { schema: 1, action: 'uninstall', target, spec, package: pkg, platform, root, supported: false,
        note: 'go install has no uninstall; delete the matching binary from bin/ manually', args: [], env: {}, directories: [], pathEntries: [join(root, 'bin')] }
    default: throw new Error(`${target} has no uninstall command here; remove it with the upstream tool`)
  }
  const env = { ...(target === 'npm' ? { NPM_CONFIG_CACHE: join(root, 'cache/npm') } : {}), ...(target === 'uv-tool' ? { UV_TOOL_DIR: join(root, 'env/uv-tools'), UV_TOOL_BIN_DIR: join(root, 'bin'), UV_CACHE_DIR: join(root, 'cache/uv') } : {}), ...(target === 'pipx' ? { PIPX_HOME: join(root, 'env/pipx'), PIPX_BIN_DIR: join(root, 'bin') } : {}), ...(target === 'mise' ? { MISE_DATA_DIR: join(root, 'env/mise'), MISE_CACHE_DIR: join(root, 'cache/mise') } : {}), ...(target === 'bun' ? { BUN_INSTALL: join(root, 'env/bun') } : {}), ...(target === 'pnpm' ? { PNPM_HOME: join(root, 'bin') } : {}) }
  return { schema: 1, action: 'uninstall', target, spec, package: pkg, platform, root, command: commandCandidates(d.executable, platform)[0], commandCandidates: commandCandidates(d.executable, platform), args, env, directories: [], pathEntries: [join(root, 'bin')],
    supported: target !== 'go', note: target === 'go' ? 'go install has no uninstall; delete the binary from bin/ manually' : undefined }
}

export function executePlan(plan, { spawn = spawnSync, inheritedEnv = process.env } = {}) {
  if (plan.platform !== process.platform) throw new Error('Cross-platform execution is not supported')
  if (process.platform === 'win32') throw new Error(`Windows execution is not verified; plan-only. Resume with commandCandidates: ${(plan.commandCandidates || [plan.command]).join(', ')}`)
  const env = { ...inheritedEnv, ...plan.env, PATH: [...plan.pathEntries, inheritedEnv.PATH || ''].join(delimiter) }
  const probe = spawn(plan.command, ['--version'], { cwd: plan.cwd, env, encoding: 'utf8', shell: false, timeout: 5000 })
  if (probe.error || probe.status !== 0) throw new Error(`Target executable unavailable: ${plan.command}: ${probe.error?.message || probe.stderr || probe.status}`)
  for (const dir of plan.directories) mkdirSync(dir, { recursive: true })
  const runs = join(plan.root, 'state', 'target-runs')
  mkdirSync(runs, { recursive: true })
  const file = join(runs, `${randomUUID()}.json`)
  const record = { schema: 1, action: plan.action || 'install', target: plan.target, scope: plan.scope, spec: plan.spec, cwd: plan.cwd, command: plan.command, args: plan.args, startedAt: new Date().toISOString(), state: 'running' }
  writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 })
  try {
    const result = spawn(plan.command, plan.args, { cwd: plan.cwd, env, stdio: 'inherit', shell: false })
    record.exitCode = result.status ?? 1
    record.signal = result.signal ?? null
    record.state = !result.error && result.status === 0 ? (plan.action === 'uninstall' ? 'uninstalled' : 'succeeded') : 'failed'
    if (result.error) record.error = result.error.message
    if (result.error) throw result.error
    return record.exitCode
  } catch (error) {
    record.state = 'failed'; record.error = error.message; throw error
  } finally {
    record.finishedAt = new Date().toISOString()
    const next = `${file}.tmp`
    writeFileSync(next, JSON.stringify(record, null, 2), { mode: 0o600 })
    renameSync(next, file)
  }
}

/** Compact one-screen summary; full catalog JSON costs ~9 KB, this costs ~0.6 KB. */
export function summaryText(root, platform = process.platform) {
  const cat = catalog(platform)
  const verify = verifyDeclared(root, { platform })
  const history = (() => { try { return readRunRecords(root) } catch { return [] } })()
  const live = Object.fromEntries(verify.items.map(i => [`${i.target} ${i.spec}`, i.state]))
  const managers = cat.managers.map(m => `${m.id}${m.supported ? '' : '*'}`).join(', ')
  const unimplemented = cat.sources.filter(x => x.status === 'not-implemented').map(x => x.id).join(', ')
  const recent = history.slice(-3).map(r => `${r.action || 'install'} ${r.target} ${r.spec || ''} ${r.state}`)
  return [
    `managers(${cat.managers.length}): ${managers}  (* = unsupported on ${platform})`,
    `sources: ${cat.sources.filter(x => x.status !== 'not-implemented').map(x => x.id).join(', ')} | unimplemented: ${unimplemented}`,
    `memory targets: ${cat.memory.length} (configuration only, not verified activation)`,
    `declared installs: ${verify.items.length} | absent: ${verify.absent} | unverifiable: ${verify.unverifiable}`,
    ...Object.entries(live).map(([k, v]) => `  ${k} → ${v}`),
    recent.length ? `recent: ${recent.join(' ; ')}` : 'recent: none',
  ].join('\n')
}

export function main(argv) {
  const [command, target, spec, ...rest] = argv
  if (command === 'summary') {
    const root = process.env.DSH_SHARED_ROOT || join(homedir(), '.local/share/dsh-shared')
    console.log(summaryText(root)); return 0
  }
  if (command === 'list' || !command) { console.log(JSON.stringify(catalog(), null, 2)); return 0 }
  if (command === 'history') {
    const root = process.env.DSH_SHARED_ROOT || join(homedir(), '.local/share/dsh-shared')
    const dir = join(root, 'state', 'target-runs')
    let names
    try { names = readdirSync(dir) } catch (e) { if (e.code !== 'ENOENT') throw e; names = [] }
    const records = names.filter(n => n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(dir, n), 'utf8')))
    console.log(JSON.stringify({ schema: 1, records: records.sort((a, b) => a.startedAt.localeCompare(b.startedAt)) }, null, 2)); return 0
  }
  if (command === 'uninstall') {
    let scope = 'shared', execute = false
    const rest0 = rest.slice()
    for (let i = 0; i < rest0.length; i++) {
      if (rest0[i] === '--execute') execute = true
      else throw new Error(`Unknown option: ${rest0[i]}`)
    }
    const plan = planUninstall({ target, spec })
    if (!plan.supported) { console.log(JSON.stringify({ ...plan, executed: false }, null, 2)); return 1 }
    if (!execute) { console.log(JSON.stringify({ ...plan, executed: false }, null, 2)); return 0 }
    return executePlan(plan)
  }
  if (command === 'verify') {
    const root = process.env.DSH_SHARED_ROOT || join(homedir(), '.local/share/dsh-shared')
    const report = verifyDeclared(root)
    console.log(JSON.stringify(report, null, 2))
    return report.absent > 0 ? 1 : 0
  }
  if (command !== 'install') throw new Error('Usage: targets.mjs list | summary | verify | history | install TARGET SPEC [--scope shared|project] [--execute] | uninstall TARGET SPEC [--execute]')
  let scope = 'shared', execute = false
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--scope') { scope = rest[++i]; if (!scope) throw new Error('--scope needs a value') }
    else if (rest[i] === '--execute') execute = true
    else throw new Error(`Unknown option: ${rest[i]}`)
  }
  const plan = planInstall({ target, spec, scope })
  if (!execute) { console.log(JSON.stringify({ ...plan, executed: false }, null, 2)); return 0 }
  return executePlan(plan)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
