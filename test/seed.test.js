/**
 * 资产铺盘用例：缺就补、种子没被改过就升级、用户改过就不动。
 *   node --test test/*.test.js
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const PACKAGE = new URL('..', import.meta.url).pathname

test('技能种子：缺失补齐、未改动则升级、改动后保留', async () => {
  const work = mkdtempSync(join(tmpdir(), 'shared-seed-'))
  const pkg = join(work, 'pkg')
  const root = join(work, 'root')
  try {
    mkdirSync(root, { recursive: true })
    cpSync(join(PACKAGE, 'lib'), join(pkg, 'lib'), { recursive: true })
    cpSync(join(PACKAGE, 'assets'), join(pkg, 'assets'), { recursive: true })

    const { init } = await import(join(pkg, 'lib', 'index.js'))
    const skill = join(root, 'skills', 'shared-library', 'SKILL.md')
    const asset = join(pkg, 'assets', 'skills', 'shared-library', 'SKILL.md')

    init(root, join(root, 'bin'))
    assert.match(readFileSync(skill, 'utf8'), /共享库/, '缺失时应补种')

    // 资产升级 + 用户没动过 → 覆盖
    writeFileSync(asset, '---\nname: shared-library\ndescription: v2\n---\n\n正文 v2\n')
    init(root, join(root, 'bin'))
    assert.match(readFileSync(skill, 'utf8'), /正文 v2/, '未改动的种子应跟随升级')

    // 用户改过 → 保留
    writeFileSync(skill, '---\nname: shared-library\ndescription: mine\n---\n\n我的改动\n')
    writeFileSync(asset, '---\nname: shared-library\ndescription: v3\n---\n\n正文 v3\n')
    init(root, join(root, 'bin'))
    assert.match(readFileSync(skill, 'utf8'), /我的改动/, '用户编辑必须保留')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('apply stamps the loaded module version for staleness detection', async () => {
  const work = mkdtempSync(join(tmpdir(), 'shared-stamp-'))
  const pkg = join(work, 'pkg'); const root = join(work, 'root')
  try {
    mkdirSync(root, { recursive: true })
    cpSync(join(PACKAGE, 'lib'), join(pkg, 'lib'), { recursive: true })
    cpSync(join(PACKAGE, 'assets'), join(pkg, 'assets'), { recursive: true })
    cpSync(join(PACKAGE, 'package.json'), join(pkg, 'package.json'))
    const { apply } = await import(join(pkg, 'lib', 'index.js'))
    const ctx = {
      inject(_names, cb) { cb({ shellEnv: { register() {} }, skills: { registerProvider() { return () => {} } }, tools: { register() { return () => {} }, guard() { return () => {} } }, systemPrompt: { section() { return () => {} } } }) },
      get: () => undefined, logger: { warn() {} }, effect() {},
    }
    apply(ctx, { root, linkDir: join(root, 'bin'), intercept: false })
    const stamp = JSON.parse(readFileSync(join(root, 'state', 'runtime.json'), 'utf8'))
    assert.equal(stamp.version, JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version)
    assert.ok(Date.parse(stamp.appliedAt) > 0)
  } finally { rmSync(work, { recursive: true, force: true }) }
})
