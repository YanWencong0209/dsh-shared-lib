import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync as readText } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const packageRoot = new URL('..', import.meta.url).pathname
const cli = join(packageRoot, 'assets/shared.sh')

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

test('doctor reports version drift with a repair command', () => {
  const { root, linkDir } = setup()
  try {
    const runs = join(root, 'state', 'target-runs'); mkdirSync(runs, { recursive: true })
    writeFileSync(join(runs, 'a.json'), JSON.stringify({ action: 'install', target: 'npm', spec: 'left-pad@1.3.0', state: 'succeeded', args: ['install', '-g', 'left-pad@1.3.0'], startedAt: '2026-01-01T00:00:00Z' }))
    const pkgDir = join(root, 'env/npm/lib/node_modules/left-pad')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.3.1' }))
    const doctor = invoke(root, linkDir, ['doctor', '--json'])
    assert.notEqual(doctor.status, 0)
    const drift = JSON.parse(doctor.stdout).issues.filter(i => i.code === 'TARGET_DRIFT')
    assert.equal(drift.length, 1, doctor.stdout)
    assert.match(drift[0].message, /1\.3\.1/)
    assert.match(drift[0].fix, /uninstall-target npm "left-pad@1\.3\.0" --execute/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('doctor flags a running plugin older than the shipped CLI', () => {
  const { root, linkDir } = setup()
  try {
    // Simulate "package updated on disk, process still running the previous module".
    writeFileSync(join(root, 'state', 'runtime.json'), JSON.stringify({ version: '0.0.1-old', appliedAt: new Date().toISOString() }))
    const doctor = invoke(root, linkDir, ['doctor', '--json'])
    assert.notEqual(doctor.status, 0)
    const stale = JSON.parse(doctor.stdout).issues.filter(i => i.code === 'PLUGIN_STALE')
    assert.equal(stale.length, 1, doctor.stdout)
    assert.match(stale[0].message, /0\.0\.1-old/)
    assert.match(stale[0].fix, /重启 DSH/)

    // Matching versions must not raise it.
    const version = JSON.parse(readText(join(packageRoot, 'package.json'), 'utf8')).version
    const cliVersion = /^VERSION=\"([^\"]+)\"/m.exec(readText(cli, 'utf8'))?.[1]
    assert.equal(cliVersion, version, 'package.json and seeded CLI version must stay synchronized')
    writeFileSync(join(root, 'state', 'runtime.json'), JSON.stringify({ version, appliedAt: new Date().toISOString() }))
    // Install a self-link so unrelated PATH occupancy does not affect doctor status.
    symlinkSync(join(root, 'bin', 'shared'), join(linkDir, 'shared'))
    const okDoctor = invoke(root, linkDir, ['doctor', '--json'])
    assert.equal(JSON.parse(okDoctor.stdout).issues.filter(i => i.code === 'PLUGIN_STALE').length, 0, 'matching runtime stamp must clear only the staleness issue')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
