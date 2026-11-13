/**
 * 拦截层集成用例：真实文件系统 + 假的工具执行体，跑通「判定 → 拒绝理由 → 落日志 → 对账」。
 *   node --test test/*.test.js
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_MANIFESTS, modePath } from '../lib/hook.js'
import { cliCwd, createInterceptor } from '../lib/index.js'

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'shared-icept-'))
  for (const dir of ['bin', 'logs', 'state', 'env/python', 'env/npm', 'skills']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  return root
}

function bash(command, cwd, session = 'session-1') {
  return {
    name: 'bash',
    arguments: { command, workdir: cwd },
    agent: { id: session, session: { header: { cwd } } },
  }
}

function logEntries(root) {
  const path = join(root, 'logs', 'hook.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

test('裸目录里 pip install 被拒，理由可直接复制', () => {
  const root = makeRoot()
  try {
    const dir = join(root, 'workspace')
    mkdirSync(dir)
    const intercept = createInterceptor(root, { manifests: DEFAULT_MANIFESTS })

    const reason = intercept(bash('pip install requests', dir))
    assert.ok(typeof reason === 'string', '应返回拒绝理由')
    assert.match(reason, /\[shared-lib\]/)
    assert.match(reason, /shared pip install requests/)
    assert.match(reason, /SHARED_BYPASS=1/)

    const entries = logEntries(root)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].event, 'deny')
    assert.equal(entries[0].rule, 'pip-install')
    assert.equal(entries[0].command, 'pip install requests')
    assert.equal(entries[0].cwd, dir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('模型改用 shared 命令后记一次 corrected', () => {
  const root = makeRoot()
  try {
    const dir = join(root, 'workspace')
    mkdirSync(dir)
    const intercept = createInterceptor(root, { manifests: DEFAULT_MANIFESTS })

    assert.ok(intercept(bash('npm install -g typescript', dir)))
    assert.equal(intercept(bash('shared npm install -g typescript', dir)), undefined, 'shared 命令本身必须放行')

    const events = logEntries(root).map(entry => entry.event)
    assert.deepEqual(events, ['deny', 'corrected'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('项目内有清单就放行，清单中途出现也能立刻生效', () => {
  const root = makeRoot()
  try {
    const dir = join(root, 'project')
    mkdirSync(dir)
    const intercept = createInterceptor(root, { manifests: DEFAULT_MANIFESTS })

    assert.ok(intercept(bash('pip install requests', dir)), '初始无清单应拦截')
    writeFileSync(join(dir, 'requirements.txt'), 'requests\n')
    assert.equal(intercept(bash('pip install requests', dir)), undefined, '清单出现后应立即放行（否定结果不缓存）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('.dsh-shared-root 标记优先于清单', () => {
  const root = makeRoot()
  try {
    const repo = join(root, 'repo')
    const deep = join(repo, 'packages', 'app')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(repo, '.dsh-shared-root'), '')
    const intercept = createInterceptor(root, { manifests: DEFAULT_MANIFESTS })

    assert.equal(intercept(bash('pip install requests', deep)), undefined, '深层目录靠标记放行')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('工作区 mode=local 时不做拦截（文件由 CLI 写入，格式一致）', () => {
  const root = makeRoot()
  try {
    const dir = join(root, 'local-ws')
    mkdirSync(dir)
    writeFileSync(modePath(root, dir), 'local\n')
    const intercept = createInterceptor(root, { manifests: DEFAULT_MANIFESTS })

    assert.equal(intercept(bash('pip install requests', dir)), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('只看 bash，看不懂的构造放行', () => {
  const root = makeRoot()
  try {
    const dir = join(root, 'workspace')
    mkdirSync(dir)
    const intercept = createInterceptor(root, { manifests: DEFAULT_MANIFESTS })

    assert.equal(intercept({ name: 'read', arguments: { file_path: '/x' }, agent: { id: 's' } }), undefined)
    assert.equal(intercept(bash('bash -c "$CMD"', dir)), undefined, '取不到 -c 内容应放行')
    assert.equal(intercept(bash('pip install "requests[socks]"', dir)), undefined, '带引号放行')
    assert.ok(intercept(bash('bash -c "pip install requests"', dir)), '可从 -c 取出的应递归命中')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('不传 agent 也不崩，cwd 回退到注入目录', () => {
  const root = makeRoot()
  try {
    const dir = join(root, 'workspace')
    mkdirSync(dir)
    const intercept = createInterceptor(root, { manifests: DEFAULT_MANIFESTS })
    const reason = intercept({ name: 'bash', arguments: { command: 'pip install x', workdir: dir } })
    assert.ok(typeof reason === 'string')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shared_lib 的工作目录取会话工作区，而不是宿主进程 cwd', () => {
  assert.equal(cliCwd({ agent: { session: { header: { cwd: '/root/测试' } } } }), '/root/测试')
  assert.equal(cliCwd({ agent: { session: { header: { cwd: 'relative/dir' } } } }), process.cwd(), '相对路径不采信')
  assert.equal(cliCwd({}), process.cwd(), '没有 agent 时回退到进程 cwd')
})
