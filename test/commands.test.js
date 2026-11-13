/**
 * 固定语料回归用例：规则每次改动都必须跑这一套。
 *   node --test test/
 *
 * 断言口径：误拦（本该放行却 deny）是不可接受的失败；
 * 漏拦（本该 deny 却 pass）只要落在「看不懂/歧义」一侧，允许存在，交给事后 adopt 兜底。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  analyzeCommand,
  createProjectResolver,
  describe,
  extractInnerCommands,
  modePath,
  readModeAt,
  summarize,
  workspaceKey,
} from '../lib/hook.js'

/* ────────────────────────── 判定 ────────────────────────── */

const BARE = { cwd: '/tmp/nowhere/deep', resolveProject: () => undefined }
const PROJECT = { cwd: '/work/repo', resolveProject: () => ({ root: '/work/repo', kind: 'manifest' }) }

const verdict = (command, context = BARE) => analyzeCommand(command, context)

const MUST_DENY = [
  ['pip install requests', 'pip-install'],
  ['pip3 install requests', 'pip-install'],
  ['pip install -r requirements.txt', 'pip-install'],
  ['pip install -q requests', 'pip-install'],
  ['sudo pip install requests', 'pip-install'],
  ['time pip install requests', 'pip-install'],
  ['env pip install requests', 'pip-install'],
  ['FOO=bar pip install requests', 'pip-install'],
  ['/usr/bin/pip3 install requests', 'pip-install'],
  ['python3 -m pip install requests', 'python-m-pip'],
  ['python -m pip install requests', 'python-m-pip'],
  ['bash -c "pip install requests"', 'pip-install'],
  ["bash -c 'pip install requests'", 'pip-install'],
  ['sh -c "python3 -m pip install requests"', 'python-m-pip'],
  ['echo hi; pip install requests', 'pip-install'],
  ['pip install requests && ls', 'pip-install'],
  ['npm install -g typescript', 'npm-global'],
  ['npm i -g pnpm', 'npm-global'],
  ['npm add --global serve', 'npm-global'],
  ['pip install a\npip install b', 'pip-install'],
]

const MUST_PASS = [
  'pip show requests',
  'pip --version',
  'pip install "requests[socks]"',
  'bash -c "$CMD"',
  'cat <<EOF | bash\npip install x\nEOF',
  'echo "pip install x"',
  'npm install express',
  'npm ci',
  'npm run build',
  'npx tsc --noEmit',
  'curl -o /tmp/x https://example.com/x',
  'wget https://example.com/x',
  'python3 script.py',
  'python3 -m pytest',
  'SHARED_BYPASS=1 pip install requests',
  'shared pip install requests',
  '(pip install requests)',
  'pip install requests > $OUT',
  'pip install requests 2>&1 > "$LOG"',
  'uv add requests',
  'cargo install ripgrep',
  '',
]

test('必须拦截：语义明确的安装命令', () => {
  for (const [command, rule] of MUST_DENY) {
    const got = verdict(command)
    assert.equal(got.action, 'deny', `应拦截却没拦：${command}`)
    assert.equal(got.rule, rule, `${command} 命中规则不符`)
  }
})

test('绝不误拦：歧义、引号、重定向、已有项目、非安装子命令', () => {
  for (const command of MUST_PASS) {
    const got = verdict(command)
    assert.equal(got.action, 'pass', `不该拦却拦了：${JSON.stringify(command)} → ${got.rule}`)
  }
})

test('项目内依赖放行', () => {
  for (const command of ['pip install -r requirements.txt', 'pip install requests', 'npm install -g typescript']) {
    assert.equal(verdict(command, PROJECT).action, 'pass', `项目内应放行：${command}`)
  }
  const forced = { ...PROJECT, npmGlobalIgnoreManifest: true }
  assert.equal(verdict('npm install -g typescript', forced).action, 'deny', 'npmGlobalIgnoreManifest 应让全局安装不再放行')
})

