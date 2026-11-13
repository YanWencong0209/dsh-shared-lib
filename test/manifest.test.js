/**
 * 清单/完整性/复现回归（参考 flox/devbox/mise 的 lockfile+checksum 模式）。
 * 靶标用 file:// URL：spawnSync 会阻塞测试进程事件循环，进程内起 HTTP 服务是陷阱，
 * curl 原生支持 file://，无需服务器即可闭环下载路径。
 *   node --test test/manifest.test.js
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const packageRoot = new URL('..', import.meta.url).pathname
const cli = join(packageRoot, 'assets/shared.sh')
const PAYLOAD = '#!/bin/sh\necho hi\n'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'shared-manifest-'))
  for (const dir of ['path', 'home', 'srv']) mkdirSync(join(root, dir), { recursive: true })
  const src = join(root, 'srv', 'fakebin')
  writeFileSync(src, PAYLOAD)
  return { root, url: `file://${src}` }
}

function invoke(root, args) {
  return spawnSync('bash', [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DSH_SHARED_ROOT: root, SHARED_LINK_DIR: join(root, 'path'), HOME: join(root, 'home') },
  })
}

test('get records manifest, verify detects tampering, import restores from export', () => {
  const { root, url } = setup()
  try {
    const got = invoke(root, ['get', url, 'fakebin', '--version', '1.2.3'])
    assert.equal(got.status, 0, got.stderr)
    const pin = JSON.parse(readFileSync(join(root, 'state', 'tools.json'), 'utf8')).tools.fakebin
    assert.equal(pin.url, url)
    assert.equal(pin.version, '1.2.3')
    assert.match(pin.sha256, /^[0-9a-f]{64}$/)

    const verified = invoke(root, ['verify', '--json'])
    assert.equal(verified.status, 0, verified.stdout)
    assert.equal(JSON.parse(verified.stdout).tools[0].state, 'ok')

    writeFileSync(join(root, 'bin', 'fakebin'), '#!/bin/sh\necho evil\n')
    const tampered = invoke(root, ['verify', '--json'])
    assert.notEqual(tampered.status, 0)
    assert.equal(JSON.parse(tampered.stdout).tools[0].state, 'corrupt')

    const exportRun = invoke(root, ['export'])
    assert.equal(exportRun.status, 0, exportRun.stderr)
    const snapshot = JSON.parse(exportRun.stdout)
    assert.deepEqual(snapshot.tools.map(t => t.name), ['fakebin'])
    const snapFile = join(root, 'snapshot.json')
    writeFileSync(snapFile, exportRun.stdout)

    rmSync(join(root, 'bin', 'fakebin'))
    const dry = invoke(root, ['import', snapFile])
    assert.equal(dry.status, 0, dry.stderr)
    assert.equal(existsSync(join(root, 'bin', 'fakebin')), false, 'dry 模式不得落盘')

    const restored = invoke(root, ['import', snapFile, '--force'])
    assert.equal(restored.status, 0, restored.stderr)
    assert.equal(readFileSync(join(root, 'bin', 'fakebin'), 'utf8'), PAYLOAD)
    assert.equal(invoke(root, ['verify', '--json']).status, 0)

    const uninstalled = invoke(root, ['uninstall', 'fakebin'])
    assert.equal(uninstalled.status, 0, uninstalled.stderr)
    assert.equal(JSON.parse(readFileSync(join(root, 'state', 'tools.json'), 'utf8')).tools.fakebin, undefined)
    assert.equal(existsSync(join(root, 'bin', 'fakebin')), false)
    assert.equal(existsSync(join(root, 'path', 'fakebin')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('get refuses a sha256 mismatch and writes nothing', () => {
  const { root, url } = setup()
  try {
    const bad = invoke(root, ['get', url, 'fakebin', '--sha256', '0'.repeat(64)])
    assert.notEqual(bad.status, 0)
    assert.match(bad.stderr + bad.stdout, /sha256 校验失败/)
    assert.equal(existsSync(join(root, 'bin', 'fakebin')), false)
    assert.equal(existsSync(join(root, 'path', 'fakebin')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doctor reports actionable fixes for unlinked bin tools', () => {
  const { root } = setup()
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', 'loose'), '#!/bin/sh\n')
  try {
    const run = invoke(root, ['doctor', '--json'])
    assert.notEqual(run.status, 0)
    const health = JSON.parse(run.stdout)
    const notLinked = health.issues.find(issue => issue.code === 'NOT_LINKED')
    assert.ok(notLinked, run.stdout)
    assert.equal(notLinked.fix, 'shared link')
    assert.equal(notLinked.message.includes('loose'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('backends fail loudly when the underlying tool is missing', () => {
  const { root } = setup()
  try {
    for (const tool of ['uv', 'cargo', 'go']) {
      if (spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()) continue
      const run = invoke(root, [tool, '--version'])
      assert.notEqual(run.status, 0, `${tool} 缺失时必须报错`)
      assert.match(run.stderr + run.stdout, new RegExp(`${tool} 未安装`))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
