import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rewriteMeowLabels, installMeowOverlay } from '../lib/bundle.js'

// The shipped labels file, captured from meow-memory 0.32.7. Kept inline so the
// test does not depend on an installed plugin, but shaped exactly like the real
// file: comments, blank lines, and keys the overlay must not touch.
const SHIPPED = [
  '# meow-memory 短框架词',
  '',
  '- inject.title: ===== 长期记忆 =====',
  '- inject.end: ===== 长期记忆结束 =====',
  '- inject.guide: 记忆导引',
  '- inject.guideSearchLine: 需要时用 memory_search 检索（必须传 query 检索词，不能空查）、memory_read 读取。',
  '- inject.guideProjectLine: 当有项目相关任务时，应先用 memory_project 查项目全景（记得带上项目名，不能空参），这样可以对项目有整体理解。',
  '- inject.guideProjects: 用户的所有 project：{list}',
  '- project.global: 全局',
  '- project.unlabeled: 未标记',
].join('\n')

const parse = text => {
  const map = new Map()
  for (const line of text.split('\n')) {
    if (!line.startsWith('- ')) continue
    const sep = line.indexOf(': ')
    if (sep > 2) map.set(line.slice(2, sep), line.slice(sep + 2))
  }
  return map
}

test('overlay keeps every shipped key and rewrites only the four guide lines', () => {
  const { text, applied } = rewriteMeowLabels(SHIPPED)
  assert.equal(applied, 4)
  const before = parse(SHIPPED)
  const after = parse(text)
  // Whole-file replacement means a dropped key breaks keyedValue() at runtime.
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort())
  assert.equal(after.get('inject.guide'), '记忆')
  assert.equal(after.get('inject.guideProjects'), 'project：{list}')
  // Untouched keys must survive verbatim.
  assert.equal(after.get('project.unlabeled'), before.get('project.unlabeled'))
  assert.equal(after.get('inject.title'), before.get('inject.title'))
})

test('overlay text is shorter than the shipped guide block', () => {
  const { text } = rewriteMeowLabels(SHIPPED)
  const guide = t => ['inject.guide', 'inject.guideSearchLine', 'inject.guideProjectLine', 'inject.guideProjects']
    .map(k => parse(t).get(k) ?? '').join('\n')
  assert.ok(guide(text).length < guide(SHIPPED).length)
})

test('a rewrite whose key is absent is reported, not silently dropped', () => {
  const { applied } = rewriteMeowLabels('- other.key: value\n', [['inject.guide', '记忆']])
  assert.equal(applied, 0)
})

test('installMeowOverlay writes a complete file and refuses a partial match', () => {
  const root = mkdtempSync(join(tmpdir(), 'meow-overlay-'))
  try {
    const shipped = join(root, 'labels.md')
    writeFileSync(shipped, SHIPPED)
    const result = installMeowOverlay({ homeDir: join(root, 'home'), shippedPath: shipped })
    assert.equal(result.ok, true)
    assert.equal(result.applied, 4)
    assert.equal(result.keys, parse(SHIPPED).size)
    const written = readFileSync(result.path, 'utf8')
    assert.equal(parse(written).size, parse(SHIPPED).size)
    assert.equal(parse(written).get('inject.guide'), '记忆')

    // A shipped file missing a key must not produce a half overlay.
    const partial = join(root, 'partial.md')
    writeFileSync(partial, '- inject.guide: x\n')
    const refused = installMeowOverlay({ homeDir: join(root, 'home2'), shippedPath: partial })
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /匹配到 1\/4/)
    assert.equal(existsSync(join(root, 'home2', 'prompts', 'zh', 'labels.md')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
