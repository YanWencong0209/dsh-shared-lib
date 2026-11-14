/**
 * 融合配置回归：meow-memory 随行、mnemon 不插行、memory 探测进 JSON。
 * 上游依据：dsh-mnemon 自带 bundle patch 禁止复制插行（issue #470）；
 * meow-memory 的 registry tarball 自带预构建 lib/，安装期不执行构建脚本。
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const packageRoot = new URL('..', import.meta.url).pathname
// Loaded once so the prompt budget test can inspect the shipped text.
const promptPure = await import(join(packageRoot, 'lib', 'bundle.js'))
const cli = join(packageRoot, 'assets/shared.sh')

test('fusion manifest pins both upstream memory packages', () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.version, '0.8.0')
  // Memory backends are installed as their own bundles, not as runtime deps:
  // link: installs do not install a linked package's dependencies into the profile.
  assert.equal(pkg.dependencies, undefined)
})

test('bundle patch mounts only its own row; memory backends stay separate bundles', () => {
  const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: shared-lib/)
  // Regression: a meow-memory row here fails the whole bundle with ERR_MODULE_NOT_FOUND
  // under link: installs (pnpm does not install dependencies of linked packages).
  assert.doesNotMatch(patch, /^\s*- id: meow-memory\s*$/m)
  assert.doesNotMatch(patch, /^\s*- id: mnemon(-bundle|-source|-strategy)?\s*$/m)
  assert.match(patch, /install_bundle", target:"meow-memory"/, 'patch must document how to enable memory')
})

test('memory home prefers configured over legacy', () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-memhome-'))
  const cfgHome = join(root, 'state', 'memory-home')
  const legacy = join(root, 'home', '.dsh-meow')
  mkdirSync(cfgHome, { recursive: true })
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, 'memory.db'), 'x')
  try {
    const env = { ...process.env, DSH_SHARED_ROOT: root, SHARED_LINK_DIR: join(root, 'path'), HOME: join(root, 'home') }
    const run = args => spawnSync('bash', [cli, ...args], { cwd: root, encoding: 'utf8', env })
    // 只有 legacy 有内容 → 报 legacy 且带迁移注记
    const legacyOnly = JSON.parse(run(['status', '--json']).stdout)
    assert.equal(legacyOnly.memory.meow.home, legacy)
    assert.match(legacyOnly.memory.meow.migrationNote, /legacy/)
    // cfg 有内容 → 优先 cfg
    writeFileSync(join(cfgHome, 'window-index.json'), '{}')
    const migrated = JSON.parse(run(['status', '--json']).stdout)
    assert.equal(migrated.memory.meow.home, cfgHome)
    assert.equal(migrated.memory.meow.homeState, 'present')
    assert.equal(migrated.memory.meow.migrationNote, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('memoryReport reads Loader entries and reports disabled entries', async () => {
  const { memoryReport } = await import(join(packageRoot, 'lib', 'bundle.js'))
  const ctx = {
    get: name => name === 'configEditor'
      ? { entries: () => [{ options: { id: 'meow-memory' }, disabled: false }, { options: { id: 'mnemon' }, disabled: true }] }
      : undefined,
  }
  const report = memoryReport(ctx, '/tmp/unused')
  assert.equal(report.exitCode, 0)
  assert.match(report.text, /meow-memory/)
  assert.match(report.text, /mnemon（已禁用）/)
  assert.deepEqual(report.state.declared, ['meow-memory', 'mnemon（已禁用）'])
})

test('status/doctor JSON expose memory backends', () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-fusion-'))
  const linkDir = join(root, 'path')
  const fakeHome = join(root, 'home')
  mkdirSync(join(fakeHome, '.dsh-meow'), { recursive: true })
  writeFileSync(join(fakeHome, '.dsh-meow', 'memory.db'), 'x')
  try {
    const env = { ...process.env, DSH_SHARED_ROOT: root, SHARED_LINK_DIR: linkDir, HOME: fakeHome }
    const status = spawnSync('bash', [cli, 'status', '--json'], { cwd: root, encoding: 'utf8', env })
    const value = JSON.parse(status.stdout)
    assert.equal(value.memory.meow.bundled, true)
    assert.equal(value.memory.meow.home, join(fakeHome, '.dsh-meow'))
    assert.equal(value.memory.meow.dbExists, true)
    assert.equal(typeof value.memory.mnemon.cliInstalled, 'boolean')

    const doctor = spawnSync('bash', [cli, 'doctor', '--json'], { cwd: root, encoding: 'utf8', env })
    const health = JSON.parse(doctor.stdout)
    assert.equal(health.memory.meow.homeState, 'present')
    if (!health.memory.mnemon.cliInstalled) {
      assert.ok(health.warnings.some(line => line.includes('mnemon')))
      // mnemon CLI 缺失是可选依赖：warning 可以出现，但不得计入 issues（issues 为 {code,message,fix} 对象）
      assert.ok(!health.issues.some(issue => `${issue.code} ${issue.message} ${issue.fix ?? ''}`.includes('mnemon')))
    }

    const memory = spawnSync('bash', [cli, 'memory'], { cwd: root, encoding: 'utf8', env })
    assert.equal(memory.status, 0, memory.stderr)
    assert.match(memory.stdout, /meow-memory/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('memoryReport separates declared config from runtime activation', async () => {
  const { memoryReport } = await import(join(packageRoot, 'lib', 'bundle.js'))
  const base = {
    get: name => name === 'configEditor'
      ? { entries: () => [{ options: { id: 'meow-memory' }, disabled: false }] }
      : undefined,
  }
  const inactive = memoryReport(base, '/tmp/unused')
  assert.deepEqual(inactive.state.declared, ['meow-memory'])
  assert.deepEqual(inactive.state.active, [])
  assert.match(inactive.text, /未检测到 memory_\* 工具/)
  assert.match(inactive.text, /结论只看 active/)

  const active = memoryReport({
    get: name => name === 'configEditor'
      ? { entries: () => [{ options: { id: 'meow-memory' }, disabled: false }] }
      : name === 'tools'
        ? { schemas: () => [{ name: 'memory_remember' }, { name: 'memory_search' }, { name: 'bash' }] }
        : undefined,
  }, '/tmp/unused')
  assert.deepEqual(active.state.active, ['memory_remember', 'memory_search'])
  assert.match(active.text, /已注册 2 个/)
})

test('targetsReport summarises matrix, verification and recent runs without executing', async () => {
  const { targetsReport } = await import(join(packageRoot, 'lib', 'bundle.js'))
  const root = mkdtempSync(join(tmpdir(), 'targets-report-'))
  try {
    const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true })
    cpSync(join(packageRoot, 'assets', 'targets.mjs'), join(bin, '.shared-targets.mjs'))
    const reports = join(root, 'state', 'target-runs'); mkdirSync(reports, { recursive: true })

    // Empty history: nothing declared, nothing absent.
    const empty = targetsReport(root)
    assert.equal(empty.state.managers, 9)
    assert.equal(empty.state.memory, 10)
    assert.match(empty.text, /npm, pnpm, bun, uv-tool, pipx, cargo, go, conda, mise/)
    assert.match(empty.text, /未实现：archive, source-build, container/)
    assert.match(empty.text, /最近执行：无/)
    assert.match(empty.text, /本工具只读/)
    assert.equal(empty.exitCode, 0)

    // Declared-but-missing install: rendered, summarised, and signalled.
    writeFileSync(join(reports, 'r1.json'), JSON.stringify({ target: 'npm', state: 'succeeded', args: ['install', '-g', 'typescript@5'], startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z' }))
    const absent = targetsReport(root)
    assert.match(absent.text, /typescript@5 → succeeded/)
    assert.equal(absent.state.verified, 1)
    assert.equal(absent.state.absent, 1)
    assert.equal(absent.exitCode, 1, 'absent declared install must be non-zero')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('every shared_lib action returns only declared output properties', async () => {
  const { defineSharedTool, targetsReport, memoryReport } = await import(join(packageRoot, 'lib', 'bundle.js'))
  const root = mkdtempSync(join(tmpdir(), 'tool-schema-'))
  try {
    const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true })
    cpSync(join(packageRoot, 'assets', 'targets.mjs'), join(bin, '.shared-targets.mjs'))
    const tool = defineSharedTool(root, { get: () => undefined })
    const declared = Object.keys(tool.output.schema.properties)

    const targets = targetsReport(root)
    assert.deepEqual(Object.keys(targets).filter(k => !declared.includes(k)), [], 'targets report leaked undeclared keys')

    const memory = memoryReport({ get: () => undefined }, root)
    assert.deepEqual(Object.keys(memory).filter(k => !declared.includes(k)), [], 'memory report leaked undeclared keys')

    assert.equal(tool.parameters.properties.action.enum.includes('targets'), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('shared_cases forwards every action its schema advertises', async () => {
  const { caseTool } = await import(join(packageRoot, 'lib', 'cases.js'))
  const { CaseStore } = await import(join(packageRoot, 'lib', 'cases.js'))
  const root = mkdtempSync(join(tmpdir(), 'case-proxy-'))
  try {
    // Mirror the plugin's proxy: a bare object forwarding to a lazily created store.
    let store
    const proxy = new Proxy({}, { get: (_t, method) => typeof method === 'string' ? (...args) => { if (!store) store = new CaseStore(root); const fn = store[method]; if (typeof fn !== 'function') throw new Error(`unsupported case action: ${method}`); return fn.apply(store, args) } : undefined })
    const tool = caseTool(proxy, () => '/work')
    const exec = { agent: { id: 's1' } }
    for (const action of tool.parameters.properties.action.enum) {
      const args = { action }
      if (action === 'search') args.query = 'nothing'
      if (action === 'read' || action === 'archive') args.id = 'missing'
      if (action === 'prune') args.retentionDays = 30
      if (action === 'save') Object.assign(args, { title: 't', problem: 'p', environment: 'e', attempts: 'a', solution: 's', evidence: 'ev' })
      await assert.doesNotReject(async () => tool.execute(args, exec), `${action} must be forwarded`)
    }
    assert.equal(tool.parameters.properties.action.enum.includes('stats'), true)
  } finally { try { store?.close() } catch {} ; rmSync(root, { recursive: true, force: true }) }
})

test('injected prompt stays small and keeps the essentials', () => {
  const { promptText } = promptPure
  const text = promptText('/root/shared', '/usr/local/bin', { intercept: true })
  // Budget: this text is paid on every single request.
  assert.ok(text.length < 520, `prompt must stay under 520 chars, got ${text.length}`)
  for (const must of ['shared get', 'shared npm', 'shared pip', 'shared doctor', 'SKILL.md', 'shared_cases search', 'SHARED_BYPASS']) {
    assert.ok(text.includes(must), `prompt lost essential: ${must}`)
  }
  assert.ok(text.split('\n').length <= 8, 'prompt should stay at most 8 lines')
})

test('tool schemas stay within their token budget', async () => {
  const { defineSharedTool } = promptPure
  const { caseTool } = await import(join(packageRoot, 'lib', 'cases.js'))
  const lib = defineSharedTool('/root/shared', { get: () => undefined })
  // These strings are sent with every request; keep them terse and put detail in skills.
  assert.ok(lib.description.length < 220, `shared_lib description ${lib.description.length} chars`)
  assert.ok(lib.parameters.properties.action.description.length < 200, 'shared_lib action description too long')

  const cases = caseTool({}, () => '/w')
  assert.ok(cases.description.length < 160, `shared_cases description ${cases.description.length} chars`)
  const six = ['title', 'problem', 'environment', 'attempts', 'solution', 'evidence']
    .reduce((n, k) => n + cases.parameters.properties[k].description.length, 0)
  assert.ok(six < 220, `six save-field descriptions total ${six} chars`)
})
