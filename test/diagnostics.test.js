import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const cli = new URL('../assets/shared.sh', import.meta.url).pathname

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'shared-diag-'))
  const linkDir = join(root, 'path')
  for (const dir of ['bin', 'env/npm/bin', 'skills', 'cache', 'logs', 'state', 'path']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'bin', 'shared'), '#!/bin/sh\n')
  return { root, linkDir }
}

function invoke(root, linkDir, args) {
  return spawnSync('bash', [cli, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, DSH_SHARED_ROOT: root, SHARED_LINK_DIR: linkDir } })
}

test('status, doctor, and inventory JSON are parseable and coherent', () => {
  const { root, linkDir } = setup()
  try {
    writeFileSync(join(root, 'skills', 'note.md'), 'skill')
    const status = invoke(root, linkDir, ['status', '--json'])
    const value = JSON.parse(status.stdout)
    assert.equal(value.root, root)
    assert.equal(value.mode, 'shared')
    assert.equal(Array.isArray(value.issues), true)

    const doctor = invoke(root, linkDir, ['doctor', '--json'])
    const doctorValue = JSON.parse(doctor.stdout)
    assert.equal(doctorValue.ok, doctor.status === 0)
    assert.equal(Array.isArray(doctorValue.warnings), true)

    const list = invoke(root, linkDir, ['list', '--json'])
    const inventory = JSON.parse(list.stdout)
    assert.ok(inventory.tools.some(item => item.name === 'shared'))
    assert.ok(inventory.skills.some(item => item.name === 'note'))
    assert.equal(Array.isArray(inventory.npmPackages), true)
    assert.equal(Array.isArray(inventory.pythonPackages), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('adopt writes a run manifest with item results', () => {
  const { root, linkDir } = setup()
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'bin'), { recursive: true })
  writeFileSync(join(workspace, 'bin', 'portable-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  try {
    const source = join(workspace, 'bin', 'portable-tool.c')
    writeFileSync(source, 'int main(void) { return 0; }\n')
    const compile = spawnSync('cc', [source, '-o', join(workspace, 'bin', 'portable-tool')], { encoding: 'utf8' })
    assert.equal(compile.status, 0, compile.stderr)
    const result = invoke(root, linkDir, ['adopt', workspace, '--yes', '--class', 'A'])
    assert.equal(result.status, 0, result.stderr)
    const match = result.stdout.match(/迁移清单：(.+)/)
    assert.ok(match, result.stdout)
    const lines = readFileSync(match[1], 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(lines[0].event, 'run-start')
    assert.ok(lines.some(line => line.event === 'adopt' && line.class === 'A' && line.status === 'succeeded'))
    assert.equal(lines.at(-1).event, 'run-end')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status and doctor surface target matrix and case counts', () => {
  const { root, linkDir } = setup()
  try {
    // A declared install that is not on disk must be visible in both status and doctor.
    const runs = join(root, 'state', 'target-runs'); mkdirSync(runs, { recursive: true })
    writeFileSync(join(runs, 'a.json'), JSON.stringify({ action: 'install', target: 'npm', spec: 'left-pad@1.3', state: 'succeeded', args: ['install', '-g', 'left-pad@1.3'], startedAt: '2026-01-01T00:00:00Z' }))
    const status = JSON.parse(invoke(root, linkDir, ['status', '--json']).stdout)
    assert.deepEqual(status.targets, { runs: 1, declared: 1 })
    assert.ok('cases' in status)

    const doctor = invoke(root, linkDir, ['doctor', '--json'])
    assert.notEqual(doctor.status, 0)
    const health = JSON.parse(doctor.stdout)
    const absent = health.issues.filter(i => i.code === 'TARGET_ABSENT')
    assert.equal(absent.length, 1, doctor.stdout)
    assert.match(absent[0].message, /left-pad@1\.3/)
    assert.match(absent[0].fix, /shared install-target npm "left-pad@1\.3" --execute/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