test('cd 改变落点：项目内放行、项目外拦', () => {
  const resolver = dir => (dir === '/work/proj' || dir.startsWith('/work/proj/'))
    ? { root: '/work/proj', kind: 'manifest' }
    : undefined
  const ctx = { cwd: '/root', resolveProject: resolver }

  assert.equal(verdict('cd /work/proj && pip install requests', ctx).action, 'pass', 'cd 进项目应放行')
  assert.equal(verdict('cd /work/proj/sub && pip install requests', ctx).action, 'pass', 'cd 进子目录应向上找到清单')
  assert.equal(verdict('cd /elsewhere && pip install requests', ctx).action, 'deny', 'cd 出项目应拦')
  assert.equal(verdict('cd /work/proj && npm install -g ts', ctx).action, 'pass', 'cd 进项目后全局安装也放行')
  assert.equal(verdict('cd "$DIR" && pip install requests', ctx).action, 'deny', '动态 cd 目标不可求值，按原 cwd 判定')
})

test('工作区 mode=local 全放行', () => {
  assert.equal(verdict('pip install requests', { ...BARE, mode: 'local' }).action, 'pass')
})

test('-c 提取与递归', () => {
  assert.deepEqual(extractInnerCommands('bash -c "pip install x"'), ['pip install x'])
  assert.deepEqual(extractInnerCommands("bash -c 'pip install x'"), ['pip install x'])
  assert.deepEqual(extractInnerCommands('bash -c $CMD'), [null])
  assert.deepEqual(extractInnerCommands('pip install x'), [])
  assert.equal(verdict('bash -c "bash -c \'pip install x\'"').action, 'deny', '嵌套 -c 也应递归命中')
})

test('拒绝理由含可复制的正确命令', () => {
  const pip = describe(verdict('pip install requests flask'), '/root/shared')
  assert.match(pip, /shared pip install requests flask/)
  assert.match(pip, /SHARED_BYPASS=1/)

  const npm = describe(verdict('npm i -g pnpm'), '/root/shared')
  assert.match(npm, /shared npm install -g pnpm/)
})

/* ────────────────────────── 项目根 / 模式 / 统计 ────────────────────────── */

test('项目根判定：标记优先、清单其次、只缓存正向', () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-hook-'))
  try {
    const deep = join(root, 'a', 'b', 'c')
    mkdirSync(deep, { recursive: true })
    const cache = new Map()
    const resolve = createProjectResolver({ exists: existsSync, cache })

    assert.equal(resolve(deep), undefined, '空树不该命中')

    writeFileSync(join(root, 'package.json'), '{}')
    assert.deepEqual(resolve(deep), { root, kind: 'manifest', file: 'package.json' }, '应向上找到清单')

    writeFileSync(join(deep, '.dsh-shared-root'), '')
    assert.deepEqual(resolve(deep), { root: deep, kind: 'marker' }, '标记应优先且比清单更近')
    assert.equal(cache.get(deep), 'marker')
    assert.equal(cache.has(join(root, 'a', 'b')), false, '未命中的层级不该进缓存')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('工作区标识与 mode 文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'shared-mode-'))
  try {
    const repo = join(root, 'repo')
    const sub = join(repo, 'src')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(sub, { recursive: true })

    assert.equal(workspaceKey(sub, existsSync), repo, '.git 祖先就是工作区')

    const file = modePath('/root/shared', repo)
    assert.match(file, /mode-[0-9a-f]{16}\.txt$/)
    assert.equal(readModeAt(file, () => { throw new Error('ENOENT') }), 'shared', '缺文件默认 shared')
    assert.equal(readModeAt(file, () => 'local\n'), 'local')
    assert.equal(readModeAt(file, () => 'garbage'), 'shared')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('拦截对账统计', () => {
  const text = [
    JSON.stringify({ event: 'deny', rule: 'pip-install' }),
    JSON.stringify({ event: 'corrected', rule: 'pip-install' }),
    'not json',
    JSON.stringify({ event: 'deny', rule: 'npm-global' }),
  ].join('\n')
  const stats = summarize(text)
  assert.equal(stats.deny, 2)
  assert.equal(stats.corrected, 1)
  assert.equal(stats.lastDeny.rule, 'npm-global')
})
