/**
 * 融合配置回归：meow-memory 随行、mnemon 不插行、memory 探测进 JSON。
 * 上游依据：dsh-mnemon 自带 bundle patch 禁止复制插行（issue #470）；
 * meow-memory 的 registry tarball 自带预构建 lib/，安装期不执行构建脚本。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const packageRoot = new URL('..', import.meta.url).pathname
const cli = join(packageRoot, 'assets/shared.sh')

test('fusion manifest pins both upstream memory packages', () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.version, '0.6.1')
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
