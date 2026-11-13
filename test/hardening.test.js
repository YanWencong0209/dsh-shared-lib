import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const packageRoot = new URL('..', import.meta.url).pathname
const cli = join(packageRoot, 'assets/shared.sh')

function run(root, args, extraEnv = {}) {
  return spawnSync('bash', [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DSH_SHARED_ROOT: root, SHARED_LINK_DIR: join(root, 'path'), ...extraEnv },
  })
}

test('shared link preserves an unrelated symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-link-'))
  try {
    const bin = join(root, 'bin')
    const path = join(root, 'path')
    mkdirSync(bin, { recursive: true })
    mkdirSync(path, { recursive: true })
    writeFileSync(join(bin, 'tool'), '#!/bin/sh\n')
    const external = join(root, 'external-tool')
    writeFileSync(external, '#!/bin/sh\n')
    symlinkSync(external, join(path, 'tool'))
    const result = run(root, ['link'])
    assert.equal(result.status, 0)
    assert.equal(readlinkSync(join(path, 'tool')), external)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shared get rejects traversal names before downloading', () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-get-'))
  try {
    const result = run(root, ['get', 'https://invalid.example/tool', '../outside'])
    assert.notEqual(result.status, 0)
    assert.equal(existsSync(join(root, 'outside')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shared env safely quotes shell-significant root paths', () => {
  const parent = mkdtempSync(join(tmpdir(), 'shared-env-'))
  const root = join(parent, "odd';touch PWNED; #")
  try {
    mkdirSync(root, { recursive: true })
    const result = run(root, ['env'])
    assert.equal(result.status, 0)
    const envFile = join(parent, 'output.sh')
    writeFileSync(envFile, result.stdout)
    const source = spawnSync('bash', ['-c', 'source "$1"; printf "%s" "$DSH_SHARED_ROOT"', '_', envFile], { cwd: parent, encoding: 'utf8' })
    assert.equal(source.stdout, root)
    assert.equal(existsSync(join(parent, 'PWNED')), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
